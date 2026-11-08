// Operator review (E10-S12): a pending authorization (the request waiting on the consent screen)
// expires after ten minutes, so abandoned requests cannot pile up in memory or be approved late.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  consumePendingAuthorization,
  getPendingAuthorization,
  MAX_PENDING_AUTHORIZATIONS,
  pendingAuthorizationCount,
  putPendingAuthorization,
  PENDING_TTL_MS,
} from "./pending";
import { fixedRandom, systemRandom } from "../seams/random";

// The signed-in people a pending request can belong to.
const ALICE = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";

test("a pending authorization is readable within its lifetime and gone after it", () => {
  let now = 1_000_000;
  const clock = () => now;
  const handle = putPendingAuthorization(new URLSearchParams({ client_id: "c1" }), ALICE, fixedRandom(11), clock);
  assert.equal(getPendingAuthorization(handle, ALICE, clock)?.params.get("client_id"), "c1");
  now += PENDING_TTL_MS + 1;
  assert.equal(getPendingAuthorization(handle, ALICE, clock), null, "an expired request reads as absent");
  assert.equal(consumePendingAuthorization(handle, ALICE, clock), null, "an expired request cannot be consumed");
});

test("a pending authorization is consumed exactly once", () => {
  const handle = putPendingAuthorization(new URLSearchParams({ client_id: "c2" }), ALICE, fixedRandom(12));
  assert.equal(consumePendingAuthorization(handle, ALICE)?.params.get("client_id"), "c2");
  assert.equal(consumePendingAuthorization(handle, ALICE), null);
});

// Review fix (DCR/pending finding) — the pending store is bounded: past the cap the
// OLDEST waiting request is dropped, so no account can grow the process heap without
// limit by opening authorize requests.
test("the pending store never holds more than its cap; the oldest request is dropped first", () => {
  let now = 5_000_000;
  const clock = () => now;
  const first = putPendingAuthorization(new URLSearchParams({ client_id: "oldest" }), ALICE, fixedRandom(21), clock);
  for (let i = 0; i < MAX_PENDING_AUTHORIZATIONS; i++) {
    now += 1;
    putPendingAuthorization(new URLSearchParams({ client_id: `c${i}` }), ALICE, systemRandom, clock);
  }
  assert.ok(pendingAuthorizationCount() <= MAX_PENDING_AUTHORIZATIONS, "the store stays within its cap");
  assert.equal(getPendingAuthorization(first, ALICE, clock), null, "the oldest request made room");
});

// Review fix W3.4 — a pending request belongs to the person who started it. If someone
// signs out and another person signs in on the same browser while the consent cookie is
// still set, the second person can neither see nor decide the first person's request; the
// request stays usable for its owner.
test("a pending authorization is bound to the person who started it", () => {
  const handle = putPendingAuthorization(new URLSearchParams({ client_id: "bound" }), ALICE, fixedRandom(31));
  assert.equal(getPendingAuthorization(handle, BOB), null, "another person cannot read it");
  assert.equal(consumePendingAuthorization(handle, BOB), null, "another person cannot consume it");
  assert.equal(getPendingAuthorization(handle, ALICE)?.params.get("client_id"), "bound", "it is still there for its owner");
  assert.equal(consumePendingAuthorization(handle, ALICE)?.params.get("client_id"), "bound", "and its owner can decide it");
});
