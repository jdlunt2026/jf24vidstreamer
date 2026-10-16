import "dotenv/config";

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(`Missing required environment variable ${name} (see .env.example)`);
    process.exit(1);
  }
  return value;
}

function optional(name, fallback) {
  const value = process.env[name]?.trim();
  return value ? value : fallback;
}

function list(name, fallback = "") {
  return optional(name, fallback)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function int(name, fallback) {
  const value = Number.parseInt(optional(name, ""), 10);
  return Number.isFinite(value) ? value : fallback;
}

function bool(name, fallback) {
  const value = optional(name, "").toLowerCase();
  if (!value) return fallback;
  return ["1", "true", "yes", "on"].includes(value);
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

// Accepts a bare Jellyfin ID, a GUID with dashes, or a pasted web-UI URL
// containing "id=..." / "userId=...", and returns the 32-character ID.
function jellyfinId(name, raw) {
  const fromUrl = /[?&](?:id|userId|parentId)=([0-9a-fA-F-]{32,36})/.exec(raw);
  const id = (fromUrl ? fromUrl[1] : raw).replaceAll("-", "").toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(id)) {
    fail(
      `${name}: "${raw}" isn't a Jellyfin ID. IDs are 32 hex characters; in the ` +
        `Jellyfin web UI open the item and copy the "id=" value from the address bar.`,
    );
  }
  return id;
}

// People often paste the address bar, e.g. http://host:8096/web/#/home.html.
function jellyfinBaseUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    fail(`JELLYFIN_URL: "${raw}" isn't a URL. Example: http://localhost:8096`);
  }
  const path = url.pathname.replace(/\/web(\/.*)?$/i, "").replace(/\/+$/, "");
  return `${url.protocol}//${url.host}${path}`;
}

export const config = {
  port: int("PORT", 8080),
  discord: {
    clientId: required("DISCORD_CLIENT_ID"),
    clientSecret: required("DISCORD_CLIENT_SECRET"),
    // Who may pick what to watch and control playback. Empty = everyone.
    controlUserIds: new Set(list("CONTROL_USER_IDS")),
  },
  jellyfin: {
    url: jellyfinBaseUrl(required("JELLYFIN_URL")),
    apiKey: required("JELLYFIN_API_KEY"),
    // A user ID or a username; a username is looked up when the server starts.
    user: optional("JELLYFIN_USER_ID", ""),
    // Libraries / folders / collections to offer for browsing. Empty = all
    // video libraries.
    parentIds: list("JELLYFIN_PARENT_IDS").map((id) => jellyfinId("JELLYFIN_PARENT_IDS", id)),
  },
  stream: {
    // Upper limit per viewer. Jellyfin copies the original video when it fits
    // (and is H.264), and transcodes down otherwise.
    maxBitrateKbps: int("MAX_BITRATE_KBPS", 8000),
    maxHeight: int("MAX_HEIGHT", 1080),
  },
  // Lets you open the Activity in a normal browser at http://localhost:PORT
  // without Discord, for testing. Never enable on a public server.
  devAuth: bool("DEV_AUTH", false),
};
