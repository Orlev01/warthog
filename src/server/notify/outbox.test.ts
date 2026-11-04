// E01-S10 — the dev/test notification outbox (`src/server/notify/outbox.ts`).
//
// RED-first: the module does not exist yet, so importing it throws and every
// test here fails until the implementation lands. These tests pin BEHAVIOUR
// (what the outbox records when a sender method is called, and that the exported
// instance is one per process) — never the source text of the module.
//
// Design §10 / AC: "All senders sit behind an interface with a dev/test outbox
// implementation." The outbox IS that one implementation of every channel: it
// satisfies PushSender, EmailSender and SmsSender (channel-named send methods)
// and records every sent message — (channel, recipient, body/link) — into ONE
// process-wide list that dev surfaces (the `/dev/outbox` viewer) can read back.
//
// Contract these tests define:
//   createOutbox()  -> a fresh, empty outbox instance (for isolated tests). It
//                      exposes sendPush / sendEmail / sendSms (each taking a
//                      message { recipient, body, link? } and resolving) plus
//                      list(): the recorded messages, each stamped with its
//                      channel, in send order.
//   outbox          -> the process-wide singleton (one per process, not rebuilt
//                      per request) — the instance dev tooling reads.
//
// The outbox is a dumb recorder: redaction happens in the caller before anything
// reaches a sender (that is a different module/task), so the outbox stores what
// it is given, verbatim. These tests therefore do NOT assert redaction.
//
// Every send is awaited so the tests pass whether the implementation is
// synchronous (natural for an in-memory array) or async (matching real senders,
// which are Promise-returning). Tests never touch the network, Azure or a DB.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { createOutbox, outbox } from "./outbox";
// Documentary type anchors — the exact names/shapes the implementation exports.
// These are erased at runtime, so a rename cannot break these tests; the runtime
// assertions below are what actually gate behaviour.
import type { Outbox, SentMessage } from "./outbox";
import type { PushSender, EmailSender, SmsSender } from "./senders";

// ---------------------------------------------------------------------------
// Shape: a fresh outbox exposes the three channel senders and a readable list,
// and starts empty.
// ---------------------------------------------------------------------------

test("createOutbox() returns an empty outbox exposing the three channel senders and list()", () => {
  assert.equal(typeof createOutbox, "function", "createOutbox is a factory");

  const ob: Outbox = createOutbox();

  assert.equal(typeof ob.sendPush, "function", "exposes sendPush (PushSender)");
  assert.equal(typeof ob.sendEmail, "function", "exposes sendEmail (EmailSender)");
  assert.equal(typeof ob.sendSms, "function", "exposes sendSms (SmsSender)");
  assert.equal(typeof ob.list, "function", "exposes list() for dev to read");

  assert.deepEqual(ob.list(), [], "a freshly created outbox has recorded nothing");
});

// ---------------------------------------------------------------------------
// AC: the outbox records every sent message (channel, recipient, body/link).
// One test per channel pins the channel stamp and the recorded fields.
// ---------------------------------------------------------------------------

test("sendPush records one message stamped channel 'push' with its recipient and body", async () => {
  const ob = createOutbox();

  await ob.sendPush({ recipient: "push-sub-abc", body: "approval-123" });

  const sent = ob.list();
  assert.equal(sent.length, 1, "exactly one message was recorded");
  const [msg] = sent;
  assert.equal(msg.channel, "push", "the push channel is stamped from the method called");
  assert.equal(msg.recipient, "push-sub-abc", "the recipient is recorded");
  assert.equal(msg.body, "approval-123", "the body is recorded");
  assert.equal(msg.link, undefined, "a push with no link records no link");
});

test("sendEmail records one message stamped channel 'email' with recipient, body and link", async () => {
  const ob = createOutbox();

  await ob.sendEmail({
    recipient: "person@example.com",
    body: "Open the approval to continue.",
    link: "https://warthog.com.au/a/tok-email",
  });

  const sent = ob.list();
  assert.equal(sent.length, 1);
  const [msg] = sent;
  assert.equal(msg.channel, "email");
  assert.equal(msg.recipient, "person@example.com");
  assert.equal(msg.body, "Open the approval to continue.");
  assert.equal(msg.link, "https://warthog.com.au/a/tok-email");
});

test("sendSms records one message stamped channel 'sms' with recipient, body and link", async () => {
  const ob = createOutbox();

  await ob.sendSms({
    recipient: "+61400000000",
    body: "Warthog: an agent is waiting for your approval.",
    link: "https://warthog.com.au/a/tok-sms",
  });

  const sent = ob.list();
  assert.equal(sent.length, 1);
  const [msg] = sent;
  assert.equal(msg.channel, "sms");
  assert.equal(msg.recipient, "+61400000000");
  assert.equal(msg.body, "Warthog: an agent is waiting for your approval.");
  assert.equal(msg.link, "https://warthog.com.au/a/tok-sms");
});

