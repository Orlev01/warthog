// E12-S19 — Notification settings actions
// (`src/app/(portal)/(protected)/settings/notifications/actions.ts`).
//
// RED-first: the notification-settings seam does NOT exist yet (the notifications dir
// holds only a placeholder `page.tsx`), so importing `./actions` throws and every test
// here fails until the builder adds it. That absence IS the point of test-first — do
// NOT implement anything to make these pass; the builder writes `actions.ts` afterwards
// as the minimum code that turns these green.
//
// These tests pin BEHAVIOUR (what each action CHANGES in the database, what it SENDS
// through the configured senders, and what it REFUSES) against an isolated in-memory
// PGlite with the REAL migrations (`@/test/db`) and the REAL sibling stores
// (push-subscriptions, mobile-numbers, notification-prefs), the REAL session seam, a
// real `KeyWrapper`, and the REAL dev outbox (`createOutbox`). No test asserts on the
// source text of any module, so a later behaviour-preserving refactor (a rename, a moved
// import) stays green. No test touches the network or Azure.
//
// Why a sibling `actions.ts` factory (not `page.tsx`): a Next `page.tsx` entry file may
// export ONLY its framework fields (its default page component), so it cannot carry an
// injectable, unit-testable seam without breaking `next build`. The thin protected-page
// loader reads the session + database and renders <NotificationsView>; the testable logic
// — reading this person's devices / numbers / preferences and mutating them, and firing a
// test push through the configured sender — lives in the plain sibling module `actions.ts`
// (the convention's `createXActions(deps)` factory, here `createNotificationsActions`, the
// same shape as the already-built security / inbox / connectors actions). These tests
// drive that factory directly with real seams; the page wires thin server-action wrappers
// over it.
//
// ─── THE PINNED CONTRACT (chosen by the tester; the implementation conforms to it) ──────
//
//   createNotificationsActions(deps): {
//     load(session):                           Promise<NotificationsData>
//     registerPushDevice(session, input):      Promise<ActionResult>
//     addMobileNumber(session, input):         Promise<ActionResult>
//     verifyMobileNumber(session, input):      Promise<ActionResult>
//     saveNotificationPrefs(session, input):   Promise<ActionResult>
//     sendTestNotification(session):           Promise<ActionResult>
//   }
//
//   deps: {
//     db: Db; clock: Clock; random: Random; hmacKey: Uint8Array;
//     keyWrapper: KeyWrapper;      // resolves the session person's own DEK (device data)
//     senders: Senders;            // the CONFIGURED senders — the dev OUTBOX for every
//                                  // channel in dev (selectSenders), the real Azure
//                                  // senders in prod; which one is wired is the page's job
//   }
//
//   type ActionResult = { ok: true } | { ok: false; reason: string }
//
//   type NotificationsData = {
//     devices:  ReadonlyArray<{ id: string; label?: string }>;
//     numbers:  ReadonlyArray<{ id: string; number: string; verified: boolean }>;
//     emailFallback: boolean;              // brief default: true
//     fallbackDelayMinutes: number;        // brief default: 2
//   }
//
//   input shapes:
//     registerPushDevice:    { endpoint: string; keys: { p256dh: string; auth: string };
//                              expiresAt?: Date | string | null }
//     addMobileNumber:       { number: string }
//     verifyMobileNumber:    { id: string; code: string }
//     saveNotificationPrefs: { emailFallback: boolean; fallbackDelayMinutes: number }
//
//   • Every method takes the person's VERIFIED Session and derives the acting user id
//     from `session.userId` — NEVER a client-supplied value (CLAUDE.md member scope /
//     design §5). There is no userId field on any input, so a signed-in person can only
//     register devices / add numbers / change preferences for THEMSELVES, and can never
//     read or verify another person's number/device by id.
//   • sendTestNotification reads the session person's OWN registered devices and delivers
//     a push to EACH of them through the configured push sender (the dev outbox in dev),
//     so the loop is drivable end-to-end in the running app.
//   • saveNotificationPrefs rejects a delay outside the inclusive 1–30 range, writing
//     nothing (the stored value is left untouched, never clamped).
//
// ─── Obligations (this task's cross-cutting invariants, as behaviour) ─────────────────
//   [obligation:validate-and-parameterize-input] (INV-102) — a handler rejects malformed
//     or oversized input with a 4xx `HttpError` (a non-HTTPS / oversized push endpoint, a
//     mis-shaped number id, an oversized number / code) BEFORE it reaches a query; and a
//     SQL-injection probe in an input field travels as a BOUND value and cannot alter a
//     query (parameter binding is used).
//   [obligation:secrets-from-env] (INV-103) — the actions run purely from their injected
//     seams and read no `process.env`, so a decoy env secret never lands in a result, in
//     stored content, or in a delivered message.
//
// Every db handle is closed in a `finally`; each test uses its own `freshDb()`, so tests
// share no state.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

