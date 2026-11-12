// Review fix B5 — the shared, bounded store for unauthenticated pending auth state
// (`src/server/auth/pending-store.ts`). Pending sign-ups, sign-up names, new-device
// requests and pending recoveries are created by unauthenticated requests, so each
// must expire and the whole store must stay bounded: an abandoned flow is forgotten,
// and a flood of requests cannot grow process memory without limit.
//
// Pins behaviour only: what get/set/delete do against an injected instant, never the
// module's internals. Every test uses its own store name, because the store is a
// process-wide singleton keyed by that name.

import { test } from "node:test";
import assert from "node:assert/strict";

import { pendingStore } from "./pending-store";

const T0 = new Date("2026-05-01T00:00:00.000Z");
const MINUTE_MS = 60_000;

function at(offsetMs: number): Date {
  return new Date(T0.getTime() + offsetMs);
}

let seq = 0;
function uniqueName(): string {
  seq += 1;
  return `test.pendingStore.${process.pid}.${seq}.${Math.random().toString(36).slice(2)}`;
}

test("a value set is read back until its time-to-live lapses, then it is gone", () => {
  const store = pendingStore<{ n: number }>(uniqueName(), { ttlMs: 10 * MINUTE_MS, maxEntries: 100 });
  store.set("a", { n: 1 }, T0);

  assert.deepEqual(store.get("a", at(9 * MINUTE_MS)), { n: 1 }, "still live inside the TTL");
  assert.equal(store.get("a", at(10 * MINUTE_MS)), undefined, "gone once the TTL has passed");
  assert.equal(store.size, 0, "an expired entry read is evicted, not kept");
});

test("the same object is handed back, so a flow can record progress on it", () => {
  const store = pendingStore<{ done?: boolean }>(uniqueName(), { ttlMs: MINUTE_MS, maxEntries: 10 });
  store.set("a", {}, T0);
  store.get("a", T0)!.done = true;
  assert.equal(store.get("a", T0)?.done, true);
});

test("delete removes an entry at once", () => {
  const store = pendingStore<string>(uniqueName(), { ttlMs: MINUTE_MS, maxEntries: 10 });
  store.set("a", "x", T0);
  store.delete("a");
  assert.equal(store.get("a", T0), undefined);
  assert.equal(store.size, 0);
});

test("setting prunes every expired entry, so abandoned flows do not accumulate", () => {
  const store = pendingStore<number>(uniqueName(), { ttlMs: MINUTE_MS, maxEntries: 1000 });
  for (let i = 0; i < 50; i += 1) store.set(`old-${i}`, i, T0);
  assert.equal(store.size, 50);

  store.set("fresh", 1, at(2 * MINUTE_MS));
  assert.equal(store.size, 1, "only the live entry remains after a later set");
});

test("the store never holds more than its cap: the oldest entries are evicted first", () => {
  const store = pendingStore<number>(uniqueName(), { ttlMs: 60 * MINUTE_MS, maxEntries: 100 });
  for (let i = 0; i < 250; i += 1) store.set(`k-${i}`, i, at(i));

  assert.equal(store.size, 100, "the cap bounds the store");
  assert.equal(store.get("k-0", at(300)), undefined, "the oldest entry was evicted");
  assert.equal(store.get("k-249", at(300)), 249, "the newest entry is kept");
});

test("re-setting a key refreshes its lifetime", () => {
  const store = pendingStore<number>(uniqueName(), { ttlMs: 10 * MINUTE_MS, maxEntries: 10 });
  store.set("a", 1, T0);
  store.set("a", 2, at(8 * MINUTE_MS));
  assert.equal(store.get("a", at(15 * MINUTE_MS)), 2, "the second set starts a new lifetime");
});

test("two stores with the same name share one map (the process-wide singleton)", () => {
  const name = uniqueName();
  const first = pendingStore<number>(name, { ttlMs: MINUTE_MS, maxEntries: 10 });
  const second = pendingStore<number>(name, { ttlMs: MINUTE_MS, maxEntries: 10 });
  first.set("a", 7, T0);
  assert.equal(second.get("a", T0), 7);
});

test("live entries can be listed with their expiry; expired ones are skipped and forgotten", () => {
  const store = pendingStore<string>(uniqueName(), { ttlMs: 10 * MINUTE_MS, maxEntries: 10 });
  store.set("old", "a", T0);
  store.set("new", "b", at(5 * MINUTE_MS));
  assert.deepEqual(store.live(at(6 * MINUTE_MS)), [
    { key: "old", value: "a", expiresAt: at(10 * MINUTE_MS) },
    { key: "new", value: "b", expiresAt: at(15 * MINUTE_MS) },
  ]);
  assert.deepEqual(store.live(at(10 * MINUTE_MS)).map((entry) => entry.key), ["new"]);
  assert.equal(store.size, 1, "the expired entry was evicted by the listing");
});
