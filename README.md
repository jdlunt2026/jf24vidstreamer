# jf24vidstreamer

A 24/7 "TV channel" from your Jellyfin library, as a **Discord Activity**.
Start it in a voice channel and everyone who joins sees the same movie or
episode at the same point, like live TV. It shuffles your library (or plays a
show in order), lets people skip and queue things, and keeps going forever.

It uses an official Discord application and the Embedded App SDK. No
self-bot, no user tokens, nothing against Discord's terms.

## How it works

```
 Discord voice channel
 ┌──────────────────────────────┐       ┌──────────────────────────────────┐
 │ Activity (web page in each    │       │ jf24 server (this repo, Node)    │
 │ viewer's Discord client)      │──────▶│  • schedule: what's on, since    │
 │  hls.js player, synced to the │ via   │    when; skip / queue            │
 │  schedule; skip / queue UI    │Discord│  • Discord OAuth                 │
 └──────────────────────────────┘ proxy  │  • relays Jellyfin HLS streams   │
                                         └───────────────┬──────────────────┘
                                                         │ LAN, API key stays here
                                                   ┌─────▼─────┐
                                                   │ Jellyfin  │
                                                   └───────────┘
```

- The server keeps a schedule ("item X started at 21:04:10"). It doesn't
  stream anything itself; it just knows what's on.
- When someone opens the Activity, it asks the server what's on and plays it
  from `now - startedAt`. Every viewer is in sync to within a second or two,
  and the player catches up on its own after buffering.
- Video comes from Jellyfin as HLS. Jellyfin sends the original video when the
  browser can play it (H.264 under `MAX_BITRATE_KBPS`) and transcodes
  otherwise. The server relays it and adds the Jellyfin API key, which never
  reaches viewers.
- When nobody is watching, nothing is streamed. The schedule keeps moving,
  so it's "live" whenever someone tunes in.

## Setup

You need:
- a PC that's always on and can reach Jellyfin (Windows, Linux or macOS)
- a way to give that PC a public HTTPS address: a Cloudflare Tunnel (needs a
  domain on Cloudflare) or Tailscale Funnel (free, no domain). See step 4.

### 1. Create the Discord application

