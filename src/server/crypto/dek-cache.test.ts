// The in-process cache of unwrapped data keys (`src/server/crypto/dek-cache.ts`; design §4.1
// "Unwrapped DEKs are cached in process memory for at most 5 minutes"; review 2026-11-23,
// High: every MCP request unwrapped the person's DEK through Key Vault, uncached, and the
// vault's quota is shared by everyone).
//
// RED-first: the module does not exist yet. These tests pin BEHAVIOUR — how often the inner
// KeyWrapper is asked to unwrap, what each caller gets back, and when a key is gone — never
// the module's source text.
//
// Contract:
//   createDekCache({ clock, schedule?, ttlMs?, maxEntries? }) -> DekCache
//     .unwrap(wrapped, inner)  the DEK for `wrapped`: from the cache within the TTL (counted
//                              from the unwrap, never extended by use), else from
//                              `inner(wrapped)`. Each caller gets its own copy. A failed
//                              unwrap is never cached.
//     .forget(wrapped)         drops that key now.
//     .size()                  how many keys are held (expired ones are swept first).
//   cachedKeyWrapper(inner, cache) -> a KeyWrapper whose unwrap goes through the cache and
//                              whose wrap is the inner wrapper's.
//
// Tests never touch Azure, the network or a database.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

import { cachedKeyWrapper, createDekCache, DEK_CACHE_TTL_MS } from "./dek-cache";
import { localAesKeyWrapper, type KeyWrapper } from "./key-wrapper";
import type { ScheduleEviction } from "./release-store";
import type { Clock } from "../seams/clock";

const MINUTE_MS = 60 * 1000;

// A clock the test advances by hand.
function controllableClock(start = new Date("2026-11-23T00:00:00.000Z")): { clock: Clock; advance: (ms: number) => void } {
  let current = start.getTime();
  return { clock: { now: () => new Date(current) }, advance: (ms) => { current += ms; } };
}

// A scheduler that never fires on its own: the test fires the armed evictions by hand.
function manualSchedule(): { schedule: ScheduleEviction; fireAll: () => void } {
  const armed = new Set<() => void>();
  return {
    schedule: (evict) => {
      armed.add(evict);
      return () => armed.delete(evict);
    },
    fireAll: () => {
      for (const evict of [...armed]) {
        armed.delete(evict);
        evict();
      }
    },
  };
}

// A real local AES wrapper with a counter on unwrap, so a test sees exactly how often the
// "Key Vault" behind the cache was asked.
function countingWrapper(): { wrapper: KeyWrapper; unwraps: () => number } {
  const inner = localAesKeyWrapper(randomBytes(32));
  let count = 0;
  return {
    unwraps: () => count,
    wrapper: {
      wrap: (dek) => inner.wrap(dek),
      unwrap: async (wrapped) => {
        count += 1;
        return inner.unwrap(wrapped);
      },
    },
  };
}

test("the cache allows at most 5 minutes, as the design says", () => {
  assert.equal(DEK_CACHE_TTL_MS, 5 * MINUTE_MS);
});

test("repeated unwraps of the same wrapped key within the TTL ask the inner wrapper once", async () => {
  const { clock, advance } = controllableClock();
  const { wrapper, unwraps } = countingWrapper();
  const cached = cachedKeyWrapper(wrapper, createDekCache({ clock, schedule: manualSchedule().schedule }));
  const dek = randomBytes(32);
  const wrapped = await wrapper.wrap(dek);

  for (let i = 0; i < 5; i += 1) {
    assert.deepEqual(Buffer.from(await cached.unwrap(wrapped)), dek, "every caller gets the person's key");
    advance(MINUTE_MS - 1);
  }
  assert.equal(unwraps(), 1, "five unwraps inside five minutes reach the inner wrapper once");
});

test("each caller gets its own copy: zeroing one never changes what the next caller gets", async () => {
  const { clock } = controllableClock();
  const { wrapper } = countingWrapper();
  const cached = cachedKeyWrapper(wrapper, createDekCache({ clock, schedule: manualSchedule().schedule }));
  const dek = randomBytes(32);
  const wrapped = await wrapper.wrap(dek);

  const first = await cached.unwrap(wrapped);
  first.fill(0);
  const second = await cached.unwrap(wrapped);
  assert.deepEqual(Buffer.from(second), dek, "a caller that zeroes its key after use leaves the cached key intact");
  assert.notEqual(first, second, "two callers never share a buffer");
});

test("the TTL counts from the unwrap and is never extended by use: at 5 minutes the inner wrapper is asked again", async () => {
  const { clock, advance } = controllableClock();
  const { wrapper, unwraps } = countingWrapper();
  const cached = cachedKeyWrapper(wrapper, createDekCache({ clock, schedule: manualSchedule().schedule }));
  const wrapped = await wrapper.wrap(randomBytes(32));

  await cached.unwrap(wrapped);
  advance(DEK_CACHE_TTL_MS - 1);
  await cached.unwrap(wrapped);
  assert.equal(unwraps(), 1, "a use just inside the window is served from the cache");
  advance(1);
  await cached.unwrap(wrapped);
  assert.equal(unwraps(), 2, "at five minutes after the unwrap the key is gone, despite the recent use");
});

