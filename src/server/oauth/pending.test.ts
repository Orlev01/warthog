// Operator review (E10-S12): a pending authorization (the request waiting on the consent screen)
// expires after ten minutes, so abandoned requests cannot pile up in memory or be approved late.
import { test } from "node:test";
import assert from "node:assert/strict";

import { consumePendingAuthorization, getPendingAuthorization, putPendingAuthorization, PENDING_TTL_MS } from "./pending";
import { fixedRandom } from "../seams/random";

test("a pending authorization is readable within its lifetime and gone after it", () => {
  let now = 1_000_000;
  const clock = () => now;
  const handle = putPendingAuthorization(new URLSearchParams({ client_id: "c1" }), fixedRandom(11), clock);
  assert.equal(getPendingAuthorization(handle, clock)?.params.get("client_id"), "c1");
  now += PENDING_TTL_MS + 1;
  assert.equal(getPendingAuthorization(handle, clock), null, "an expired request reads as absent");
  assert.equal(consumePendingAuthorization(handle, clock), null, "an expired request cannot be consumed");
});

test("a pending authorization is consumed exactly once", () => {
  const handle = putPendingAuthorization(new URLSearchParams({ client_id: "c2" }), fixedRandom(12));
  assert.equal(consumePendingAuthorization(handle)?.params.get("client_id"), "c2");
  assert.equal(consumePendingAuthorization(handle), null);
});
