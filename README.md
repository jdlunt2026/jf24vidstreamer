# jf24vidstreamer

Streams video from a Jellyfin server into a Discord voice channel, nonstop. It
shuffles through your library (or plays a show or playlist in order), plays
`!play` requests first, and rejoins on its own after a disconnect.

> [!WARNING]
> **This runs on a regular Discord user account, not a bot account.**
> Discord's bot API can't send video (Go Live or camera); bots only get audio.
> Every working video-streaming bot is a "selfbot" that automates a user
> account, which is against Discord's Terms of Service. The account can be
> banned. **Use a throwaway alt account**, never your main one.

## How it works

```
Jellyfin /Videos/{id}/stream?static=true   (original file, no server transcode)
   │
   ▼  feeder ffmpeg, one per item: scale/letterbox to fixed size, H.264 + Opus,
   │  timestamps shifted so they keep counting up across items
   ▼  MPEG-TS into one never-ending pipe
remux ffmpeg (copy, MPEG-TS → NUT)
   ▼
@dank074/discord-video-stream playStream()  →  Discord Go Live
```

Discord only ever sees one continuous stream, so the Go Live never ends
between episodes and viewers don't get kicked out of it. If anything breaks
(network, Discord voice, ffmpeg), the whole pipeline restarts with backoff.

## Setup

The steps below are the same on every OS. On Windows, follow
[Running on Windows](#running-on-windows) instead of step 4.

Requirements: Node.js 22+ and `ffmpeg` on `PATH` (or use Docker).

1. **Discord account:** create an alt account and add it to your server.
   Get its token: log in at discord.com in a browser, open DevTools → Network,
   and copy the `Authorization` header from any request to `/api`.
   Turn on Developer Mode (Settings → Advanced), then right-click to copy the
   server ID, the voice channel ID, and your own user ID.
2. **Jellyfin:** Dashboard → API Keys → create one.
3. `cp .env.example .env` and fill it in.
4. Run it:

   ```sh
   npm install
   npm start
   ```

   or with Docker:

   ```sh
   docker compose up -d --build
   ```

## Running on Windows

Works on Windows 10/11 x64. Download the repo (Code → Download ZIP, or
`git clone`), unzip it somewhere permanent such as `C:\jf24vidstreamer`, then:

1. **Run `windows\setup.cmd`** (double-click it). It:
   - installs Node.js LTS and FFmpeg with `winget` if they're missing (FFmpeg
     is Gyan's full build, which includes NVENC, Quick Sync and AMF),
   - runs `npm ci`,
   - creates `.env`, writes FFmpeg's full path into it, lists the GPU
     encoders your FFmpeg supports, and opens `.env` in Notepad.
2. **Fill in `.env`** (steps 1–3 above) and save it.
3. **Run `windows\start.cmd`.** The bot streams while that window is open.
   It restarts automatically if it crashes. Output also goes to `logs\bot.log`.
   Press Ctrl+C to stop.
4. **Optional: run it in the background at boot** with
   `windows\autostart.cmd`. It asks for admin rights, then registers a Task
   Scheduler task named `jf24vidstreamer` that starts when Windows boots,
   even if nobody logs in. Logs go to `logs\bot.log`.
   - Stop: Task Scheduler → `jf24vidstreamer` → End, or
     `Stop-ScheduledTask jf24vidstreamer` in an admin PowerShell
   - Remove: `windows\autostart.cmd -Uninstall`
   - After editing `.env`, restart the task (End, then Run) to apply it.

**GPU encoding on Windows:** set `STREAM_ENCODER` to `nvenc` (NVIDIA),
`qsv` (Intel iGPU/Arc) or `amf` (AMD Radeon) to keep CPU use low. Use
`STREAM_HW_DECODE=true` to also decode on the GPU. If the stream doesn't start,
`logs\bot.log` shows the FFmpeg error; switch back to `software` to check.

**Firewall:** the first run may show a Windows Firewall prompt for Node.js.
Allow it on private networks. It needs outbound UDP to reach Discord voice.

Keep the PC from sleeping (Settings → System → Power → Sleep: Never), or the
stream stops when it sleeps.

## Commands

Commands only work for user IDs listed in `ALLOWED_USER_IDS`. They can be sent
in any channel the account can see, or in a DM to it.

| Command | |
|---|---|
| `!np` | What's playing |
| `!skip` | Next item |
| `!play <search>` | Queue the best match to play next |
| `!queue` | Next 10 items |
| `!reload` | Re-fetch and reshuffle the library |
| `!restart` | Rejoin voice and restart the stream |
| `!help` | List commands |

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

## Performance

Each item is transcoded in real time on the machine running this, not on the
Jellyfin server. With the defaults (720p30, x264 `veryfast`), one modern
CPU core is about enough. For 1080p, or on weak hardware:

- NVIDIA GPU: `STREAM_ENCODER=nvenc`
- Intel GPU: `STREAM_ENCODER=qsv` (Windows or Linux)
- AMD GPU on Windows: `STREAM_ENCODER=amf`
- Intel/AMD GPU on Linux: `STREAM_ENCODER=vaapi` (pass `/dev/dri` into
  Docker; see `docker-compose.yml`)
- Or lower `STREAM_PRESET` to `superfast`/`ultrafast`

Discord limits what viewers see: non-Nitro accounts are capped at 720p30, and
higher settings need Nitro on the streaming account.

## Limitations

- Subtitles aren't burned in. Only the first audio track plays.
- No pause or seek. `!skip` and `!play` are the controls.
- Run one instance per account. A user account can only be in one voice
  channel at a time.
