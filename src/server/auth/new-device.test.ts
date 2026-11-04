// E04-S08 — New-device sign-in approval (`src/server/auth/new-device.ts`).
//
// RED-first: the new-device module does not exist yet, so importing `./new-device`
// throws and every test here fails until the builder adds it. That absence IS the
// point of test-first — do NOT implement anything to make these pass.
//
// These tests pin BEHAVIOUR (what each function RETURNS, what gets stored/sent, and
// which device ends up with a session), never the source text of the module — a later
// rename that preserves behaviour must not redden them. There is no browser, no Azure
// and no network: email codes, passkeys, recovery codes and sessions are all driven
// through the real sibling modules against an isolated in-memory PGlite (src/test/db),
// and the passkey round trip is driven by the software authenticator (src/test/
// authenticator), whose only non-test collaborator is the real @simplewebauthn/server
// verifier. The one piece of new state this task owns — the pending new-device request
// — lives in process memory inside new-device.ts (the release-store pattern), because
// the task touches only `src/server/auth/new-device.ts` and adds no migration.
//
// Why this exists (brief "Sign in on another device"; design §5: "New-device sign-in:
// email code + (synced passkey | hybrid QR | approval from a signed-in device via
// push + step-up | recovery code)"): on a new phone or computer the person enters
// their email, types the one-time code, then proves themselves a SECOND way — a synced
// passkey, a passkey on another device via hybrid QR, approving the sign-in from a
// device where they are already signed in (that device gets a push and approves after a
// step-up check), or the recovery code. The email code is the first factor; the second
// factor completes the sign-in. A session is then issued to the REQUESTING device only.
//
// Server note on "synced passkey" vs "hybrid QR": both are an ordinary WebAuthn
// assertion the new device presents — they differ ONLY in the client transport (a
// locally-synced credential vs one scanned from another device over caBLE). The server
// verifies them identically (finishPasskeyAuthentication), so one passkey path covers
// both; there is no server branch on transport to test.
//
// The contract this task defines (the builder implements exactly this). All four
// methods require the email code as the first factor and, on success, mint a brand-new
// session for the requesting device, returned as:
//
//   type NewDeviceResult =
//     | { ok: true; session: Session; token: string; cookie: string }   // issued to the new device
//     | { ok: false; reason: string }                                   // never throws for an expected failure
//
//   deps (each function reads the SUBSET it needs; a superset is always accepted):
//     { clock: Clock; random: Random; hmacKey: Uint8Array;
//       emailSender: EmailSender; pushSender: PushSender; rpId: string }
//
//   // ---- self-service second factors (the new device completes in one call) ----
//
//   signInNewDeviceWithPasskey(
//     db, { email: string; code: string; response: AuthenticationResponseJSON }, deps,
//   ): Promise<NewDeviceResult>
//     • verifies the email code (first factor) for `email`; resolves the person by email.
//     • verifies the WebAuthn assertion against that person's registered passkeys
//       (finishPasskeyAuthentication against the challenge a prior
//       beginPasskeyAuthentication issued). Covers synced passkey AND hybrid QR.
//     • on success issues a session to the new device; any failed factor → { ok: false }.
//
//   signInNewDeviceWithRecoveryCode(
//     db, { email: string; code: string; recoveryCode: string }, deps,
//   ): Promise<NewDeviceResult>
//     • verifies the email code, resolves the person, verifies the recovery code
//       (verifyRecoveryCode). On success issues a session; any failed factor → { ok:false }.
//
//   // ---- approval from a signed-in device (a two-party handshake) ----
//
//   requestNewDeviceApproval(
//     db, { email: string; code: string; deviceLabel: string }, deps,
//   ): Promise<{ ok: true; requestId: string } | { ok: false; reason: string }>
//     • verifies the email code first; a failed code does NOT start a request and sends
//       no push. On success records a pending request for the person and sends ONE push
//       ("Approve sign-in on <deviceLabel>?") via deps.pushSender.
//     • returns `requestId` — the requesting device's own collection handle (a bearer
//       secret). It is handed back ONLY to the requesting device and is never placed in
//       the push (approvals happen inside the signed-in app, not by reading a message).
//
//   approveNewDeviceRequest(
//     db, { requestId: string; approvingSession: Session }, deps,
//   ): Promise<{ ok: true } | { ok: false; reason: string }>
//     • accepted ONLY when the approving session passes a fresh step-up (requireStepUp)
//       AND the request belongs to the approver's OWN userId (member-scoped — the userId
//       comes from the session, never the client). Marks the request approved.
//     • returns NO session: approving never hands the approver a new session, and never
//       throws for an unknown request / missing step-up / wrong owner.
//
//   collectNewDeviceApproval(
//     db, { requestId: string }, deps,
//   ): Promise<NewDeviceResult>
//     • before approval, or for an unknown/already-collected request → { ok: false }.
//     • once approved, issues a session to the requesting device exactly once (single
//       collection, like the release store) and returns it.
//
// Acceptance criteria → tests:
//   AC1 "A new device with a valid email code can be approved from a signed-in device
//        after step-up (push sent), or via synced passkey, hybrid-QR, or recovery code."
//        — the happy path of each of the four methods issues a session, and each is
//        GATED on the email code (a wrong code blocks every method); the approval method
//        sends the push and requires a fresh step-up on the approver.
//   AC2 "Approval issues a session only to the requesting device." — approving returns
//        no session to the approver; the session appears only when the requesting device
//        COLLECTS, is a distinct session from the approver's, verifies as the person, and
//        can be collected only once; a wrong email code issues no session at all.
//
// Every db handle is closed in a `finally` so node:test leaves no open handle; each test
// uses its own `freshDb()` and `createOutbox()`. requestIds and session tokens are drawn
// from the REAL random seam so the per-process request store never collides across the
// tests in this file (same discipline recovery/session tests use).

