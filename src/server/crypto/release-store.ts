// The in-memory release store (design §4.2). A "release" is a one-time
// hand-over of a high-tier identity value or card to an agent: on approval the
// browser decrypts the value and posts it to the server, which holds it ONLY
// here — a process-memory Map with a 5-minute TTL and a single collection —
// never writing it to the database, logs or metrics. The agent collects the
// value exactly once; an uncollected value is discarded five minutes after it
// was put.
//
// Discarding is ACTIVE, not lazy (brief: "SHALL discard it from server memory on
// collection or expiry, whichever comes first"): each put arms an eviction for the
// end of its window, and every put/collect also sweeps any entry already past its
// window — so an abandoned release never lingers in the heap as plaintext.

import type { Clock } from "../seams/clock";
import { systemClock } from "../seams/clock";
import { processSingleton } from "../seams/process-singleton";

const TTL_MS = 5 * 60 * 1000; // 5-minute TTL (design §4.2)

interface Entry {
  value: string;
  putAt: number; // epoch millis the value was put, read through the clock
  cancelEviction: () => void; // disarms this entry's scheduled eviction
}

export interface ReleaseStore {
  put(key: string, value: string): void;
  collect(key: string): string | undefined;
  // Discard all approvals under an authenticated connection's exact scope.
  discardScope(scope: string): void;
  // How many released values are held in memory right now (expired ones are swept
  // first, so they are never counted).
  size(): number;
}

// Arms `evict` to run after `delayMs` and returns a function that disarms it. The
// production default is an unref'd timer (it never holds the process open); tests
// inject a scheduler they fire by hand.
export type ScheduleEviction = (evict: () => void, delayMs: number) => () => void;

export const timerEviction: ScheduleEviction = (evict, delayMs) => {
  const timer = setTimeout(evict, delayMs);
  timer.unref?.();
  return () => clearTimeout(timer);
};

// Build a release store reading time through the given clock and arming each
// value's eviction through `schedule`.
export function createReleaseStore(
  clock: Clock,
  schedule: ScheduleEviction = timerEviction,
): ReleaseStore {
  const entries = new Map<string, Entry>();

  // Drop one entry and disarm its eviction (a missing key is a harmless no-op).
  function drop(key: string): void {
    const entry = entries.get(key);
    if (entry === undefined) return;
    entry.cancelEviction();
    entries.delete(key);
  }

  function isExpired(entry: Entry, now: number): boolean {
    return now - entry.putAt > TTL_MS;
  }

  // Evict every entry already past its window (a stalled or late timer never keeps
  // a value alive).
  function sweep(): void {
    const now = clock.now().getTime();
    for (const [key, entry] of entries) {
      if (isExpired(entry, now)) drop(key);
    }
  }

  return {
    put(key: string, value: string): void {
      sweep();
      // A newer release for the same key replaces the old one (and its eviction).
      drop(key);
      const entry: Entry = { value, putAt: clock.now().getTime(), cancelEviction: () => {} };
      entry.cancelEviction = schedule(() => {
        // Only ever evict THIS entry: a late eviction for a replaced value must not
        // remove the newer one put under the same key.
        if (entries.get(key) === entry) entries.delete(key);
      }, TTL_MS);
      entries.set(key, entry);
    },
    collect(key: string): string | undefined {
      sweep();
      const entry = entries.get(key);
      if (entry === undefined) return undefined;
      // A release is one-time: drop the entry on collection, then hand it back
      // (the sweep above already discarded it if it was past its window).
      drop(key);
      return entry.value;
    },
    size(): number {
      sweep();
      return entries.size;
    },
    discardScope(scope: string): void {
      sweep();
      for (const key of entries.keys()) {
        if (key.startsWith(scope)) drop(key);
      }
    },
  };
}

// The process-wide singleton (design §4.2: one per process, not re-instantiated
// per request), held through processSingleton (globalThis): Next bundles route handlers and pages into
// separate module graphs, and a value released by the MCP route must be collectable from
// any other entry in the same process.
export const releaseStore: ReleaseStore = processSingleton("crypto.releaseStore", () =>
  createReleaseStore(systemClock),
);
