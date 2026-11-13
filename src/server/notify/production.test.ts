import { test } from "node:test";
import assert from "node:assert/strict";
import { createUserPushSender, notificationSenders } from "./production";
import { SIGN_IN_REQUESTS_PATH } from "../auth/sign-in-requests-path";
import { loadConfig } from "../config";
import { outbox } from "./outbox";

test("SMS-off sender refuses direct sends in development and production without database or network access", async () => {
  const config = loadConfig({ PUBLIC_BASE_URL: "https://app.example.test", WEBAUTHN_RP_ID: "app.example.test",
    DATABASE_URL: "pglite:memory", WARTHOG_HMAC_KEY: Buffer.alloc(32, 1).toString("base64"),
    WARTHOG_DEV_KEK: Buffer.alloc(32, 2).toString("base64"), SMS_ENABLED: "false" });
  for (const devTools of [true, false]) {
    const senders = notificationSenders({ ...config, devTools });
    assert.equal(senders.sms.enabled, false);
    await assert.rejects(senders.sms.sendSms({ recipient: "+61412345678", body: "test" }), /^Error: SMS is disabled$/);
    if (devTools) {
      const before = outbox.list().length;
      await senders.email.sendEmail({ recipient: "test@example.test", body: "email remains available" });
      assert.equal(outbox.list().length, before + 1);
    }
  }
});

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


test("record reminders carry only a validated opaque target and reject arbitrary links", async () => {
  const payloads: unknown[] = [];
  const sender = createUserPushSender({
    subscriptions: async () => [{ id: "device", endpoint: "https://push.test/a", keys: { p256dh: "x", auth: "y" } }],
    remove: async () => {}, send: async (_subscription, target) => { payloads.push(target); },
  });
  const recordId = "d7d57ea2-50ea-4ed7-b234-66eb47957b38";
  for (const tab of ["subscriptions", "receipts", "renewals"]) {
    await sender.sendPush({ recipient: "owner", body: "private insurance content", link: `/life-admin?view=life&tab=${tab}#record-${recordId}` });
    assert.deepEqual(payloads.at(-1), { recordId, recordTab: tab });
  }
  for (const link of [`https://evil.test/life-admin?view=life&tab=receipts#record-${recordId}`, `/life-admin?view=life&tab=receipts&secret=private#record-${recordId}`, "/life-admin?view=life&tab=__proto__#record-bad", undefined]) {
    await sender.sendPush({ recipient: "owner", body: "private content", link });
    assert.equal(payloads.at(-1), undefined);
  }
});

test("a sign-in request push carries only the fixed sign-in-requests kind, never an id", async () => {
  const payloads: unknown[] = [];
  const sender = createUserPushSender({
    subscriptions: async () => [{ id: "device", endpoint: "https://push.test/a", keys: { p256dh: "x", auth: "y" } }],
    remove: async () => {}, send: async (_subscription, target) => { payloads.push(target); },
  });
  await sender.sendPush({ recipient: "owner", body: "A new device wants to sign in", link: SIGN_IN_REQUESTS_PATH });
  assert.deepEqual(payloads.at(-1), { kind: "sign-in-requests" });
  for (const link of [`${SIGN_IN_REQUESTS_PATH}?request=abc`, `https://evil.test${SIGN_IN_REQUESTS_PATH}`]) {
    await sender.sendPush({ recipient: "owner", body: "x", link });
    assert.equal(payloads.at(-1), undefined, "only the exact path routes; anything else is dropped");
  }
});

test("the production email sender brands every email with the logo hosted on the public base URL", async () => {
  const config = loadConfig({ PUBLIC_BASE_URL: "https://app.example.test", WEBAUTHN_RP_ID: "app.example.test",
    DATABASE_URL: "pglite:memory", WARTHOG_HMAC_KEY: Buffer.alloc(32, 1).toString("base64"),
    WARTHOG_DEV_KEK: Buffer.alloc(32, 2).toString("base64"), SMS_ENABLED: "false",
    RESEND_API_KEY: "re_synthetic", RESEND_FROM_ADDRESS: "notifications@mail.example.test",
    RESEND_SENDING_DOMAIN: "mail.example.test", RESEND_REPLY_TO_ADDRESS: "operator@support.example.test" });
  const realFetch = globalThis.fetch;
  let payload: Record<string, unknown> | undefined;
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    payload = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ id: "synthetic" }));
  }) as typeof fetch;
  try {
    await notificationSenders({ ...config, devTools: false }).email.sendEmail({ recipient: "person@example.test", body: "Hello",
      email: { subject: "New passkey added", heading: "A new passkey was added", paragraphs: ["A new passkey was added."] } });
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(payload?.subject, "New passkey added");
  assert.match(String(payload?.html), /<img src="https:\/\/app\.example\.test\/icons\/icon-192\.png"[^>]*alt="Warthog"/);
  assert.match(String(payload?.text), /A new passkey was added\./);
});
