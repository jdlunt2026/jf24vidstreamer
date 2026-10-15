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

export const config = {
  port: int("PORT", 8080),
  discord: {
    clientId: required("DISCORD_CLIENT_ID"),
    clientSecret: required("DISCORD_CLIENT_SECRET"),
    // Who may skip / queue. Empty = everyone watching.
    controlUserIds: new Set(list("CONTROL_USER_IDS")),
  },
  jellyfin: {
    url: required("JELLYFIN_URL").replace(/\/+$/, ""),
    apiKey: required("JELLYFIN_API_KEY"),
    userId: optional("JELLYFIN_USER_ID", ""),
    // Library / folder / playlist / series IDs to pull from. Empty = everything.
    parentIds: list("JELLYFIN_PARENT_IDS"),
    itemTypes: list("JELLYFIN_ITEM_TYPES", "Movie,Episode"),
    // "random" shuffles the whole list; anything else is passed to Jellyfin's SortBy.
    order: optional("JELLYFIN_ORDER", "random"),
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