test("a different wrapped value — a new key, or the same key re-wrapped under a new vault key version — is unwrapped afresh", async () => {
  const { clock } = controllableClock();
  const { wrapper, unwraps } = countingWrapper();
  const cached = cachedKeyWrapper(wrapper, createDekCache({ clock, schedule: manualSchedule().schedule }));
  const oldDek = randomBytes(32);
  const newDek = randomBytes(32);
  const oldWrapped = await wrapper.wrap(oldDek);
  const rewrapped = await wrapper.wrap(oldDek); // a fresh wrap of the same key is a different value
  const replaced = await wrapper.wrap(newDek);
  assert.notEqual(oldWrapped, rewrapped);

  assert.deepEqual(Buffer.from(await cached.unwrap(oldWrapped)), oldDek);
  assert.deepEqual(Buffer.from(await cached.unwrap(rewrapped)), oldDek);
  assert.deepEqual(Buffer.from(await cached.unwrap(replaced)), newDek, "a replaced key is never served from the old entry");
  assert.equal(unwraps(), 3, "each distinct wrapped value is its own entry");
});

test("a failed unwrap is never cached: a tampered value fails every time", async () => {
  const { clock } = controllableClock();
  const { wrapper, unwraps } = countingWrapper();
  const cache = createDekCache({ clock, schedule: manualSchedule().schedule });
  const cached = cachedKeyWrapper(wrapper, cache);
  const wrapped = await wrapper.wrap(randomBytes(32));
  const tampered = `${wrapped.slice(0, 20)}${wrapped[20] === "A" ? "B" : "A"}${wrapped.slice(21)}`;

  await assert.rejects(cached.unwrap(tampered));
  await assert.rejects(cached.unwrap(tampered));
  await assert.rejects(cached.unwrap(""), "an erased (deleted account) key never unwraps");
  assert.equal(unwraps(), 3, "every failed attempt reached the inner wrapper");
  assert.equal(cache.size(), 0, "nothing was cached");
});

test("the cache holds at most maxEntries keys; the oldest go first", async () => {
  const { clock, advance } = controllableClock();
  const { wrapper, unwraps } = countingWrapper();
  const cache = createDekCache({ clock, schedule: manualSchedule().schedule, maxEntries: 3 });
  const cached = cachedKeyWrapper(wrapper, cache);
  const wrapped: string[] = [];
  for (let i = 0; i < 5; i += 1) wrapped.push(await wrapper.wrap(randomBytes(32)));

  for (const value of wrapped) {
    await cached.unwrap(value);
    advance(1000);
    assert.ok(cache.size() <= 3, `the bound holds after each insert (size ${cache.size()})`);
  }
  assert.equal(cache.size(), 3);
  assert.equal(unwraps(), 5);

  // The three newest are still held; the two oldest were evicted.
  for (const value of wrapped.slice(2)) await cached.unwrap(value);
  assert.equal(unwraps(), 5, "the newest keys are served from the cache");
  await cached.unwrap(wrapped[0]!);
  assert.equal(unwraps(), 6, "the oldest key was evicted and is unwrapped again");
  assert.ok(cache.size() <= 3);
});

test("forget drops one key at once and leaves the others", async () => {
  const { clock } = controllableClock();
  const { wrapper, unwraps } = countingWrapper();
  const cache = createDekCache({ clock, schedule: manualSchedule().schedule });
  const cached = cachedKeyWrapper(wrapper, cache);
  const deleted = await wrapper.wrap(randomBytes(32));
  const kept = await wrapper.wrap(randomBytes(32));
  await cached.unwrap(deleted);
  await cached.unwrap(kept);

  cache.forget(deleted);
  assert.equal(cache.size(), 1);
  await cached.unwrap(kept);
  assert.equal(unwraps(), 2, "the other key is still cached");
  await cached.unwrap(deleted);
  assert.equal(unwraps(), 3, "the forgotten key has to be unwrapped again");
});

test("an unwrap that was in flight when its key was forgotten is not cached afterwards", async () => {
  const { clock } = controllableClock();
  const inner = localAesKeyWrapper(randomBytes(32));
  const wrapped = await inner.wrap(randomBytes(32));
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let count = 0;
  const slow: KeyWrapper = { wrap: inner.wrap, unwrap: async (value) => { count += 1; await gate; return inner.unwrap(value); } };
  const cache = createDekCache({ clock, schedule: manualSchedule().schedule });
  const cached = cachedKeyWrapper(slow, cache);

  const pending = cached.unwrap(wrapped);
  cache.forget(wrapped);
  release();
  await pending;
  assert.equal(cache.size(), 0, "a key forgotten mid-unwrap is not put back");
});

test("an armed eviction removes the key when it fires, without anyone asking for it", async () => {
  const { clock } = controllableClock();
  const { wrapper } = countingWrapper();
  const { schedule, fireAll } = manualSchedule();
  const cache = createDekCache({ clock, schedule });
  await cachedKeyWrapper(wrapper, cache).unwrap(await wrapper.wrap(randomBytes(32)));
  assert.equal(cache.size(), 1);
  fireAll();
  assert.equal(cache.size(), 0, "the key left memory when its five minutes were up");
});

test("wrapping goes straight to the inner wrapper", async () => {
  const { clock } = controllableClock();
  const { wrapper, unwraps } = countingWrapper();
  const cached = cachedKeyWrapper(wrapper, createDekCache({ clock, schedule: manualSchedule().schedule }));
  const dek = randomBytes(32);
  const wrapped = await cached.wrap(dek);
  assert.deepEqual(Buffer.from(await wrapper.unwrap(wrapped)), dek, "the inner wrapper can unwrap what the cached one wrapped");
  assert.equal(unwraps(), 1);
});
