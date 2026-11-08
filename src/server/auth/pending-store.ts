// The bounded, expiring store for pending auth state (review fix B5). Several auth
// flows span requests before anyone is signed in — a pending sign-up, the name parked
// at send-code, a new-device approval request, a pending recovery — and keep that
// state in process memory between the requests, keyed by a random handle (or the
// email). Because unauthenticated requests create the entries, an unbounded Map would
// let a scripted loop grow the single replica's heap until it is killed, and would keep
// abandoned flows (and a stale approved device request) alive forever.
//
// Every such store is therefore built here, with:
//   • a time-to-live: an entry is readable only until `ttlMs` after it was last set,
//     judged against the instant the caller passes (from its injected Clock, so expiry
//     is deterministic and testable — never Date.now());
//   • pruning on every set: entries are kept in insertion order (a re-set moves the key
//     to the end), so the expired ones are at the front and the prune stops at the first
//     live entry;
//   • a hard cap: when full, the oldest entry is evicted to make room. Eviction (rather
//     than refusing new entries) means a flood can delay, but never lock out, a real
//     person's flow.
// The map lives on globalThis through processSingleton, so every module graph Next
// builds (route handlers, pages, dev reloads) shares one store per name.

import { processSingleton } from "../seams/process-singleton";

export interface PendingStoreOptions {
  // How long an entry stays readable after it was last set.
  readonly ttlMs: number;
  // The most entries the store holds at once.
  readonly maxEntries: number;
}

export interface PendingStore<T> {
  // The live value for `key` at `now`, or undefined when absent or expired. The same
  // object is handed back, so a flow can record its progress on it in place.
  get(key: string, now: Date): T | undefined;
  // Store `value` under `key`, live until `now + ttlMs`.
  set(key: string, value: T, now: Date): void;
  delete(key: string): void;
  readonly size: number;
}

interface Entry<T> {
  readonly value: T;
  readonly expiresAt: number;
}

export function pendingStore<T>(name: string, options: PendingStoreOptions): PendingStore<T> {
  const entries = processSingleton(`${name}.pending`, () => new Map<string, Entry<T>>());

  function prune(nowMs: number): void {
    for (const [key, entry] of entries) {
      if (entry.expiresAt > nowMs) break;
      entries.delete(key);
    }
  }

  return {
    get(key, now) {
      const entry = entries.get(key);
      if (!entry) return undefined;
      if (entry.expiresAt <= now.getTime()) {
        entries.delete(key);
        return undefined;
      }
      return entry.value;
    },
    set(key, value, now) {
      const nowMs = now.getTime();
      prune(nowMs);
      entries.delete(key);
      while (entries.size >= options.maxEntries) {
        const oldest = entries.keys().next();
        if (oldest.done) break;
        entries.delete(oldest.value);
      }
      entries.set(key, { value, expiresAt: nowMs + options.ttlMs });
    },
    delete(key) {
      entries.delete(key);
    },
    get size() {
      return entries.size;
    },
  };
}
