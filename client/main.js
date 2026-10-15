import { DiscordSDK } from "@discord/embedded-app-sdk";
import Hls from "hls.js";

// Inside Discord the page is served from <client_id>.discordsays.com, and
// requests to our own server go through Discord's proxy under /.proxy.
const inDiscord = new URLSearchParams(location.search).has("frame_id");
const BASE = inDiscord ? "/.proxy" : "";

const POLL_MS = 4000;
const MAX_DRIFT_S = 4;

const $ = (id) => document.getElementById(id);
const video = $("video");

let session = null;
let discord = null;
let clockOffset = 0; // server time - local time (ms)
let state = null;
let playing = null; // { id, playSessionId }
let hls = null;

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
    session = (await api("/dev-login", { method: "POST" })).session;
  } else {
    throw new Error("Open this from a Discord voice channel (Activities).");
  }
}

// ---- Sync -------------------------------------------------------------------------

function serverNow() {
  return Date.now() + clockOffset;
}

function elapsedSeconds(cur) {
  return Math.max(0, (serverNow() - cur.startedAt) / 1000);
}

async function poll() {
  try {
    const sent = Date.now();
    const next = await api("/state");
    const received = Date.now();
    // Assume the server answered halfway through the round trip.
    clockOffset = next.now - (sent + received) / 2;
    state = next;
    $("status").textContent = state.current ? "" : "Waiting for Jellyfin…";
    render();
    sync();
  } catch (err) {
    $("status").textContent = `Can't reach the server: ${err.message}`;
  }
}

function sync() {
  const cur = state?.current;
  if (!cur) return stop();
  if (playing?.id !== cur.id) return load(cur);

  // Same item: pull back in line if we drifted (buffering, slow network…).
  const expected = elapsedSeconds(cur);
  if (!video.seeking && video.readyState >= 2 && Math.abs(video.currentTime - expected) > MAX_DRIFT_S) {
    video.currentTime = expected;
  }
}

// ---- Player -------------------------------------------------------------------------

function stop() {
  if (playing) {
    api("/stop", { method: "POST", body: { playSessionId: playing.playSessionId } }).catch(() => {});
  }
  hls?.destroy();
  hls = null;
  video.removeAttribute("src");
  video.load();
  playing = null;
}

function load(cur) {
  stop();
  const playSessionId = crypto.randomUUID().replaceAll("-", "");
  playing = { id: cur.id, playSessionId };
  const src = `${BASE}/media/${session}/${cur.id}/master.m3u8?ps=${playSessionId}`;

  if (Hls.isSupported()) {
    hls = new Hls({ startPosition: elapsedSeconds(cur), maxBufferLength: 30 });
    let recoveries = 0;
    hls.on(Hls.Events.ERROR, (_e, data) => {
      if (!data.fatal) return;
      if (data.type === Hls.ErrorTypes.MEDIA_ERROR && recoveries++ < 3) {
        hls.recoverMediaError();
      } else {
        console.warn("Playback failed, reloading", data);
        $("status").textContent = "Playback error, retrying…";
        setTimeout(() => {
          $("status").textContent = "";
          if (playing?.playSessionId === playSessionId) load(state.current);
        }, 3000);
      }
    });
    hls.loadSource(src);
    hls.attachMedia(video);
  } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
    // Safari / iOS WebView without MSE: native HLS.
    video.src = src;
    video.addEventListener("loadedmetadata", () => (video.currentTime = elapsedSeconds(cur)), { once: true });
  } else {
    $("status").textContent = "This device can't play HLS video.";
    return;
  }
  play();
  updatePresence(cur);
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

video.addEventListener("ended", () => setTimeout(poll, 500));

function updatePresence(cur) {
  discord?.commands
    .setActivity({
      activity: {
        type: 3, // "Watching"
        details: cur.title,
        state: cur.subtitle || undefined,
        timestamps: { start: cur.startedAt, end: cur.startedAt + cur.duration },
      },
    })
    .catch(() => {});
}

// ---- UI --------------------------------------------------------------------------------

function formatTime(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

function render() {
  const cur = state?.current;
  $("np-title").textContent = cur?.title ?? "";
  $("np-subtitle").textContent = cur?.subtitle ?? "";
  $("skip").hidden = !state?.canControl;
  $("search").hidden = !state?.canControl;

  const list = $("upnext");
  list.replaceChildren(
    ...(state?.upNext ?? []).map((item) => {
      const li = document.createElement("li");
      li.textContent = item.title;
      if (item.subtitle) {
        const small = document.createElement("small");
        small.textContent = item.subtitle;
        li.append(small);
      }
      return li;
    }),
  );
  renderProgress();
}

function renderProgress() {
  const cur = state?.current;
  if (!cur) return;
  const elapsed = Math.min(serverNow() - cur.startedAt, cur.duration);
  $("np-bar").style.width = `${(elapsed / cur.duration) * 100}%`;
  $("np-time").textContent = `${formatTime(elapsed)} / ${formatTime(cur.duration)}`;
}

function renderVolume() {
  $("mute").textContent = video.muted || video.volume === 0 ? "🔇" : "🔊";
  $("volume").value = video.muted ? 0 : video.volume;
}

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

$("panel-toggle").addEventListener("click", () => {
  $("panel").hidden = !$("panel").hidden;
});
$("panel-close").addEventListener("click", () => {
  $("panel").hidden = true;
});

$("skip").addEventListener("click", async () => {
  $("skip").disabled = true;
  try {
    await api("/skip", { method: "POST", body: { id: state?.current?.id } });
    await poll();
  } finally {
    $("skip").disabled = false;
  }
});

let searchTimer;
$("search-input").addEventListener("input", (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => search(e.target.value), 300);
});
$("search").addEventListener("submit", (e) => {
  e.preventDefault();
  search($("search-input").value);
});

async function search(q) {
  const results = q.trim() ? await api(`/search?q=${encodeURIComponent(q)}`).catch(() => []) : [];
  $("results").replaceChildren(
    ...results.map((item) => {
      const li = document.createElement("li");
      const label = document.createElement("span");
      label.textContent = item.subtitle ? `${item.title} (${item.subtitle})` : item.title;
      const add = document.createElement("button");
      add.type = "button";
      add.textContent = "Queue";
      add.addEventListener("click", async () => {
        add.disabled = true;
        try {
          const { position } = await api("/queue", { method: "POST", body: { id: item.id } });
          add.textContent = `#${position}`;
          await poll();
        } catch (err) {
          add.textContent = err.message;
        }
      });
      li.append(label, add);
      return li;
    }),
  );
}

// Hide the overlays when the mouse is idle.
let idleTimer;
function wake() {
  document.body.classList.remove("idle");
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if ($("panel").hidden) document.body.classList.add("idle");
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
  wake();
  await poll();
  setInterval(poll, POLL_MS);
  setInterval(renderProgress, 1000);
})();
