import { test } from "node:test";
import assert from "node:assert/strict";
import { createPendingConnectStore } from "./pending";

test("connector state is single use, bound to both user and initiating session, and expires", () => {
  let now = 1000;
  const store = createPendingConnectStore(() => now);
  const flow = { connectorId: "google-gmail", accountLabel: "Gmail", codeVerifier: "private-verifier" };
  store.put("user", "session", "unguessable-state", flow);
  assert.equal(store.take("other", "session", "unguessable-state"), null);
  assert.equal(store.take("user", "other-session", "unguessable-state"), null);
  assert.deepEqual(store.take("user", "session", "unguessable-state"), flow);
  assert.equal(store.take("user", "session", "unguessable-state"), null);
  store.put("user", "session", "expiring-state", flow);
  now += 600_001;
  assert.equal(store.take("user", "session", "expiring-state"), null);
});

test("pending connections are bounded per user and globally without evicting unrelated flows", () => {
  const store = createPendingConnectStore(() => 1000, { perUser: 2, total: 3 });
  const flow = { connectorId: "google-gmail", accountLabel: "Gmail", codeVerifier: "private-verifier" };
  store.put("a", "s", "one", flow); store.put("a", "s", "two", flow);
  assert.throws(() => store.put("a", "s", "three", flow), /many/);
  store.put("b", "s", "three", flow);
  assert.throws(() => store.put("c", "s", "four", flow), /many/);
  assert.deepEqual(store.take("a", "s", "one"), flow);
});