1. Go to <https://discord.com/developers/applications> → **New Application**.
2. **OAuth2**: copy the **Client ID** and **Client Secret** (Reset Secret).
   Under Redirects, add `https://127.0.0.1` (a placeholder Discord requires;
   it's never used).
3. **Activities → Settings**: turn on **Enable Activities**. Choose the
   platforms you want (desktop/web, and mobile if you like).
4. **Activities → URL Mappings**: you'll fill this in at step 4.
5. **Installation**: use the install link to add the app to your server.

### 2. Get a Jellyfin API key

Jellyfin → Dashboard → API Keys → **+**.

### 3. Install and configure

**Windows:** download the repo to a permanent folder such as
`C:\jf24vidstreamer` and double-click **`windows\setup.cmd`**. It installs
Node.js (and, if you want, `cloudflared`) with `winget`, builds the app, and
opens `.env` in Notepad. Fill it in, then run **`windows\start.cmd`**.

**Linux / macOS:**

```sh
cp .env.example .env    # fill it in
npm ci
npm run build
npm start               # or: npm run supervised  (auto-restart + logs/server.log)
```

**Docker:** `docker build -t jf24 . && docker run -d --env-file .env -p 8080:8080 --restart unless-stopped jf24`

The server listens on `http://localhost:8080`. To check it before Discord is
involved, set `DEV_AUTH=true`, open that address in a browser, and you should
see the channel playing. Set it back to `false` before step 4.

### 4. Make the server reachable

Discord loads the Activity from its own domain and forwards requests to your
server through its proxy, so the server needs a public HTTPS address.
**Only expose the jf24 server (port 8080), not Jellyfin.**

**Option A: Cloudflare Tunnel** (needs a domain on Cloudflare)

1. Cloudflare dashboard → Zero Trust → Networks → Tunnels → **Create a
   tunnel** → Cloudflared. Name it `jf24`.
2. Copy the `cloudflared service install <token>` command it shows and run it
   in an admin terminal. On Windows this installs a service that starts with
   the PC.
3. Add a public hostname, e.g. `jf24.example.com` → service `http://localhost:8080`.

**Option B: Tailscale Funnel** (free, no domain)

Install Tailscale, then run `tailscale funnel --bg 8080`. It prints a fixed
address like `https://my-pc.tailnet-name.ts.net`.

Then in the Discord Developer Portal → **Activities → URL Mappings**, set the
root mapping: **PREFIX** `/` → **TARGET** `jf24.example.com` (your hostname,
without `https://`).

### 5. Watch

Join a voice channel → the rocket icon (**Activities**) → your app. Anyone in
the channel can join from the same menu.

If friends can't find the app in the Activities list, Discord may only show
unverified apps to the owner and testers. Add them in the Developer Portal
under **App Testers**.

### Start automatically on Windows

Run **`windows\autostart.cmd`**. It asks for admin rights and registers a
Task Scheduler task, `jf24vidstreamer`, that starts the server at boot even
if nobody logs in. The supervisor restarts it if it crashes, and logs go to
`logs\server.log`.

- Stop it: Task Scheduler → `jf24vidstreamer` → End
- Remove it: `windows\autostart.cmd -Uninstall`
- After editing `.env`, restart the task (End, then Run).

Keep the PC from sleeping (Settings → System → Power → Sleep: Never).

## Using it

- **Up next**: shows the next 10 items.
- **Skip**: moves the whole channel to the next item, for everyone.
- **Add to queue**: search your library and queue something to play next.
- `CONTROL_USER_IDS` in `.env` limits Skip and Queue to specific Discord
  users (turn on Developer Mode in Discord, right-click a user → Copy User
  ID). Leave it empty to let everyone use them.
- Browsers may block autoplay with sound. The player then starts muted and
  shows **Click to unmute**.

## Choosing what plays

- `JELLYFIN_PARENT_IDS` limits playback to libraries, folders, series,
  collections or playlists. Open the item in Jellyfin's web UI; the ID is the
  `id=` value in the URL. You can list several, separated by commas.
- `JELLYFIN_ITEM_TYPES` defaults to `Movie,Episode`. Add `MusicVideo` or
  `Video` (home videos) if you want those.
- `JELLYFIN_ORDER=random` shuffles. To play a series in order, set the series
  ID as the parent and use
  `JELLYFIN_ORDER=SeriesSortName,ParentIndexNumber,IndexNumber`.

When the list runs out it's fetched again (and reshuffled), so it loops forever.

## Bandwidth and transcoding

- Every viewer pulls their own stream: your **upload** needs about
  `MAX_BITRATE_KBPS × viewers`. Lower `MAX_BITRATE_KBPS` (and `MAX_HEIGHT`)
  if viewers buffer.
- Files that are already H.264 and under the bitrate limit are sent as-is
  (cheap). Anything else (HEVC, AV1, high bitrate) is transcoded by Jellyfin,
  once per viewer. Turn on hardware acceleration in Jellyfin (Dashboard →
  Playback → Transcoding) if you have a GPU.
- Video for the Activity passes through Discord's proxy. Discord doesn't
  publish limits for this; if playback stutters for everyone, try a lower
  `MAX_BITRATE_KBPS`.

## Development

```sh
DEV_AUTH=true npm run dev     # server on :8080, restarts on changes
npm run dev:client            # client with hot reload on :5173
```

Inside Discord, the client sends API and media requests through
`/.proxy/...`. The server accepts paths with or without that prefix.

## Limitations

- No subtitles yet. Only the default audio track plays.
- The schedule lives in memory. Restarting the server starts a new item.
- One channel per server. All Activity instances watch the same schedule.