import { test } from "node:test";
import assert from "node:assert/strict";

import type { AuthenticationResponseJSON } from "@simplewebauthn/server";

import {
  signInNewDeviceWithPasskey,
  signInNewDeviceWithRecoveryCode,
  requestNewDeviceApproval,
  approveNewDeviceRequest,
  collectNewDeviceApproval,
} from "./new-device";
import { issueEmailCode } from "./email-code";
import { issueRecoveryCode } from "./recovery";
import {
  beginPasskeyRegistration,
  finishPasskeyRegistration,
  beginPasskeyAuthentication,
} from "./passkey";
import {
  createSession,
  recordStepUp,
  verifySession,
  type Session,
} from "./session";
import { createUser, type User } from "../db/users";
import { freshDb } from "../../test/db";
import { createAuthenticator, type SoftwareAuthenticator } from "../../test/authenticator";
import { createOutbox, type Outbox, type SentMessage } from "../notify/outbox";
import { systemRandom } from "../seams/random";
import type { Clock } from "../seams/clock";
import type { Db } from "../db/index";

const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const T0 = new Date("2026-03-01T00:00:00.000Z");

// The configured WebAuthn RP ID (design §5 / own-domain) — passed through deps, never a
// hard-coded module constant, so the "from config" discipline is exercised end to end.
const RP_ID = "warthog.com.au";

// One keyed HMAC for the email-code first factor: issue (test setup) and verify (inside
// the module) use the SAME key, so the emailed code verifies.
const HMAC_KEY = new Uint8Array(Buffer.from("warthog-new-device-hmac-key-0123456789ab", "utf8"));

// A placeholder wrapped-DEK reference; createUser stores it verbatim. Its value is
// irrelevant — we only need a genuine `users` row so sessions / passkeys / recovery codes
// can hang off a real userId (the account id every member-scoped row filters by).
const WRAPPED_DEK = "wrapped-dek-placeholder";

// A clock the test can advance, so time-dependent windows are exercised deterministically
// with no wall-clock dependence (same shape as session/email-code tests).
function mutableClock(start: Date): { clock: Clock; advance(ms: number): void } {
  let current = start.getTime();
  return {
    clock: {
      now(): Date {
        return new Date(current);
      },
    },
    advance(ms: number): void {
      current += ms;
    },
  };
}

// The superset deps bundle. Each new-device function reads only the fields it needs; a
// non-literal superset is structurally assignable to every per-function deps type, so
// one bundle drives them all. The outbox satisfies both EmailSender and PushSender.
function makeDeps(clock: Clock, outbox: Outbox) {
  return {
    clock,
    random: systemRandom,
    hmacKey: HMAC_KEY,
    emailSender: outbox,
    pushSender: outbox,
    rpId: RP_ID,
  };
}

