// E07-S08 — in-memory per-connection rate limiter (`src/server/mcp/rate-limit.ts`).
//
// These tests are RED-first: the module does not exist yet, so importing it
// fails and every test is red until a builder writes the minimum code to pass.
// They pin BEHAVIOUR (what the limiter allows/refuses over time and across
// references), never the source text of the module — no assertion reads the
// file's characters.
//
// Context (design §6 pipeline; brief NFR "WHILE an agent exceeds its request
// limit (default 120 requests per minute, set per agent by the person on that
// agent's permissions page)"): the agent-call pipeline must refuse bursts
// in-memory per connection — a process-singleton sliding window, no DB round
// trip. The person's configured limit (default 120/min) is read from the
// agent's permissions and handed to the limiter per call, so the limiter stays
// pure in-memory with nothing to persist.
//
// Contract these tests define:
//   createRateLimiter(clock)        -> a fresh limiter instance that reads time
//                                      through the standard Clock seam (so tests
//                                      can slide the one-minute window by hand).
//     .allow(connectionId, limit?)  -> records ONE call for this connection at
//                                      the clock's current instant and returns
//                                      whether it is allowed (true) or refused
//                                      because the window already holds `limit`
//                                      calls (false). `limit` is the person's
//                                      per-connection override; omitted, the
//                                      default of 120/min applies. Synchronous:
//                                      an in-memory Map check, no await.
//   getRateLimiter()                -> the memoized per-process singleton (the
//                                      SAME instance on every call and every
//                                      import), reading the real system clock.
//
// The window is one minute (design §6: "default 120/min"). Tests cross the
// window with a hand-advanced clock and leave a one-second margin either side of
// the 60s boundary, so no assertion rides an inclusive/exclusive edge.
//
// Tests never touch the network, Azure or a database.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { createRateLimiter, getRateLimiter } from "./rate-limit";
import type { Clock } from "../seams/clock";

const WINDOW_MS = 60 * 1000; // a one-minute window (design §6: default 120/min)
const DEFAULT_LIMIT = 120; // default requests per minute (brief NFR)

// A clock whose instant the test advances by hand, so the one-minute window can
// be slid deterministically without waiting in real time. Implements the same
// Clock interface the limiter reads time through.
function controllableClock(start: Date = new Date("2026-01-01T00:00:00.000Z")): {
  clock: Clock;
  advance: (ms: number) => void;
} {
  let current = start.getTime();
  const clock: Clock = { now: () => new Date(current) };
  return {
    clock,
    advance(ms: number): void {
      current += ms;
    },
  };
}

// ---------------------------------------------------------------------------
// AC: up to the limit of calls in the window are allowed and the next is refused.
// ---------------------------------------------------------------------------

test("up to the limit of calls are allowed; the very next call is refused", () => {
  const rl = createRateLimiter(controllableClock().clock);
  const conn = "conn-limit";
  const limit = 3;

  for (let i = 1; i <= limit; i++) {
    assert.equal(
      rl.allow(conn, limit),
      true,
      `call ${i} of ${limit} within the window is allowed`,
    );
  }
  assert.equal(
    rl.allow(conn, limit),
    false,
    "the call immediately after the limit is refused",
  );
});

test("the default limit is 120 requests per minute when no override is given", () => {
  const rl = createRateLimiter(controllableClock().clock);
  const conn = "conn-default";

  for (let i = 1; i <= DEFAULT_LIMIT; i++) {
    assert.equal(
      rl.allow(conn),
      true,
      `call ${i} within the default ${DEFAULT_LIMIT}/min is allowed`,
    );
  }
  assert.equal(
    rl.allow(conn),
    false,
    `the ${DEFAULT_LIMIT + 1}th call in the minute is refused under the default limit`,
  );
});

// ---------------------------------------------------------------------------
// AC: as the window slides, older calls drop and capacity returns.
// ---------------------------------------------------------------------------

test("capacity stays full while calls are inside the window, then returns once they slide out", () => {
  const c = controllableClock();
  const rl = createRateLimiter(c.clock);
  const conn = "conn-slide";
  const limit = 3;

  for (let i = 0; i < limit; i++) {
    assert.equal(rl.allow(conn, limit), true);
  }

  c.advance(WINDOW_MS - 1000); // 59s — the first calls are still inside the window
  assert.equal(
    rl.allow(conn, limit),
    false,
    "still refused while the original calls remain inside the one-minute window",
  );

  c.advance(2000); // now 61s past the originals — they have slid out of the window
  assert.equal(
    rl.allow(conn, limit),
    true,
    "capacity returns once the oldest calls age past the one-minute window",
  );
});

