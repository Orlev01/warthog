// E04-S09 — Account reset after lost factors
// (`src/server/auth/account-reset.ts`, `db/migrations/0008_account_reset.sql`).
//
// RED-first: neither the account-reset module nor its migration exists yet, so
// importing `./account-reset` throws and `freshDb()` has no `account_resets`
// schema — every test here fails until the builder adds them. That absence IS the
// point of test-first; do NOT implement anything to make these pass.
//
// These tests pin BEHAVIOUR (what each function RETURNS, what is stored, what is
// sent, and what the completion actually does), never the source text of the
// module or the SQL file — a later rename that preserves behaviour must not redden
// them. There is no browser, no Azure and no network: the email one-time code is
// driven through the REAL sibling issuer (email-code), alerts are recorded in the
// dev/test outbox (notify), the 7-day timer is observed through the REAL jobs
// queue (E01-S11), and everything runs against an isolated in-memory PGlite with
// the real migrations (src/test/db).
//
// Why this exists (brief "Device-held protection …"; design §4.2, §5): when every
// passkey AND the recovery code are lost, the account can still be reset — but
// only by email, after a 7-day waiting period during which every registered
// channel (push, email, SMS) is alerted and the reset can be cancelled from any
// signed-in device. A completed reset ERASES the VK-wrapped vault data (so the
// device-held high-tier details and cards are gone, never exposed) and REVOKES
// every agent and service connection, while KEEPING everything else (the account
// itself, the per-person DEK and the DEK-encrypted content survive — a reset is
// not an account deletion).
//
// ── Why the erase/revoke is an INJECTED seam, not direct SQL here ────────────────
// This task lands at migration 0008. The tables a reset must act on are created
// MUCH later — `vault_unlock_methods` (0021), `agents` (0020), `connections`
// (0018), `agent_permissions` (0013) — and this task may touch only
// `src/server/auth/account-reset.ts` and `db/migrations/0008_account_reset.sql`.
// So the module cannot (and must not) issue DELETEs against tables that do not
// exist yet. It OWNS the reset state machine (request → 7-day wait → cancel /
// complete) and DELEGATES the cross-aggregate erase/revoke through a `ResetExecutor`
// seam — exactly as it delegates delivery through the notification `Senders` seam
// and persistence through the `Db` seam. The app wires the real executor (which
// clears the vault-unlock rows and revokes agents/connections) when those
// aggregates exist; here a spy executor lets us assert the completion REQUESTS the
// erase and the revocation for the right person, and that a cancelled reset
// requests neither. This is the only design that is both buildable at 0008 and a
// faithful test of the acceptance criteria.
//
// ── The contract this task defines (the builder implements EXACTLY this) ─────────
//
//   // The cross-aggregate work a completed reset performs, injected because the
//   // vault / agent / connection stores live in other aggregates (and are built
//   // later). account-reset owns only the state machine and calls this seam when a
//   // still-pending (never a cancelled) reset completes.
//   export interface ResetExecutor {
//     eraseVaultData(userId: string): Promise<void>;            // VK-wrapped vault data
//     revokeAgentsAndConnections(userId: string): Promise<void>; // every agent + connection
//   }
//
//   // A superset deps bundle; each function reads only the subset it needs, so one
//   // bundle drives all three (the new-device pattern). The outbox satisfies the
//   // push / email / sms senders.
//   deps: { clock: Clock; random: Random; hmacKey: Uint8Array;
//           senders: Senders; executor: ResetExecutor }
//
//   requestAccountReset(
//     db, { email: string; code: string }, deps,
//   ): Promise<{ ok: true } | { ok: false; reason: string }>
//     • verifies the email one-time code (the first factor) for `email` and resolves
//       the person by email; a failed code OR no account starts NOTHING — no timer,
//       no alert — and returns { ok: false }.
//     • on success records a pending reset for the person, starts a 7-day timer
//       (a background job due now+7d, and/or a completion time stored on the reset),
//       and alerts EVERY channel once: deps.senders.push, .email and .sms.
//
//   cancelAccountReset(
//     db, { userId: string }, deps,
//   ): Promise<{ ok: true } | { ok: false; reason: string }>
//     • cancels the person's pending reset. It takes the userId from the session, so
//       ANY signed-in device of that person can cancel (member-scoped — never an id
//       from the client); another person's userId cannot cancel this reset.
//     • { ok: false } (never a throw) when the person has no pending reset.
//
//   completeAccountReset(
//     db, { userId: string }, deps,
//   ): Promise<unknown>
//     • the action the 7-day timer fires. ONLY when the person's reset is still
//       pending does it call deps.executor.eraseVaultData(userId) and
//       deps.executor.revokeAgentsAndConnections(userId) (each once) and mark the
//       reset done. A cancelled reset, or no pending reset, is a safe no-op — the
//       executor is NOT called (so a cancel wins the race against the firing timer,
//       and a stray fire never wipes a vault that did not request a reset).
//     • keeps everything else: the account's users row and its wrapped DEK survive.
//
//   The schema this task defines: `db/migrations/0008_account_reset.sql` creates an
//   `account_resets` table (the pending-reset state per person), applied by the
//   shared migration runner — named below exactly as the recovery/email-code tests
//   name the tables their migrations create.
//
// ── Acceptance criteria → tests ──────────────────────────────────────────────────
//   AC1 "A reset request starts a 7-day timer, alerts every registered channel, and
//        is cancellable from any signed-in device."
//        — a valid-code request schedules completion 7 days out and alerts push,
//          email AND sms; a bad code / unknown account starts nothing; the pending
//          reset is cancellable by the person's userId (any device) and cancel is
//          member-scoped; cancelling with nothing pending is a plain { ok: false }.
//   AC2 "On completion it erases VK-wrapped vault data, revokes all agents and
//        connections, and keeps everything else."
//        — completing a pending reset calls the erase AND the revoke exactly once
//          for that person; a cancelled reset (and a never-requested one) calls
//          neither; the account's users row and wrapped DEK survive completion.
//   Migration: 0008_account_reset applies, creates `account_resets`, and re-running
//        every migration changes nothing (idempotent).
//
// Every db handle is closed in a `finally` so node:test leaves no open handle; each
// test uses its own `freshDb()` and fresh outboxes/executor, so tests share no
// state. Email codes are drawn through the REAL issuer so the module verifies a
// genuine code; the first-factor code is issued on a SEPARATE outbox from the
// alert outbox, so the alert outbox holds the reset alerts alone.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  requestAccountReset,
  cancelAccountReset,
  completeAccountReset,
  getPendingAccountReset,
  type ResetExecutor,
} from "./account-reset";
import { createResetExecutor } from "../account/reset-executor";
import { addCard, listCards } from "../db/cards";
import { issueEmailCode } from "./email-code";
import { freshDb } from "../../test/db";
import { createUser, getUserById, type User } from "../db/users";
import { createOutbox, type Outbox } from "../notify/outbox";
import { systemRandom } from "../seams/random";
import { fixedClock, type Clock } from "../seams/clock";
import { loadMigrations, runMigrations, type Db } from "../db/index";