import { createNotificationsActions } from "./actions";

import { createUser } from "@/server/db/users";
import { createSession, type Session } from "@/server/auth/session";
import { listSubscriptions } from "@/server/db/push-subscriptions";
import { listMobileNumbers } from "@/server/db/mobile-numbers";
import { getNotificationPrefs } from "@/server/db/notification-prefs";
import { HttpError } from "@/server/http/validate";
import { localAesKeyWrapper, type KeyWrapper } from "@/server/crypto/key-wrapper";
import { createOutbox, type Outbox } from "@/server/notify/outbox";
import type { Senders } from "@/server/notify/senders";
import { fixedClock, type Clock } from "@/server/seams/clock";
import { systemRandom } from "@/server/seams/random";
import { freshDb } from "@/test/db";
import type { Db, QueryResult } from "@/server/db/index";

// --- the contract types, declared here so the tests read cleanly (see header) ----------

type ActionResult = { ok: true } | { ok: false; reason: string };

// --- fixtures --------------------------------------------------------------------------

const DEK_BYTES = 32; // a 256-bit per-person data key
const KEK_BYTES = 32; // the local AES-256 key-encryption key for the KeyWrapper seam

// A keyed HMAC key the mobile-number code is stored and matched under (INJECTED, never
// read from env). One per file: every action built below shares it, so a code added by
// one call verifies through another built with the same key.
const HMAC_KEY = randomBytes(32);

// The frozen instant every action reads time through: add + verify a mobile number at the
// same NOW, comfortably inside the 10-minute code window, with no wall-clock dependence.
const NOW = new Date("2026-11-15T12:00:00.000Z");
const clock: Clock = fixedClock(NOW);

function keyWrapperFor(): KeyWrapper {
  return localAesKeyWrapper(randomBytes(KEK_BYTES));
}

// Build the notifications actions over the real seams. `senders` is a FRESH dev outbox
// standing in for every channel (exactly what selectSenders wires in dev), so a test can
// read back the pushes/SMS the actions deliver. Returns the actions plus the outbox.
function makeActions(
  db: Db,
  keyWrapper: KeyWrapper,
): { actions: ReturnType<typeof createNotificationsActions>; outbox: Outbox } {
  const outbox = createOutbox();
  const senders: Senders = { push: outbox, email: outbox, sms: outbox };
  const actions = createNotificationsActions({
    db,
    clock,
    random: systemRandom,
    hmacKey: HMAC_KEY,
    keyWrapper,
    senders,
  });
  return { actions, outbox };
}

// Create a person whose wrapped DEK really unwraps under `keyWrapper` (the resolution path
// the actions use to decrypt this person's device subscriptions), returning their id and
// the raw DEK.
async function makePerson(
  db: Db,
  keyWrapper: KeyWrapper,
  who: string,
): Promise<{ userId: string; dek: Uint8Array }> {
  const dek = randomBytes(DEK_BYTES);
  const user = await createUser(db, {
    email: `${who}@warthog.com.au`,
    wrappedDek: await keyWrapper.wrap(dek),
  });
  return { userId: user.id, dek };
}

// A real verified session for `userId` — the actions read `session.userId` from it.
async function sessionFor(db: Db, userId: string): Promise<Session> {
  return (await createSession(db, userId, { clock, random: systemRandom })).session;
}

// A well-formed HTTPS push subscription (the shape push_subscriptions stores): a distinct
// endpoint per `token` so a test can prove which devices were pushed.
function subscriptionFor(token: string) {
  return {
    endpoint: `https://push.example.com/send/${token}`,
    keys: { p256dh: `p256dh-${token}`, auth: `auth-${token}` },
  };
}

