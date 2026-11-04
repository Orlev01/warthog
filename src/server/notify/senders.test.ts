// E01-S10 — notification sender interfaces + config-driven selection
// (`src/server/notify/senders.ts`).
//
// RED-first: the module does not exist yet, so importing it throws and every
// test here fails until the implementation lands. These tests pin BEHAVIOUR
// (which senders a config selects, and where a send is routed), never the source
// text of the module.
//
// Design §10 / AC:
//   - Each channel sits behind its own interface: PushSender (sendPush),
//     EmailSender (sendEmail), SmsSender (sendSms). Each send takes a message
//     { recipient, body, link? } and resolves.
//   - A `Senders` bundle groups one of each: { push, email, sms }. Real senders
//     (Azure push/email/sms, built by later tasks) and the dev/test outbox both
//     satisfy this bundle, so the correspondence loop depends only on the bundle.
//   - Selection is driven by config: `selectSenders(config, real)` returns the
//     process-wide outbox for every channel when dev tooling is on
//     (config.devTools === true, i.e. WARTHOG_DEV_TOOLS=1), otherwise the real
//     senders it was given.
//
// Real senders are injected (dependency injection) rather than constructed here:
// that keeps senders.ts free of Azure imports and lets these tests pass plain
// fakes — no network, no Azure, no DB. The fakes below record every call so a
// test can prove a send went to the real sender (prod) and NOT to the outbox, or
// vice versa (dev).

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { selectSenders } from "./senders";
// Documentary type anchors — erased at runtime, so renames cannot break these
// tests; the runtime assertions below are what gate behaviour.
import type { Senders, PushSender, EmailSender, SmsSender, OutgoingMessage } from "./senders";

import { outbox } from "./outbox";

// A set of real-sender fakes that record what they were asked to send, so a test
// can assert routing by channel without any real Azure service.
function recordingSenders(): {
  calls: { channel: "push" | "email" | "sms"; message: OutgoingMessage }[];
  senders: Senders;
} {
  const calls: { channel: "push" | "email" | "sms"; message: OutgoingMessage }[] = [];
  const senders: Senders = {
    push: {
      async sendPush(message: OutgoingMessage): Promise<void> {
        calls.push({ channel: "push", message });
      },
    },
    email: {
      async sendEmail(message: OutgoingMessage): Promise<void> {
        calls.push({ channel: "email", message });
      },
    },
    sms: {
      async sendSms(message: OutgoingMessage): Promise<void> {
        calls.push({ channel: "sms", message });
      },
    },
  };
  return { calls, senders };
}

// ---------------------------------------------------------------------------
// Shape.
// ---------------------------------------------------------------------------

test("selectSenders is a function", () => {
  assert.equal(typeof selectSenders, "function");
});

// ---------------------------------------------------------------------------
// AC: selecting the outbox vs a real sender is driven by config — dev tooling
// on routes every channel to the shared outbox (and NOT to the real senders).
// ---------------------------------------------------------------------------

test("with devTools on, selection routes every channel to the process-wide outbox", async () => {
  const { calls, senders: real } = recordingSenders();

  const selected = selectSenders({ devTools: true }, real);

  // The selected bundle is still a full set of senders.
  assert.equal(typeof selected.push.sendPush, "function");
  assert.equal(typeof selected.email.sendEmail, "function");
  assert.equal(typeof selected.sms.sendSms, "function");

  // Unique canaries so assertions survive the shared singleton being written by
  // other tests in the suite.
  const pushTo = `dev-push-${randomUUID()}`;
  const emailTo = `dev-email-${randomUUID()}@example.com`;
  const smsTo = `dev-sms-${randomUUID()}`;

  await selected.push.sendPush({ recipient: pushTo, body: "approval-dev" });
  await selected.email.sendEmail({ recipient: emailTo, body: "email body", link: "https://warthog.com.au/a/e" });
  await selected.sms.sendSms({ recipient: smsTo, body: "sms body", link: "https://warthog.com.au/a/s" });

  // The three sends landed in the dev outbox, each on its own channel.
  const recorded = outbox.list();
  const push = recorded.find((m) => m.recipient === pushTo);
  const email = recorded.find((m) => m.recipient === emailTo);
  const sms = recorded.find((m) => m.recipient === smsTo);

  assert.equal(push?.channel, "push", "the push send was recorded in the outbox");
  assert.equal(email?.channel, "email", "the email send was recorded in the outbox");
  assert.equal(email?.link, "https://warthog.com.au/a/e");
  assert.equal(sms?.channel, "sms", "the sms send was recorded in the outbox");
  assert.equal(sms?.link, "https://warthog.com.au/a/s");

  // ...and NOT at the real senders: in dev the outbox stands in for them.
  assert.equal(calls.length, 0, "dev selection does not call the real senders");
});

