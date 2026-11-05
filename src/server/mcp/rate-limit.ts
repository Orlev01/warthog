// In-memory per-connection rate limiter for the agent-call pipeline (design §6;
// brief NFR "default 120 requests per minute, set per agent by the person on
// that agent's permissions page"). A sliding one-minute window keyed by
// connection id, held in-process so a burst is refused without a DB round trip.
// The person's configured limit is read from the agent's permissions and handed
// to `allow()` per call, so the limiter has nothing to persist.

import { type Clock, systemClock } from "../seams/clock";

const WINDOW_MS = 60 * 1000; // one-minute window (design §6: default 120/min)
const DEFAULT_LIMIT = 120; // default requests per minute (brief NFR)

export interface RateLimiter {
  // Records one call for `connectionId` at the clock's current instant and
  // returns whether it is allowed (true) or refused (false) because the sliding
  // window already holds `limit` calls. `limit` is the person's per-connection
  // override; omitted, the default of 120/min applies. Synchronous.
  allow(connectionId: string, limit?: number): boolean;
}

// A fresh limiter instance reading time through the injected clock seam.
export function createRateLimiter(clock: Clock): RateLimiter {
  const windows = new Map<string, number[]>();

  return {
    allow(connectionId: string, limit: number = DEFAULT_LIMIT): boolean {
      const now = clock.now().getTime();
      const cutoff = now - WINDOW_MS;

      const previous = windows.get(connectionId) ?? [];
      // Drop calls that have aged past the one-minute window.
      const live = previous.filter((at) => at > cutoff);

      if (live.length >= limit) {
        windows.set(connectionId, live);
        return false;
      }

      live.push(now);
      windows.set(connectionId, live);
      return true;
    },
  };
}

// The memoized per-process singleton reading the real system clock. Kept on
// globalThis so Next's dev-mode module reloads (and a module bundled into two
// graphs) reuse the one shared set of windows instead of splitting it.
const KEY = Symbol.for("warthog.mcp.rateLimiter");
type WithRateLimiter = typeof globalThis & { [KEY]?: RateLimiter };

export function getRateLimiter(): RateLimiter {
  const g = globalThis as WithRateLimiter;
  g[KEY] ??= createRateLimiter(systemClock);
  return g[KEY];
}
