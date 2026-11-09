// E12-S08 — Approval fallback job (`src/server/notify/fallback-job.ts`), design §10
// Notifications; brief NFR:
//   "IF a person has no registered push device, or an approval has not been opened within
//    the person's fallback delay (default 2 minutes), THEN THE SYSTEM SHALL send one SMS to
//    the verified mobile number (if any) and one email (unless the person switched email
//    fallback off), each containing a single-use link that expires after 10 minutes and
//    opens the approval only after sign-in."
//
// RED-first: `./fallback-job` does not exist yet, so importing `runApprovalFallback` throws
// and every test here fails until the builder writes the minimum code to pass. That absence
// IS the point of test-first; do NOT implement anything to make these pass — the builder
// writes `fallback-job.ts` (and whatever idempotency marker it needs) afterwards.
//
// These tests pin BEHAVIOUR (what the job DOES at the fallback time: when it sends vs stays
// silent, who the SMS and email reach, that each carries a single-use 10-minute link, that a
// second run sends nothing more, that it stays within the approval owner's scope and
// parameter-binds / shape-guards its input), never the source text of any module — a later
// rename that preserves behaviour must not redden them. Every piece of state the job reads is
// set up through ALREADY-BUILT, tested seams: the approvals store (`createApproval`,
// `decide`), opened-tracking (`markOpened`), the verified-number store (`addMobileNumber` +
// `verifyMobileNumber`), the notification-prefs store (`saveNotificationPrefs`) and the users
// store (`createUser`). The senders are spies, so "sent vs not" and "what the message
// carried" are observed directly; the single-use link is proven by REDEEMING it through the
// real `redeemApprovalLink`. No network, no Azure.
//
// ---------------------------------------------------------------------------
// THE PINNED CONTRACT (chosen by the tester; the implementation conforms to it).
//
//   interface ApprovalFallbackDeps {
//     db: Db;                 // the parameterizing db seam (approvals / opened / numbers /
//                             // prefs / users / links)
//     clock: Clock;           // the current instant — the link's 10-minute expiry is
//                             // computed from it (never Date.now())
//     random: Random;         // entropy for the single-use link token (INJECTED)
//     senders: Senders;       // the CONFIGURED sender bundle; only .email / .sms are used
//     publicBaseUrl: string;  // the configured public address (warthog.com.au) the
//                             // single-use link is built on — from config, never hard-coded
//                             // in the module (project rule 21; INV-103 — injected, no env)
//   }
//
//   interface ApprovalFallbackInput {
//     approvalId: string;     // the approval the enqueued job carries (its `payload.approvalId`)
//   }
//
//   runApprovalFallback(deps, input): Promise<void>
//     • At the fallback time, IF the approval is still unopened (opened_at IS NULL AND still
//       pending — i.e. `isUnopened`): issue ONE single-use link (256-bit token, 10-minute
//       expiry) and send ONE SMS to the owner's VERIFIED number (if any) AND ONE email to the
//       owner's address (unless the owner switched email fallback off), each carrying that
//       link. Otherwise (already opened, or already decided) send NOTHING.
//     • Idempotent: a second run over the same state sends nothing more (no extra SMS, no
//       extra email, no second link) — the marker, not `isUnopened`, is what suppresses it.
//     • The message carries the single-use link but NO approval detail (personal content):
//       the job never loads the (DEK-encrypted) detail.
//     • Member scope: the SMS and email reach the APPROVAL OWNER's number / address, resolved
//       from the approval — never another person's.
//     • `approvalId` is shape-guarded at the boundary: an empty, oversized or otherwise
//       malformed (non-uuid) id is rejected with a 4xx BEFORE any query runs, so an
//       injection-shaped value never reaches `WHERE id = $1` (OBS-049) and cannot alter a
//       query — every real value is bound as a parameter, never concatenated.
//
// Acceptance criteria → tests:
//   AC1  unopened ⇒ one SMS (only if a verified number exists) + one email (unless off),
//        each carrying a single-use link that expires in 10 minutes and redeems exactly once.
//   AC2  already opened OR already decided ⇒ sends nothing (and issues no link).
//   AC3  idempotent ⇒ a second run over the same state sends nothing more.
//   OBL  [validate-and-parameterize-input] a malformed / oversized id is rejected with a 4xx
//        (nothing sent, no link issued); a SQL-injection-shaped id is rejected and the tables
//        are intact (the probe cannot alter a query — values are bound, the id is shape-guarded).
//   OBL  [secrets-from-env] the job holds no secret and needs no ambient config — it works
//        purely from its injected db / clock / random / senders / publicBaseUrl + input.
//
// Every db handle is closed in a `finally` so node:test leaves no open handle; each test uses
// its own `freshDb()` (an isolated in-memory PGlite with the real migrations), so tests share
// no state.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";

