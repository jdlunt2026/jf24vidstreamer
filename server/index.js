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
  browse,
  describe,
  episodes,
  getItem,
  hlsParams,
  isPlayable,
  ITEM_ID,
  jellyfinUrl,
  libraries,
  resolveUser,
  search,
  stopEncoding,
  summary,
} from "./jellyfin.js";
import { Rooms } from "./rooms.js";

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

// ---- Rooms ------------------------------------------------------------------------

const rooms = new Rooms();
rooms.on("log", (msg) => log(msg));

const ROOM_ID = /^[\w-]{1,100}$/;

function roomState(room, session) {
  const cur = room.current;
  return {
    now: Date.now(),
    current: cur && {
      ...summary(cur.item),
      playId: cur.playId,
      position: room.position(),
      paused: cur.paused,
    },
    queue: room.queue.map(summary),
    viewers: room.presentViewers(),
    canControl: canControl(session),
  };
}

function itemLabel(item) {
  const { title, subtitle } = describe(item);
  return subtitle ? `${title} - ${subtitle}` : title;
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

// Log requests (except the high-volume video, poster and room polling ones),
// so it's visible whether Discord reaches this server at all.
app.use((req, res, next) => {
  const quiet = /^\/(media|img)\//.test(req.path) || (req.method === "GET" && req.path.startsWith("/api/room/"));
  if (!quiet) {
    const start = Date.now();
    res.on("finish", () => log(`${req.method} ${req.path} -> ${res.statusCode} (${Date.now() - start}ms)`));
  }
  next();
});

app.use(express.json({ limit: "16kb" }));

// Startup steps and errors reported by the Activity (no dev tools in Discord).
app.post("/api/client-log", (req, res) => {
  const { kind, message, inDiscord } = req.body ?? {};
  log(`[activity${inDiscord ? "" : " (browser)"}] ${String(kind).slice(0, 20)}: ${String(message).slice(0, 1000)}`);
  res.status(204).end();
});

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
  log("DEV_AUTH is on: anyone who can reach this server can browse, watch and control it");
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

// ---- Library browsing ----

api.get("/libraries", async (_req, res) => {
  res.json(await libraries());
});

api.get("/browse/:parentId", async (req, res) => {
  if (!ITEM_ID.test(req.params.parentId)) return res.status(400).json({ error: "Bad id" });
  const startIndex = Math.max(0, Number.parseInt(req.query.start, 10) || 0);
  res.json(await browse(req.params.parentId, { startIndex, limit: 60 }));
});

api.get("/episodes/:seriesId", async (req, res) => {
  if (!ITEM_ID.test(req.params.seriesId)) return res.status(400).json({ error: "Bad id" });
  res.json(await episodes(req.params.seriesId));
});

api.get("/search", async (req, res) => {
  const q = String(req.query.q ?? "").trim();
  res.json(q ? await search(q) : []);
});

// ---- Rooms ----
// The room ID is the Discord Activity instance ID, so each voice channel's
// Activity has its own watch party.

api.use("/room/:roomId", (req, res, next) => {
  if (!ROOM_ID.test(req.params.roomId)) return res.status(400).json({ error: "Bad room" });
  req.room = rooms.get(req.params.roomId);
  req.room.seen(req.session.user.id, req.session.user.name);
  next();
});

api.get("/room/:roomId", (req, res) => {
  res.json(roomState(req.room, req.session));
});

api.post("/room/:roomId", async (req, res) => {
  const { room, session } = req;
  if (!canControl(session)) return res.status(403).json({ error: "Not allowed" });
  const { action, itemId, position, index, playId } = req.body ?? {};
  const who = session.user.name;

  // Actions on the current item name it, so a click that lands just after
  // the item changed (ended, or someone else picked something) is ignored.
  const stale = ["pause", "resume", "seek", "next"].includes(action) && room.current?.playId !== playId;

  if (action === "play" || action === "queue") {
    if (!ITEM_ID.test(String(itemId))) return res.status(400).json({ error: "Bad item id" });
    const item = await getItem(itemId);
    if (!isPlayable(item)) return res.status(400).json({ error: "That item can't be played" });
    if (action === "play") room.play(item);
    else room.enqueue(item);
    log(`[${room.id}] ${who} ${action === "play" ? "started" : "queued"} ${itemLabel(item)}`);
  } else if (stale) {
    // Ignore; the client picks up the new state from the response.
  } else if (action === "pause") {
    room.pause();
  } else if (action === "resume") {
    room.resume();
  } else if (action === "seek" && Number.isFinite(position)) {
    room.seek(position);
  } else if (action === "next") {
    room.next();
    log(`[${room.id}] ${who} skipped`);
  } else if (action === "stop") {
    room.stop();
    log(`[${room.id}] ${who} stopped playback`);
  } else if (action === "unqueue" && Number.isInteger(index)) {
    room.removeFromQueue(index);
  } else {
    return res.status(400).json({ error: "Unknown action" });
  }
  res.json(roomState(room, session));
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

// ---- Poster images ------------------------------------------------------------------
// /img/<session>/<itemId>?h=300 -> Jellyfin's primary image, resized.

app.get("/img/:session/:itemId", async (req, res) => {
  if (!getSession(req.params.session) || !ITEM_ID.test(req.params.itemId)) return res.status(404).end();
  const height = Math.min(Math.max(Number.parseInt(req.query.h, 10) || 300, 50), 1080);
  const upstream = await fetch(
    jellyfinUrl(`/Items/${req.params.itemId}/Images/Primary`, `maxHeight=${height}&quality=85`),
    { headers: { Authorization: authHeader } },
  ).catch(() => null);
  if (!upstream?.ok || !upstream.body) return res.status(upstream?.status ?? 502).end();
  res.set("Content-Type", upstream.headers.get("content-type") ?? "image/jpeg");
  res.set("Cache-Control", "private, max-age=86400");
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

try {
  await resolveUser();
} catch (err) {
  log(err.message);
  // Exit only for a bad setting; if Jellyfin is just unreachable, start
  // anyway; library requests will work once it's back.
  if (err.message.startsWith("JELLYFIN_USER_ID")) process.exit(1);
}

app.listen(config.port, () => {
  log(`Listening on http://localhost:${config.port}`);
});

for (const sig of ["SIGINT", "SIGTERM", "SIGBREAK", "SIGHUP"]) {
  process.on(sig, () => {
    log("Shutting down");
    process.exit(0);
  });
}
