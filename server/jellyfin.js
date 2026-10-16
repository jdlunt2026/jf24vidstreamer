import { config } from "./config.js";

const { url, apiKey, user, parentIds } = config.jellyfin;
let userId = "";

export const authHeader = `MediaBrowser Token="${apiKey}", Client="jf24vidstreamer", Device="discord-activity", DeviceId="jf24vidstreamer", Version="2.0.0"`;

export const ITEM_ID = /^[0-9a-fA-F-]{32,36}$/;

async function get(path, params = {}) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") query.set(key, String(value));
  }
  const res = await fetch(`${url}${path}?${query}`, { headers: { Authorization: authHeader } });
  if (!res.ok) {
    const detail = await errorDetail(res);
    throw new Error(`Jellyfin ${path} -> HTTP ${res.status} ${res.statusText}${detail ? `: ${detail}` : ""}`);
  }
  return res.json();
}

// Jellyfin explains 400s in an ASP.NET "problem details" body, e.g.
// {"errors":{"parentId":["The value 'abc' is not valid."]}}.
async function errorDetail(res) {
  const text = await res.text().catch(() => "");
  try {
    const body = JSON.parse(text);
    if (body.errors) {
      return Object.entries(body.errors)
        .map(([field, msgs]) => `${field}: ${[].concat(msgs).join(" ")}`)
        .join("; ");
    }
    return body.detail ?? body.title ?? text.slice(0, 300);
  } catch {
    return text.slice(0, 300);
  }
}

/**
 * Resolves JELLYFIN_USER_ID, which may be a user ID or a username. Called
 * once at startup; throws with a helpful message if the user doesn't exist.
 */
export async function resolveUser() {
  if (!user) return;
  const fromUrl = /[?&]userId=([0-9a-fA-F-]{32,36})/.exec(user);
  const id = (fromUrl ? fromUrl[1] : user).replaceAll("-", "").toLowerCase();
  if (/^[0-9a-f]{32}$/.test(id)) {
    userId = id;
    return;
  }
  const users = await get("/Users");
  const match = users.find((u) => u.Name.toLowerCase() === user.toLowerCase());
  if (!match) {
    const names = users.map((u) => u.Name).join(", ");
    throw new Error(`JELLYFIN_USER_ID: no Jellyfin user named "${user}". Users on this server: ${names}`);
  }
  userId = match.Id;
}

// What the browser offers: playable videos plus the containers that lead to them.
const PLAYABLE = new Set(["Movie", "Episode", "Video", "MusicVideo", "Trailer"]);
const BROWSE_TYPES = "Movie,Series,Video,MusicVideo,BoxSet";
// Library kinds that hold no video.
const NON_VIDEO_LIBRARIES = new Set(["music", "books", "photos", "livetv", "playlists"]);

const LIST_FIELDS = "ProductionYear,RunTimeTicks,ChildCount";

/** Top-level libraries to show as tabs. */
export async function libraries() {
  if (parentIds.length) {
    const result = await get("/Items", { userId, ids: parentIds.join(",") });
    return result.Items.map(summary);
  }
  const result = userId ? await get("/UserViews", { userId }) : await get("/Library/MediaFolders");
  return result.Items.filter((lib) => !NON_VIDEO_LIBRARIES.has(lib.CollectionType)).map(summary);
}

/** One page of a library or folder: movies, shows, videos and collections, A-Z. */
export async function browse(parentId, { startIndex = 0, limit = 60 } = {}) {
  const result = await get("/Items", {
    userId,
    parentId,
    recursive: true,
    includeItemTypes: BROWSE_TYPES,
    sortBy: "SortName",
    sortOrder: "Ascending",
    fields: LIST_FIELDS,
    startIndex,
    limit,
    enableUserData: false,
  });
  return { items: result.Items.map(summary), total: result.TotalRecordCount };
}

/** All episodes of a series, in order. */
export async function episodes(seriesId) {
  const result = await get(`/Shows/${seriesId}/Episodes`, { userId, fields: LIST_FIELDS, enableUserData: false });
  return result.Items.filter((ep) => ep.RunTimeTicks > 0 && ep.LocationType !== "Virtual").map(summary);
}

export async function search(term) {
  const parents = parentIds.length ? parentIds : [undefined];
  const items = [];
  for (const parentId of parents) {
    const result = await get("/Items", {
      userId,
      parentId,
      searchTerm: term,
      recursive: true,
      includeItemTypes: `${BROWSE_TYPES},Episode`,
      fields: LIST_FIELDS,
      limit: 40,
      enableUserData: false,
    });
    items.push(...result.Items);
  }
  const seen = new Set();
  return items.filter((i) => !seen.has(i.Id) && seen.add(i.Id)).map(summary);
}

export async function getItem(id) {
  const result = await get("/Items", { userId, ids: id, fields: LIST_FIELDS });
  return result.Items[0];
}

export function isPlayable(item) {
  return PLAYABLE.has(item?.Type) && item.RunTimeTicks > 0;
}

/** The shape the client gets for any item. */
export function summary(item) {
  return {
    id: item.Id,
    type: item.Type,
    ...describe(item),
    duration: item.RunTimeTicks ? item.RunTimeTicks / 10_000 : 0,
    playable: isPlayable(item),
    image: Boolean(item.ImageTags?.Primary),
  };
}

export function describe(item) {
  if (item.Type === "Episode" && item.SeriesName) {
    const s = String(item.ParentIndexNumber ?? 0).padStart(2, "0");
    const e = String(item.IndexNumber ?? 0).padStart(2, "0");
    return { title: item.SeriesName, subtitle: `S${s}E${e} · ${item.Name}` };
  }
  if (item.Type === "Series" && item.ChildCount) {
    return { title: item.Name, subtitle: `${item.ChildCount} season${item.ChildCount === 1 ? "" : "s"}` };
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