// Create a genuine person row and return it. Distinct labels give distinct (unique)
// emails within a test, so two users never collide on the users.email UNIQUE.
async function freshUser(db: Db, label: string): Promise<User> {
  return createUser(db, { email: `${label}@warthog.com.au`, wrappedDek: WRAPPED_DEK });
}

// Pull the standalone 6-digit code out of a delivered email body (robust to the copy).
function extractCode(body: string): string {
  const match = body.match(/(?<!\d)\d{6}(?!\d)/);
  assert.ok(match, `the email body must carry a standalone 6-digit code: ${JSON.stringify(body)}`);
  return match[0];
}

// Issue an email one-time code for `email` through the REAL issuer and read the plaintext
// back from the one delivered email — exactly how the person receives it. The resulting
// code is the first factor every new-device method requires.
async function issueCodeFor(
  db: Db,
  email: string,
  clock: Clock,
  outbox: Outbox,
): Promise<string> {
  await issueEmailCode(db, email, { clock, random: systemRandom, hmacKey: HMAC_KEY, emailSender: outbox });
  const emailMsg = outbox
    .list()
    .filter((m) => m.channel === "email" && m.recipient === email)
    .at(-1);
  assert.ok(emailMsg, `issuing a code must deliver an email to ${email}`);
  return extractCode(emailMsg.body);
}

// A 6-digit string that is NOT `code` (a genuine wrong guess of the same shape).
function wrongCode(code: string): string {
  const first = code[0] === "0" ? "1" : "0";
  return first + code.slice(1);
}

// Register a passkey for `user` through the real begin → authenticator → finish path, so
// a credential the module can later verify an assertion against exists. Returns nothing;
// the authenticator instance now holds the keypair it signs with.
async function registerPasskeyFor(db: Db, auth: SoftwareAuthenticator, user: User): Promise<void> {
  const options = await beginPasskeyRegistration(db, { userId: user.id, userName: user.email }, { rpId: RP_ID });
  const response = await auth.register(options);
  const result = await finishPasskeyRegistration(db, { userId: user.id, response }, { rpId: RP_ID });
  if (!result.ok) assert.fail(`setup registration must verify: ${JSON.stringify(result)}`);
}

// Drive one WebAuthn assertion: issue the authentication challenge for `challengeUserId`
// (so the module's internal finish can verify against the challenge the server issued),
// then have `auth` sign it. Passing a DIFFERENT authenticator than the challenge's owner
// models a credential that is not the claimed person's (the ownership case).
async function assertionFor(
  db: Db,
  auth: SoftwareAuthenticator,
  challengeUserId: string,
): Promise<AuthenticationResponseJSON> {
  const options = await beginPasskeyAuthentication(db, { userId: challengeUserId }, { rpId: RP_ID });
  return auth.authenticate(options);
}

// Create a signed-in session for `userId`, optionally stamping a fresh step-up. Returns
// the (possibly stepped-up) Session plus the raw token the device holds — the shape the
// approval path needs: an existing device approves with its Session, and we later prove
// its token still verifies.
async function freshSignedInSession(
  db: Db,
  userId: string,
  clock: Clock,
  stepUp: boolean,
): Promise<{ session: Session; token: string }> {
  const created = await createSession(db, userId, { clock, random: systemRandom });
  if (!stepUp) return { session: created.session, token: created.token };
  const stepped = await recordStepUp(db, created.session.id, { clock });
  return { session: stepped, token: created.token };
}

// The push messages the outbox recorded (approval prompts travel on the push channel).
function pushes(outbox: Outbox): SentMessage[] {
  return outbox.list().filter((m) => m.channel === "push");
}

// =====================================================================================
// Approval from a signed-in device — the two-party handshake (push + step-up), and the
// AC2 guarantee that the session lands ONLY on the requesting device.
// =====================================================================================