import { runApprovalFallback } from "./fallback-job";
import type { Senders, SmsSender, OutgoingMessage } from "./senders";
import { createApproval, decide } from "../db/approvals";
import { markOpened } from "../approvals/opened";
import { redeemApprovalLink } from "../db/approval-links";
import { addMobileNumber, verifyMobileNumber } from "../db/mobile-numbers";
import { saveNotificationPrefs } from "../db/notification-prefs";
import { createUser } from "../db/users";
import { freshDb } from "../../test/db";
import { fixedClock, type Clock } from "../seams/clock";
import { fixedRandom, systemRandom } from "../seams/random";
import type { Db } from "../db/index";

// --- fixtures ----------------------------------------------------------------------

const DEK_BYTES = 32; // a 256-bit per-person data key (only needed to create an approval)
const MINUTE_MS = 60_000;
const LINK_TTL_MS = 10 * MINUTE_MS; // design §10: a single-use link expires ten minutes after issue

// The configured public address the single-use link is built on. Injected (never hard-coded
// in the module), so a test can prove the link is rooted at the configured address.
const PUBLIC_BASE_URL = "https://warthog.example.test";

// The key the verified-number store stores code HMACs under — the test's own, consistent
// across add + verify. The fallback job itself needs NO hmac key (it reads only the
// `verified` flag), so this never reaches its deps.
const HMAC_KEY = randomBytes(32);

// The frozen instant most tests read time through. Mid-month noon UTC, so the link expiry
// arithmetic is unambiguous.
const NOW = new Date("2026-11-15T12:00:00.000Z");

// Compare the MOMENT, not the representation: a stored timestamptz may come back as a Date or
// an ISO string — either is fine and must not redden a test.
const toMs = (value: unknown): number => new Date(value as string | number | Date).getTime();

// Create a person and return their id, their email (the email fallback's recipient) and the
// data key an approval's detail is encrypted under. The wrapped DEK handed to createUser is an
// opaque stand-in (createUser never reads it).
async function makePerson(
  db: Db,
  who: string,
): Promise<{ userId: string; email: string; dek: Uint8Array }> {
  const dek = randomBytes(DEK_BYTES);
  const email = `${who}-${randomUUID()}@warthog.com.au`;
  const user = await createUser(db, {
    email,
    wrappedDek: Buffer.from(`wrapped-dek-${who}`).toString("base64"),
  });
  return { userId: user.id, email, dek };
}

// Create a PENDING, UNOPENED approval owned by `userId` and return its id. The detail is
// DEK-encrypted personal content the fallback job must NEVER surface in a message.
async function createPendingApproval(
  db: Db,
  userId: string,
  dek: Uint8Array,
  clock: Clock,
  detail: Record<string, unknown> = { recipient: "someone@example.com", amount: 42 },
): Promise<string> {
  const approval = await createApproval(
    db,
    { userId, agentId: randomUUID(), detail },
    dek,
    clock,
  );
  return approval.id;
}

// Add a VERIFIED mobile number for `userId` through the real flow: add it (which delivers a
// 6-digit code by SMS), read the code back out of that delivery, and verify with it. Returns
// the number so a test can prove the fallback SMS reached exactly it.
async function addVerifiedNumber(
  db: Db,
  userId: string,
  number: string,
  clock: Clock,
): Promise<string> {
  const delivered: OutgoingMessage[] = [];
  const smsSender: SmsSender = {
    async sendSms(message: OutgoingMessage): Promise<void> {
      delivered.push(message);
    },
  };
  const stored = await addMobileNumber(
    db,
    { userId, number },
    { clock, random: systemRandom, hmacKey: HMAC_KEY, smsSender },
  );
  const code = /(\d{6})/.exec(delivered[0]?.body ?? "")?.[1];
  assert.ok(code, "fixture: the add step delivered a 6-digit verification code by SMS");
  const result = await verifyMobileNumber(
    db,
    { userId, id: stored.id, code },
    { clock, hmacKey: HMAC_KEY },
  );
  assert.ok(result.ok, "fixture: the number was verified for the test");
  await db.query("INSERT INTO notification_prefs (user_id, sms_fallback) VALUES ($1, true) ON CONFLICT (user_id) DO UPDATE SET sms_fallback = true", [userId]);
  return number;
}

