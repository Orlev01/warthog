// E04-S16 — Auth email alerts (`src/server/auth/alerts.ts`).
//
// RED-first: the alerts module does not exist yet, so importing `./alerts`
// throws and every test here fails until the builder writes it. That absence IS
// the point of test-first — do NOT implement anything in this file or add a
// source module to make these pass.
//
// These tests pin BEHAVIOUR (what is SENT when each event fires, to whom, and
// what the delivered body may NOT contain), never the source text of the module.
// A later rename that preserves behaviour must not redden them. There is no
// browser, no Azure and no network: a genuine `users` row is created through the
// real person aggregate (db/users), alerts are recorded in the dev/test outbox
// (notify), and everything runs against an isolated in-memory PGlite with the
// real migrations (src/test/db). The outbox is a dumb recorder — it stores what
// it is handed verbatim — so a sensitive value that reached a sender WOULD show
// up here; that is exactly what the "no code / token / credential" tests probe.
//
// Why this exists (brief "Sign-up and sign-in … email alerts for a new passkey,
// a new agent connection and a sign-in from a new device"): people are told
// about security-relevant events, and — unlike the one-time-code email, which
// legitimately carries its code — these ALERTS carry no code, token or
// credential. The redaction rule is a project hard rule (a reviewer veto):
// everything that reaches an email passes through `src/domain/redaction` first,
// so any free-text an alert carries (an agent's name, a device label — both
// untrusted) is scrubbed before delivery.
//
// ── The contract this task defines (the builder implements EXACTLY this) ─────────
//
//   // Email alerts only (the brief says "email alerts"); the dev/test outbox
//   // satisfies EmailSender, so tests pass it directly. Redaction happens inside
//   // the module before the body reaches the sender.
//   interface AlertDeps { readonly emailSender: EmailSender }
//
//   alertNewPasskey(
//     db, { userId: string }, deps,
//   ): Promise<void>
//     • resolves the person by the session's `userId` (never a client value) and
//       sends exactly ONE email to that person's address telling them a new
//       passkey was added. Carries no code, token or credential.
//
//   alertNewAgentConnection(
//     db, { userId: string; agentName: string }, deps,
//   ): Promise<void>
//     • one email to the person naming the agent that connected. `agentName` is
//       untrusted free text, so it is redacted before it lands in the body.
//
//   alertNewDeviceSignIn(
//     db, { userId: string; deviceLabel: string }, deps,
//   ): Promise<void>
//     • one email to the person naming the new device that signed in.
//       `deviceLabel` is untrusted free text, so it is redacted before delivery.
//
//   The recipient is ALWAYS the address resolved from the session's `userId`
//   (member-scoped — design security rules), never an address supplied by the
//   caller: these functions take no recipient argument at all.
//
// ── Acceptance criteria → tests ──────────────────────────────────────────────────
//   AC1 "Sends an email on a new passkey, a new agent connection and a new-device
//        sign-in."
//        — each of the three functions records exactly one EMAIL in the outbox,
//          addressed to the triggering person's own email, with a non-empty body
//          that identifies its event (and the three are distinct alerts).
//   AC2 "No alert email contains a code, token or credential."
//        — no delivered alert body carries a verification-code-shaped digit run or
//          an opaque long token; and a card number planted in the untrusted
//          free-text (agent name / device label) is MASKED to its last four
//          digits before delivery (the redaction pass), the full number never
//          surviving in the email.
//
// Every db handle is closed in a `finally` so node:test leaves no open handle;
// each test uses its own `freshDb()` and a fresh outbox, so tests share no state.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { alertNewPasskey, alertNewAgentConnection, alertNewDeviceSignIn } from "./alerts";
import { freshDb } from "../../test/db";
import { createUser, type User } from "../db/users";
import { createOutbox, type Outbox } from "../notify/outbox";
import { passesLuhn } from "../../domain/redaction/luhn";
import type { Db } from "../db/index";

// A placeholder wrapped-DEK reference; createUser stores it verbatim (opaque to
// the app). We only need a genuine `users` row so an alert hangs off a real
// userId and a real email to resolve as the recipient.
const WRAPPED_DEK = "wrapped-dek-placeholder";