test("requestNewDeviceApproval verifies the code, returns a collection handle, and sends ONE approval push naming the device", async () => {
  const { clock } = mutableClock(T0);
  const outbox = createOutbox();
  const db = await freshDb();
  try {
    const person = await freshUser(db, "req-happy");
    const code = await issueCodeFor(db, person.email, clock, outbox);
    const deviceLabel = "Oren's new iPhone";

    const started = await requestNewDeviceApproval(
      db,
      { email: person.email, code, deviceLabel },
      makeDeps(clock, outbox),
    );
    if (!started.ok) assert.fail(`a valid code must start the request: ${JSON.stringify(started)}`);
    assert.equal(typeof started.requestId, "string", "the requesting device receives a collection handle");
    assert.ok(started.requestId.length > 0, "the collection handle is non-empty");

    // A push prompt was sent, naming the new device so the person knows what they are
    // approving ("Approve sign-in on <deviceLabel>?").
    const sent = pushes(outbox);
    assert.equal(sent.length, 1, "exactly one approval push is sent");
    const [prompt] = sent;
    assert.ok(prompt, "an approval push was recorded");
    assert.ok(
      prompt.body.includes(deviceLabel),
      `the push names the requesting device: ${JSON.stringify(prompt.body)}`,
    );

    // The collection handle is a bearer secret for the requesting device alone — it must
    // NOT ride along in the push (approvals happen inside the signed-in app, and the push
    // is not the one message that delivers a person a sign-in secret). Scoped to the push
    // body only; the random handle has no legitimate reason to appear there.
    assert.ok(
      !prompt.body.includes(started.requestId),
      "the collection handle must never appear in the push prompt",
    );
  } finally {
    await db.close();
  }
});

test("approve-from-signed-in-device issues a session ONLY to the requesting device (AC1 + AC2)", async () => {
  const { clock } = mutableClock(T0);
  const outbox = createOutbox();
  const db = await freshDb();
  try {
    const person = await freshUser(db, "handshake");
    const code = await issueCodeFor(db, person.email, clock, outbox);

    // New device starts the request.
    const started = await requestNewDeviceApproval(
      db,
      { email: person.email, code, deviceLabel: "new laptop" },
      makeDeps(clock, outbox),
    );
    if (!started.ok) assert.fail(`request must start: ${JSON.stringify(started)}`);

    // The person's EXISTING, signed-in device (same account) steps up and approves.
    const approver = await freshSignedInSession(db, person.id, clock, true);
    const approved = await approveNewDeviceRequest(
      db,
      { requestId: started.requestId, approvingSession: approver.session },
      makeDeps(clock, outbox),
    );
    if (!approved.ok) assert.fail(`a stepped-up owner must approve: ${JSON.stringify(approved)}`);

    // Approving hands the approver NO new session — the whole point of AC2. (Narrowly
    // scoped to the approve result object.)
    assert.ok(
      !("token" in approved) && !("cookie" in approved) && !("session" in approved),
      "approving must not mint or return a session to the approver",
    );

    // The requesting device collects — and ONLY now does a session appear, for the person.
    const collected = await collectNewDeviceApproval(
      db,
      { requestId: started.requestId },
      makeDeps(clock, outbox),
    );
    if (!collected.ok) assert.fail(`the approved request must collect a session: ${JSON.stringify(collected)}`);

    assert.equal(collected.session.userId, person.id, "the new session belongs to the person signing in");
    assert.equal(typeof collected.token, "string", "the requesting device is handed a session token");
    assert.equal(typeof collected.cookie, "string", "the requesting device is handed a Set-Cookie value");

    // It is a DISTINCT session from the approver's — the approver's device is not the one
    // being signed in.
    assert.notEqual(collected.session.id, approver.session.id, "the issued session is not the approver's session");
    assert.notEqual(collected.token, approver.token, "the issued token is not the approver's token");

    // The issued token is a real, usable session for the new device.
    const verified = await verifySession(db, collected.token, { clock });
    assert.ok(verified, "the issued session token verifies");
    assert.equal(verified.userId, person.id, "the verified session is the person's");

    // Approving did not disturb the approver's own session.
    const approverStillValid = await verifySession(db, approver.token, { clock });
    assert.ok(approverStillValid, "the approver's own session remains valid after approving");
  } finally {
    await db.close();
  }
});