// The 6-digit code from the one SMS the outbox recorded for `recipient` (the raw code
// lives ONLY in the delivered SMS — never a stored column or a returned field).
function codeFromSms(outbox: Outbox, recipient: string): string {
  const sms = outbox.list().find((m) => m.channel === "sms" && m.recipient === recipient);
  assert.ok(sms, `an SMS must have been delivered to ${recipient}; outbox=${JSON.stringify(outbox.list())}`);
  const match = sms!.body.match(/\b(\d{6})\b/);
  assert.ok(match, `the SMS body must carry a 6-digit code; body="${sms!.body}"`);
  return match![1]!;
}

// A 6-digit code guaranteed to differ from `code` (for the wrong-code refusal path).
function aDifferentCode(code: string): string {
  return code === "000000" ? "111111" : "000000";
}

// --- assertion helpers (mirrored from the sibling inbox/security action tests) ---------

function expectOk(r: ActionResult, label: string): void {
  if (!r.ok) assert.fail(`${label}: expected success, got refusal "${r.reason}"`);
}
function expectRefused(r: ActionResult, label: string): void {
  if (r.ok) assert.fail(`${label}: expected a refusal, got success`);
  assert.ok(r.reason.length > 0, `${label}: the refusal carries a plain reason`);
}

// Assert that awaiting `fn()` rejects with a 4xx HttpError (the validation boundary).
async function assertRejects4xx(label: string, fn: () => Promise<unknown>): Promise<void> {
  let threw = false;
  try {
    await fn();
  } catch (err) {
    threw = true;
    assert.ok(
      err instanceof HttpError,
      `${label}: must be rejected at the validation boundary (HttpError), got ${String(err)}`,
    );
    assert.ok(
      (err as HttpError).status >= 400 && (err as HttpError).status < 500,
      `${label}: the rejection must carry a 4xx status, got ${(err as HttpError).status}`,
    );
  }
  assert.ok(threw, `${label}: must be rejected (nothing was thrown)`);
}

// Assert a save was rejected — EITHER a thrown 4xx at the boundary OR a returned
// { ok: false } domain refusal (the builder may pick either for an out-of-range delay).
// Returns nothing; the caller then proves nothing was persisted.
async function assertSaveRejected(label: string, fn: () => Promise<ActionResult>): Promise<void> {
  try {
    const result = await fn();
    assert.equal(result.ok, false, `${label}: an out-of-range delay must be rejected, not saved`);
  } catch (err) {
    assert.ok(
      err instanceof HttpError && err.status >= 400 && err.status < 500,
      `${label}: a rejection must be a 4xx HttpError or a { ok: false } result, got ${String(err)}`,
    );
  }
}

// A recording proxy over a real db: passes queries through while capturing (text, values),
// so "every value is bound, never spliced into the SQL text" is observable (INV-102).
interface RecordingProxy extends Db {
  readonly calls: { text: string; values: unknown[] }[];
}
function recordingProxy(real: Db): RecordingProxy {
  const calls: { text: string; values: unknown[] }[] = [];
  return {
    calls,
    query(text: string, values: unknown[] = []): Promise<QueryResult> {
      calls.push({ text, values });
      return real.query(text, values);
    },
    close(): Promise<void> {
      return real.close();
    },
  };
}

// =====================================================================================
// registerPushDevice — registers a device for the SESSION person (member-scoped), and a
// person may register more than one. It lands under that person and nobody else.
// =====================================================================================

