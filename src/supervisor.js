// Runs the bot as a child process, restarts it if it exits, and copies its
// output to the console and to a log file. Used by windows\start.cmd and the
// auto-start task, but works on any OS:  node src/supervisor.js [logfile]
//
// On Windows, Node puts child processes in a job object that is killed with
// the parent, so stopping this process also stops the bot and its ffmpegs.

import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const logPath = resolve(process.argv[2] ?? join(root, "logs", "bot.log"));
const MAX_LOG_BYTES = 10 * 1024 * 1024;
const RESTART_DELAY_MS = 10_000;

mkdirSync(dirname(logPath), { recursive: true });
let log = openLog();

function openLog() {
  try {
    if (statSync(logPath).size > MAX_LOG_BYTES) renameSync(logPath, `${logPath}.1`);
  } catch {
    // No log yet.
  }
  return createWriteStream(logPath, { flags: "a" });
}

function write(text) {
  process.stdout.write(text);
  log.write(text);
  if (log.bytesWritten > MAX_LOG_BYTES) {
    log.end();
    log = openLog();
  }
}

let child = null;
let stopping = false;

function start() {
  write(`${new Date().toISOString()} [supervisor] starting bot\n`);
  child = spawn(process.execPath, [join(root, "src", "index.js")], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdout.on("data", (d) => write(d.toString()));
  child.stderr.on("data", (d) => write(d.toString()));
  child.on("exit", (code, signal) => {
    child = null;
    if (stopping) return;
    write(
      `${new Date().toISOString()} [supervisor] bot exited (${signal ?? code}); ` +
        `restarting in ${RESTART_DELAY_MS / 1000}s\n`,
    );
    setTimeout(start, RESTART_DELAY_MS);
  });
}

for (const sig of ["SIGINT", "SIGTERM", "SIGBREAK", "SIGHUP"]) {
  process.on(sig, () => {
    if (stopping) return;
    stopping = true;
    write(`${new Date().toISOString()} [supervisor] stopping\n`);
    if (!child) process.exit(0);
    child.once("exit", () => process.exit(0));
    child.kill();
    setTimeout(() => process.exit(0), 5000).unref();
  });
}

start();
