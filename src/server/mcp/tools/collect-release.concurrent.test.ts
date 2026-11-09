import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { createReleaseStore } from "../../crypto/release-store";
import { createCollectReleaseTool, releaseKeyFor } from "./collect-release";

test("two pending approvals for one connection are independently collected once", async () => {
  const connection = { userId: randomUUID(), connectionId: randomUUID(), agentId: randomUUID(), active: true };
  const first = randomUUID();
  const second = randomUUID();
  const store = createReleaseStore({ now: () => new Date() });
  store.put(releaseKeyFor(connection, first), "first synthetic secret");
  store.put(releaseKeyFor(connection, second), "second synthetic secret");
  const tool = createCollectReleaseTool({ releaseStore: store });
  assert.deepEqual(await tool.handle({ approval_id: randomUUID() }, connection), { status: "gone" });
  assert.deepEqual(await tool.handle({ approval_id: first }, { ...connection, connectionId: randomUUID() }), { status: "gone" });
  assert.deepEqual(await tool.handle({ approval_id: first }, connection), { status: "collected", value: "first synthetic secret" });
  assert.deepEqual(await tool.handle({ approval_id: first }, connection), { status: "gone" });
  assert.deepEqual(await tool.handle({ approval_id: second }, connection), { status: "collected", value: "second synthetic secret" });
  assert.equal(store.size(), 0);
});

test("an approval ID is required before touching the store", async () => {
  const store = createReleaseStore({ now: () => new Date() });
  const tool = createCollectReleaseTool({ releaseStore: store });
  const connection = { userId: randomUUID(), connectionId: randomUUID(), agentId: randomUUID(), active: true };
  await assert.rejects(() => tool.handle({}, connection));
  await assert.rejects(() => tool.handle({ approval_id: "not-an-id" }, connection));
});
