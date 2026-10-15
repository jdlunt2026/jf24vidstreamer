import { Client } from "@lng2004/discord.js-selfbot-v13";
import { Streamer } from "@dank074/discord-video-stream";
import { config } from "./config.js";
import {
  authHeaders,
  buildPlaylist,
  describe,
  formatTicks,
  hasAudio,
  searchItems,
  streamUrl,
} from "./jellyfin.js";
import { Station } from "./station.js";

const log = (...args) => console.log(new Date().toISOString(), ...args);

const streamer = new Streamer(new Client());
const client = streamer.client;

let playlist = [];
const requests = []; // items queued with !play, played before the playlist

async function nextEntry() {
  let item = requests.shift();
  if (!item) {
    if (!playlist.length) {
      playlist = await buildPlaylist();
      log(`Loaded ${playlist.length} items from Jellyfin`);
      if (!playlist.length) throw new Error("Jellyfin returned no items; check JELLYFIN_PARENT_IDS / JELLYFIN_ITEM_TYPES");
    }
    item = playlist.shift();
  }
  return {
    item,
    title: describe(item),
    input: streamUrl(item),
    headers: authHeaders,
    hasAudio: await hasAudio(item).catch(() => true),
  };
}

// Called at the start of every stream session. Always rejoins from scratch,
// since a session usually restarts because the old connection broke.
async function connect() {
  const { guildId, channelId } = config.discord;
  streamer.leaveVoice();
  log(`Joining voice channel ${channelId}`);
  await streamer.joinVoice(guildId, channelId);
}

const station = new Station({ streamer, connect, next: nextEntry, stream: config.stream });

station.on("log", (msg) => log(msg));
station.on("nowPlaying", ({ title }) => {
  log(`Now playing: ${title}`);
  if (config.setStatus) {
    client.user?.setActivity(title, { type: "WATCHING" });
  }
});

const commands = {
  async help(msg) {
    const p = config.discord.commandPrefix;
    await msg.reply(
      [
        `\`${p}np\` - what's playing`,
        `\`${p}skip\` - skip to the next item`,
        `\`${p}play <search>\` - queue a movie/episode to play next`,
        `\`${p}queue\` - show what's coming up`,
        `\`${p}reload\` - re-fetch and reshuffle the library`,
        `\`${p}restart\` - reconnect and restart the stream`,
      ].join("\n"),
    );
  },

  async np(msg) {
    const cur = station.current;
    if (!cur) return msg.reply("Nothing is playing right now.");
    const elapsed = (Date.now() - cur.startedAt) * 10_000;
    await msg.reply(`Now playing: **${cur.title}** (${formatTicks(elapsed)} / ${formatTicks(cur.item.RunTimeTicks)})`);
  },

  async skip(msg) {
    const title = station.current?.title;
    station.skip();
    await msg.reply(title ? `Skipped **${title}**.` : "Skipping.");
  },

  async play(msg, args) {
    if (!args) return msg.reply("Usage: `play <search>`");
    const results = await searchItems(args, 1);
    if (!results.length) return msg.reply(`Nothing found for "${args}".`);
    requests.push(results[0]);
    await msg.reply(`Queued **${describe(results[0])}** (position ${requests.length}).`);
  },

  async queue(msg) {
    const upcoming = [...requests, ...playlist].slice(0, 10).map((item, i) => `${i + 1}. ${describe(item)}`);
    await msg.reply(upcoming.length ? upcoming.join("\n") : "Queue is empty; the library will be reloaded next.");
  },

  async reload(msg) {
    playlist = await buildPlaylist();
    await msg.reply(`Reloaded ${playlist.length} items.`);
  },

  async restart(msg) {
    station.restart();
    await msg.reply("Restarting the stream.");
  },
};

client.on("messageCreate", async (msg) => {
  const { commandPrefix, allowedUserIds } = config.discord;
  if (!msg.content.startsWith(commandPrefix)) return;
  if (!allowedUserIds.has(msg.author.id)) return;

  const [name, ...rest] = msg.content.slice(commandPrefix.length).trim().split(/\s+/);
  const command = commands[name?.toLowerCase()];
  if (!command) return;
  try {
    await command(msg, rest.join(" "));
  } catch (err) {
    log(`Command ${name} failed:`, err);
    await msg.reply(`Error: ${err.message}`).catch(() => {});
  }
});

client.once("ready", () => {
  log(`Logged in as ${client.user.tag}`);
  station.run();
});

// If someone drags the account out of the channel or the voice connection drops,
// restart the session so it rejoins.
client.on("voiceStateUpdate", (oldState, newState) => {
  if (newState.id !== client.user?.id) return;
  if (oldState.channelId && newState.channelId !== config.discord.channelId) {
    log("Left the configured voice channel; restarting stream");
    station.restart();
  }
});

// SIGBREAK = Ctrl+Break on Windows, SIGHUP = console window closed.
for (const sig of ["SIGINT", "SIGTERM", "SIGBREAK", "SIGHUP"]) {
  process.on(sig, () => {
    log("Shutting down");
    station.stop();
    streamer.leaveVoice();
    client.destroy();
    process.exit(0);
  });
}

process.on("unhandledRejection", (err) => log("Unhandled rejection:", err));

client.login(config.discord.token).catch((err) => {
  log(`Discord login failed: ${err.message}`);
  process.exit(1);
});