test("approval requires a FRESH step-up on the approving device", async () => {
  const { clock } = mutableClock(T0);
  const outbox = createOutbox();
  const db = await freshDb();
  try {
    const person = await freshUser(db, "stepup-gate");
    const code = await issueCodeFor(db, person.email, clock, outbox);
    const started = await requestNewDeviceApproval(
      db,
      { email: person.email, code, deviceLabel: "new phone" },
      makeDeps(clock, outbox),
    );
    if (!started.ok) assert.fail(`request must start: ${JSON.stringify(started)}`);

    // A signed-in device that has NOT stepped up cannot approve.
    const notStepped = await freshSignedInSession(db, person.id, clock, false);
    const rejected = await approveNewDeviceRequest(
      db,
      { requestId: started.requestId, approvingSession: notStepped.session },
      makeDeps(clock, outbox),
    );
    assert.equal(rejected.ok, false, "approval without a fresh step-up is refused");

    // …and because approval was refused, the requesting device still has nothing to collect.
    const stillPending = await collectNewDeviceApproval(
      db,
      { requestId: started.requestId },
      makeDeps(clock, outbox),
    );
    assert.equal(stillPending.ok, false, "no session is collectable while the request is unapproved");

    // Once the SAME device steps up, approval goes through and the new device collects.
    const stepped = await freshSignedInSession(db, person.id, clock, true);
    const approved = await approveNewDeviceRequest(
      db,
      { requestId: started.requestId, approvingSession: stepped.session },
      makeDeps(clock, outbox),
    );
    if (!approved.ok) assert.fail(`a stepped-up approval must succeed: ${JSON.stringify(approved)}`);

    const collected = await collectNewDeviceApproval(
      db,
      { requestId: started.requestId },
      makeDeps(clock, outbox),
    );
    if (!collected.ok) assert.fail(`the approved request must collect: ${JSON.stringify(collected)}`);
    assert.equal(collected.session.userId, person.id, "the collected session is the person's");
  } finally {
    await db.close();
  }
});

test("only the request's OWN owner can approve it (member-scoped by the approver's session userId)", async () => {
  const { clock } = mutableClock(T0);
  const outbox = createOutbox();
  const db = await freshDb();
  try {
    const owner = await freshUser(db, "owner");
    const stranger = await freshUser(db, "stranger");
    const code = await issueCodeFor(db, owner.email, clock, outbox);
    const started = await requestNewDeviceApproval(
      db,
      { email: owner.email, code, deviceLabel: "owner's new tablet" },
      makeDeps(clock, outbox),
    );
    if (!started.ok) assert.fail(`request must start: ${JSON.stringify(started)}`);

    // The stranger is fully signed in on their OWN account and has stepped up — yet they
    // must not be able to approve a sign-in for someone else's account.
    const strangerSession = await freshSignedInSession(db, stranger.id, clock, true);
    const rejected = await approveNewDeviceRequest(
      db,
      { requestId: started.requestId, approvingSession: strangerSession.session },
      makeDeps(clock, outbox),
    );
    assert.equal(rejected.ok, false, "another person cannot approve your new-device sign-in");

    // So the requesting device still cannot collect a session.
    const stillPending = await collectNewDeviceApproval(
      db,
      { requestId: started.requestId },
      makeDeps(clock, outbox),
    );
    assert.equal(stillPending.ok, false, "a stranger's attempted approval issues no session");
  } finally {
    await db.close();
  }
});

test("collect is not-ok before approval, for an unknown handle, and is single-use after collection", async () => {
  const { clock } = mutableClock(T0);
  const outbox = createOutbox();
  const db = await freshDb();
  try {
    const person = await freshUser(db, "collect-rules");

    // An unknown handle collects nothing and does not throw.
    const unknown = await collectNewDeviceApproval(
      db,
      { requestId: "no-such-request-id" },
      makeDeps(clock, outbox),
    );
    assert.equal(unknown.ok, false, "an unknown request handle yields no session (and no throw)");

    // Start + collect-before-approval → pending (not-ok).
    const code = await issueCodeFor(db, person.email, clock, outbox);
    const started = await requestNewDeviceApproval(
      db,
      { email: person.email, code, deviceLabel: "new watch" },
      makeDeps(clock, outbox),
    );
    if (!started.ok) assert.fail(`request must start: ${JSON.stringify(started)}`);
    const beforeApproval = await collectNewDeviceApproval(
      db,
      { requestId: started.requestId },
      makeDeps(clock, outbox),
    );
    assert.equal(beforeApproval.ok, false, "nothing is collectable before approval");

    // Approve, then collect once (ok) and again (not-ok) — single collection, like the
    // one-time release store.
    const approver = await freshSignedInSession(db, person.id, clock, true);
    const approved = await approveNewDeviceRequest(
      db,
      { requestId: started.requestId, approvingSession: approver.session },
      makeDeps(clock, outbox),
    );
    if (!approved.ok) assert.fail(`approval must succeed: ${JSON.stringify(approved)}`);

    const first = await collectNewDeviceApproval(db, { requestId: started.requestId }, makeDeps(clock, outbox));
    if (!first.ok) assert.fail(`the first collection must issue a session: ${JSON.stringify(first)}`);

    const second = await collectNewDeviceApproval(db, { requestId: started.requestId }, makeDeps(clock, outbox));
    assert.equal(second.ok, false, "a second collection of the same request issues no further session");
  } finally {
    await db.close();
  }
});

