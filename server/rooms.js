import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";

// When something starts, resumes or jumps, clients get a moment to load
// before the clock runs, so nobody starts behind.
const START_LEAD_MS = 2000;
const RESUME_LEAD_MS = 750;
// A viewer counts as present while they keep polling.
const PRESENT_MS = 15_000;
// Pause when everyone has left; forget the room after a long while.
const EMPTY_PAUSE_MS = 60_000;
const EMPTY_DELETE_MS = 6 * 60 * 60 * 1000;

/**
 * One watch party: what's playing, where it is, and what's queued. Each
 * Discord Activity instance (one per voice channel) gets its own room.
 *
 * Playback position is a clock, not a stream: `position` ms at `anchorAt`
 * (server time), advancing in real time unless paused. Clients poll it and
 * keep their players in line.
 */
export class Room extends EventEmitter {
  current = null; // { item, playId, position, anchorAt, paused }
  queue = [];
  viewers = new Map(); // Discord user ID -> { name, lastSeen }
  lastActive = Date.now();
  #timer = null;

  constructor(id) {
    super();
    this.id = id;
  }

  /** Current position in ms. Negative during the start lead-in. */
  position(now = Date.now()) {
    const cur = this.current;
    if (!cur) return 0;
    return cur.paused ? cur.position : cur.position + (now - cur.anchorAt);
  }

  play(item) {
    this.current = { item, playId: randomUUID(), position: 0, anchorAt: Date.now() + START_LEAD_MS, paused: false };
    this.#armTimer();
  }

  enqueue(item) {
    this.queue.push(item);
  }

  removeFromQueue(index) {
    this.queue.splice(index, 1);
  }

  pause() {
    const cur = this.current;
    if (!cur || cur.paused) return;
    cur.position = Math.max(0, this.position());
    cur.paused = true;
    this.#armTimer();
  }

  resume() {
    const cur = this.current;
    if (!cur || !cur.paused) return;
    cur.anchorAt = Date.now() + RESUME_LEAD_MS;
    cur.paused = false;
    this.#armTimer();
  }

  seek(ms) {
    const cur = this.current;
    if (!cur) return;
    const duration = cur.item.RunTimeTicks / 10_000;
    cur.position = Math.min(Math.max(0, ms), Math.max(0, duration - 1000));
    cur.anchorAt = Date.now() + (cur.paused ? 0 : RESUME_LEAD_MS);
    this.#armTimer();
  }

  /** Plays the next queued item, or stops if the queue is empty. */
  next() {
    const item = this.queue.shift();
    if (item) this.play(item);
    else this.stop();
  }

  stop() {
    this.current = null;
    this.#armTimer();
  }

  seen(key, name) {
    this.viewers.set(key, { name, lastSeen: Date.now() });
    this.lastActive = Date.now();
  }

  presentViewers(now = Date.now()) {
    return [...this.viewers.values()].filter((v) => now - v.lastSeen < PRESENT_MS).map((v) => v.name);
  }

  /** Housekeeping, called periodically. Returns false when the room can be dropped. */
  tick(now = Date.now()) {
    const idleFor = now - this.lastActive;
    if (idleFor > EMPTY_PAUSE_MS && this.current && !this.current.paused) {
      this.pause();
      this.emit("log", "Everyone left; paused");
    }
    return idleFor < EMPTY_DELETE_MS;
  }

  // Moves on when the current item ends.
  #armTimer() {
    clearTimeout(this.#timer);
    const cur = this.current;
    if (!cur || cur.paused) return;
    const remaining = cur.item.RunTimeTicks / 10_000 - this.position();
    this.#timer = setTimeout(() => {
      this.emit("log", "Finished; playing next");
      this.next();
    }, Math.max(0, remaining) + 1000);
  }

  dispose() {
    clearTimeout(this.#timer);
  }
}

export class Rooms extends EventEmitter {
  #rooms = new Map();

  constructor() {
    super();
    setInterval(() => {
      for (const [id, room] of this.#rooms) {
        if (!room.tick()) {
          room.dispose();
          this.#rooms.delete(id);
        }
      }
    }, 10_000).unref();
  }

  get(id) {
    let room = this.#rooms.get(id);
    if (!room) {
      room = new Room(id);
      room.on("log", (msg) => this.emit("log", `[${id}] ${msg}`));
      this.#rooms.set(id, room);
    }
    return room;
  }
}