test("the window truly slides per call, not as a fixed bucket: one freed slot frees exactly one call", () => {
  const c = controllableClock();
  const rl = createRateLimiter(c.clock);
  const conn = "conn-truly-sliding";
  const limit = 2;

  assert.equal(rl.allow(conn, limit), true, "call A at t=0");
  c.advance(30 * 1000); // t = 30s
  assert.equal(rl.allow(conn, limit), true, "call B at t=30s fills the window");
  assert.equal(
    rl.allow(conn, limit),
    false,
    "refused at t=30s: A (0s old) and B (0s old) occupy both slots",
  );

  c.advance(31 * 1000); // t = 61s — A (61s old) has dropped; B (31s old) is still inside
  assert.equal(
    rl.allow(conn, limit),
    true,
    "exactly one slot freed as A slides out — one more call is allowed",
  );
  assert.equal(
    rl.allow(conn, limit),
    false,
    "and no more: B (still inside the window) plus the call just made again fill both slots",
  );
});

// ---------------------------------------------------------------------------
// AC: a per-connection override limit is honoured over the default.
// ---------------------------------------------------------------------------

test("a per-connection override limit is honoured over the default 120", () => {
  const rl = createRateLimiter(controllableClock().clock);

  // Connection "p" is overridden to a limit of 2.
  assert.equal(rl.allow("p", 2), true, "p call 1 under override 2");
  assert.equal(rl.allow("p", 2), true, "p call 2 under override 2");
  assert.equal(
    rl.allow("p", 2),
    false,
    "p's 3rd call is refused — the override of 2 governs, well below the default 120",
  );

  // Connection "q" has no override: its 3rd call is still allowed, proving it is
  // the override — not the default — that refused "p".
  assert.equal(rl.allow("q"), true, "q call 1 under the default");
  assert.equal(rl.allow("q"), true, "q call 2 under the default");
  assert.equal(
    rl.allow("q"),
    true,
    "q's 3rd call is allowed under the default 120 — the override only bound p",
  );
});

test("each connection has its own independent window", () => {
  const rl = createRateLimiter(controllableClock().clock);

  assert.equal(rl.allow("conn-x", 1), true);
  assert.equal(
    rl.allow("conn-x", 1),
    false,
    "conn-x has reached its own limit of 1",
  );
  assert.equal(
    rl.allow("conn-y", 1),
    true,
    "conn-y keeps its own window and is unaffected by conn-x",
  );
});

// ---------------------------------------------------------------------------
// AC: the limiter is a memoized per-process singleton (same instance across
// imports), not re-created per request.
// ---------------------------------------------------------------------------

test("getRateLimiter is a memoized accessor returning the SAME instance each call", () => {
  assert.equal(
    typeof getRateLimiter,
    "function",
    "the singleton is reached through an accessor function, not rebuilt inline",
  );

  const a = getRateLimiter();
  const b = getRateLimiter();

  assert.equal(typeof a, "object");
  assert.notEqual(a, null);
  assert.equal(typeof a.allow, "function", "the singleton exposes allow()");
  assert.equal(
    a,
    b,
    "repeated calls return the same memoized instance — not re-created per request",
  );
});

test("the singleton is one shared window per process, even across re-imports", async () => {
  // A unique connection id so this never collides with the shared singleton in
  // any other test in this file (or any other process's copy).
  const conn = `singleton-${randomUUID()}`;

  // Consume this connection's whole window (override limit of 1) through one
  // reference to the singleton.
  assert.equal(
    getRateLimiter().allow(conn, 1),
    true,
    "the first call for a fresh connection is allowed",
  );

  // Re-importing the module must yield the SAME singleton (a memoized per-process
  // instance), so the call recorded above is visible through the re-imported
  // reference and the next call for the same connection is refused.
  const again = await import("./rate-limit");
  assert.equal(
    again.getRateLimiter(),
    getRateLimiter(),
    "re-importing returns the same singleton instance",
  );
  assert.equal(
    again.getRateLimiter().allow(conn, 1),
    false,
    "a call recorded via one reference is seen via another — one shared window per process",
  );
});

test("separate factory instances do not share state — the singleton's sharing is the accessor's, not a global in the factory", () => {
  const a = createRateLimiter(controllableClock().clock);
  const b = createRateLimiter(controllableClock().clock);

  assert.equal(a.allow("k", 1), true);
  assert.equal(a.allow("k", 1), false, "instance a has reached its limit for k");
  assert.equal(
    b.allow("k", 1),
    true,
    "instance b is independent — nothing is persisted to a shared/global store",
  );
});