// Add an UNVERIFIED mobile number (added but never verified) for `userId`.
async function addUnverifiedNumber(db: Db, userId: string, number: string, clock: Clock): Promise<void> {
  const smsSender: SmsSender = { async sendSms(): Promise<void> {} };
  await addMobileNumber(db, { userId, number }, { clock, random: systemRandom, hmacKey: HMAC_KEY, smsSender });
}

// A sender bundle whose email / sms / push channels record every message they are handed, so
// "sent vs not" and "what the message carried" are observed directly. The push channel is
// never used by the fallback job (it is the notifier's concern) — it is present only because
// the bundle type requires it.
function recordingSenders(): {
  senders: Senders;
  email: OutgoingMessage[];
  sms: OutgoingMessage[];
  push: OutgoingMessage[];
} {
  const email: OutgoingMessage[] = [];
  const sms: OutgoingMessage[] = [];
  const push: OutgoingMessage[] = [];
  const senders: Senders = {
    push: {
      async sendPush(message: OutgoingMessage): Promise<void> {
        push.push(message);
      },
    },
    email: {
      async sendEmail(message: OutgoingMessage): Promise<void> {
        email.push(message);
      },
    },
    sms: {
      async sendSms(message: OutgoingMessage): Promise<void> {
        sms.push(message);
      },
    },
  };
  return { senders, email, sms, push };
}

// Read back the single-use link rows issued for one approval (matched by approval id, bound as
// a parameter), so a test can prove exactly one link was issued and read its expiry.
async function linksFor(
  db: Db,
  approvalId: string,
): Promise<{ expiresAt: unknown; usedAt: unknown }[]> {
  const result = await db.query(
    "SELECT expires_at, used_at FROM approval_links WHERE approval_id = $1",
    [approvalId],
  );
  return result.rows.map((row) => ({ expiresAt: row.expires_at, usedAt: row.used_at }));
}

// ===========================================================================
// AC1 — at the fallback time, while the approval is still unopened: one SMS to the verified
// number (if any) and one email (unless off), each carrying a single-use 10-minute link.
// ===========================================================================

test("unopened ⇒ one SMS to the verified number and one email, each with a single-use link", async () => {
  const db = await freshDb();
  try {
    const clock = fixedClock(NOW);
    const { userId, email, dek } = await makePerson(db, "ac1-both");
    const number = await addVerifiedNumber(db, userId, "+61400111222", clock);
    const approvalId = await createPendingApproval(db, userId, dek, clock);

    const { senders, email: emails, sms } = recordingSenders();

    await runApprovalFallback(
      { db, clock, random: systemRandom, senders, publicBaseUrl: PUBLIC_BASE_URL },
      { approvalId },
    );

    // Exactly one SMS, to the verified number, carrying a link.
    assert.equal(sms.length, 1, "exactly one SMS is sent");
    assert.equal(sms[0]!.recipient, number, "the SMS goes to the person's verified number");
    assert.equal(typeof sms[0]!.link, "string");
    assert.ok((sms[0]!.link ?? "").startsWith(PUBLIC_BASE_URL), "the SMS link is rooted at the configured public address");

    // Exactly one email, to the person's address, carrying a link.
    assert.equal(emails.length, 1, "exactly one email is sent");
    assert.equal(emails[0]!.recipient, email, "the email goes to the person's address");
    assert.equal(typeof emails[0]!.link, "string");
    assert.ok((emails[0]!.link ?? "").startsWith(PUBLIC_BASE_URL), "the email link is rooted at the configured public address");

    // ONE single-use link, shared by both messages (design §10: "a single-use link token").
    const links = await linksFor(db, approvalId);
    assert.equal(links.length, 1, "exactly one single-use link is issued for the approval");
    assert.equal(sms[0]!.link, emails[0]!.link, "the SMS and the email carry the SAME single-use link");
  } finally {
    await db.close();
  }
});