test("registerPushDevice stores the device for the session person (member-scoped), supporting several", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const alice = await makePerson(db, keyWrapper, "alice");
    const bob = await makePerson(db, keyWrapper, "bob");
    const { actions } = makeActions(db, keyWrapper);
    const session = await sessionFor(db, alice.userId);

    const first = subscriptionFor("alice-phone");
    expectOk(await actions.registerPushDevice(session, first), "register first device");

    let stored = await listSubscriptions(db, alice.userId, alice.dek, clock);
    assert.equal(stored.length, 1, "exactly one device is registered for Alice");
    assert.equal(stored[0]!.endpoint, first.endpoint, "the device's endpoint is stored (and decrypts)");
    assert.deepEqual(stored[0]!.keys, first.keys, "the device's Web Push keys are stored (and decrypt)");

    // It landed under ALICE, not Bob — there is no client-supplied id to target Bob with.
    assert.equal(
      (await listSubscriptions(db, bob.userId, bob.dek, clock)).length,
      0,
      "the device never lands under another person",
    );

    // A person may register several devices (approval pushes fan out to all of them).
    const second = subscriptionFor("alice-laptop");
    expectOk(await actions.registerPushDevice(session, second), "register second device");
    stored = await listSubscriptions(db, alice.userId, alice.dek, clock);
    assert.equal(stored.length, 2, "a person may register more than one device");
    assert.deepEqual(
      new Set(stored.map((s) => s.endpoint)),
      new Set([first.endpoint, second.endpoint]),
      "both registered devices are present",
    );
  } finally {
    await db.close();
  }
});

// =====================================================================================
// addMobileNumber — adds an UNVERIFIED number for the session person and delivers the
// 6-digit code in exactly one SMS through the configured sender. Member-scoped.
// =====================================================================================

test("addMobileNumber adds an unverified number and sends the code in one SMS through the configured sender", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const alice = await makePerson(db, keyWrapper, "alice");
    const bob = await makePerson(db, keyWrapper, "bob");
    const { actions, outbox } = makeActions(db, keyWrapper);
    const session = await sessionFor(db, alice.userId);

    const NUMBER = "+61400555666";
    expectOk(await actions.addMobileNumber(session, { number: NUMBER }), "add number");

    // Added UNVERIFIED, under Alice.
    const aliceNumbers = await listMobileNumbers(db, alice.userId);
    assert.equal(aliceNumbers.length, 1, "exactly one number is added for Alice");
    assert.equal(aliceNumbers[0]!.number, NUMBER, "the added number is stored");
    assert.equal(aliceNumbers[0]!.verified, false, "a freshly added number starts unverified");

    // Exactly one SMS, to that number, carrying a 6-digit code (the code lives only in the
    // delivered SMS — never a returned field).
    const smses = outbox.list().filter((m) => m.channel === "sms");
    assert.equal(smses.length, 1, "exactly one verification SMS is delivered");
    assert.equal(smses[0]!.recipient, NUMBER, "the SMS goes to the number being added");
    assert.match(smses[0]!.body, /\b\d{6}\b/, "the SMS carries a 6-digit verification code");

    // Member scope: the number never lands under Bob.
    assert.equal(
      (await listMobileNumbers(db, bob.userId)).length,
      0,
      "the number never lands under another person",
    );
  } finally {
    await db.close();
  }
});

// =====================================================================================
// verifyMobileNumber — a correct, unexpired code marks the session person's number
// verified; a wrong code is refused and the number stays unverified.
// =====================================================================================

test("verifyMobileNumber verifies the number with the correct code, and refuses a wrong code", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const alice = await makePerson(db, keyWrapper, "alice");
    const { actions, outbox } = makeActions(db, keyWrapper);
    const session = await sessionFor(db, alice.userId);

    const NUMBER = "+61400555666";
    expectOk(await actions.addMobileNumber(session, { number: NUMBER }), "add number");
    const id = (await listMobileNumbers(db, alice.userId))[0]!.id;
    const code = codeFromSms(outbox, NUMBER);

    // A wrong (but well-formed) code is refused; the number stays unverified.
    expectRefused(
      await actions.verifyMobileNumber(session, { id, code: aDifferentCode(code) }),
      "verify with a wrong code",
    );
    assert.equal(
      (await listMobileNumbers(db, alice.userId))[0]!.verified,
      false,
      "a wrong code leaves the number unverified",
    );

    // The correct code verifies it.
    expectOk(await actions.verifyMobileNumber(session, { id, code }), "verify with the correct code");
    assert.equal(
      (await listMobileNumbers(db, alice.userId))[0]!.verified,
      true,
      "the correct code marks the number verified",
    );
  } finally {
    await db.close();
  }
});

// =====================================================================================
// Member scope / ownership — a signed-in person cannot verify ANOTHER person's number by
// its id (the id resolves to no row for them; the owner's number stays unverified).
// =====================================================================================

