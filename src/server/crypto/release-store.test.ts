// E01-S09 — in-memory release store (`src/server/crypto/release-store.ts`).
//
// These tests are RED-first: the module does not exist yet. They pin BEHAVIOUR
// (what put/collect do over time), never the source text of the module — no
// assertion reads `release-store.ts`.
//
// A "release" is a one-time hand-over of a high-tier identity value or card to
// an agent. On approval the browser decrypts the value and posts it to the
// server, which holds it ONLY in this process-memory store (design §4.2: "the
// in-memory release store (Map, TTL 5 minutes, single collection), never writes
// it to the database, logs or metrics"). The agent then collects it exactly
// once; after five minutes an uncollected value expires and is discarded.
//
// Contract these tests define:
//   createReleaseStore(clock)  -> a store instance that reads time through the
//                                 standard Clock seam (so tests can drive TTL).
//     .put(key, value)   stores a released value under a key.
//     .collect(key)      returns the stored value ONCE, then returns `undefined`
//                        (a release is a one-time hand-over); returns `undefined`
//                        for an unknown key or an entry older than 5 minutes.
//   releaseStore               -> the process-wide singleton (one per process,
//                                 not re-instantiated per request).
//
// The factory takes a Clock because the singleton reads time through one — the
// convention here is "external services (clock, random, …) sit behind interfaces
// with fakes". Expiry is observed ONLY through collect(): these tests do not
// require (or assert) a background sweep timer, so the simplest green
// implementation is lazy expiry checked against the injected clock.
//
// All store calls are awaited so these tests pass whether the implementation is
// synchronous (the natural choice for in-memory Map ops) or async. Tests never
// touch the network, Azure or a database.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { createReleaseStore, releaseStore } from "./release-store";
import type { Clock } from "../seams/clock";

const TTL_MS = 5 * 60 * 1000; // 5-minute TTL (design §4.2)

// A clock whose instant the test advances by hand, so the 5-minute TTL can be
// crossed deterministically without waiting in real time. Implements the same
// Clock interface the store reads time through.
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

