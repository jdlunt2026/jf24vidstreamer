import { DiscordSDK } from "@discord/embedded-app-sdk";
import Hls from "hls.js";

// Inside Discord the page is served from <client_id>.discordsays.com, and
// requests to our own server go through Discord's proxy under /.proxy.
const params = new URLSearchParams(location.search);
const inDiscord = params.has("frame_id");
const BASE = inDiscord ? "/.proxy" : "";

const POLL_MS = 2000;
const MAX_DRIFT_S = 2;

const $ = (id) => document.getElementById(id);
const video = $("video");

let session = null;
let discord = null;
let roomId = "dev";
let clockOffset = 0; // server time - local time (ms)
let room = null; // last room state from the server
let roomAt = 0; // local time `room` was received
let playing = null; // { playId, itemId, playSessionId }
let hls = null;
let view = "browse"; // "browse" | "player"

// ---- Server API ---------------------------------------------------------------

async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(`${BASE}/api${path}`, {
    method,
    headers: {
      ...(session ? { "X-Session": session } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 && session) {
    // Server restarted and forgot us; sign in again.
    session = null;
    await signIn();
    return api(path, { method, body });
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

async function signIn() {
  const cfg = await api("/config");
  if (inDiscord) {
    discord ??= new DiscordSDK(cfg.clientId);
    await discord.ready();
    roomId = discord.instanceId;
    const { code } = await discord.commands.authorize({
      client_id: cfg.clientId,
      response_type: "code",
      state: "",
      prompt: "none",
      scope: ["identify", "rpc.activities.write"],
    });
    const { access_token, session: s } = await api("/token", { method: "POST", body: { code } });
    await discord.commands.authenticate({ access_token });
    session = s;
  } else if (cfg.devAuth) {
    roomId = params.get("room") ?? "dev";
    session = (await api("/dev-login", { method: "POST" })).session;
  } else {
    throw new Error("Open this from a Discord voice channel (Activities).");
  }
}

const roomPath = () => `/room/${encodeURIComponent(roomId)}`;

async function action(body) {
  try {
    applyRoom(await api(roomPath(), { method: "POST", body }), Date.now());
  } catch (err) {
    toast(err.message);
  }
}

function imgUrl(id, h = 300) {
  return `${BASE}/img/${session}/${id}?h=${h}`;
}

// ---- Room sync ----------------------------------------------------------------------

function serverNow() {
  return Date.now() + clockOffset;
}

/** Where the shared clock says playback is, in seconds (negative = not started yet). */
function expectedSeconds() {
  const cur = room?.current;
  if (!cur) return 0;
  const ms = cur.paused ? cur.position : cur.position + (serverNow() - room.now);
  return ms / 1000;
}

async function poll() {
  try {
    const sent = Date.now();
    const next = await api(roomPath());
    const received = Date.now();
    // Assume the server answered halfway through the round trip.
    clockOffset = next.now - (sent + received) / 2;
    applyRoom(next, received);
    $("status").textContent = "";
  } catch (err) {
    if (!room) $("status").textContent = `Can't reach the server: ${err.message}`;
  }
}

function applyRoom(next, at) {
  const prevPlayId = room?.current?.playId;
  room = next;
  roomAt = at;
  const cur = room.current;

  // Something new started: everyone switches to the player.
  if (cur && cur.playId !== prevPlayId) setView("player");
  if (!cur && view === "player") setView("browse");

  renderRoom();
  sync();
}

function sync() {
  const cur = room?.current;
  if (!cur) return stopPlayback();
  if (playing?.playId !== cur.playId) return load(cur);

  const expected = expectedSeconds();
  $("waiting").hidden = !(expected < 0 && !cur.paused);

  if (cur.paused || expected < 0) {
    if (!video.paused) video.pause();
    const target = Math.max(0, expected);
    if (video.readyState >= 1 && Math.abs(video.currentTime - target) > 0.25) video.currentTime = target;
    return;
  }
  if (video.paused) play();
  if (!video.seeking && video.readyState >= 2 && Math.abs(video.currentTime - expected) > MAX_DRIFT_S) {
    video.currentTime = expected;
  }
}

// ---- Player -------------------------------------------------------------------------

function stopPlayback() {
  if (!playing) return;
  api("/stop", { method: "POST", body: { playSessionId: playing.playSessionId } }).catch(() => {});
  hls?.destroy();
  hls = null;
  video.removeAttribute("src");
  video.load();
  playing = null;
  $("waiting").hidden = true;
  discord?.commands.setActivity({ activity: { type: 3, details: "Browsing the library" } }).catch(() => {});
}

function load(cur) {
  stopPlayback();
  const playSessionId = crypto.randomUUID().replaceAll("-", "");
  playing = { playId: cur.playId, itemId: cur.id, playSessionId };
  const src = `${BASE}/media/${session}/${cur.id}/master.m3u8?ps=${playSessionId}`;
  const start = Math.max(0, expectedSeconds());

  if (Hls.isSupported()) {
    hls = new Hls({ startPosition: start, maxBufferLength: 30 });
    let recoveries = 0;
    hls.on(Hls.Events.ERROR, (_e, data) => {
      if (!data.fatal) return;
      if (data.type === Hls.ErrorTypes.MEDIA_ERROR && recoveries++ < 3) {
        hls.recoverMediaError();
      } else {
        console.warn("Playback failed, reloading", data);
        toast("Playback error, retrying…");
        setTimeout(() => {
          if (playing?.playSessionId === playSessionId && room?.current) {
            playing = null;
            load(room.current);
          }
        }, 3000);
      }
    });
    hls.loadSource(src);
    hls.attachMedia(video);
  } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
    // Safari / iOS WebView without MSE: native HLS.
    video.src = src;
    video.addEventListener("loadedmetadata", () => (video.currentTime = Math.max(0, expectedSeconds())), {
      once: true,
    });
  } else {
    toast("This device can't play HLS video.");
    return;
  }
  sync();
  discord?.commands
    .setActivity({ activity: { type: 3, details: cur.title, state: cur.subtitle || undefined } })
    .catch(() => {});
}

async function play() {
  try {
    await video.play();
  } catch {
    // Autoplay with sound was blocked: start muted and offer to unmute.
    video.muted = true;
    $("unmute").hidden = false;
    renderVolume();
    await video.play().catch(() => {});
  }
}

// ---- Rendering ------------------------------------------------------------------------

function formatTime(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

function setView(next) {
  view = next;
  $("player").hidden = view !== "player";
  $("browse").hidden = view !== "browse";
  if (view === "player") wake();
}

function renderRoom() {
  const cur = room.current;
  const control = room.canControl;
  const viewers = room.viewers.length ? `👥 ${room.viewers.join(", ")}` : "";
  $("viewers").textContent = viewers;
  $("browse-viewers").textContent = viewers;

  $("nowbar").hidden = !cur;
  if (cur) {
    $("nowbar-title").textContent = cur.subtitle ? `${cur.title} · ${cur.subtitle}` : cur.title;
    $("np-title").textContent = cur.title;
    $("np-subtitle").textContent = cur.subtitle;
    $("playpause").textContent = cur.paused ? "▶" : "⏸";
    $("duration").textContent = formatTime(cur.duration / 1000);
    $("seek").max = Math.floor(cur.duration / 1000);
  }
  for (const id of ["playpause", "back10", "fwd30", "stop", "seek"]) $(id).disabled = !control;
  $("next").disabled = !control || room.queue.length === 0;

  const queue = $("queue");
  queue.replaceChildren(
    ...room.queue.map((item, index) => {
      const li = document.createElement("li");
      if (control) {
        const remove = document.createElement("button");
        remove.textContent = "✕";
        remove.title = "Remove";
        remove.addEventListener("click", () => action({ action: "unqueue", index }));
        li.append(remove);
      }
      li.append(item.title);
      if (item.subtitle) {
        const small = document.createElement("small");
        small.textContent = item.subtitle;
        li.append(small);
      }
      return li;
    }),
  );
  $("queue-empty").hidden = room.queue.length > 0;
  $("browse-note").textContent = control
    ? cur
      ? ""
      : "Pick something to watch together."
    : "Browsing only. Someone with control can start or queue things.";
  renderProgress();
}

let seeking = false;
function renderProgress() {
  const cur = room?.current;
  if (!cur || seeking) return;
  const t = Math.min(Math.max(0, expectedSeconds()), cur.duration / 1000);
  $("time").textContent = formatTime(t);
  $("seek").value = Math.floor(t);
}

function renderVolume() {
  $("mute").textContent = video.muted || video.volume === 0 ? "🔇" : "🔊";
  $("volume").value = video.muted ? 0 : video.volume;
}

let toastTimer;
function toast(message) {
  $("toast").textContent = message;
  $("toast").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($("toast").hidden = true), 3000);
}

// ---- Library browser ------------------------------------------------------------------

let libs = [];
let crumbs = []; // [{ id, title, type }]
let page = { parentId: null, start: 0, total: 0 };

async function loadLibraries() {
  libs = await api("/libraries");
  const nav = $("libraries");
  nav.replaceChildren(
    ...libs.map((lib) => {
      const b = document.createElement("button");
      b.textContent = lib.title;
      b.dataset.id = lib.id;
      b.addEventListener("click", () => openFolder(lib, true));
      return b;
    }),
  );
  if (libs.length) openFolder(libs[0], true);
  else $("browse-note").textContent = "No video libraries found in Jellyfin.";
}

function markTab(id) {
  for (const b of $("libraries").children) b.classList.toggle("active", b.dataset.id === id);
}

function renderCrumbs() {
  const nav = $("crumbs");
  const parts = [];
  crumbs.forEach((c, i) => {
    if (i) parts.push(Object.assign(document.createElement("span"), { textContent: "›" }));
    const b = document.createElement("button");
    b.textContent = c.title;
    b.addEventListener("click", () => {
      crumbs = crumbs.slice(0, i);
      open(c);
    });
    parts.push(b);
  });
  nav.replaceChildren(...parts);
}

function open(item) {
  if (item.type === "Series") return openSeries(item);
  return openFolder(item);
}

async function openFolder(folder, isLibrary = false) {
  if (isLibrary) {
    crumbs = [];
    markTab(folder.id);
    $("search").value = "";
  }
  crumbs.push({ id: folder.id, title: folder.title, type: folder.type });
  renderCrumbs();
  $("episodes").hidden = true;
  $("grid").replaceChildren();
  page = { parentId: folder.id, start: 0, total: 0 };
  await loadPage();
}

async function loadPage() {
  const { items, total } = await api(`/browse/${page.parentId}?start=${page.start}`);
  page.start += items.length;
  page.total = total;
  $("grid").append(...items.map(card));
  $("more").hidden = page.start >= page.total;
  if (!total) $("grid").append(Object.assign(document.createElement("p"), { className: "muted", textContent: "Nothing here." }));
}

function card(item) {
  const b = document.createElement("button");
  b.className = `card${item.type === "Episode" || item.type === "Video" ? " wide" : ""}`;
  const poster = document.createElement("div");
  poster.className = "poster";
  if (item.image) poster.style.backgroundImage = `url("${imgUrl(item.id)}")`;
  else poster.textContent = item.playable ? "🎬" : "📁";
  const title = Object.assign(document.createElement("div"), { className: "card-title", textContent: item.title });
  const sub = Object.assign(document.createElement("div"), { className: "card-sub", textContent: item.subtitle });
  b.append(poster, title, sub);
  b.addEventListener("click", () => (item.playable ? showSheet(item) : open(item)));
  return b;
}

async function openSeries(series) {
  crumbs.push({ id: series.id, title: series.title, type: "Series" });
  renderCrumbs();
  $("grid").replaceChildren();
  $("more").hidden = true;
  const list = $("episodes");
  list.hidden = false;
  list.replaceChildren(Object.assign(document.createElement("li"), { className: "muted", textContent: "Loading…" }));
  const eps = await api(`/episodes/${series.id}`);
  let season = null;
  const rows = [];
  for (const ep of eps) {
    const s = ep.subtitle.slice(0, 3); // "S01"
    if (s !== season) {
      season = s;
      rows.push(Object.assign(document.createElement("li"), { className: "season", textContent: `Season ${Number(s.slice(1))}` }));
    }
    const li = document.createElement("li");
    const text = document.createElement("div");
    text.className = "ep-text";
    text.append(ep.subtitle);
    const small = Object.assign(document.createElement("div"), { className: "muted", textContent: formatTime(ep.duration / 1000) });
    text.append(small);
    li.append(text, ...itemButtons(ep));
    rows.push(li);
  }
  list.replaceChildren(...(rows.length ? rows : [Object.assign(document.createElement("li"), { textContent: "No episodes." })]));
}

function itemButtons(item) {
  if (!room?.canControl) return [];
  const play = Object.assign(document.createElement("button"), { textContent: "▶ Play", className: "primary" });
  play.addEventListener("click", () => startItem(item));
  const queue = Object.assign(document.createElement("button"), { textContent: "+ Queue" });
  queue.addEventListener("click", () => queueItem(item));
  return [play, queue];
}

let sheetItem = null;
function showSheet(item) {
  sheetItem = item;
  $("sheet-img").hidden = !item.image;
  if (item.image) $("sheet-img").src = imgUrl(item.id, 360);
  $("sheet-title").textContent = item.title;
  $("sheet-subtitle").textContent = item.subtitle;
  $("sheet-duration").textContent = item.duration ? formatTime(item.duration / 1000) : "";
  $("sheet-play").hidden = !room?.canControl;
  $("sheet-queue").hidden = !room?.canControl;
  $("sheet").hidden = false;
}

async function startItem(item) {
  $("sheet").hidden = true;
  await action({ action: "play", itemId: item.id });
}

async function queueItem(item) {
  $("sheet").hidden = true;
  await action({ action: "queue", itemId: item.id });
  toast(`Queued ${item.title}`);
}

let searchTimer;
$("search").addEventListener("input", (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => runSearch(e.target.value.trim()), 350);
});

async function runSearch(q) {
  if (!q) {
    const lib = libs.find((l) => l.id === crumbs[0]?.id) ?? libs[0];
    if (lib) openFolder(lib, true);
    return;
  }
  markTab(null);
  crumbs = [{ id: null, title: `Search: ${q}` }];
  renderCrumbs();
  $("episodes").hidden = true;
  $("more").hidden = true;
  const results = await api(`/search?q=${encodeURIComponent(q)}`);
  if ($("search").value.trim() !== q) return; // a newer search is running
  $("grid").replaceChildren(...results.map(card));
  if (!results.length) $("grid").append(Object.assign(document.createElement("p"), { className: "muted", textContent: "No matches." }));
}

// ---- Controls ------------------------------------------------------------------------

const playId = () => room?.current?.playId;

$("playpause").addEventListener("click", () =>
  action({ action: room.current.paused ? "resume" : "pause", playId: playId() }),
);
$("back10").addEventListener("click", () =>
  action({ action: "seek", position: (expectedSeconds() - 10) * 1000, playId: playId() }),
);
$("fwd30").addEventListener("click", () =>
  action({ action: "seek", position: (expectedSeconds() + 30) * 1000, playId: playId() }),
);
$("next").addEventListener("click", () => action({ action: "next", playId: playId() }));
$("stop").addEventListener("click", () => action({ action: "stop" }));

$("seek").addEventListener("input", (e) => {
  seeking = true;
  $("time").textContent = formatTime(Number(e.target.value));
});
$("seek").addEventListener("change", (e) => {
  seeking = false;
  action({ action: "seek", position: Number(e.target.value) * 1000, playId: playId() });
});

$("unmute").addEventListener("click", () => {
  video.muted = false;
  $("unmute").hidden = true;
  renderVolume();
  video.play().catch(() => {});
});
$("mute").addEventListener("click", () => {
  video.muted = !video.muted;
  $("unmute").hidden = true;
  renderVolume();
});
$("volume").addEventListener("input", (e) => {
  video.volume = Number(e.target.value);
  video.muted = video.volume === 0;
  $("unmute").hidden = true;
  renderVolume();
});
$("fullscreen").addEventListener("click", () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen?.().catch(() => {});
});

$("queue-toggle").addEventListener("click", () => ($("queue-panel").hidden = !$("queue-panel").hidden));
$("queue-close").addEventListener("click", () => ($("queue-panel").hidden = true));
$("to-browse").addEventListener("click", () => setView("browse"));
$("to-player").addEventListener("click", () => setView("player"));
$("more").addEventListener("click", loadPage);
$("sheet-close").addEventListener("click", () => ($("sheet").hidden = true));
$("sheet").addEventListener("click", (e) => e.target === $("sheet") && ($("sheet").hidden = true));
$("sheet-play").addEventListener("click", () => startItem(sheetItem));
$("sheet-queue").addEventListener("click", () => queueItem(sheetItem));

document.addEventListener("keydown", (e) => {
  if (view !== "player" || !room?.current || !room.canControl) return;
  if (e.target instanceof HTMLInputElement && e.target.type !== "range") return;
  if (e.code === "Space") {
    e.preventDefault();
    $("playpause").click();
  }
});

// Hide the player overlays when the mouse is idle.
let idleTimer;
function wake() {
  document.body.classList.remove("idle");
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if ($("queue-panel").hidden && view === "player") document.body.classList.add("idle");
  }, 3000);
}
for (const ev of ["mousemove", "pointerdown", "keydown", "touchstart"]) {
  document.addEventListener(ev, wake, { passive: true });
}

// ---- Start ---------------------------------------------------------------------------

(async () => {
  try {
    await signIn();
  } catch (err) {
    $("status").textContent = err.message;
    return;
  }
  setView("browse");
  await poll();
  loadLibraries().catch((err) => ($("browse-note").textContent = `Couldn't load libraries: ${err.message}`));
  setInterval(poll, POLL_MS);
  setInterval(renderProgress, 500);
})();