test("the single-use link expires in ten minutes and redeems exactly once", async () => {
  const db = await freshDb();
  try {
    const clock = fixedClock(NOW);
    const { userId, dek } = await makePerson(db, "ac1-link");
    await addVerifiedNumber(db, userId, "+61400333444", clock);
    const approvalId = await createPendingApproval(db, userId, dek, clock);

    // A deterministic token so the test knows exactly what the single-use link must carry: the
    // store draws base64url(randomBytes(32)); a fixed byte makes that value computable here.
    const TOKEN_BYTE = 5;
    const expectedToken = Buffer.from(new Uint8Array(32).fill(TOKEN_BYTE)).toString("base64url");

    const { senders, email: emails, sms } = recordingSenders();

    await runApprovalFallback(
      { db, clock, random: fixedRandom(TOKEN_BYTE), senders, publicBaseUrl: PUBLIC_BASE_URL },
      { approvalId },
    );

    assert.equal(sms.length, 1);
    assert.equal(emails.length, 1);
    assert.ok((sms[0]!.link ?? "").includes(expectedToken), "the SMS link carries the single-use token");
    assert.ok((emails[0]!.link ?? "").includes(expectedToken), "the email link carries the single-use token");

    // The stored link expires exactly ten minutes after the issue instant.
    const links = await linksFor(db, approvalId);
    assert.equal(links.length, 1);
    assert.equal(
      toMs(links[0]!.expiresAt),
      NOW.getTime() + LINK_TTL_MS,
      "the single-use link expires ten minutes after it is issued",
    );

    // It is a genuine single-use link: redeeming it resolves to THIS approval, exactly once.
    const first = await redeemApprovalLink(db, { token: expectedToken }, { clock });
    assert.deepEqual(first, { ok: true, approvalId }, "the link redeems to the approval it opens");
    const second = await redeemApprovalLink(db, { token: expectedToken }, { clock });
    assert.equal(second.ok, false, "a second redemption of the same link is rejected (single-use)");
  } finally {
    await db.close();
  }
});

test("unopened with NO verified number ⇒ no SMS, but still one email", async () => {
  const db = await freshDb();
  try {
    const clock = fixedClock(NOW);
    const { userId, email, dek } = await makePerson(db, "ac1-nonumber");
    const approvalId = await createPendingApproval(db, userId, dek, clock);

    const { senders, email: emails, sms } = recordingSenders();

    await runApprovalFallback(
      { db, clock, random: systemRandom, senders, publicBaseUrl: PUBLIC_BASE_URL },
      { approvalId },
    );

    assert.equal(sms.length, 0, "no verified number ⇒ no SMS is sent");
    assert.equal(emails.length, 1, "the email is still sent");
    assert.equal(emails[0]!.recipient, email);
  } finally {
    await db.close();
  }
});

test("unopened with only an UNVERIFIED number ⇒ no SMS (the SMS goes only to a verified number)", async () => {
  const db = await freshDb();
  try {
    const clock = fixedClock(NOW);
    const { userId, dek } = await makePerson(db, "ac1-unverified");
    await addUnverifiedNumber(db, userId, "+61400555666", clock);
    const approvalId = await createPendingApproval(db, userId, dek, clock);

    const { senders, email: emails, sms } = recordingSenders();

    await runApprovalFallback(
      { db, clock, random: systemRandom, senders, publicBaseUrl: PUBLIC_BASE_URL },
      { approvalId },
    );

    assert.equal(sms.length, 0, "an unverified number is never texted");
    assert.equal(emails.length, 1, "the email is still sent");
  } finally {
    await db.close();
  }
});