// Redirect every console channel into an array for the duration of a call, so a
// test can assert a secret value was never written to logs. Restores on
// teardown. Scoped to the exact value canary — the store may legitimately log
// other things; it must never log the released value in the clear.
function captureConsole(): { lines: string[]; restore: () => void } {
  const methods = ["log", "info", "warn", "error", "debug", "trace"];
  const sink = console as unknown as Record<string, (...args: unknown[]) => void>;
  const originals = new Map<string, ((...args: unknown[]) => void) | undefined>();
  const lines: string[] = [];
  for (const m of methods) {
    originals.set(m, sink[m]);
    sink[m] = (...args: unknown[]): void => {
      lines.push(
        args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "),
      );
    };
  }
  return {
    lines,
    restore(): void {
      for (const m of methods) {
        const original = originals.get(m);
        if (original) sink[m] = original;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// AC: put() stores a value retrievable exactly once; a second collect returns
// nothing (a release is a one-time hand-over).
// ---------------------------------------------------------------------------

test("collect returns a put value exactly once; a second collect returns nothing", async () => {
  const store = createReleaseStore(controllableClock().clock);

  await store.put("rel-1", "passport-X1234567");

  assert.equal(
    await store.collect("rel-1"),
    "passport-X1234567",
    "the first collect returns the stored value",
  );
  assert.equal(
    await store.collect("rel-1"),
    undefined,
    "a second collect returns nothing — a release is collected once only",
  );
});

test("collect returns nothing for a key that was never put", async () => {
  const store = createReleaseStore(controllableClock().clock);

  assert.equal(
    await store.collect("never-stored"),
    undefined,
    "an unknown key yields nothing, not a throw or a stale value",
  );
});

test("distinct keys are stored and collected independently", async () => {
  const store = createReleaseStore(controllableClock().clock);

  await store.put("a", "4111111111111111");
  await store.put("b", "tax-file-no-123456789");

  // Collecting one key must not consume or disturb the other.
  assert.equal(await store.collect("b"), "tax-file-no-123456789");
  assert.equal(await store.collect("a"), "4111111111111111");
  assert.equal(await store.collect("a"), undefined, "each key is still one-time");
});

// ---------------------------------------------------------------------------
// AC: an entry expires and is discarded after 5 minutes.
// ---------------------------------------------------------------------------

test("a value put is still collectable within the 5-minute window", async () => {
  const c = controllableClock();
  const store = createReleaseStore(c.clock);

  await store.put("rel", "secret-value");
  c.advance(TTL_MS - 1000); // 4m59s — inside the window

  assert.equal(
    await store.collect("rel"),
    "secret-value",
    "a value younger than 5 minutes is still collectable (TTL is 5 minutes, not shorter)",
  );
});

test("an entry has expired and is discarded after 5 minutes", async () => {
  const c = controllableClock();
  const store = createReleaseStore(c.clock);

  await store.put("rel", "secret-value");
  c.advance(TTL_MS + 1000); // 5m01s — past the window

  assert.equal(
    await store.collect("rel"),
    undefined,
    "an entry older than 5 minutes has expired and collects as nothing",
  );
});

test("each entry expires on its own 5-minute clock, measured from its put time", async () => {
  const c = controllableClock();
  const store = createReleaseStore(c.clock);

  await store.put("early", "v-early");
  c.advance(3 * 60 * 1000); // +3m
  await store.put("late", "v-late");
  c.advance(3 * 60 * 1000); // +6m total: "early" is 6m old, "late" is 3m old

  assert.equal(
    await store.collect("early"),
    undefined,
    "the entry older than 5 minutes has expired",
  );
  assert.equal(
    await store.collect("late"),
    "v-late",
    "the entry still inside its own 5-minute window is collectable",
  );
});

// ---------------------------------------------------------------------------
// AC: the module exports one process-wide singleton (not re-instantiated per
// request) and never persists to any store.
// ---------------------------------------------------------------------------

test("the module exports a single process-wide store object, not a factory", () => {
  // The singleton is a ready-to-use object with the store methods — not a
  // function you call to get a fresh (empty) instance per request.
  assert.equal(typeof releaseStore, "object", "releaseStore is an instance, not a function");
  assert.notEqual(releaseStore, null);
  assert.equal(typeof releaseStore.put, "function", "the singleton exposes put()");
  assert.equal(typeof releaseStore.collect, "function", "the singleton exposes collect()");
});

test("the singleton keeps one shared state across re-imports (one per process)", async () => {
  // A unique key so this never collides with the shared singleton in any other
  // test in this file.
  const key = `singleton-${randomUUID()}`;
  await releaseStore.put(key, "released-via-first-reference");

  // Re-importing the module must yield the SAME object (ESM caches it) — a value
  // put through one reference is visible through another, proving the store is a
  // single shared instance, not rebuilt on each import/request.
  const again = await import("./release-store");
  assert.equal(
    again.releaseStore,
    releaseStore,
    "re-importing returns the same singleton object",
  );
  assert.equal(
    await again.releaseStore.collect(key),
    "released-via-first-reference",
    "state put via one reference is collectable via another — one shared instance",
  );
});

test("state lives only in a store's own memory — a separate store never sees it", async () => {
  // Nothing is persisted to a shared/global/durable backing store: a value put
  // into one instance is invisible to an independently created instance, so a
  // fresh process (or a second store) starts empty.
  const a = createReleaseStore(controllableClock().clock);
  const b = createReleaseStore(controllableClock().clock);

  await a.put("k", "secret");

  assert.equal(
    await b.collect("k"),
    undefined,
    "a value put in one store is invisible to another — nothing is persisted to a shared store",
  );
  assert.equal(
    await a.collect("k"),
    "secret",
    "the value is held in, and collectable from, the store it was put into",
  );
});

test("put and collect never emit the released value to the console (logs/metrics)", async () => {
  const store = createReleaseStore(controllableClock().clock);
  // A unique canary containing characters outside hex/base64 so an appearance in
  // output could only be the raw value leaking.
  const value = `release-canary ∂ ${randomUUID()} !!`;
  const key = "rel-canary";

  const capture = captureConsole();
  try {
    await store.put(key, value);
    const got = await store.collect(key);
    assert.equal(got, value, "the value still round-trips through the store");
  } finally {
    capture.restore();
  }

  for (const line of capture.lines) {
    assert.ok(
      !line.includes(value),
      "the released value must never be written to logs/metrics in the clear",
    );
  }
});