// ---------------------------------------------------------------------------
// AC: with dev tooling off, selection returns the real senders — a send goes to
// the real sender and is NOT recorded in the dev outbox.
// ---------------------------------------------------------------------------

test("with devTools off, selection returns the real senders, not the outbox", async () => {
  const { calls, senders: real } = recordingSenders();

  const selected = selectSenders({ devTools: false }, real);

  const emailTo = `prod-email-${randomUUID()}@example.com`;
  const smsTo = `prod-sms-${randomUUID()}`;

  await selected.email.sendEmail({ recipient: emailTo, body: "prod email", link: "https://warthog.com.au/a/pe" });
  await selected.sms.sendSms({ recipient: smsTo, body: "prod sms", link: "https://warthog.com.au/a/ps" });

  // The real senders received the sends, with their messages intact.
  assert.deepEqual(
    calls.map((c) => c.channel),
    ["email", "sms"],
    "both sends were routed to the injected real senders",
  );
  const emailCall = calls.find((c) => c.channel === "email");
  assert.equal(emailCall?.message.recipient, emailTo);
  assert.equal(emailCall?.message.link, "https://warthog.com.au/a/pe");

  // ...and the dev outbox was NOT written: production never records to it.
  assert.equal(
    outbox.list().some((m) => m.recipient === emailTo || m.recipient === smsTo),
    false,
    "production selection does not record anything in the dev outbox",
  );
});

test("selection is driven by the flag alone: the same real senders route differently per config", async () => {
  const { calls, senders: real } = recordingSenders();

  const devSel = selectSenders({ devTools: true }, real);
  const prodSel = selectSenders({ devTools: false }, real);

  const devTo = `flag-dev-${randomUUID()}`;
  const prodTo = `flag-prod-${randomUUID()}`;

  await devSel.push.sendPush({ recipient: devTo, body: "via-dev" });
  await prodSel.push.sendPush({ recipient: prodTo, body: "via-prod" });

  // Dev send → outbox, not the real sender.
  assert.equal(
    outbox.list().some((m) => m.recipient === devTo),
    true,
    "the dev-selected send reached the outbox",
  );
  assert.equal(
    calls.some((c) => c.message.recipient === devTo),
    false,
    "the dev-selected send did not reach the real sender",
  );

  // Prod send → real sender, not the outbox.
  assert.equal(
    calls.some((c) => c.channel === "push" && c.message.recipient === prodTo),
    true,
    "the prod-selected send reached the real sender",
  );
  assert.equal(
    outbox.list().some((m) => m.recipient === prodTo),
    false,
    "the prod-selected send did not reach the outbox",
  );
});

// ---------------------------------------------------------------------------
// Compile-time documentation: each channel's fake satisfies its interface and a
// bundle of them satisfies Senders. Erased at runtime; records the intended
// structural contract for the implementer.
// ---------------------------------------------------------------------------

test("a channel fake structurally satisfies its sender interface", () => {
  const push: PushSender = { async sendPush(_m: OutgoingMessage) {} };
  const email: EmailSender = { async sendEmail(_m: OutgoingMessage) {} };
  const sms: SmsSender = { async sendSms(_m: OutgoingMessage) {} };
  const bundle: Senders = { push, email, sms };

  assert.equal(typeof bundle.push.sendPush, "function");
  assert.equal(typeof bundle.email.sendEmail, "function");
  assert.equal(typeof bundle.sms.sendSms, "function");
});
