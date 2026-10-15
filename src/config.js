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
  discord: {
    token: required("DISCORD_TOKEN"),
    guildId: required("DISCORD_GUILD_ID"),
    channelId: required("DISCORD_VOICE_CHANNEL_ID"),
    commandPrefix: optional("COMMAND_PREFIX", "!"),
    // Only these user IDs may run commands. Empty = commands disabled.
    allowedUserIds: new Set(list("ALLOWED_USER_IDS")),
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
    height: int("STREAM_HEIGHT", 720),
    frameRate: int("STREAM_FPS", 30),
    bitrateVideo: int("STREAM_BITRATE_KBPS", 3000),
    bitrateVideoMax: int("STREAM_BITRATE_MAX_KBPS", 4500),
    bitrateAudio: int("STREAM_AUDIO_BITRATE_KBPS", 128),
    codec: optional("STREAM_CODEC", "H264"),
    encoder: optional("STREAM_ENCODER", "software"), // software | nvenc | qsv | amf | vaapi
    preset: optional("STREAM_PRESET", "veryfast"),
    hardwareDecoding: bool("STREAM_HW_DECODE", false),
    type: optional("STREAM_TYPE", "go-live"), // go-live | camera
    // Full path to ffmpeg(.exe) if it isn't on PATH.
    ffmpegPath: optional("FFMPEG_PATH", "ffmpeg"),
  },
  // Show "Now playing" as the account's status.
  setStatus: bool("SET_STATUS", true),
};
