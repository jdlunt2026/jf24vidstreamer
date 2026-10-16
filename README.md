# jf24vidstreamer

Watch your Jellyfin library together in Discord. Start the **Activity** in a
voice channel, browse your movies and shows, pick something, and everyone in
the Activity watches it in sync. Pause, seek, queue up the next episode, or
stop and pick something else, and it happens for everyone.

It uses an official Discord application and the Embedded App SDK. No
self-bot, no user tokens, nothing against Discord's terms.

## How it works

```
 Discord voice channel
 ┌──────────────────────────────┐       ┌──────────────────────────────────┐
 │ Activity (web page in each    │       │ jf24 server (this repo, Node)    │
 │ viewer's Discord client)      │──────▶│  • rooms: what's playing, where, │
 │  library browser, hls.js      │ via   │    paused?, queue, who's here    │
 │  player kept in sync with the │Discord│  • library browsing + posters    │
 │  room; play/pause/seek/queue  │ proxy │  • Discord OAuth                 │
 └──────────────────────────────┘       │  • relays Jellyfin HLS streams   │
                                         └───────────────┬──────────────────┘
                                                         │ LAN, API key stays here
                                                   ┌─────▼─────┐
                                                   │ Jellyfin  │
                                                   └───────────┘
```

- Each Activity launch (one per voice channel) is a **room**. Different voice
  channels can watch different things at the same time.
- The room holds a shared clock: what's playing, its position, and whether
  it's paused. Every viewer's player follows that clock, so play, pause and
  seek apply to everyone, and anyone who joins late lands at the right spot.
- Video comes from Jellyfin as HLS. Jellyfin sends the original video when the
  browser can play it (H.264 under `MAX_BITRATE_KBPS`) and transcodes
  otherwise. The server relays it and adds the Jellyfin API key, which never
  reaches viewers.
- If everyone leaves, playback pauses after a minute and picks up where it
  was when someone comes back.

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
see your libraries. Set it back to `false` before step 4.

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

If **you** can't find the app in the Activities list, run
**`windows\check-discord.cmd`** (or `npm run check-discord -- <bot token>` from the project folder). The bot token is under Developer Portal → Bot → Reset Token; it is not the application ID.
It checks that Activities are on and creates the "Entry Point" command Discord
needs to list the app, if it's missing. Then restart Discord (Ctrl+R).

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

- **Browse**: library tabs at the top, then posters. Click a show to see its
  episodes, or use **Search**.
- Click a movie (or **▶ Play** on an episode) → **Play now** starts it for
  everyone in the Activity. **+ Queue** adds it to **Up next**.
- **Player controls** (shared): play/pause (or Space), back 10 s, forward 30 s,
  drag the progress bar, **Next** (plays the next queued item), **Stop** (back
  to the library). When something ends, the next queued item starts.
- **Browse** while watching to queue more; the video keeps playing. **Back to
  video** returns to it.
- Volume, mute and fullscreen are per viewer.
- `CONTROL_USER_IDS` in `.env` limits who can pick things and control playback
  (turn on Developer Mode in Discord, right-click a user → Copy User ID).
  Everyone else can browse and watch. Leave it empty to let everyone control.
- Browsers may block autoplay with sound. The player then starts muted and
  shows **Click to unmute**.

## Choosing what's offered

- By default the browser shows all of Jellyfin's video libraries (music,
  books and photos are hidden).
- `JELLYFIN_USER_ID` (a username or ID) shows only what that Jellyfin user
  can see, including their parental controls.
- `JELLYFIN_PARENT_IDS` replaces the library tabs with specific libraries,
  folders or collections. Open it in Jellyfin's web UI; the ID is the `id=`
  value in the URL. List several separated by commas.

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

With `DEV_AUTH=true`, `http://localhost:8080/?room=name` opens a given room;
open it in two windows to test syncing.

Inside Discord, the client sends API and media requests through
`/.proxy/...`. The server accepts paths with or without that prefix.

## Limitations

- No subtitles yet. Only the default audio track plays.
- Rooms live in memory. Restarting the server stops whatever was playing.
- No resume points or watched markers are sent back to Jellyfin.