const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const SEVEN_DAYS_MS = 7 * DAY_MS;

// A fixed instant the whole file requests against, so the 7-day timer lands at a
// deterministic, checkable moment (no wall-clock dependence).
const T0 = new Date("2026-05-01T00:00:00.000Z");

// One keyed HMAC for the email-code first factor: setup issues the code and the
// module verifies it under the SAME key, so the issued code verifies inside
// requestAccountReset.
const HMAC_KEY = new Uint8Array(Buffer.from("warthog-account-reset-hmac-key-0123456789ab", "utf8"));

// A placeholder wrapped-DEK reference; createUser stores it verbatim (opaque to the
// app). We only need a genuine `users` row so a reset hangs off a real userId (the
// account id every member-scoped row filters by) — and so "keeps everything else"
// can check the DEK survives.
const WRAPPED_DEK = "wrapped-dek-placeholder";

// The superset deps bundle. Each account-reset function reads only the fields it
// needs; a non-literal superset is structurally assignable to each per-function
// deps type, so one bundle drives request, cancel and complete. The outbox is all
// three senders at once; `executor` is only read by completion.
function makeDeps(clock: Clock, alertOutbox: Outbox, executor: ResetExecutor) {
  return {
    clock,
    random: systemRandom,
    hmacKey: HMAC_KEY,
    senders: { push: alertOutbox, email: alertOutbox, sms: alertOutbox },
    executor,
  };
}