test("a signed-in person cannot verify another person's number by id — the owner's number stays unverified", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const alice = await makePerson(db, keyWrapper, "alice");
    const bob = await makePerson(db, keyWrapper, "bob");
    const { actions, outbox } = makeActions(db, keyWrapper);

    // Bob adds a number and receives his code.
    const bobSession = await sessionFor(db, bob.userId);
    const BOB_NUMBER = "+61400999000";
    expectOk(await actions.addMobileNumber(bobSession, { number: BOB_NUMBER }), "Bob adds his number");
    const bobNumberId = (await listMobileNumbers(db, bob.userId))[0]!.id;
    const bobCode = codeFromSms(outbox, BOB_NUMBER);

    // Alice, signed in as herself, tries to verify Bob's number by its id with Bob's code.
    const aliceSession = await sessionFor(db, alice.userId);
    expectRefused(
      await actions.verifyMobileNumber(aliceSession, { id: bobNumberId, code: bobCode }),
      "Alice verifies Bob's number by id",
    );

    assert.equal(
      (await listMobileNumbers(db, bob.userId))[0]!.verified,
      false,
      "Bob's number is left unverified — another person could not verify it",
    );
  } finally {
    await db.close();
  }
});

// =====================================================================================
// saveNotificationPrefs — persists the session person's email-fallback choice and delay;
// a signed-in person can only change their OWN preferences (another person's are untouched).
// =====================================================================================

test("saveNotificationPrefs persists the session person's preferences and never touches another's", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const alice = await makePerson(db, keyWrapper, "alice");
    const bob = await makePerson(db, keyWrapper, "bob");
    const { actions } = makeActions(db, keyWrapper);
    const aliceSession = await sessionFor(db, alice.userId);

    expectOk(
      await actions.saveNotificationPrefs(aliceSession, { emailFallback: false, fallbackDelayMinutes: 10 }),
      "Alice saves her preferences",
    );

    const alicePrefs = await getNotificationPrefs(db, alice.userId);
    assert.equal(alicePrefs.emailFallback, false, "Alice's email-fallback choice is persisted");
    assert.equal(alicePrefs.fallbackDelayMinutes, 10, "Alice's chosen delay is persisted");

    // Bob's preferences are untouched — Alice could not change them (no client userId).
    const bobPrefs = await getNotificationPrefs(db, bob.userId);
    assert.equal(bobPrefs.emailFallback, true, "another person keeps the default email-fallback (on)");
    assert.equal(bobPrefs.fallbackDelayMinutes, 2, "another person keeps the default delay (2 minutes)");
  } finally {
    await db.close();
  }
});

// =====================================================================================
// saveNotificationPrefs — a delay OUTSIDE the inclusive 1–30 range is rejected and nothing
// is written: the previously stored value is left untouched (never clamped into range).
// =====================================================================================

test("saveNotificationPrefs rejects a delay outside 1–30 and writes nothing (the stored value is left untouched)", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const alice = await makePerson(db, keyWrapper, "alice");
    const { actions } = makeActions(db, keyWrapper);
    const session = await sessionFor(db, alice.userId);

    // A valid baseline so a later rejected save has something to (not) overwrite.
    expectOk(
      await actions.saveNotificationPrefs(session, { emailFallback: true, fallbackDelayMinutes: 10 }),
      "baseline save",
    );

    for (const bad of [0, 31, 60, -5]) {
      await assertSaveRejected(`delay ${bad}`, () =>
        actions.saveNotificationPrefs(session, { emailFallback: false, fallbackDelayMinutes: bad }),
      );
      const prefs = await getNotificationPrefs(db, alice.userId);
      assert.equal(prefs.fallbackDelayMinutes, 10, `a rejected save (delay ${bad}) leaves the stored delay at 10`);
      assert.equal(prefs.emailFallback, true, `a rejected save (delay ${bad}) leaves the stored email choice too`);
    }
  } finally {
    await db.close();
  }
});

// =====================================================================================
// sendTestNotification — delivers a push to EVERY one of the session person's registered
// devices THROUGH THE CONFIGURED SENDER (the dev outbox in dev), and never to another
// person's device. This is the end-to-end-drivable loop the acceptance criterion names.
// =====================================================================================