// ---------------------------------------------------------------------------
// AC: every channel is recorded into ONE list, readable in send order.
// ---------------------------------------------------------------------------

test("messages from every channel accumulate in ONE list, in send order", async () => {
  const ob = createOutbox();

  await ob.sendPush({ recipient: "sub-1", body: "approval-1" });
  await ob.sendEmail({ recipient: "a@b.com", body: "email body", link: "https://warthog.com.au/a/e1" });
  await ob.sendSms({ recipient: "+61400111222", body: "sms body", link: "https://warthog.com.au/a/s1" });
  await ob.sendPush({ recipient: "sub-2", body: "approval-2" });

  const sent = ob.list();
  assert.equal(sent.length, 4, "all four sends landed in the single list");
  assert.deepEqual(
    sent.map((m) => m.channel),
    ["push", "email", "sms", "push"],
    "the list preserves send order across channels, in one combined stream",
  );
  assert.deepEqual(
    sent.map((m) => m.recipient),
    ["sub-1", "a@b.com", "+61400111222", "sub-2"],
  );
});

test("the outbox records recipient/body/link verbatim — it does not transform them", async () => {
  const ob = createOutbox();
  // Awkward but legitimate content: the outbox is a dumb recorder and must not
  // trim, escape or otherwise alter what it is handed.
  const recipient = "  Person O'Neil <person+tag@example.com>  ";
  const body = "Line one\nLine two — ∂ß 🚀";
  const link = "https://warthog.com.au/a/tok?x=1&y=2";

  await ob.sendEmail({ recipient, body, link });

  const [msg] = ob.list();
  assert.equal(msg.recipient, recipient, "recipient stored exactly as given");
  assert.equal(msg.body, body, "body stored exactly as given");
  assert.equal(msg.link, link, "link stored exactly as given");
});

// ---------------------------------------------------------------------------
// AC: the outbox is one process-wide list — a single shared instance, not
// re-instantiated per request. Mirrors the release-store singleton contract.
// ---------------------------------------------------------------------------

test("the module exports a single process-wide outbox instance, not a factory", () => {
  // The singleton is a ready-to-use object with the sender + list methods — not
  // a function you call to get a fresh (empty) instance per request.
  assert.equal(typeof outbox, "object", "outbox is an instance, not a function");
  assert.notEqual(outbox, null);
  assert.equal(typeof outbox.sendPush, "function");
  assert.equal(typeof outbox.sendEmail, "function");
  assert.equal(typeof outbox.sendSms, "function");
  assert.equal(typeof outbox.list, "function");
});

test("the singleton keeps one shared state across re-imports (one per process)", async () => {
  // A unique recipient so this never collides with any other message put through
  // the shared singleton by another test in the suite.
  const canary = `singleton-${randomUUID()}@example.com`;
  await outbox.sendEmail({ recipient: canary, body: "shared-state", link: "https://warthog.com.au/a/x" });

  // Re-importing the module must yield the SAME object (ESM caches it): a message
  // recorded through one reference is visible through another, proving the outbox
  // is a single shared instance, not rebuilt per import/request.
  const again = await import("./outbox");
  assert.equal(again.outbox, outbox, "re-importing returns the same singleton object");

  const seen = again.outbox.list().filter((m) => m.recipient === canary);
  assert.equal(seen.length, 1, "the message recorded via one reference is visible via another");
  assert.equal(seen[0]?.channel, "email");
});

test("a freshly created outbox is independent of the process-wide singleton", async () => {
  // Seed the singleton, then prove a fresh instance neither starts with that
  // state nor leaks its own state back into the singleton.
  const seed = `seed-${randomUUID()}`;
  await outbox.sendPush({ recipient: seed, body: "in-singleton" });

  const fresh = createOutbox();
  assert.deepEqual(fresh.list(), [], "a fresh outbox starts empty regardless of singleton state");

  const isolated = `isolated-${randomUUID()}`;
  await fresh.sendPush({ recipient: isolated, body: "in-fresh-only" });

  assert.equal(fresh.list().length, 1, "the fresh outbox recorded its own message");
  assert.equal(
    outbox.list().some((m) => m.recipient === isolated),
    false,
    "a message recorded in a separate instance never appears in the singleton",
  );
});

// ---------------------------------------------------------------------------
// Compile-time documentation: the outbox satisfies each channel's sender
// interface. Erased at runtime (so it cannot redden a run for the wrong reason);
// it records the intended structural relationship for the implementer.
// ---------------------------------------------------------------------------

test("the outbox structurally serves as each channel's sender", () => {
  const ob = createOutbox();
  const asPush: PushSender = ob;
  const asEmail: EmailSender = ob;
  const asSms: SmsSender = ob;
  const asRecorded: readonly SentMessage[] = ob.list();

  assert.equal(typeof asPush.sendPush, "function");
  assert.equal(typeof asEmail.sendEmail, "function");
  assert.equal(typeof asSms.sendSms, "function");
  assert.ok(Array.isArray(asRecorded));
});