// A canonical Luhn-valid test PAN, in the grouped surface form a person might
// paste into a label. Its validity is asserted in-test (below) rather than
// trusted, so the card-masking tests cannot silently pass on a non-card string.
const CARD_SPACED = "4111 1111 1111 1111";
const CARD_BARE = CARD_SPACED.replace(/ /g, "");

// Create a genuine person row and return it. A unique email per call keeps two
// users in one test from colliding on the users.email UNIQUE constraint.
async function freshUser(db: Db, label: string): Promise<User> {
  return createUser(db, { email: `${label}-${randomUUID()}@warthog.com.au`, wrappedDek: WRAPPED_DEK });
}

// The email messages the outbox recorded for `recipient`, in send order.
function emailsTo(outbox: Outbox, recipient: string): { body: string; link?: string }[] {
  return outbox
    .list()
    .filter((m) => m.channel === "email" && m.recipient === recipient)
    .map((m) => ({ body: m.body, link: m.link }));
}

// AC2 — an alert body must carry no code/token/credential. These checks are
// scoped to the delivered body (the exact unit under test): a verification code
// is a standalone run of six or more digits (the one-time-code email's shape),
// and an opaque secret (session token, access key, recovery/link token) is a
// long contiguous run of token characters. A human-readable alert sentence hits
// neither; an implementer who embeds a code or token does.
function assertNoCodeOrToken(body: string): void {
  assert.ok(
    !/\d{6,}/.test(body),
    `an alert must not carry a verification-code-shaped digit run: ${JSON.stringify(body)}`,
  );
  assert.ok(
    !/[A-Za-z0-9_-]{28,}/.test(body),
    `an alert must not carry an opaque long token/credential: ${JSON.stringify(body)}`,
  );
}

// AC2 — a card number planted in untrusted free text must be masked before the
// body is delivered. Scoped to the exact PAN (bare and grouped): the full number
// must be gone and only the last four digits may remain, inside a [card …] token
// (the redaction module's masked form, either glyph). The last four legitimately
// reappear in that token, so this is never a whole-body absence check.
function assertCardMasked(body: string): void {
  const last4 = CARD_BARE.slice(-4);
  assert.ok(!body.includes(CARD_BARE), "the full (bare) card number must not survive in the alert");
  assert.ok(!body.includes(CARD_SPACED), "the full (grouped) card number must not survive in the alert");
  assert.ok(body.includes("[card "), "a detected card is masked as a [card …] token");
  assert.ok(body.includes(last4 + "]"), "the masked token reveals only the last four digits");
}

// ---------------------------------------------------------------------------
// Shape: the three event entry points exist and are callable.
// ---------------------------------------------------------------------------

test("the three alert functions are exported", () => {
  assert.equal(typeof alertNewPasskey, "function");
  assert.equal(typeof alertNewAgentConnection, "function");
  assert.equal(typeof alertNewDeviceSignIn, "function");
});

test("the test PAN really is a Luhn-valid card (so the masking tests are meaningful)", () => {
  assert.equal(passesLuhn(CARD_BARE), true, "CARD_BARE must be a valid card number for the masking tests");
});

// ---------------------------------------------------------------------------
// AC1 — each event sends exactly one email, to the triggering person's own
// address, with a non-empty, event-identifying body.
// ---------------------------------------------------------------------------

test("a new passkey sends one email to the person about a passkey", async () => {
  const db = await freshDb();
  try {
    const outbox = createOutbox();
    const person = await freshUser(db, "passkey");

    await alertNewPasskey(db, { userId: person.id }, { emailSender: outbox });

    const mail = emailsTo(outbox, person.email);
    assert.equal(mail.length, 1, "exactly one email alert is sent on a new passkey");
    assert.ok(mail[0].body.trim().length > 0, "the alert body is not empty");
    assert.match(mail[0].body, /passkey/i, "the alert names the event (a passkey was added)");
    assertNoCodeOrToken(mail[0].body);
  } finally {
    await db.close();
  }
});

