// Checks that the Discord app has the "Entry Point" command Discord uses to
// list an Activity in the Activities / App Launcher menu, and creates it if
// it's missing. Enabling Activities normally creates it, but not always.
//
//   DISCORD_BOT_TOKEN=... node server/check-discord.js
//   (on Windows, just double-click windows\check-discord.cmd)
//
// The bot token is under Developer Portal -> your app -> Bot -> Reset Token.
// It's only used for this one-off check; you don't need to keep it anywhere.

import "dotenv/config";

const clientId = process.env.DISCORD_CLIENT_ID?.trim();
const token = (process.env.DISCORD_BOT_TOKEN ?? process.argv[2] ?? "").trim();
if (!clientId || !token) {
  console.error("Usage: set DISCORD_CLIENT_ID in .env, then run:");
  console.error("  node server/check-discord.js <bot token>");
  process.exit(1);
}

if (/^\d{17,20}$/.test(token)) {
  console.error("That looks like an application/client ID, not a bot token.");
  console.error("Get the token from Developer Portal -> your app -> Bot -> Reset Token.");
  console.error("It's a long string with two dots in it.");
  process.exit(1);
}

const API = "https://discord.com/api/v10";
const headers = { Authorization: `Bot ${token}`, "Content-Type": "application/json" };

async function call(method, path, body) {
  const res = await fetch(`${API}${path}`, { method, headers, body: body && JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path} -> HTTP ${res.status}: ${JSON.stringify(data)}`);
  return data;
}

const app = await call("GET", "/applications/@me");
console.log(`App: ${app.name} (${app.id})`);
if (app.id !== clientId) {
  console.log(`!! DISCORD_CLIENT_ID in .env is ${clientId}, but this token belongs to app ${app.id}.`);
}

// Application flag EMBEDDED (1 << 17) marks an app with Activities enabled.
const embedded = Boolean(app.flags & (1 << 17));
console.log(
  `Activities enabled: ${embedded ? "yes" : "probably not - check Developer Portal -> Activities -> Settings"}`,
);

if (!embedded) {
  console.log(`
Turn Activities on first, then run this again:
  1. Developer Portal -> ${app.name} -> Activities -> URL Mappings:
     PREFIX "/"  ->  TARGET your tunnel hostname (e.g. jf24.example.com, no https://)
  2. Activities -> Settings -> turn on "Enable Activities" and save.
Enabling Activities normally creates the launch command by itself.`);
  process.exit(1);
}

const commands = await call("GET", `/applications/${app.id}/commands`);
const entry = commands.find((c) => c.type === 4);
if (entry) {
  console.log(`Entry Point command: present ("${entry.name}")`);
} else {
  console.log("Entry Point command: missing, creating it...");
  const created = await call("POST", `/applications/${app.id}/commands`, {
    name: "launch",
    description: "Watch something together",
    type: 4, // PRIMARY_ENTRY_POINT
    handler: 2, // DISCORD_LAUNCH_ACTIVITY
    integration_types: [0, 1], // server install, user install
    contexts: [0, 1, 2], // servers, bot DMs, group DMs
  });
  console.log(`Created Entry Point command "${created.name}".`);
}

console.log("\nNext: fully restart Discord (Ctrl+R on desktop), join a voice channel,");
console.log("click the rocket icon (Activities), and search for the app's name.");