test("sendTestNotification delivers a push to each of the session person's registered devices (and no one else's)", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const alice = await makePerson(db, keyWrapper, "alice");
    const bob = await makePerson(db, keyWrapper, "bob");
    const { actions, outbox } = makeActions(db, keyWrapper);
    const aliceSession = await sessionFor(db, alice.userId);

    // Alice registers two devices; Bob registers one (which must NOT be pushed).
    const a1 = subscriptionFor("alice-phone");
    const a2 = subscriptionFor("alice-laptop");
    expectOk(await actions.registerPushDevice(aliceSession, a1), "register a1");
    expectOk(await actions.registerPushDevice(aliceSession, a2), "register a2");
    expectOk(
      await actions.registerPushDevice(await sessionFor(db, bob.userId), subscriptionFor("bob-phone")),
      "register bob device",
    );

    expectOk(await actions.sendTestNotification(aliceSession), "send a test notification");

    // One push per Alice device, through the configured sender (the outbox), to each
    // device's endpoint — and NONE to Bob's device.
    const pushes = outbox.list().filter((m) => m.channel === "push");
    assert.equal(pushes.length, 2, "exactly one test push per registered device of the session person");
    assert.deepEqual(
      new Set(pushes.map((m) => m.recipient)),
      new Set([a1.endpoint, a2.endpoint]),
      "the test push reaches each of the person's own device endpoints, and only those",
    );
    assert.ok(
      !pushes.some((m) => m.recipient === subscriptionFor("bob-phone").endpoint),
      "another person's device is never pushed",
    );
    for (const push of pushes) {
      assert.ok(push.body.length > 0, "each test push carries a (non-empty) message body");
    }
  } finally {
    await db.close();
  }
});

// =====================================================================================
// sendTestNotification — with NO registered device there is nowhere to push: nothing is
// sent and the action reports a refusal (never a silent no-op, mirroring the view's
// disabled-with-a-reason control).
// =====================================================================================

test("sendTestNotification with no registered device sends nothing and reports a refusal", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const alice = await makePerson(db, keyWrapper, "alice");
    const { actions, outbox } = makeActions(db, keyWrapper);
    const session = await sessionFor(db, alice.userId);

    expectRefused(await actions.sendTestNotification(session), "send a test notification with no device");

    assert.equal(
      outbox.list().filter((m) => m.channel === "push").length,
      0,
      "no push is sent when there is no registered device",
    );
  } finally {
    await db.close();
  }
});

// =====================================================================================
// [obligation:validate-and-parameterize-input] — a handler rejects malformed / oversized
// input at the validation boundary with a 4xx HttpError, BEFORE it reaches a query, and
// nothing is persisted.
// =====================================================================================

test("malformed or oversized input is rejected with a 4xx at the validation boundary, persisting nothing", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const alice = await makePerson(db, keyWrapper, "alice");
    const { actions } = makeActions(db, keyWrapper);
    const session = await sessionFor(db, alice.userId);

    // A non-HTTPS push endpoint, and an oversized endpoint, are refused (web push is
    // HTTPS-only and bounded) — never stored.
    await assertRejects4xx("register non-HTTPS endpoint", () =>
      actions.registerPushDevice(session, {
        endpoint: "http://push.example.com/insecure",
        keys: { p256dh: "p", auth: "a" },
      }),
    );
    await assertRejects4xx("register oversized endpoint", () =>
      actions.registerPushDevice(session, {
        endpoint: `https://push.example.com/${"x".repeat(5000)}`,
        keys: { p256dh: "p", auth: "a" },
      }),
    );

    // A mis-shaped number id (not a well-formed uuid) is rejected at the boundary (OBS-049),
    // never cast at `WHERE id = $1`; so is an oversized / mis-shaped code.
    await assertRejects4xx("verify with a malformed id", () =>
      actions.verifyMobileNumber(session, { id: "not-a-uuid-at-all", code: "123456" }),
    );
    await assertRejects4xx("verify with an oversized code", () =>
      actions.verifyMobileNumber(session, {
        id: "11111111-1111-1111-1111-111111111111",
        code: "1".repeat(10_000),
      }),
    );

    // An oversized mobile number is rejected before it reaches a write.
    await assertRejects4xx("add an oversized number", () =>
      actions.addMobileNumber(session, { number: "9".repeat(10_000) }),
    );

    // Nothing was persisted by any rejected call.
    assert.equal(
      (await listSubscriptions(db, alice.userId, alice.dek, clock)).length,
      0,
      "a rejected registration stores no device",
    );
    assert.equal(
      (await listMobileNumbers(db, alice.userId)).length,
      0,
      "a rejected add stores no number",
    );
  } finally {
    await db.close();
  }
});

