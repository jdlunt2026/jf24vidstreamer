import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import express from "express";
import { config } from "./config.js";
import {
  authHeader,
  describe,
  getItem,
  hlsParams,
  ITEM_ID,
  jellyfinUrl,
  searchItems,
  stopEncoding,
} from "./jellyfin.js";
import { Schedule } from "./schedule.js";

const log = (...args) => console.log(new Date().toISOString(), ...args);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// ---- Sessions -----------------------------------------------------------------
// A session is created after Discord OAuth and identifies a viewer to the API
// and to the media relay. In memory only; viewers re-auth after a restart.

const SESSION_TTL = 24 * 60 * 60 * 1000;
const sessions = new Map(); // id -> { user, deviceId, expires }

function createSession(user) {
  const id = randomBytes(24).toString("base64url");
  sessions.set(id, {
    user,
    deviceId: `jf24-${randomBytes(6).toString("hex")}`,
    expires: Date.now() + SESSION_TTL,
  });
  return id;
}

function getSession(id) {
  const session = id && sessions.get(id);
  if (!session) return null;
  if (session.expires < Date.now()) {
    sessions.delete(id);
    return null;
  }
  return session;
}

setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) if (s.expires < now) sessions.delete(id);
}, 60 * 60 * 1000).unref();

function canControl(session) {
  const { controlUserIds } = config.discord;
  return controlUserIds.size === 0 || controlUserIds.has(session.user.id);
}

// ---- Schedule -----------------------------------------------------------------

const schedule = new Schedule();
schedule.on("log", (msg) => log(msg));
schedule.on("change", ({ item }) => {
  const { title, subtitle } = describe(item);
  log(`Now playing: ${title}${subtitle ? ` - ${subtitle}` : ""}`);
});

function itemSummary(item) {
  return { id: item.Id, type: item.Type, ...describe(item), duration: item.RunTimeTicks / 10_000 };
}

// ---- App ------------------------------------------------------------------------

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", true);

// Inside Discord, the client prefixes requests with /.proxy. Accept both forms
// in case Discord's proxy passes the prefix through.
app.use((req, _res, next) => {
  if (req.url.startsWith("/.proxy/")) req.url = req.url.slice(7);
  next();
});

app.use(express.json({ limit: "16kb" }));

app.get("/api/config", (_req, res) => {
  res.json({ clientId: config.discord.clientId, devAuth: config.devAuth });
});

// Exchange the OAuth code from the Embedded App SDK for an access token, look
// up who it belongs to, and start a session.
app.post("/api/token", async (req, res) => {
  const code = req.body?.code;
  if (typeof code !== "string") return res.status(400).json({ error: "Missing code" });

  const tokenRes = await fetch("https://discord.com/api/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.discord.clientId,
      client_secret: config.discord.clientSecret,
      grant_type: "authorization_code",
      code,
    }),
  });
  const token = await tokenRes.json().catch(() => ({}));
  if (!tokenRes.ok || !token.access_token) {
    log("OAuth token exchange failed:", tokenRes.status, token.error_description ?? token.error ?? "");
    return res.status(401).json({ error: "Discord authorization failed" });
  }

  const userRes = await fetch("https://discord.com/api/users/@me", {
    headers: { Authorization: `Bearer ${token.access_token}` },
  });
  if (!userRes.ok) return res.status(401).json({ error: "Couldn't look up Discord user" });
  const user = await userRes.json();

  const session = createSession({ id: user.id, name: user.global_name ?? user.username });
  log(`${user.username} (${user.id}) joined`);
  res.json({ access_token: token.access_token, session });
});

if (config.devAuth) {
  log("DEV_AUTH is on: anyone who can reach this server can watch and control it");
  app.post("/api/dev-login", (_req, res) => {
    res.json({ session: createSession({ id: "dev", name: "Developer" }) });
  });
}

// Everything below needs a session (X-Session header).
const api = express.Router();
api.use((req, res, next) => {
  const session = getSession(req.get("X-Session"));
  if (!session) return res.status(401).json({ error: "Not signed in" });
  req.session = session;
  next();
});

api.get("/state", (req, res) => {
  const cur = schedule.current;
  res.json({
    now: Date.now(),
    current: cur && { ...itemSummary(cur.item), startedAt: cur.startedAt, duration: cur.duration },
    upNext: schedule.upNext(10).map(itemSummary),
    canControl: canControl(req.session),
  });
});