// A spy executor: it records the userId handed to each half of the completion, so a
// test can assert the erase and the revoke were requested (and for whom) without a
// real vault/agent/connection store — which does not exist at migration 0008.
function makeExecutorSpy(): { executor: ResetExecutor; erased: string[]; revoked: string[] } {
  const erased: string[] = [];
  const revoked: string[] = [];
  const executor: ResetExecutor = {
    async eraseVaultData(userId: string): Promise<void> {
      erased.push(userId);
    },
    async revokeAgentsAndConnections(userId: string): Promise<void> {
      revoked.push(userId);
    },
  };
  return { executor, erased, revoked };
}

// Create a genuine person row and return it. Distinct labels give distinct (unique)
// emails within a test, so two users never collide on the users.email UNIQUE.
async function freshUser(db: Db, label: string): Promise<User> {
  return createUser(db, { email: `${label}@warthog.com.au`, wrappedDek: WRAPPED_DEK });
}

// Pull the standalone 6-digit code out of a delivered email body (robust to copy).
function extractCode(body: string): string {
  const match = body.match(/(?<!\d)\d{6}(?!\d)/);
  assert.ok(match, `the email body must carry a standalone 6-digit code: ${JSON.stringify(body)}`);
  return match[0];
}

// Issue an email one-time code for `email` through the REAL issuer and read the
// plaintext back from the one delivered email — exactly how the person receives it.
// Issued on its OWN outbox, kept apart from the alert outbox under test.
async function issueCodeFor(db: Db, email: string, clock: Clock, outbox: Outbox): Promise<string> {
  await issueEmailCode(db, email, { purpose: "reset", clock, random: systemRandom, hmacKey: HMAC_KEY, emailSender: outbox });
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

// Issue a fresh code (on a throwaway setup outbox) and start a reset for `user`,
// asserting it succeeded. `alertOutbox` and `executor` are the caller's, so a test
// can inspect the alerts / drive the completion afterwards.
async function requestResetFor(
  db: Db,
  user: User,
  clock: Clock,
  alertOutbox: Outbox,
  executor: ResetExecutor,
): Promise<void> {
  const setupOutbox = createOutbox();
  const code = await issueCodeFor(db, user.email, clock, setupOutbox);
  const result = await requestAccountReset(db, { email: user.email, code }, makeDeps(clock, alertOutbox, executor));
  assert.ok(result.ok, `requesting a reset with a valid code must succeed: ${JSON.stringify(result)}`);
}

// Whether a relation of this exact name exists on this handle. `to_regclass` yields
// the relation name when it exists and NULL otherwise — a non-throwing probe scoped
// to the one table under test (behaviour, not source text).
async function tableExists(db: Db, name: string): Promise<boolean> {
  const result = await db.query("SELECT to_regclass($1) AS t", [name]);
  return result.rows[0]?.t != null;
}

// Parse a stored cell to an epoch-ms timestamp, or null when it is not a timestamp
// (a uuid, a status word, …) — so a column scan can find a completion time without
// pinning its column name.
function asTimestamp(v: unknown): number | null {
  if (v instanceof Date) return v.getTime();
  if (typeof v === "string" || typeof v === "number") {
    const t = new Date(v).getTime();
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

// The 7-day timer, observed WITHOUT pinning its mechanism: it may be a scheduled
// background job (jobs.run_at, the E01-S11 queue) and/or a completion time stored
// on the account_resets row. Returns the delay (ms) from `from` to the earliest
// FUTURE completion instant found, or null when none is present. Never throws.
async function scheduledCompletionDelayMs(db: Db, from: Date): Promise<number | null> {
  const delays: number[] = [];

  const jobs = await db.query("SELECT run_at FROM jobs");
  for (const row of jobs.rows) {
    const t = asTimestamp(row.run_at);
    if (t != null && t > from.getTime()) delays.push(t - from.getTime());
  }

  if (await tableExists(db, "account_resets")) {
    const resets = await db.query("SELECT * FROM account_resets");
    for (const row of resets.rows) {
      for (const value of Object.values(row)) {
        const t = asTimestamp(value);
        if (t != null && t > from.getTime()) delays.push(t - from.getTime());
      }
    }
  }

  return delays.length === 0 ? null : Math.min(...delays);
}

// Register a mobile number for `userId` (verified or not), as the settings flow leaves it.
async function addMobile(db: Db, userId: string, number: string, verified: boolean): Promise<void> {
  await db.query(
    `INSERT INTO mobile_numbers (user_id, number, verified, code_hmac, code_expires_at, created_at, verified_at)
     VALUES ($1, $2, $3, NULL, NULL, $4::timestamptz, $5::timestamptz)`,
    [userId, number, verified, T0.toISOString(), verified ? T0.toISOString() : null],
  );
}

// The distinct channels the outbox recorded.
function channelsIn(outbox: Outbox): Set<string> {
  return new Set(outbox.list().map((m) => m.channel));
}

// =====================================================================================
// AC1 — a reset request starts a 7-day timer and alerts every registered channel.
// =====================================================================================

test("requestAccountReset with a valid email code starts a 7-day timer", async () => {
  const clock = fixedClock(T0);
  const alertOutbox = createOutbox();
  const { executor } = makeExecutorSpy();
  const db = await freshDb();
  try {
    const person = await freshUser(db, "timer");
    await requestResetFor(db, person, clock, alertOutbox, executor);

    // Completion is scheduled for the request instant + 7 days (design §5: "email
    // code + 7-day wait"), observable as a due-in-7-days background job and/or a
    // completion time on the reset row. The frozen clock makes this exact.
    const delay = await scheduledCompletionDelayMs(db, T0);
    assert.ok(delay != null, "a reset request must schedule a completion (the 7-day timer)");
    assert.ok(
      Math.abs(delay - SEVEN_DAYS_MS) < MINUTE_MS,
      `the timer must be 7 days from the request instant (got ${delay}ms, expected ~${SEVEN_DAYS_MS}ms)`,
    );
  } finally {
    await db.close();
  }
});

test("the reset request alerts every registered channel (push, email and SMS)", async () => {
  const clock = fixedClock(T0);
  const alertOutbox = createOutbox();
  const { executor } = makeExecutorSpy();
  const db = await freshDb();
  try {
    const person = await freshUser(db, "alerts");
    // SMS reaches a person only on a VERIFIED mobile number (review fix W3.3), so this
    // person has one registered.
    await addMobile(db, person.id, "+61 400 000 111", true);
    // The first-factor code was issued on a SEPARATE outbox inside requestResetFor,
    // so alertOutbox holds only the reset alerts (a successful code verify sends
    // nothing to it).
    await requestResetFor(db, person, clock, alertOutbox, executor);

    const channels = channelsIn(alertOutbox);
    assert.ok(channels.has("push"), "a reset alert is sent on the push channel");
    assert.ok(channels.has("email"), "a reset alert is sent on the email channel");
    assert.ok(channels.has("sms"), "a reset alert is sent on the sms channel");
  } finally {
    await db.close();
  }
});

test("SMS-off account reset keeps email and push alerts without calling a saved mobile", async () => {
  const db = await freshDb();
  try {
    const clock = fixedClock(T0);
    const alerts = createOutbox();
    const person = await freshUser(db, "sms-off-reset");
    await addMobile(db, person.id, "+61400000111", true);
    const code = await issueCodeFor(db, person.email, clock, createOutbox());
    const deps = makeDeps(clock, alerts, makeExecutorSpy().executor);
    let smsCalls = 0;
    const result = await requestAccountReset(db, { email: person.email, code }, { ...deps,
      senders: { ...deps.senders, sms: { enabled: false, async sendSms() { smsCalls++; } } } });
    assert.deepEqual(result, { ok: true });
    assert.equal(smsCalls, 0);
    assert.deepEqual(channelsIn(alerts), new Set(["push", "email"]));
  } finally { await db.close(); }
});

test("a wrong email code starts no reset — no timer and no alert", async () => {
  const clock = fixedClock(T0);
  const alertOutbox = createOutbox();
  const { executor } = makeExecutorSpy();
  const db = await freshDb();
  try {
    const person = await freshUser(db, "bad-code");
    const setupOutbox = createOutbox();
    const code = await issueCodeFor(db, person.email, clock, setupOutbox);

    const result = await requestAccountReset(
      db,
      { email: person.email, code: wrongCode(code) },
      makeDeps(clock, alertOutbox, executor),
    );

    assert.equal(result.ok, false, "a reset must not start without a valid email code");
    assert.equal(
      await scheduledCompletionDelayMs(db, T0),
      null,
      "a rejected request schedules no completion timer",
    );
    assert.equal(alertOutbox.list().length, 0, "a rejected request alerts no channel");
  } finally {
    await db.close();
  }
});

test("a reset for an email with no account starts nothing", async () => {
  const clock = fixedClock(T0);
  const alertOutbox = createOutbox();
  const { executor } = makeExecutorSpy();
  const db = await freshDb();
  try {
    // A code exists for this address, but no `users` row does — resolving the person
    // fails, so the request starts nothing even though the code itself is correct.
    const orphanEmail = "no-such-account@warthog.com.au";
    const setupOutbox = createOutbox();
    const code = await issueCodeFor(db, orphanEmail, clock, setupOutbox);

    const result = await requestAccountReset(
      db,
      { email: orphanEmail, code },
      makeDeps(clock, alertOutbox, executor),
    );

    assert.equal(result.ok, false, "a reset for an unknown account must not start");
    assert.equal(await scheduledCompletionDelayMs(db, T0), null, "no completion timer is scheduled");
    assert.equal(alertOutbox.list().length, 0, "no channel is alerted");
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC1 — cancellable from any signed-in device (member-scoped by the session userId).
// =====================================================================================

test("a pending reset is cancellable by the person's userId, and cancelling stops the completion from erasing anything", async () => {
  const clock = fixedClock(T0);
  const alertOutbox = createOutbox();
  const { executor, erased, revoked } = makeExecutorSpy();
  const db = await freshDb();
  try {
    const person = await freshUser(db, "cancel");
    await requestResetFor(db, person, clock, alertOutbox, executor);

    // Cancellation needs only the session's userId — so ANY signed-in device of the
    // person can cancel (no requesting-device handle is required).
    const cancelled = await cancelAccountReset(db, { userId: person.id }, makeDeps(clock, alertOutbox, executor));
    assert.ok(cancelled.ok, `cancelling a pending reset must succeed: ${JSON.stringify(cancelled)}`);

    // When the 7-day timer later fires, completion must find the reset cancelled and
    // erase / revoke NOTHING — the cancel wins the race.
    await completeAccountReset(db, { userId: person.id }, makeDeps(clock, alertOutbox, executor));
    assert.deepEqual(erased, [], "a cancelled reset must not erase vault data");
    assert.deepEqual(revoked, [], "a cancelled reset must not revoke agents or connections");
  } finally {
    await db.close();
  }
});

test("cancel is member-scoped: another person cannot cancel this person's reset", async () => {
  const clock = fixedClock(T0);
  const alertOutbox = createOutbox();
  const { executor, erased, revoked } = makeExecutorSpy();
  const db = await freshDb();
  try {
    const alice = await freshUser(db, "scope-alice");
    const bob = await freshUser(db, "scope-bob");
    await requestResetFor(db, alice, clock, alertOutbox, executor);

    // Bob (no reset of his own) tries to cancel using his own userId — he cannot
    // touch Alice's reset, and gets a plain { ok: false } rather than a throw.
    const bobTry = await cancelAccountReset(db, { userId: bob.id }, makeDeps(clock, alertOutbox, executor));
    assert.equal(bobTry.ok, false, "a person with no pending reset cancels nothing");

    // Alice's reset is untouched, so its completion still erases and revokes — for
    // Alice, and only Alice.
    await completeAccountReset(db, { userId: alice.id }, makeDeps(clock, alertOutbox, executor));
    assert.deepEqual(erased, [alice.id], "Alice's reset still erases her vault data after Bob's failed cancel");
    assert.deepEqual(revoked, [alice.id], "Alice's reset still revokes her agents and connections");
  } finally {
    await db.close();
  }
});

test("cancelAccountReset returns not-ok (never throws) when the person has no pending reset", async () => {
  const clock = fixedClock(T0);
  const alertOutbox = createOutbox();
  const { executor } = makeExecutorSpy();
  const db = await freshDb();
  try {
    const person = await freshUser(db, "cancel-none");
    const result = await cancelAccountReset(db, { userId: person.id }, makeDeps(clock, alertOutbox, executor));
    assert.equal(result.ok, false, "cancelling with nothing pending is a plain false, not a throw");
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC2 — on completion: erase VK-wrapped vault data, revoke agents + connections, keep
// everything else.
// =====================================================================================

test("completing a pending reset erases VK-wrapped vault data and revokes all agents and connections for that person", async () => {
  const clock = fixedClock(T0);
  const alertOutbox = createOutbox();
  const { executor, erased, revoked } = makeExecutorSpy();
  const db = await freshDb();
  try {
    const person = await freshUser(db, "complete");
    await requestResetFor(db, person, clock, alertOutbox, executor);

    await completeAccountReset(db, { userId: person.id }, makeDeps(clock, alertOutbox, executor));

    // Both halves of the acceptance criterion fire, exactly once, for this person:
    // the VK-wrapped vault data is erased and every agent and connection is revoked.
    assert.deepEqual(erased, [person.id], "completion erases the person's VK-wrapped vault data once");
    assert.deepEqual(revoked, [person.id], "completion revokes the person's agents and connections once");
  } finally {
    await db.close();
  }
});

test("a completed reset keeps everything else: the account's users row and wrapped DEK survive", async () => {
  const clock = fixedClock(T0);
  const alertOutbox = createOutbox();
  const { executor } = makeExecutorSpy();
  const db = await freshDb();
  try {
    const person = await freshUser(db, "keeps-rest");
    await requestResetFor(db, person, clock, alertOutbox, executor);

    await completeAccountReset(db, { userId: person.id }, makeDeps(clock, alertOutbox, executor));

    // A reset is NOT an account deletion: the person signs back in afterwards. The
    // users row survives and the per-person DEK is untouched (only VK-wrapped vault
    // data is erased), so DEK-encrypted content stays readable — "keeps everything
    // else".
    const after = await getUserById(db, person.id);
    assert.ok(after, "the account's users row must survive a reset (a reset is not a deletion)");
    assert.equal(after.wrappedDek, WRAPPED_DEK, "the per-person wrapped DEK is kept (not crypto-shredded) by a reset");
  } finally {
    await db.close();
  }
});

test("completing when no reset is pending does nothing (no erase, no revoke)", async () => {
  const clock = fixedClock(T0);
  const alertOutbox = createOutbox();
  const { executor, erased, revoked } = makeExecutorSpy();
  const db = await freshDb();
  try {
    const person = await freshUser(db, "complete-none");
    // No reset was ever requested — a stray completion must not wipe a vault.
    await completeAccountReset(db, { userId: person.id }, makeDeps(clock, alertOutbox, executor));
    assert.deepEqual(erased, [], "completion with no pending reset erases nothing");
    assert.deepEqual(revoked, [], "completion with no pending reset revokes nothing");
  } finally {
    await db.close();
  }
});

// =====================================================================================
// Migration — 0008_account_reset applies and a second run changes nothing.
// =====================================================================================

test("the account-reset migration applies and re-running every migration changes nothing", async () => {
  const db = await freshDb();
  try {
    const migrations = await loadMigrations();
    assert.ok(
      migrations.some((m) => m.name === "0008_account_reset"),
      "db/migrations/0008_account_reset.sql must be part of the project migrations",
    );
    assert.ok(
      await tableExists(db, "account_resets"),
      "the account-reset migration must create the account_resets table",
    );

    // A second run over the same database applies nothing new and does not throw —
    // re-executing 0008's CREATE would throw "already exists", so an empty result AND
    // no throw together prove the migration's second run changes nothing (idempotent).
    const again = await runMigrations(db, migrations);
    assert.deepEqual(again, [], "a second migration run must change nothing");
  } finally {
    await db.close();
  }
});

// =====================================================================================
// Review fix W3.3 — the alerts reach the person's real channels, each independently, and a
// completion is marked done only together with the erase and the revoke.
// =====================================================================================

test("the SMS alert goes to the person's verified mobile number — never their user id or an unverified number", async () => {
  const clock = fixedClock(T0);
  const alertOutbox = createOutbox();
  const { executor } = makeExecutorSpy();
  const db = await freshDb();
  try {
    const person = await freshUser(db, "sms-target");
    await addMobile(db, person.id, "+61 400 000 222", false);
    await addMobile(db, person.id, "+61 400 000 333", true);
    await requestResetFor(db, person, clock, alertOutbox, executor);

    const sms = alertOutbox.list().filter((m) => m.channel === "sms");
    assert.deepEqual(sms.map((m) => m.recipient), ["+61 400 000 333"], "one SMS, to the verified number");
    assert.ok(alertOutbox.list().every((m) => m.channel === "push" || m.recipient !== person.id));
  } finally {
    await db.close();
  }
});

test("a person with no verified mobile number gets no SMS, and the reset still starts", async () => {
  const clock = fixedClock(T0);
  const alertOutbox = createOutbox();
  const { executor } = makeExecutorSpy();
  const db = await freshDb();
  try {
    const person = await freshUser(db, "no-mobile");
    await requestResetFor(db, person, clock, alertOutbox, executor);
    assert.equal(alertOutbox.list().filter((m) => m.channel === "sms").length, 0, "nothing is texted");
    assert.ok(channelsIn(alertOutbox).has("email"), "the email alert still goes out");
  } finally {
    await db.close();
  }
});

test("a failing channel does not stop the others from being alerted", async () => {
  const clock = fixedClock(T0);
  const outbox = createOutbox();
  const { executor } = makeExecutorSpy();
  const db = await freshDb();
  try {
    const person = await freshUser(db, "one-fails");
    await addMobile(db, person.id, "+61 400 000 444", true);
    const code = await issueCodeFor(db, person.email, clock, createOutbox());
    const deps = {
      ...makeDeps(clock, outbox, executor),
      senders: {
        push: { sendPush: async () => Promise.reject(new Error("push service down")) },
        email: outbox,
        sms: outbox,
      },
    };
    const result = await requestAccountReset(db, { email: person.email, code }, deps);
    assert.deepEqual(result, { ok: true }, "the reset starts");
    assert.deepEqual([...channelsIn(outbox)].sort(), ["email", "sms"], "email and SMS still go out after push fails");
  } finally {
    await db.close();
  }
});

test("when no channel can be reached the reset does not start", async () => {
  const clock = fixedClock(T0);
  const { executor, erased } = makeExecutorSpy();
  const db = await freshDb();
  try {
    const person = await freshUser(db, "none-reached");
    const code = await issueCodeFor(db, person.email, clock, createOutbox());
    const fail = async () => Promise.reject(new Error("down"));
    const deps = {
      ...makeDeps(clock, createOutbox(), executor),
      senders: { push: { sendPush: fail }, email: { sendEmail: fail }, sms: { sendSms: fail } },
    };
    const result = await requestAccountReset(db, { email: person.email, code }, deps);
    assert.deepEqual(result, { ok: false, reason: "alert_failed" }, "nobody could be told, so nothing starts");
    const pending = await db.query("SELECT 1 FROM account_resets WHERE user_id = $1 AND status = 'pending'", [person.id]);
    assert.equal(pending.rows.length, 0, "no pending reset is left behind");
    assert.equal(await scheduledCompletionDelayMs(db, T0), null, "no completion is scheduled");
    await completeAccountReset(db, { userId: person.id }, makeDeps(clock, createOutbox(), executor));
    assert.deepEqual(erased, [], "a stray completion erases nothing");
  } finally {
    await db.close();
  }
});

test("a completion whose erase fails stays pending for the retry, and the retry completes it", async () => {
  const clock = fixedClock(T0);
  const { executor, erased } = makeExecutorSpy();
  const db = await freshDb();
  try {
    const person = await freshUser(db, "erase-fails");
    await requestResetFor(db, person, clock, createOutbox(), executor);

    const failing: ResetExecutor = {
      ...executor,
      async eraseVaultData() {
        throw new Error("storage unavailable");
      },
    };
    await assert.rejects(
      completeAccountReset(db, { userId: person.id }, makeDeps(clock, createOutbox(), failing)),
      /storage unavailable/,
      "the failure surfaces, so the job runner retries",
    );
    const status = await db.query("SELECT status FROM account_resets WHERE user_id = $1", [person.id]);
    assert.equal(status.rows[0]?.status, "pending", "the reset is not marked done");

    assert.deepEqual(await completeAccountReset(db, { userId: person.id }, makeDeps(clock, createOutbox(), executor)), {
      ok: true,
    });
    assert.deepEqual(erased, [person.id], "the retry erases");
  } finally {
    await db.close();
  }
});

test("the erase, the revoke and the status change commit together: a failed revoke undoes the erase", async () => {
  const clock = fixedClock(T0);
  const { executor: spy } = makeExecutorSpy();
  const real = await freshDb();
  try {
    const person = await freshUser(real, "atomic");
    await requestResetFor(real, person, clock, createOutbox(), spy);
    await addCard(real, {
      userId: person.id,
      brand: "visa",
      lastFour: "4242",
      expiryMonth: 12,
      expiryYear: 2030,
      nickname: "card",
      billingAddressId: "addr-1",
      numberCiphertext: "v1:card",
    });
    // A db whose agent revoke fails, after the vault erase has run in the same unit.
    const db: Db = {
      query(text, values = []) {
        if (/UPDATE agents SET status = 'disconnected'/.test(text)) return Promise.reject(new Error("lock timeout"));
        return real.query(text, values);
      },
      close: () => real.close(),
    };
    await assert.rejects(
      completeAccountReset(db, { userId: person.id }, makeDeps(clock, createOutbox(), createResetExecutor(db))),
      /lock timeout/,
    );
    assert.equal((await listCards(real, person.id)).length, 1, "the erase was rolled back with the failed revoke");
    const status = await real.query("SELECT status FROM account_resets WHERE user_id = $1", [person.id]);
    assert.equal(status.rows[0]?.status, "pending", "and the reset is still pending");
  } finally {
    await real.close();
  }
});

test("getPendingAccountReset reports a pending reset's dates to its own person only", async () => {
  const clock = fixedClock(T0);
  const { executor } = makeExecutorSpy();
  const db = await freshDb();
  try {
    const person = await freshUser(db, "pending-read");
    const other = await freshUser(db, "pending-read-other");
    assert.equal(await getPendingAccountReset(db, { userId: person.id }), null, "nothing pending yet");
    await requestResetFor(db, person, clock, createOutbox(), executor);

    const pending = await getPendingAccountReset(db, { userId: person.id });
    assert.equal(pending?.requestedAt.getTime(), T0.getTime());
    assert.equal(pending?.completesAt.getTime(), T0.getTime() + SEVEN_DAYS_MS);
    assert.equal(await getPendingAccountReset(db, { userId: other.id }), null, "another person sees nothing");

    await cancelAccountReset(db, { userId: person.id }, {});
    assert.equal(await getPendingAccountReset(db, { userId: person.id }), null, "a cancelled reset is not pending");
  } finally {
    await db.close();
  }
});