test("a new agent connection sends one email to the person naming the agent", async () => {
  const db = await freshDb();
  try {
    const outbox = createOutbox();
    const person = await freshUser(db, "agent");
    const agentName = "Research Assistant";

    await alertNewAgentConnection(db, { userId: person.id, agentName }, { emailSender: outbox });

    const mail = emailsTo(outbox, person.email);
    assert.equal(mail.length, 1, "exactly one email alert is sent on a new agent connection");
    assert.ok(mail[0].body.includes(agentName), "the alert names the agent that connected");
    assertNoCodeOrToken(mail[0].body);
  } finally {
    await db.close();
  }
});

test("a new-device sign-in sends one email to the person naming the device", async () => {
  const db = await freshDb();
  try {
    const outbox = createOutbox();
    const person = await freshUser(db, "device");
    const deviceLabel = "Oren's MacBook";

    await alertNewDeviceSignIn(db, { userId: person.id, deviceLabel }, { emailSender: outbox });

    const mail = emailsTo(outbox, person.email);
    assert.equal(mail.length, 1, "exactly one email alert is sent on a new-device sign-in");
    assert.ok(mail[0].body.includes(deviceLabel), "the alert names the device that signed in");
    assertNoCodeOrToken(mail[0].body);
  } finally {
    await db.close();
  }
});

// The three events produce three DISTINCT alerts (not one generic message), so a
// person can tell a new passkey from a new agent from a new device.
test("the three events produce three distinct alert bodies", async () => {
  const db = await freshDb();
  try {
    const outbox = createOutbox();
    const person = await freshUser(db, "distinct");

    await alertNewPasskey(db, { userId: person.id }, { emailSender: outbox });
    await alertNewAgentConnection(db, { userId: person.id, agentName: "Research Assistant" }, { emailSender: outbox });
    await alertNewDeviceSignIn(db, { userId: person.id, deviceLabel: "Oren's MacBook" }, { emailSender: outbox });

    const bodies = emailsTo(outbox, person.email).map((m) => m.body);
    assert.equal(bodies.length, 3, "one email per event (three in total)");
    assert.equal(new Set(bodies).size, 3, "the three alerts are distinct messages");
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// Member-scoping — the recipient is the address resolved from the session's
// userId, never a client value (the functions take no recipient argument). An
// alert for one person is delivered to that person, not another.
// ---------------------------------------------------------------------------

test("an alert goes to the triggering person, not another account", async () => {
  const db = await freshDb();
  try {
    const outbox = createOutbox();
    const alice = await freshUser(db, "alice");
    const bob = await freshUser(db, "bob");

    await alertNewPasskey(db, { userId: alice.id }, { emailSender: outbox });

    assert.equal(emailsTo(outbox, alice.email).length, 1, "Alice's own address received the alert");
    assert.equal(emailsTo(outbox, bob.email).length, 0, "no alert was sent to the other account");
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// AC2 — redaction: a card number planted in the untrusted free-text an alert
// carries is masked to its last four digits before the email is delivered. The
// full number never survives in the alert body.
// ---------------------------------------------------------------------------

test("a card number in the agent name is masked in the delivered alert", async () => {
  const db = await freshDb();
  try {
    const outbox = createOutbox();
    const person = await freshUser(db, "agent-card");

    await alertNewAgentConnection(
      db,
      { userId: person.id, agentName: `Sketchy Bot ${CARD_SPACED}` },
      { emailSender: outbox },
    );

    const mail = emailsTo(outbox, person.email);
    assert.equal(mail.length, 1, "exactly one email alert is sent");
    assertCardMasked(mail[0].body);
  } finally {
    await db.close();
  }
});

test("a card number in the device label is masked in the delivered alert", async () => {
  const db = await freshDb();
  try {
    const outbox = createOutbox();
    const person = await freshUser(db, "device-card");

    await alertNewDeviceSignIn(
      db,
      { userId: person.id, deviceLabel: `Phone ${CARD_SPACED}` },
      { emailSender: outbox },
    );

    const mail = emailsTo(outbox, person.email);
    assert.equal(mail.length, 1, "exactly one email alert is sent");
    assertCardMasked(mail[0].body);
  } finally {
    await db.close();
  }
});