// =====================================================================================
// [obligation:validate-and-parameterize-input] — a SQL-injection probe in an input field
// cannot alter a query: every value the actions issue travels BOUND (never spliced into
// the SQL text), and the table is not dropped. Proven with a recording proxy over a real
// db that passes queries through while capturing text + values.
// =====================================================================================

test("input values are bound, and a SQL-injection probe cannot alter a query", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const alice = await makePerson(db, keyWrapper, "alice");
    const proxy = recordingProxy(db);
    const outbox = createOutbox();
    const senders: Senders = { push: outbox, email: outbox, sms: outbox };
    const actions = createNotificationsActions({
      db: proxy,
      clock,
      random: systemRandom,
      hmacKey: HMAC_KEY,
      keyWrapper,
      senders,
    });
    const session = await sessionFor(db, alice.userId);

    // Phase 1 — a clean number binds: the number and the acting user id travel as BOUND
    // values, never concatenated into the SQL text. (Proves parameter binding is used.)
    const CLEAN = "+61400555666";
    expectOk(await actions.addMobileNumber(session, { number: CLEAN }), "add a clean number");
    const allValues = proxy.calls.flatMap((c) => c.values);
    assert.ok(allValues.includes(CLEAN), "the number travels as a bound value");
    assert.ok(allValues.includes(alice.userId), "the acting user id travels as a bound value");
    for (const call of proxy.calls) {
      assert.ok(!call.text.includes(CLEAN), "the number is bound, never concatenated into the SQL");
    }

    // Phase 2 — a SQL-injection probe cannot alter a query. Whether the boundary rejects it
    // (a 4xx) or the store binds it verbatim as data, the table survives and no injected
    // statement ever appears in a query's SQL text.
    const PROBE = "'); DROP TABLE mobile_numbers; --";
    try {
      await actions.addMobileNumber(session, { number: PROBE });
    } catch (err) {
      assert.ok(
        err instanceof HttpError && err.status >= 400 && err.status < 500,
        `a rejected probe must be a 4xx HttpError, got ${String(err)}`,
      );
    }
    for (const call of proxy.calls) {
      assert.ok(!/\bDROP\s+TABLE\b/i.test(call.text), "no injected statement appears in the SQL text");
      assert.ok(!call.text.includes(PROBE), "the probe is never spliced into the SQL text");
    }

    // The table is intact and the clean number is still there (read through the REAL db).
    const numbers = await listMobileNumbers(db, alice.userId);
    assert.ok(
      numbers.some((n) => n.number === CLEAN),
      "the mobile_numbers table survives the probe and the clean number is still stored",
    );
  } finally {
    await db.close();
  }
});

// =====================================================================================
// [obligation:secrets-from-env] — the actions run purely from their injected seams and
// read no `process.env`: a decoy secret set in the environment never appears in a result,
// in stored content, or in a delivered message.
// =====================================================================================

