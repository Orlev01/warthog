// The in-memory release store (design §4.2). A "release" is a one-time
// hand-over of a high-tier identity value or card to an agent: on approval the
// browser decrypts the value and posts it to the server, which holds it ONLY
// here — a process-memory Map with a 5-minute TTL and a single collection —
// never writing it to the database, logs or metrics. The agent collects the
// value exactly once; an uncollected value is discarded five minutes after it
// was put.

import type { Clock } from "../seams/clock";
import { systemClock } from "../seams/clock";
import { processSingleton } from "../seams/process-singleton";

const TTL_MS = 5 * 60 * 1000; // 5-minute TTL (design §4.2)

interface Entry {
  value: string;
  putAt: number; // epoch millis the value was put, read through the clock
}

export interface ReleaseStore {
  put(key: string, value: string): void;
  collect(key: string): string | undefined;
}

// Build a release store reading time through the given clock. Expiry is lazy:
// an entry's age is checked against the clock at collect() time, so no
// background sweep timer is needed.
export function createReleaseStore(clock: Clock): ReleaseStore {
  const entries = new Map<string, Entry>();

  return {
    put(key: string, value: string): void {
      entries.set(key, { value, putAt: clock.now().getTime() });
    },
    collect(key: string): string | undefined {
      const entry = entries.get(key);
      if (entry === undefined) return undefined;
      // A release is one-time and expires after 5 minutes: drop the entry on
      // collection either way, then hand it back only if it is still fresh.
      entries.delete(key);
      if (clock.now().getTime() - entry.putAt > TTL_MS) return undefined;
      return entry.value;
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
