import { config } from "./config.js";

const { url, apiKey, userId, parentIds, itemTypes, order } = config.jellyfin;

export const authHeader = `MediaBrowser Token="${apiKey}", Client="jf24vidstreamer", Device="discord-activity", DeviceId="jf24vidstreamer", Version="2.0.0"`;

export const ITEM_ID = /^[0-9a-fA-F-]{32,36}$/;

async function get(path, params = {}) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") query.set(key, String(value));
  }
  const res = await fetch(`${url}${path}?${query}`, { headers: { Authorization: authHeader } });
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
  // Items without a runtime can't be scheduled.
  const seen = new Set();
  return items.filter((item) => item.RunTimeTicks > 0 && !seen.has(item.Id) && seen.add(item.Id));
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

export async function searchItems(term, limit = 10) {
  return fetchItems({ searchTerm: term, limit });
}

export async function getItem(id) {
  const result = await get("/Items", { userId, ids: id });
  return result.Items[0];
}

export function describe(item) {
  if (item.Type === "Episode" && item.SeriesName) {
    const s = String(item.ParentIndexNumber ?? 0).padStart(2, "0");
    const e = String(item.IndexNumber ?? 0).padStart(2, "0");
    return { title: item.SeriesName, subtitle: `S${s}E${e} · ${item.Name}` };
  }
  return { title: item.Name, subtitle: item.ProductionYear ? String(item.ProductionYear) : "" };
}

/** Jellyfin query parameters for an HLS stream that browsers can play. */
export function hlsParams({ itemId, deviceId, playSessionId }) {
  const { maxBitrateKbps, maxHeight } = config.stream;
  const bitrate = maxBitrateKbps * 1000;
  return new URLSearchParams({
    MediaSourceId: itemId,
    DeviceId: deviceId,
    PlaySessionId: playSessionId,
    VideoCodec: "h264",
    AudioCodec: "aac,mp3",
    AudioBitrate: "192000",
    VideoBitrate: String(bitrate - 192000),
    MaxStreamingBitrate: String(bitrate),
    MaxHeight: String(maxHeight),
    TranscodingMaxAudioChannels: "2",
    SegmentContainer: "ts",
    MinSegments: "1",
    BreakOnNonKeyFrames: "true",
    AllowVideoStreamCopy: "true",
    AllowAudioStreamCopy: "true",
    // Discord desktop is Chromium; burn nothing in, skip subtitles.
    SubtitleMethod: "Drop",
  });
}

export function jellyfinUrl(path, query = "") {
  return `${url}${path}${query ? `?${query}` : ""}`;
}

export async function stopEncoding(deviceId, playSessionId) {
  await fetch(jellyfinUrl("/Videos/ActiveEncodings", new URLSearchParams({ deviceId, playSessionId })), {
    method: "DELETE",
    headers: { Authorization: authHeader },
  }).catch(() => {});
}