test("a wrong email code starts no approval request and sends no push (the first factor gates it)", async () => {
  const { clock } = mutableClock(T0);
  const outbox = createOutbox();
  const db = await freshDb();
  try {
    const person = await freshUser(db, "req-badcode");
    const code = await issueCodeFor(db, person.email, clock, outbox);

    const started = await requestNewDeviceApproval(
      db,
      { email: person.email, code: wrongCode(code), deviceLabel: "attacker device" },
      makeDeps(clock, outbox),
    );
    assert.equal(started.ok, false, "a wrong email code does not start a new-device request");
    assert.equal(pushes(outbox).length, 0, "no approval push is sent when the first factor fails");
  } finally {
    await db.close();
  }
});

test("requestNewDeviceApproval returns not-ok (never throws) for an email with no account", async () => {
  const { clock } = mutableClock(T0);
  const outbox = createOutbox();
  const db = await freshDb();
  try {
    // A code can be issued to any address (email_codes is keyed by email, not user), but
    // with no `users` row there is no person to approve a sign-in for.
    const ghost = "ghost@warthog.com.au";
    const code = await issueCodeFor(db, ghost, clock, outbox);

    const started = await requestNewDeviceApproval(
      db,
      { email: ghost, code, deviceLabel: "phantom phone" },
      makeDeps(clock, outbox),
    );
    assert.equal(started.ok, false, "no account for the email → not-ok, not a throw");
    assert.equal(pushes(outbox).length, 0, "no push is sent when there is no account to notify");
  } finally {
    await db.close();
  }
});

// =====================================================================================
// Synced passkey / hybrid QR — a WebAuthn assertion as the second factor. Server-
// identical for both transports; one path covers both (see header note).
// =====================================================================================

test("signInNewDeviceWithPasskey issues a session for a valid code + the person's own passkey", async () => {
  const { clock } = mutableClock(T0);
  const outbox = createOutbox();
  const db = await freshDb();
  try {
    const person = await freshUser(db, "pk-happy");
    const auth = createAuthenticator();
    await registerPasskeyFor(db, auth, person);

    const code = await issueCodeFor(db, person.email, clock, outbox);
    const response = await assertionFor(db, auth, person.id);

    const result = await signInNewDeviceWithPasskey(
      db,
      { email: person.email, code, response },
      makeDeps(clock, outbox),
    );
    if (!result.ok) assert.fail(`code + own passkey must sign in: ${JSON.stringify(result)}`);

    assert.equal(result.session.userId, person.id, "the session belongs to the person");
    const verified = await verifySession(db, result.token, { clock });
    assert.ok(verified, "the issued passkey session token verifies");
    assert.equal(verified.userId, person.id, "the verified session is the person's");
  } finally {
    await db.close();
  }
});

test("signInNewDeviceWithPasskey refuses (and issues no session) when the email code is wrong", async () => {
  const { clock } = mutableClock(T0);
  const outbox = createOutbox();
  const db = await freshDb();
  try {
    const person = await freshUser(db, "pk-badcode");
    const auth = createAuthenticator();
    await registerPasskeyFor(db, auth, person);

    const code = await issueCodeFor(db, person.email, clock, outbox);
    const response = await assertionFor(db, auth, person.id);

    const result = await signInNewDeviceWithPasskey(
      db,
      { email: person.email, code: wrongCode(code), response },
      makeDeps(clock, outbox),
    );
    assert.equal(result.ok, false, "a valid passkey does not rescue a wrong email code");

    // The failed first factor issued no session: this person has none (the approver-less
    // single-shot path creates sessions only on success).
    const count = await db.query("SELECT count(*)::int AS n FROM sessions WHERE user_id = $1", [person.id]);
    assert.equal(count.rows[0]?.n, 0, "a failed sign-in issues no session");
  } finally {
    await db.close();
  }
});