test("the actions read no process.env: a decoy env secret never appears in a result, stored content, or a message", async () => {
  const DECOY = "sk_live_DECOY_must_never_appear_in_warthog_notifications";
  const prev = process.env.WARTHOG_DECOY_SECRET;
  process.env.WARTHOG_DECOY_SECRET = DECOY;
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const alice = await makePerson(db, keyWrapper, "alice");
    const { actions, outbox } = makeActions(db, keyWrapper);
    const session = await sessionFor(db, alice.userId);

    const registered = await actions.registerPushDevice(session, subscriptionFor("alice-phone"));
    const added = await actions.addMobileNumber(session, { number: "+61400555666" });
    const saved = await actions.saveNotificationPrefs(session, {
      emailFallback: true,
      fallbackDelayMinutes: 5,
    });
    const tested = await actions.sendTestNotification(session);

    for (const [label, result] of [
      ["registerPushDevice", registered],
      ["addMobileNumber", added],
      ["saveNotificationPrefs", saved],
      ["sendTestNotification", tested],
    ] as const) {
      expectOk(result, label);
      assert.ok(!JSON.stringify(result).includes(DECOY), `${label}: no ambient env value is folded into the result`);
    }

    // Nothing the actions stored or delivered carries the decoy.
    const stored = {
      devices: await listSubscriptions(db, alice.userId, alice.dek, clock),
      numbers: await listMobileNumbers(db, alice.userId),
      prefs: await getNotificationPrefs(db, alice.userId),
      outbox: outbox.list(),
    };
    assert.ok(
      !JSON.stringify(stored).includes(DECOY),
      "no ambient env value is folded into stored content or a delivered message",
    );
  } finally {
    await db.close();
    if (prev === undefined) delete process.env.WARTHOG_DECOY_SECRET;
    else process.env.WARTHOG_DECOY_SECRET = prev;
  }
});

// =====================================================================================
// Review fix G5 — devices are told apart and can be removed. Every device used to be
// labelled "This device" (the loader handed back only ids) and there was no way to remove
// a lost or stale device that still receives approval pushes.
// =====================================================================================

test("load labels each device by when it was registered and fingerprints its endpoint without revealing it", async () => {
  const { createHash } = await import("node:crypto");
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const alice = await makePerson(db, keyWrapper, "alice-labels");
    const { actions } = makeActions(db, keyWrapper);
    const session = await sessionFor(db, alice.userId);
    const phone = subscriptionFor("alice-phone");
    expectOk(await actions.registerPushDevice(session, phone), "register");

    const data = await actions.load(session);
    assert.equal(data.devices.length, 1);
    const device = data.devices[0]!;
    assert.match(device.label ?? "", /^Registered 15 Nov 2026/, `a plain registration label; got ${device.label}`);
    assert.equal(device.fingerprint, createHash("sha256").update(phone.endpoint).digest("hex"));
    assert.ok(!JSON.stringify(data).includes(phone.endpoint), "the endpoint itself never reaches the page");
  } finally {
    await db.close();
  }
});

test("removePushDevice removes the session person's own device; another person's id is refused and untouched", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const alice = await makePerson(db, keyWrapper, "alice-remove");
    const bob = await makePerson(db, keyWrapper, "bob-remove");
    const { actions } = makeActions(db, keyWrapper);
    const aliceSession = await sessionFor(db, alice.userId);
    const bobSession = await sessionFor(db, bob.userId);
    expectOk(await actions.registerPushDevice(aliceSession, subscriptionFor("alice-old-phone")), "register alice");
    expectOk(await actions.registerPushDevice(bobSession, subscriptionFor("bob-phone")), "register bob");
    const [alicesDevice] = await listSubscriptions(db, alice.userId, alice.dek, clock);
    const [bobsDevice] = await listSubscriptions(db, bob.userId, bob.dek, clock);

    assert.deepEqual(await actions.removePushDevice(aliceSession, { id: bobsDevice!.id }), {
      ok: false,
      reason: "not_found",
    });
    assert.equal((await listSubscriptions(db, bob.userId, bob.dek, clock)).length, 1, "Bob's device survives");

    expectOk(await actions.removePushDevice(aliceSession, { id: alicesDevice!.id }), "remove own device");
    assert.equal((await listSubscriptions(db, alice.userId, alice.dek, clock)).length, 0);

    await assertRejects4xx("malformed id", () => actions.removePushDevice(aliceSession, { id: "1 OR 1=1" }));
  } finally {
    await db.close();
  }
});

test("registering the same browser subscription again keeps a single device (no duplicate pushes)", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const alice = await makePerson(db, keyWrapper, "alice-dupe");
    const { actions } = makeActions(db, keyWrapper);
    const session = await sessionFor(db, alice.userId);
    const phone = subscriptionFor("alice-phone");
    expectOk(await actions.registerPushDevice(session, phone), "first register");
    expectOk(await actions.registerPushDevice(session, phone), "same subscription again");
    assert.equal((await listSubscriptions(db, alice.userId, alice.dek, clock)).length, 1);
  } finally {
    await db.close();
  }
});
