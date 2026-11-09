import { test } from "node:test";
import assert from "node:assert/strict";
import { createUserPushSender } from "./production";

test("generic push resolves owned subscriptions, prunes expired endpoints and never sends message content", async () => {
  const sent: string[] = [], removed: string[] = [];
  const sender = createUserPushSender({
    subscriptions: async (userId) => { assert.equal(userId, "owner"); return [
      { id: "old", endpoint: "https://push.test/old", keys: { p256dh: "x", auth: "y" } },
      { id: "good", endpoint: "https://push.test/good", keys: { p256dh: "x", auth: "y" } },
    ]; },
    remove: async (user, id) => { assert.equal(user, "owner"); removed.push(id); },
    send: async (subscription) => { sent.push(subscription.endpoint); if (subscription.endpoint.endsWith("old")) throw Object.assign(new Error("gone"), { status: 410 }); },
  });
  await sender.sendPush({ recipient: "owner", body: "personal content stays out of push", link: "https://private.test/secret" });
  assert.deepEqual(sent, ["https://push.test/old", "https://push.test/good"]);
  assert.deepEqual(removed, ["old"]);
});

test("push cannot claim delivery when no devices exist or all endpoints fail", async () => {
  const empty = createUserPushSender({ subscriptions: async () => [], remove: async () => {}, send: async () => {} });
  await assert.rejects(empty.sendPush({ recipient: "owner", body: "test" }), /device/);
  const failed = createUserPushSender({ subscriptions: async () => [{ id: "a", endpoint: "https://push.test/a", keys: { p256dh: "x", auth: "y" } }], remove: async () => {}, send: async () => { throw new Error("private endpoint token"); } });
  await assert.rejects(failed.sendPush({ recipient: "owner", body: "test" }), /^Error: Push delivery failed$/);
});