test("signInNewDeviceWithPasskey rejects a passkey that is not the claimed person's (ownership)", async () => {
  const { clock } = mutableClock(T0);
  const outbox = createOutbox();
  const db = await freshDb();
  try {
    const person = await freshUser(db, "pk-owner");
    const other = await freshUser(db, "pk-other");
    const personAuth = createAuthenticator();
    const otherAuth = createAuthenticator();
    await registerPasskeyFor(db, personAuth, person);
    await registerPasskeyFor(db, otherAuth, other);

    // The new device claims `person`'s email with a valid code, but presents a credential
    // that belongs to `other` (signed against person's issued challenge, by other's key).
    const code = await issueCodeFor(db, person.email, clock, outbox);
    const foreignResponse = await assertionFor(db, otherAuth, person.id);

    const result = await signInNewDeviceWithPasskey(
      db,
      { email: person.email, code, response: foreignResponse },
      makeDeps(clock, outbox),
    );
    assert.equal(result.ok, false, "a credential that is not the claimed person's is rejected");
  } finally {
    await db.close();
  }
});

// =====================================================================================
// Recovery code — the last-resort second factor.
// =====================================================================================

test("signInNewDeviceWithRecoveryCode issues a session for a valid code + the correct recovery code", async () => {
  const { clock } = mutableClock(T0);
  const outbox = createOutbox();
  const db = await freshDb();
  try {
    const person = await freshUser(db, "rc-happy");
    const { code: recoveryCode } = await issueRecoveryCode(db, person.id, { random: systemRandom });
    const code = await issueCodeFor(db, person.email, clock, outbox);

    const result = await signInNewDeviceWithRecoveryCode(
      db,
      { email: person.email, code, recoveryCode },
      makeDeps(clock, outbox),
    );
    if (!result.ok) assert.fail(`code + recovery code must sign in: ${JSON.stringify(result)}`);

    assert.equal(result.session.userId, person.id, "the session belongs to the person");
    const verified = await verifySession(db, result.token, { clock });
    assert.ok(verified, "the issued recovery session token verifies");
    assert.equal(verified.userId, person.id, "the verified session is the person's");
  } finally {
    await db.close();
  }
});

test("signInNewDeviceWithRecoveryCode refuses a wrong recovery code", async () => {
  const { clock } = mutableClock(T0);
  const outbox = createOutbox();
  const db = await freshDb();
  try {
    const person = await freshUser(db, "rc-wrong");
    const { code: recoveryCode } = await issueRecoveryCode(db, person.id, { random: systemRandom });
    const code = await issueCodeFor(db, person.email, clock, outbox);

    // A well-formed but wrong recovery code (flip the first base32 character).
    const bad = (recoveryCode[0] === "A" ? "B" : "A") + recoveryCode.slice(1);
    const result = await signInNewDeviceWithRecoveryCode(
      db,
      { email: person.email, code, recoveryCode: bad },
      makeDeps(clock, outbox),
    );
    assert.equal(result.ok, false, "a wrong recovery code does not sign in");
  } finally {
    await db.close();
  }
});

test("signInNewDeviceWithRecoveryCode refuses when the email code is wrong, even with the correct recovery code", async () => {
  const { clock } = mutableClock(T0);
  const outbox = createOutbox();
  const db = await freshDb();
  try {
    const person = await freshUser(db, "rc-badcode");
    const { code: recoveryCode } = await issueRecoveryCode(db, person.id, { random: systemRandom });
    const code = await issueCodeFor(db, person.email, clock, outbox);

    const result = await signInNewDeviceWithRecoveryCode(
      db,
      { email: person.email, code: wrongCode(code), recoveryCode },
      makeDeps(clock, outbox),
    );
    assert.equal(result.ok, false, "the recovery code does not rescue a wrong email code (first factor gates it)");
  } finally {
    await db.close();
  }
});