test("unopened with email fallback switched OFF ⇒ one SMS but no email", async () => {
  const db = await freshDb();
  try {
    const clock = fixedClock(NOW);
    const { userId, dek } = await makePerson(db, "ac1-emailoff");
    const number = await addVerifiedNumber(db, userId, "+61400777888", clock);
    const saved = await saveNotificationPrefs(db, { userId, emailFallback: false, smsFallback: true, fallbackDelayMinutes: 2 });
    assert.ok(saved.ok, "fixture: the email-off preference was saved");
    const approvalId = await createPendingApproval(db, userId, dek, clock);

    const { senders, email: emails, sms } = recordingSenders();

    await runApprovalFallback(
      { db, clock, random: systemRandom, senders, publicBaseUrl: PUBLIC_BASE_URL },
      { approvalId },
    );

    assert.equal(emails.length, 0, "email fallback is off ⇒ no email is sent");
    assert.equal(sms.length, 1, "the SMS is still sent when email is off");
    assert.equal(sms[0]!.recipient, number);
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC2 — already opened, or already decided: send NOTHING (and issue no link).
// ===========================================================================

test("already opened ⇒ sends nothing and issues no link", async () => {
  const db = await freshDb();
  try {
    const clock = fixedClock(NOW);
    const { userId, dek } = await makePerson(db, "ac2-opened");
    await addVerifiedNumber(db, userId, "+61400999000", clock);
    const approvalId = await createPendingApproval(db, userId, dek, clock);

    // The person has viewed the approval — the fallback is suppressed.
    const marked = await markOpened(db, { id: approvalId, userId }, clock);
    assert.ok(marked, "fixture: the approval was marked opened");

    const { senders, email: emails, sms } = recordingSenders();

    await runApprovalFallback(
      { db, clock, random: systemRandom, senders, publicBaseUrl: PUBLIC_BASE_URL },
      { approvalId },
    );

    assert.equal(sms.length, 0, "an opened approval triggers no SMS");
    assert.equal(emails.length, 0, "an opened approval triggers no email");
    assert.equal((await linksFor(db, approvalId)).length, 0, "an opened approval issues no single-use link");
  } finally {
    await db.close();
  }
});

test("already decided ⇒ sends nothing and issues no link", async () => {
  const db = await freshDb();
  try {
    const clock = fixedClock(NOW);
    const { userId, dek } = await makePerson(db, "ac2-decided");
    await addVerifiedNumber(db, userId, "+61401111222", clock);
    const approvalId = await createPendingApproval(db, userId, dek, clock);

    // The approval was decided before the fallback fired (denied, never opened).
    await decide(db, { userId, id: approvalId, decision: { status: "denied" } }, dek, clock);

    const { senders, email: emails, sms } = recordingSenders();

    await runApprovalFallback(
      { db, clock, random: systemRandom, senders, publicBaseUrl: PUBLIC_BASE_URL },
      { approvalId },
    );

    assert.equal(sms.length, 0, "a decided approval triggers no SMS");
    assert.equal(emails.length, 0, "a decided approval triggers no email");
    assert.equal((await linksFor(db, approvalId)).length, 0, "a decided approval issues no single-use link");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC3 — idempotent: a second run over the same (still-unopened) state sends nothing more.
// ===========================================================================

test("idempotent: a second run over the same unopened state sends nothing more", async () => {
  const db = await freshDb();
  try {
    const clock = fixedClock(NOW);
    const { userId, dek } = await makePerson(db, "ac3-idempotent");
    await addVerifiedNumber(db, userId, "+61402222333", clock);
    const approvalId = await createPendingApproval(db, userId, dek, clock);

    const { senders, email: emails, sms } = recordingSenders();

    // Two runs, with the approval left UNOPENED between them: the suppression must come from
    // the job's own record of having fired, not from the approval changing state.
    await runApprovalFallback(
      { db, clock, random: systemRandom, senders, publicBaseUrl: PUBLIC_BASE_URL },
      { approvalId },
    );
    await runApprovalFallback(
      { db, clock, random: systemRandom, senders, publicBaseUrl: PUBLIC_BASE_URL },
      { approvalId },
    );

    assert.equal(sms.length, 1, "a second run sends no additional SMS");
    assert.equal(emails.length, 1, "a second run sends no additional email");
    assert.equal((await linksFor(db, approvalId)).length, 1, "a second run issues no additional link");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// Security — member scope: the SMS and email reach the APPROVAL OWNER's number / address,
// resolved from the approval, never another person's.
// ===========================================================================

test("delivers only to the approval owner's number and email — never another person's", async () => {
  const db = await freshDb();
  try {
    const clock = fixedClock(NOW);
    const owner = await makePerson(db, "sec-owner");
    const other = await makePerson(db, "sec-other");

    const ownerNumber = await addVerifiedNumber(db, owner.userId, "+61403000111", clock);
    const otherNumber = await addVerifiedNumber(db, other.userId, "+61403999888", clock);

    const approvalId = await createPendingApproval(db, owner.userId, owner.dek, clock);

    const { senders, email: emails, sms } = recordingSenders();

    await runApprovalFallback(
      { db, clock, random: systemRandom, senders, publicBaseUrl: PUBLIC_BASE_URL },
      { approvalId },
    );

    assert.equal(sms.length, 1);
    assert.equal(sms[0]!.recipient, ownerNumber, "the SMS reaches the owner's verified number");
    assert.notEqual(sms[0]!.recipient, otherNumber, "never another person's number");

    assert.equal(emails.length, 1);
    assert.equal(emails[0]!.recipient, owner.email, "the email reaches the owner's address");
    assert.notEqual(emails[0]!.recipient, other.email, "never another person's address");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// Security — the message carries the single-use link but NO approval detail (personal
// content): the job never loads the DEK-encrypted detail, so it cannot leak into a message.
// ===========================================================================

test("the SMS and email carry no approval detail (personal content)", async () => {
  const db = await freshDb();
  try {
    const clock = fixedClock(NOW);
    const { userId, dek } = await makePerson(db, "sec-nodetail");
    await addVerifiedNumber(db, userId, "+61404000111", clock);

    // A unique, recognizable secret buried in the approval's (DEK-encrypted) detail. If the
    // job ever surfaced the detail, this would appear in a message body or link.
    const secret = `top-secret-recipient-${randomUUID()}`;
    const approvalId = await createPendingApproval(db, userId, dek, clock, {
      recipient: secret,
      amount: 10000,
      field: "card",
    });

    const { senders, email: emails, sms } = recordingSenders();

    await runApprovalFallback(
      { db, clock, random: systemRandom, senders, publicBaseUrl: PUBLIC_BASE_URL },
      { approvalId },
    );

    for (const message of [sms[0]!, emails[0]!]) {
      assert.ok(message, "the message was sent");
      assert.ok(!message.body.includes(secret), "no approval detail appears in the message body");
      assert.ok(!(message.link ?? "").includes(secret), "no approval detail appears in the message link");
    }
  } finally {
    await db.close();
  }
});

// ===========================================================================
// OBL [validate-and-parameterize-input] — a malformed / oversized id is rejected with a 4xx
// before anything is sent or any link is issued; a SQL-injection-shaped id is rejected and the
// tables are intact (the probe cannot alter a query — values are bound, the id is shape-guarded).
// ===========================================================================

test("rejects an empty approval id with a 4xx before sending or issuing anything", async () => {
  const db = await freshDb();
  try {
    const clock = fixedClock(NOW);
    const { userId, dek } = await makePerson(db, "obl-empty");
    await addVerifiedNumber(db, userId, "+61405000111", clock);
    await createPendingApproval(db, userId, dek, clock);

    const { senders, email: emails, sms } = recordingSenders();

    await assert.rejects(
      () =>
        runApprovalFallback(
          { db, clock, random: systemRandom, senders, publicBaseUrl: PUBLIC_BASE_URL },
          { approvalId: "" },
        ),
      (err: unknown) => {
        const status = (err as { status?: number }).status;
        assert.equal(typeof status, "number", "the rejection carries an HTTP status");
        assert.ok(status! >= 400 && status! < 500, `malformed input is a 4xx, got ${status}`);
        return true;
      },
    );

    assert.equal(sms.length, 0, "a malformed id sends no SMS");
    assert.equal(emails.length, 0, "a malformed id sends no email");
    const anyLinks = await db.query("SELECT token_hash FROM approval_links");
    assert.equal(anyLinks.rows.length, 0, "a malformed id issues no single-use link (validated first)");
  } finally {
    await db.close();
  }
});

test("rejects an oversized approval id with a 4xx before sending or issuing anything", async () => {
  const db = await freshDb();
  try {
    const clock = fixedClock(NOW);
    const { userId, dek } = await makePerson(db, "obl-oversized");
    await addVerifiedNumber(db, userId, "+61406000111", clock);
    await createPendingApproval(db, userId, dek, clock);

    const { senders, email: emails, sms } = recordingSenders();
    const oversized = "x".repeat(100_000); // far beyond any id length

    await assert.rejects(
      () =>
        runApprovalFallback(
          { db, clock, random: systemRandom, senders, publicBaseUrl: PUBLIC_BASE_URL },
          { approvalId: oversized },
        ),
      (err: unknown) => {
        const status = (err as { status?: number }).status;
        assert.equal(typeof status, "number", "the rejection carries an HTTP status");
        assert.ok(status! >= 400 && status! < 500, `oversized input is a 4xx, got ${status}`);
        return true;
      },
    );

    assert.equal(sms.length, 0, "an oversized id sends no SMS");
    assert.equal(emails.length, 0, "an oversized id sends no email");
    const anyLinks = await db.query("SELECT token_hash FROM approval_links");
    assert.equal(anyLinks.rows.length, 0, "an oversized id issues no single-use link (validated first)");
  } finally {
    await db.close();
  }
});

test("a SQL-injection-shaped approval id is rejected and cannot alter a query (the tables are intact)", async () => {
  const db = await freshDb();
  try {
    const clock = fixedClock(NOW);
    const { userId, dek } = await makePerson(db, "obl-injection");
    await addVerifiedNumber(db, userId, "+61407000111", clock);
    await createPendingApproval(db, userId, dek, clock);

    const { senders, email: emails, sms } = recordingSenders();

    // If this id were spliced into the SQL instead of bound (and shape-guarded at the
    // boundary), it would drop the approval_links table; it cannot.
    const probe = "'); DROP TABLE approval_links; --";

    await assert.rejects(
      () =>
        runApprovalFallback(
          { db, clock, random: systemRandom, senders, publicBaseUrl: PUBLIC_BASE_URL },
          { approvalId: probe },
        ),
      (err: unknown) => {
        const status = (err as { status?: number }).status;
        assert.equal(typeof status, "number", "the rejection carries an HTTP status");
        assert.ok(status! >= 400 && status! < 500, `an injection-shaped id is a 4xx, got ${status}`);
        return true;
      },
    );

    assert.equal(sms.length, 0, "the injection probe sends no SMS");
    assert.equal(emails.length, 0, "the injection probe sends no email");
    // The approval_links table still exists and is queryable — the probe did not alter a query.
    const stillThere = await db.query("SELECT count(*)::int AS n FROM approval_links");
    assert.equal(Number(stillThere.rows[0]!.n), 0, "approval_links is intact; the DROP never ran");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// OBL [secrets-from-env] — the job holds no secret and needs no ambient config: it works
// purely from its injected db / clock / random / senders / publicBaseUrl + input. (The ACS
// email/SMS connection strings and the link entropy are supplied by the composition root,
// never read from the environment inside this module.)
// ===========================================================================

test("runs from injected deps alone: no secret and no ambient configuration are needed", async () => {
  const db = await freshDb();
  try {
    const clock = fixedClock(NOW);
    const { userId, email, dek } = await makePerson(db, "obl-secrets");
    const number = await addVerifiedNumber(db, userId, "+61408000111", clock);
    const approvalId = await createPendingApproval(db, userId, dek, clock);

    const { senders, email: emails, sms } = recordingSenders();

    // Only db / clock / random / senders / publicBaseUrl + the input — no connection string,
    // no VAPID key, no env.
    await runApprovalFallback(
      { db, clock, random: systemRandom, senders, publicBaseUrl: PUBLIC_BASE_URL },
      { approvalId },
    );

    assert.equal(sms.length, 1, "the SMS was sent with no secret handed to the job");
    assert.equal(sms[0]!.recipient, number);
    assert.equal(emails.length, 1, "the email was sent with no secret handed to the job");
    assert.equal(emails[0]!.recipient, email);
  } finally {
    await db.close();
  }
});

// ===========================================================================
// One channel's failure never costs the other, and a retry sends only what has not gone yet
// (review finding: the link was issued BEFORE either send, and "a link exists" was the
// idempotency marker — so an SMS provider blip made the retried job see the link and return,
// and neither the SMS nor the email was ever sent; an email failure after a successful SMS
// skipped the email for good). And an approval that is past its expiry is never fallen back
// on, even before the expiry sweep has marked it.
// ===========================================================================

// Senders whose `failing` channels throw on their first `failures` calls, recording every
// message that does go out.
function flakySenders(failing: { sms?: number; email?: number }): ReturnType<typeof recordingSenders> {
  const base = recordingSenders();
  let smsFailures = failing.sms ?? 0;
  let emailFailures = failing.email ?? 0;
  return {
    ...base,
    senders: {
      push: base.senders.push,
      sms: {
        async sendSms(message: OutgoingMessage): Promise<void> {
          if (smsFailures > 0) {
            smsFailures -= 1;
            throw new Error("SMS provider unavailable");
          }
          await base.senders.sms.sendSms(message);
        },
      },
      email: {
        async sendEmail(message: OutgoingMessage): Promise<void> {
          if (emailFailures > 0) {
            emailFailures -= 1;
            throw new Error("email provider unavailable");
          }
          await base.senders.email.sendEmail(message);
        },
      },
    },
  };
}

test("an ambiguous SMS failure lets email go and never repeats the paid SMS attempt", async () => {
  const db = await freshDb();
  try {
    const clock = fixedClock(NOW);
    const { userId, dek } = await makePerson(db, "flaky-sms");
    await addVerifiedNumber(db, userId, "+61400111333", clock);
    const approvalId = await createPendingApproval(db, userId, dek, clock);
    const flaky = flakySenders({ sms: 1 });
    const deps = { db, clock, random: systemRandom, senders: flaky.senders, publicBaseUrl: PUBLIC_BASE_URL };

    await assert.rejects(runApprovalFallback(deps, { approvalId }), /SMS provider/, "the failure surfaces so the job retries");
    assert.equal(flaky.sms.length, 0, "the SMS did not go");
    assert.equal(flaky.email.length, 1, "the email still went");

    await runApprovalFallback(deps, { approvalId });
    assert.equal(flaky.sms.length, 0, "an ambiguous failure never repeats a paid SMS attempt");
    assert.equal(flaky.email.length, 1, "and does not repeat the email");
    const claims = await db.query("SELECT * FROM approval_sms_attempts WHERE approval_id = $1", [approvalId]);
    assert.equal(claims.rows.length, 1, "the attempt survives worker recreation");
    await runApprovalFallback(deps, { approvalId });
    assert.equal(flaky.sms.length + flaky.email.length, 1);
  } finally {
    await db.close();
  }
});

test("an email that fails after the SMS went is retried on its own", async () => {
  const db = await freshDb();
  try {
    const clock = fixedClock(NOW);
    const { userId, dek } = await makePerson(db, "flaky-email");
    await addVerifiedNumber(db, userId, "+61400111444", clock);
    const approvalId = await createPendingApproval(db, userId, dek, clock);
    const flaky = flakySenders({ email: 1 });
    const deps = { db, clock, random: systemRandom, senders: flaky.senders, publicBaseUrl: PUBLIC_BASE_URL };

    await assert.rejects(runApprovalFallback(deps, { approvalId }), /email provider/);
    assert.deepEqual([flaky.sms.length, flaky.email.length], [1, 0]);

    await runApprovalFallback(deps, { approvalId });
    assert.deepEqual([flaky.sms.length, flaky.email.length], [1, 1], "only the email was retried");
  } finally {
    await db.close();
  }
});

test("an approval past its expiry is not fallen back on, even while it still reads pending", async () => {
  const db = await freshDb();
  try {
    const created = fixedClock(NOW);
    const { userId, dek } = await makePerson(db, "expired-pending");
    await addVerifiedNumber(db, userId, "+61400111555", created);
    const approvalId = await createPendingApproval(db, userId, dek, created);
    const row = await db.query("SELECT expires_at, status FROM approvals WHERE id = $1", [approvalId]);
    assert.equal(row.rows[0]!.status, "pending");

    // The job runs after the approval's window closed, before the expiry sweep marked it.
    const late = fixedClock(new Date(toMs(row.rows[0]!.expires_at) + 1));
    const { senders, sms, email } = recordingSenders();
    await runApprovalFallback({ db, clock: late, random: systemRandom, senders, publicBaseUrl: PUBLIC_BASE_URL }, { approvalId });
    assert.deepEqual([sms.length, email.length], [0, 0], "nothing is sent for an expired approval");
    assert.equal((await linksFor(db, approvalId)).length, 0, "and no link is issued");
  } finally {
    await db.close();
  }
});


test("a verified number alone does not opt in to SMS and opting out keeps email working", async () => {
  const db = await freshDb();
  try {
    const clock = fixedClock(NOW);
    const { userId, dek } = await makePerson(db, "sms-optout");
    await addVerifiedNumber(db, userId, "+447700900123", clock);
    await saveNotificationPrefs(db, { userId, emailFallback: true, smsFallback: false, fallbackDelayMinutes: 2 });
    const approvalId = await createPendingApproval(db, userId, dek, clock);
    const { senders, sms, email } = recordingSenders();
    await runApprovalFallback({ db, clock, random: systemRandom, senders, publicBaseUrl: PUBLIC_BASE_URL }, { approvalId });
    assert.equal(sms.length, 0); assert.equal(email.length, 1);
  } finally { await db.close(); }
});
