import { EventEmitter } from "node:events";
import { buildPlaylist } from "./jellyfin.js";

/**
 * The "TV channel": decides what's on and since when. Nothing is streamed
 * here. Viewers ask for the current item and its start time, then play from
 * (now - startedAt), so everyone watching sees the same thing.
 */
export class Schedule extends EventEmitter {
  playlist = [];
  requests = []; // queued by viewers, played before the playlist
  current = null; // { item, startedAt, duration } (ms)
  #timer = null;
  #advancing = null;

  start() {
    return this.advance();
  }

  /** Moves to the next item now (used for skip and when an item ends). */
  advance() {
    // Coalesce concurrent calls (e.g. two people clicking skip at once).
    this.#advancing ??= this.#advance().finally(() => {
      this.#advancing = null;
    });
    return this.#advancing;
  }

  async #advance() {
    clearTimeout(this.#timer);
    let item;
    try {
      item = await this.#nextItem();
    } catch (err) {
      this.current = null;
      this.emit("log", `Couldn't load the next item: ${err.message}. Retrying in 30s`);
      this.#timer = setTimeout(() => this.advance(), 30_000);
      return;
    }
    const duration = item.RunTimeTicks / 10_000;
    this.current = { item, startedAt: Date.now(), duration };
    this.#timer = setTimeout(() => this.advance(), duration);
    this.emit("change", this.current);
  }

  async #nextItem() {
    const requested = this.requests.shift();
    if (requested) return requested;
    if (!this.playlist.length) {
      this.playlist = await buildPlaylist();
      this.emit("log", `Loaded ${this.playlist.length} items from Jellyfin`);
      if (!this.playlist.length) {
        throw new Error("Jellyfin returned no playable items; check JELLYFIN_PARENT_IDS / JELLYFIN_ITEM_TYPES");
      }
    }
    return this.playlist.shift();
  }

  enqueue(item) {
    this.requests.push(item);
  }

  upNext(limit = 10) {
    return [...this.requests, ...this.playlist].slice(0, limit);
  }

  async reload() {
    this.playlist = await buildPlaylist();
    return this.playlist.length;
  }
}
