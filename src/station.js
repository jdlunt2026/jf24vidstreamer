import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import { Encoders, playStream } from "@dank074/discord-video-stream";

/**
 * Keeps one Discord stream alive forever and feeds it item after item.
 *
 * Pipeline:
 *
 *   feeder ffmpeg (one per item, encodes to a fixed WxH/fps H.264 + Opus,
 *   shifted by -output_ts_offset so timestamps keep counting up)
 *        │  MPEG-TS, written into a shared PassThrough that never ends
 *        ▼
 *   remux ffmpeg (one per session, -c copy, MPEG-TS -> NUT)
 *        ▼
 *   playStream()  ->  Discord Go Live / camera
 *
 * Because playStream only ever sees one continuous input, the Go Live never
 * stops between items and viewers don't get kicked out of the stream.
 */
export class Station extends EventEmitter {
  /**
   * @param {object} opts
   * @param {import("@dank074/discord-video-stream").Streamer} opts.streamer
   * @param {() => Promise<void>} opts.connect  joins the voice channel
   * @param {() => Promise<{title: string, input: string, headers?: Record<string,string>, hasAudio: boolean, item?: any}>} opts.next
   * @param {object} opts.stream  config.stream
   * @param {typeof playStream} [opts.play]  override for testing
   */
  constructor({ streamer, connect, next, stream, play = playStream }) {
    super();
    this.play = play;
    this.streamer = streamer;
    this.connect = connect;
    this.next = next;
    this.cfg = stream;
    this.height = even(stream.height);
    this.width = even((stream.height * 16) / 9);
    this.current = null;
    this.stopped = false;
    this.feeder = null;
    this.session = null;
  }

  /** Runs forever; restarts the whole pipeline after any failure. */
  async run() {
    let backoff = 5;
    while (!this.stopped) {
      const started = Date.now();
      try {
        await this.runSession();
      } catch (err) {
        if (!this.stopped) this.emit("log", `Stream session ended: ${err?.message ?? err}`);
      }
      if (this.stopped) break;
      // Reset backoff if the session ran for a while; otherwise back off up to 2 min.
      backoff = Date.now() - started > 60_000 ? 5 : Math.min(backoff * 2, 120);
      this.emit("log", `Restarting stream in ${backoff}s`);
      await sleep(backoff * 1000);
    }
  }

  skip() {
    const feeder = this.feeder;
    if (!feeder) return;
    // SIGINT lets ffmpeg flush what it already encoded, so the next item's
    // timestamps line up exactly; SIGKILL if it doesn't exit promptly.
    feeder.kill("SIGINT");
    setTimeout(() => feeder.exitCode === null && feeder.kill("SIGKILL"), 5000).unref();
  }

  /** Tears down the current session; run() will start a new one. */
  restart() {
    this.session?.abort(new Error("Restart requested"));
  }

  stop() {
    this.stopped = true;
    this.restart();
  }

  async runSession() {
    const session = new AbortController();
    this.session = session;
    const { signal } = session;

    await this.connect();
    signal.throwIfAborted();

    const feed = new PassThrough({ highWaterMark: 1 << 20 });
    const remux = spawn(
      "ffmpeg",
      [
        "-hide_banner", "-loglevel", "error", "-nostats",
        "-f", "mpegts", "-probesize", "5M", "-analyzeduration", "5M",
        "-i", "pipe:0",
        "-map", "0:v:0", "-map", "0:a:0",
        "-c", "copy",
        "-f", "nut", "pipe:1",
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    remux.stderr.on("data", (d) => this.emit("log", `[remux] ${d.toString().trim()}`));
    remux.stdin.on("error", () => {});
    feed.pipe(remux.stdin);
    remux.once("exit", (code) => session.abort(new Error(`remux ffmpeg exited (${code})`)));

    const play = this.play(
      remux.stdout,
      this.streamer,
      {
        type: this.cfg.type,
        width: this.width,
        height: this.height,
        frameRate: this.cfg.frameRate,
      },
      signal,
    );
    play.then(
      () => session.abort(new Error("Discord stream ended")),
      (err) => session.abort(err),
    );

    try {
      let offset = 0;
      while (!signal.aborted) {
        offset = await this.feedOne(feed, offset, signal);
      }
    } finally {
      this.current = null;
      this.feeder?.kill("SIGKILL");
      feed.unpipe();
      remux.stdin.destroy();
      remux.kill("SIGKILL");
      this.streamer.stopStream();
    }
    throw signal.reason;
  }

  /** Plays one item into the feed. Returns the timestamp offset for the next one. */
  async feedOne(feed, offset, signal) {
    let entry;
    try {
      entry = await Promise.race([
        this.next(),
        new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })),
      ]);
    } catch (err) {
      if (signal.aborted) return offset;
      this.emit("log", `Couldn't get next item: ${err?.message ?? err}`);
      await sleep(15_000, undefined, { signal }).catch(() => {});
      return offset;
    }
    if (signal.aborted) return offset;