api.post("/skip", async (req, res) => {
  if (!canControl(req.session)) return res.status(403).json({ error: "Not allowed" });
  // The client says which item it means to skip, so a click that lands just
  // after an item ended on its own doesn't also skip the next one.
  const id = req.body?.id;
  if (schedule.current && schedule.current.item.Id !== id) return res.json({ ok: true, skipped: false });
  log(`${req.session.user.name} skipped`);
  await schedule.advance();
  res.json({ ok: true, skipped: true });
});

api.get("/search", async (req, res) => {
  const q = String(req.query.q ?? "").trim();
  if (!q) return res.json([]);
  const items = await searchItems(q, 15);
  res.json(items.map(itemSummary));
});

api.post("/queue", async (req, res) => {
  if (!canControl(req.session)) return res.status(403).json({ error: "Not allowed" });
  const id = String(req.body?.id ?? "");
  if (!ITEM_ID.test(id)) return res.status(400).json({ error: "Bad item id" });
  const item = await getItem(id);
  if (!item?.RunTimeTicks) return res.status(404).json({ error: "Item not found" });
  schedule.enqueue(item);
  log(`${req.session.user.name} queued ${describe(item).title}`);
  res.json({ ok: true, position: schedule.requests.length });
});

// Ends this viewer's Jellyfin transcode when they move on to another item.
api.post("/stop", async (req, res) => {
  const ps = String(req.body?.playSessionId ?? "");
  if (/^[\w-]{1,64}$/.test(ps)) await stopEncoding(req.session.deviceId, ps);
  res.json({ ok: true });
});

app.use("/api", api);

// ---- Media relay ------------------------------------------------------------------
// /media/<session>/<itemId>/master.m3u8?ps=<playSessionId>
//   -> Jellyfin /Videos/<itemId>/master.m3u8 with our transcoding parameters.
// Jellyfin's playlists use relative URLs (main.m3u8, hls1/main/0.ts, ...), so
// they resolve back to /media/<session>/<itemId>/... and get relayed the same way.
// The session is in the path because the <video> element / hls.js can't add
// headers to every request. The Jellyfin API key never leaves this server.

const MEDIA_PATH = /^(?:master\.m3u8|main\.m3u8|hls1\/[\w.-]+\/[\w.-]+)$/;

app.get("/media/:session/:itemId/*rest", async (req, res) => {
  const session = getSession(req.params.session);
  if (!session) return res.status(401).end();
  const { itemId } = req.params;
  const rest = req.params.rest.join("/");
  if (!ITEM_ID.test(itemId) || !MEDIA_PATH.test(rest)) return res.status(404).end();

  const query = new URL(req.originalUrl, "http://x").searchParams;
  let upstreamQuery;
  if (rest === "master.m3u8") {
    const playSessionId = query.get("ps") ?? "";
    if (!/^[\w-]{1,64}$/.test(playSessionId)) return res.status(400).end();
    upstreamQuery = hlsParams({ itemId, deviceId: session.deviceId, playSessionId });
  } else {
    upstreamQuery = query;
  }

  const abort = new AbortController();
  res.on("close", () => abort.abort());
  let upstream;
  try {
    upstream = await fetch(jellyfinUrl(`/Videos/${itemId}/${rest}`, upstreamQuery.toString()), {
      headers: {
        Authorization: authHeader,
        ...(req.get("Range") ? { Range: req.get("Range") } : {}),
      },
      signal: abort.signal,
    });
  } catch (err) {
    if (!abort.signal.aborted) log(`Jellyfin request failed for ${rest}: ${err.message}`);
    return res.headersSent ? res.end() : res.status(502).end();
  }

  res.status(upstream.status);
  for (const h of ["content-type", "content-length", "content-range", "accept-ranges"]) {
    const v = upstream.headers.get(h);
    if (v) res.set(h, v);
  }
  res.set("Cache-Control", "no-store");
  if (!upstream.ok) log(`Jellyfin returned ${upstream.status} for ${rest}`);
  if (!upstream.body) return res.end();
  await pipeline(Readable.fromWeb(upstream.body), res).catch(() => {});
});

// ---- Client ------------------------------------------------------------------------

const dist = join(root, "dist");
if (existsSync(dist)) {
  app.use(express.static(dist, { index: "index.html" }));
} else {
  app.get("/", (_req, res) => res.status(500).send("Client not built. Run: npm run build"));
}

app.use((err, _req, res, _next) => {
  log("Request failed:", err);
  if (!res.headersSent) res.status(500).json({ error: err.message });
});

app.listen(config.port, () => {
  log(`Listening on http://localhost:${config.port}`);
  schedule.start();
});

for (const sig of ["SIGINT", "SIGTERM", "SIGBREAK", "SIGHUP"]) {
  process.on(sig, () => {
    log("Shutting down");
    process.exit(0);
  });
}
