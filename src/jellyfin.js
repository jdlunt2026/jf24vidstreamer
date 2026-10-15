import { config } from "./config.js";

const { url, apiKey, userId, parentIds, itemTypes, order } = config.jellyfin;

export const authHeaders = {
  Authorization: `MediaBrowser Token="${apiKey}", Client="jellyfin-discord-stream", Device="discord", DeviceId="jellyfin-discord-stream", Version="1.0.0"`,
};

async function get(path, params = {}) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") query.set(key, String(value));
  }
  const res = await fetch(`${url}${path}?${query}`, { headers: authHeaders });
  if (!res.ok) {
    throw new Error(`Jellyfin ${path} -> HTTP ${res.status} ${res.statusText}`);
  }
  return res.json();
}

async function fetchItems(extra = {}) {
  const base = {
    userId,
    recursive: true,
    includeItemTypes: itemTypes.join(","),
    mediaTypes: "Video",
    isMissing: false,
    fields: "RunTimeTicks",
    enableImages: false,
    enableUserData: false,
    ...extra,
  };
  const parents = parentIds.length ? parentIds : [undefined];
  const items = [];
  for (const parentId of parents) {
    const result = await get("/Items", { ...base, parentId });
    items.push(...result.Items);
  }
  // A playlist can contain the same item twice; parents can overlap.
  const seen = new Set();
  return items.filter((item) => !seen.has(item.Id) && seen.add(item.Id));
}

function shuffle(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

/** Builds one full pass over the configured library, in playback order. */
export async function buildPlaylist() {
  if (order.toLowerCase() === "random") {
    return shuffle(await fetchItems());
  }
  return fetchItems({ sortBy: order, sortOrder: "Ascending" });
}

export async function searchItems(term, limit = 5) {
  return fetchItems({ searchTerm: term, limit });
}

/** Whether the item has at least one audio track (silence is generated otherwise). */
export async function hasAudio(item) {
  const result = await get("/Items", { userId, ids: item.Id, fields: "MediaStreams" });
  const streams = result.Items[0]?.MediaStreams;
  // If Jellyfin doesn't tell us, assume yes; most video files have audio.
  return streams ? streams.some((s) => s.Type === "Audio") : true;
}

/**
 * Original-file stream URL. static=true makes Jellyfin serve the file as-is
 * (no server-side transcode); ffmpeg in this process does the transcoding.
 */
export function streamUrl(item) {
  return `${url}/Videos/${item.Id}/stream?static=true`;
}

export function describe(item) {
  if (item.Type === "Episode" && item.SeriesName) {
    const s = String(item.ParentIndexNumber ?? 0).padStart(2, "0");
    const e = String(item.IndexNumber ?? 0).padStart(2, "0");
    return `${item.SeriesName} S${s}E${e} - ${item.Name}`;
  }
  return item.ProductionYear ? `${item.Name} (${item.ProductionYear})` : item.Name;
}

export function formatTicks(ticks) {
  if (!ticks) return "?";
  const total = Math.floor(ticks / 10_000_000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(h ? 2 : 1, "0");
  return `${h ? `${h}:` : ""}${mm}:${String(s).padStart(2, "0")}`;
}