    const args = this.feederArgs(entry, offset);
    const feeder = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe", "pipe"] });
    this.feeder = feeder;
    this.current = { ...entry, startedAt: Date.now() };
    this.emit("nowPlaying", this.current);

    let outTime = 0;
    let stderr = "";
    feeder.stdio[3].on("data", (chunk) => {
      for (const m of chunk.toString().matchAll(/out_time_us=(\d+)/g)) {
        outTime = Math.max(outTime, Number(m[1]) / 1e6);
      }
    });
    feeder.stderr.on("data", (d) => {
      stderr = (stderr + d.toString()).slice(-2000);
    });
    feeder.stdout.pipe(feed, { end: false });

    const code = await new Promise((resolve) => feeder.once("close", resolve));
    feeder.stdout.unpipe(feed);
    this.feeder = null;

    if (code !== 0 && !signal.aborted && outTime < 1) {
      this.emit("log", `Failed to play "${entry.title}" (ffmpeg exit ${code}):\n${stderr.trim()}`);
      // Avoid hammering the server if everything is failing.
      await sleep(3000, undefined, { signal }).catch(() => {});
    }
    // out_time is the last frame's timestamp; leave a few frames of headroom
    // so timestamps never go backwards between items.
    return offset + outTime + 0.1;
  }

  feederArgs(entry, offset) {
    const c = this.cfg;
    const { width: W, height: H } = this;
    const encoderFactory =
      c.encoder === "nvenc"
        ? Encoders.nvenc({ preset: "p4" })
        : c.encoder === "vaapi"
          ? Encoders.vaapi()
          : Encoders.software({ x264: { preset: c.preset }, x265: { preset: c.preset } });
    const enc = encoderFactory(c.bitrateVideo, c.bitrateVideoMax)[c.codec];
    if (!enc) throw new Error(`Encoder "${c.encoder}" doesn't support ${c.codec}`);
    const split = (opts = []) => opts.flatMap((o) => o.split(/\s+/)).filter(Boolean);

    const args = ["-hide_banner", "-loglevel", "error", "-nostats"];
    args.push(...split(enc.globalOptions));
    if (c.hardwareDecoding) args.push("-hwaccel", "auto");
    if (/^https?:/.test(entry.input)) {
      if (entry.headers) {
        const headers = Object.entries(entry.headers).map(([k, v]) => `${k}: ${v}\r\n`).join("");
        args.push("-headers", headers);
      }
      args.push("-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "30");
    }
    args.push("-i", entry.input);
    if (!entry.hasAudio) {
      args.push("-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo");
    }

    const vf = [
      `scale=${W}:${H}:force_original_aspect_ratio=decrease`,
      `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2`,
      "setsar=1",
      `fps=${c.frameRate}`,
      "format=yuv420p",
      ...(enc.outFilters ?? []),
    ].join(",");

    args.push(
      "-map", "0:v:0",
      "-map", entry.hasAudio ? "0:a:0" : "1:a:0",
      ...(entry.hasAudio ? [] : ["-shortest"]),
      "-sn", "-dn",
      "-vf", vf,
      "-c:v", enc.name, ...split(enc.options),
      "-b:v", `${c.bitrateVideo}k`,
      "-maxrate:v", `${c.bitrateVideoMax}k`,
      "-bufsize:v", `${Math.round(c.bitrateVideo / 2)}k`,
      "-bf", "0",
      "-g", String(c.frameRate),
      "-force_key_frames", "expr:gte(t,n_forced*1)",
      "-c:a", "libopus", "-b:a", `${c.bitrateAudio}k`, "-ar", "48000", "-ac", "2",
      "-lfe_mix_level", "1",
      "-output_ts_offset", offset.toFixed(3),
      "-muxdelay", "0", "-muxpreload", "0",
      "-progress", "pipe:3",
      "-f", "mpegts", "pipe:1",
    );
    return args;
  }
}

function even(n) {
  return Math.round(n / 2) * 2;
}
