// E04-S09 — Account reset after lost factors (design §5; brief "Device-held
// protection…"). When every passkey AND the recovery code are lost, the account
// can still be reset — but only by email, after a 7-day wait during which every
// registered channel (push, email, SMS) is alerted and the reset can be cancelled
// from any signed-in device. A completed reset ERASES the VK-wrapped vault data
// (so the device-held high-tier details and cards are gone, never exposed) and
// REVOKES every agent and service connection, while KEEPING everything else: the
// account's `users` row and its per-person wrapped DEK survive — a reset is not an
// account deletion.
//
// This module OWNS only the reset state machine (request → 7-day wait → cancel /
// complete) in the `account_resets` table. The 7-day timer is a background job on
// the real jobs queue (E01-S11). The cross-aggregate erase/revoke a completion
// performs acts on stores built by much later tasks (vault_unlock_methods, agents,
// connections), so it is DELEGATED through an injected `ResetExecutor` seam —
// exactly as delivery is delegated through the notification senders and
// persistence through the `Db` seam. Every member-scoped read/write takes `userId`
// from the session (or the resolved account), never from a client-supplied value,
// and every statement is parameterized (INV-102).

//
// Review fix W3.3: the SMS alert goes to the person's VERIFIED mobile numbers (never their
// user id, never an unverified number); each channel is alerted independently, so one
// failing sender never silences the others, and a reset that reached nobody does not
// start; and a completion is marked done in ONE transaction with the erase and the
// revoke, so a failure rolls all three back and the job's retry finds the reset still
// pending.

import type { RegistrationResponseJSON } from "@simplewebauthn/server";

import { getUserByEmail } from "../db/users";
import { listMobileNumbers } from "../db/mobile-numbers";
import { verifyEmailCode } from "./email-code";
import { finishPasskeyRegistration } from "./passkey";
import { issueRecoveryCode } from "./recovery";
import { createSession, lockActiveAccount, type CreatedSession } from "./session";
import { enqueue } from "../db/jobs";
import { withTransaction } from "../db/index";
import type { Clock } from "../seams/clock";
import type { Random } from "../seams/random";
import type { Senders } from "../notify/senders";
import type { Db } from "../db/index";
import { releaseStore, type ReleaseStore } from "../crypto/release-store";

const MINUTE_MS = 60 * 1000;
const SEVEN_DAYS_MS = 7 * 24 * 60 * MINUTE_MS;

// How long a requested reset waits before it completes (the brief's 7-day window).
export const RESET_WAIT_MS = SEVEN_DAYS_MS;

// How long after a reset completes the person may use it to set up a new passkey (review
// fix W5). A finished reset is a standing way in for whoever holds the email address, so
// it does not stay open for ever: after this the person asks for a new reset, with its own
// 7-day wait and alerts. Measured from requested_at + RESET_WAIT_MS (the earliest the
// reset can have completed).
export const REENROL_WINDOW_MS = 30 * 24 * 60 * MINUTE_MS;

// The background-job type the 7-day timer fires; its payload names the account so
// the handler can drive completeAccountReset for the right person.
export const COMPLETE_JOB_TYPE = "account_reset.complete";

// A fixed, code-free notice sent on every channel when a reset is requested. It
// carries no sensitive value (no code, token or link that could be acted on by
// reply): approvals and cancellation happen only inside the signed-in app
// (INV-18), so the alert simply tells the person to open the app if it wasn't
// them.
const ALERT_BODY =
  "A reset of your Warthog account was requested and will complete in 7 days. " +
  "If this wasn't you, open the Warthog app on a device you're still signed in on and cancel it.";

// The cross-aggregate work a completed reset performs, injected because the vault /
// agent / connection stores live in other aggregates (and are built later).
// account-reset owns only the state machine and calls this seam when a
// still-pending (never a cancelled) reset completes. Completion passes its transaction
// as `tx`, and the executor runs its statements on it, so the work and the status change
// commit (or roll back) together.
export interface ResetExecutor {
  eraseVaultData(userId: string, tx?: Db): Promise<void>; // VK-wrapped vault data
  revokeAgentsAndConnections(userId: string, tx?: Db): Promise<void>; // every agent + connection
}

// Each function reads only the subset of the deps bundle it needs; the caller's
// superset bundle is structurally assignable to each of these.

// Requesting verifies the email-code first factor (clock + hmacKey, with the email
// sender carrying the code module's own throttle alert) and alerts every channel.
export interface RequestAccountResetDeps {
  readonly clock: Clock;
  readonly hmacKey: Uint8Array;
  readonly senders: Senders;
}

// Completing reads only the executor — the seam that erases the vault and revokes
// the agents/connections of a reset that is still pending.
export interface CompleteAccountResetDeps {
  readonly executor: ResetExecutor;
  readonly clock: Clock;
  readonly releases?: Pick<ReleaseStore, "discardScope">;
}

// Start a 7-day account reset for the person owning `email`, gated on the email
// one-time code (the first factor). A failed code OR no account for the email
// starts NOTHING — no timer, no alert — and returns { ok: false }. On success it
// records a 'pending' reset and schedules completion 7 days out on the jobs queue (one
// transaction), then alerts every registered channel once: push, email, and an SMS to
// each verified mobile number. Each channel is sent independently; when not one of them
// could be reached the reset is withdrawn and { ok: false, reason: "alert_failed" } is
// returned, because a reset nobody was told about is exactly what the alerts guard
// against.
export async function requestAccountReset(
  db: Db,
  { email, code }: { email: string; code: string },
  deps: RequestAccountResetDeps,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const verified = await verifyEmailCode(db, email, code, {
    purpose: "reset",
    clock: deps.clock,
    hmacKey: deps.hmacKey,
    emailSender: deps.senders.email,
  });
  if (!verified.ok) return { ok: false, reason: "invalid_code" };

  const person = await getUserByEmail(db, email);
  if (!person) return { ok: false, reason: "no_account" };

  const now = deps.clock.now();

  await withTransaction(db, async (tx) => {
    // Record the one pending reset for this person. Re-requesting replaces an
    // earlier (e.g. cancelled) reset in place, so the row hangs off user_id as its
    // primary key.
    await tx.query(
      `INSERT INTO account_resets (user_id, status, requested_at)
       VALUES ($1, 'pending', $2::timestamptz)
       ON CONFLICT (user_id)
       DO UPDATE SET status = 'pending', requested_at = EXCLUDED.requested_at`,
      [person.id, now.toISOString()],
    );

    // Supersede any earlier reset's timer before scheduling this one. The reset row
    // is replaced in place (one per person), but every request also enqueued its own
    // completion job. Remove earlier pending work; a timer already claimed by a
    // worker cannot be removed here, so completion independently enforces the
    // CURRENT reset's full waiting period in its atomic claim.
    await clearCompletionJobs(tx, person.id);

    // The 7-day timer: a background job due now + 7 days that fires completion.
    await enqueue(tx, {
      type: COMPLETE_JOB_TYPE,
      payload: { userId: person.id },
      runAt: new Date(now.getTime() + SEVEN_DAYS_MS),
    });
  });

  // Alert every registered channel once, so the person sees the reset on whatever
  // they still have access to and can cancel it from a signed-in device. Push is
  // addressed to the person (the sender finds their devices); SMS only ever goes to a
  // number they verified.
  const mobiles = deps.senders.sms.enabled === false ? []
    : (await listMobileNumbers(db, person.id)).filter((number) => number.verified);
  const sends: (() => Promise<void>)[] = [
    () => deps.senders.push.sendPush({ recipient: person.id, body: ALERT_BODY }),
    () => deps.senders.email.sendEmail({ recipient: person.email, body: ALERT_BODY }),
    ...mobiles.map((mobile) => () => deps.senders.sms.sendSms({ recipient: mobile.number, body: ALERT_BODY })),
  ];
  // Each send is isolated, even one that throws before returning a promise.
  const outcomes = await Promise.allSettled(sends.map(async (send) => send()));
  if (!outcomes.some((outcome) => outcome.status === "fulfilled")) {
    // Nobody could be told: withdraw the reset and its timer rather than let it run
    // unannounced. The send errors are not logged (they may name a recipient).
    await withTransaction(db, async (tx) => {
      // Alerts run after the request commits. A newer reset can supersede this
      // one while those sends are in flight; compensate only this generation.
      // The row lock also keeps a replacement request from inserting its timer
      // between a successful cancellation and the matching job cleanup.
      const cancelled = await tx.query(
        `UPDATE account_resets SET status = 'cancelled'
         WHERE user_id = $1 AND status = 'pending' AND requested_at = $2::timestamptz
         RETURNING user_id`,
        [person.id, now.toISOString()],
      );
      if (cancelled.rows.length > 0) await clearCompletionJobs(tx, person.id);
    });
    return { ok: false, reason: "alert_failed" };
  }

  return { ok: true };
}

// Remove this person's still-pending completion timers.
async function clearCompletionJobs(db: Db, userId: string): Promise<void> {
  await db.query(
    `DELETE FROM jobs
      WHERE type = $1 AND status = 'pending' AND payload->>'userId' = $2`,
    [COMPLETE_JOB_TYPE, userId],
  );
}

// Cancel the person's pending reset. The userId comes from the session, so ANY
// signed-in device of that person can cancel (member-scoped — never an id from the
// client); the WHERE clause binds it, so another person's userId touches nothing.
// A person with no pending reset gets a plain { ok: false }, never a throw. Cancel
// reads no seam, so its deps bundle is unused.
export async function cancelAccountReset(
  db: Db,
  { userId }: { userId: string },
  _deps: unknown,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const result = await db.query(
    `UPDATE account_resets SET status = 'cancelled'
     WHERE user_id = $1 AND status = 'pending'
     RETURNING user_id`,
    [userId],
  );
  if (result.rows.length === 0) return { ok: false, reason: "no_pending_reset" };
  return { ok: true };
}

// The person's pending reset, for the signed-in banner that offers to cancel it: when it
// was requested and when it will complete. Member-scoped by the session's user id; null
// when nothing is pending.
export async function getPendingAccountReset(
  db: Db,
  { userId }: { userId: string },
): Promise<{ requestedAt: Date; completesAt: Date } | null> {
  const found = await db.query(
    "SELECT requested_at FROM account_resets WHERE user_id = $1 AND status = 'pending'",
    [userId],
  );
  const row = found.rows[0];
  if (!row) return null;
  const requestedAt = new Date(row.requested_at as string | Date);
  return { requestedAt, completesAt: new Date(requestedAt.getTime() + RESET_WAIT_MS) };
}

// The action the 7-day timer fires. Claiming the completion is a guarded, atomic
// status transition: ONLY a still-'pending' reset whose full seven-day wait has
// elapsed moves to 'done' and returns a row. The deadline belongs to the current
// request: a superseded timer already claimed by a worker cannot complete a newer
// reset early. When it does, the erase and the revoke run once each for that person; a
// cancelled reset, an already-completed one, or no reset at all transitions
// nothing, so the executor is not called (a cancel wins the race against a firing
// timer, and a stray fire never wipes a vault that did not request a reset).
// The claim, the erase and the revoke are ONE transaction: if the erase or the revoke
// fails, the status change rolls back with it and the error surfaces, so the job runner
// retries a reset that is still pending — never one marked done but half done.
// Everything else is kept: the users row and the wrapped DEK are untouched.
export async function completeAccountReset(
  db: Db,
  { userId }: { userId: string },
  deps: CompleteAccountResetDeps,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const outcome = await withTransaction(db, async (tx) => {
    const claimed = await tx.query(
      `UPDATE account_resets SET status = 'done'
       WHERE user_id = $1 AND status = 'pending' AND requested_at <= $2::timestamptz
       RETURNING user_id`,
      [userId, new Date(deps.clock.now().getTime() - RESET_WAIT_MS).toISOString()],
    );
    if (claimed.rows.length === 0) return { ok: false as const, reason: "no_pending_reset" };

    await deps.executor.eraseVaultData(userId, tx);
    await deps.executor.revokeAgentsAndConnections(userId, tx);
    return { ok: true as const };
  });
  if (outcome.ok) (deps.releases ?? releaseStore).discardScope(`${userId}:`);
  return outcome;
}


// --- setting up a new passkey after a completed reset (review fix W5) ---------------
//
// A completed reset leaves the person with no passkey they can use and no recovery code,
// so no sign-in path admits them. Re-enrolment is the way back: after the person proves
// their email again (the handler's email code), a reset whose status is 'done' lets them
// register ONE new passkey, and is then claimed 'done' → 'reenrolled' so it can never be
// used again.

// The earliest requested_at a still-usable 'done' reset can carry at `now`.
function reenrolFloor(now: Date): string {
  return new Date(now.getTime() - RESET_WAIT_MS - REENROL_WINDOW_MS).toISOString();
}

// Whether the person has a completed reset they can still use to set up a new passkey.
// Member-scoped by the verified user id; a pending, cancelled, already-used or lapsed
// reset (or none) is false.
export async function hasCompletedReset(
  db: Db,
  { userId }: { userId: string },
  deps: { readonly clock: Clock },
): Promise<boolean> {
  const found = await db.query(
    `SELECT 1 FROM account_resets
      WHERE user_id = $1 AND status = 'done' AND requested_at > $2::timestamptz`,
    [userId, reenrolFloor(deps.clock.now())],
  );
  return found.rows.length > 0;
}

// What re-enrolment needs: the WebAuthn RP ID and origin the registration verifies
// against, the clock, and the randomness the recovery code and session are drawn from.
export interface ReenrolDeps {
  readonly rpId: string;
  readonly origin: string;
  readonly clock: Clock;
  readonly random: Random;
}

export type ReenrolResult =
  | { ok: true; recoveryCode: string; session: CreatedSession }
  | { ok: false; reason: "no_completed_reset" | "bad_attestation" };

// Register the person's new passkey and re-enrol them, in ONE transaction:
//   1. claim the reset: UPDATE … SET status = 'reenrolled' WHERE status = 'done' RETURNING.
//      Of any number of racing or replayed re-enrolments exactly one gets the row (the row
//      lock makes the others wait and then find nothing); the rest get nothing at all.
//   2. register the passkey through the shared seam (its purpose-bound, single-use
//      challenge). A registration that does not verify puts the reset back to 'done' in the
//      same transaction, so the person can try again — while the spent challenge stays
//      spent (passkey.ts burns a challenge even on a failed attempt).
//   3. remove the lost factors: every other passkey, the authenticator app and every
//      session. They are what the person lost (and what whoever has the lost device holds),
//      so after this the account's only ways in are the ones just set up.
//   4. issue the new recovery code (replacing the old one) and mint the session.
// The new recovery code is returned once, to be shown once; only its hash is stored.
export async function reenrolAfterReset(
  db: Db,
  { userId, response }: { userId: string; response: RegistrationResponseJSON },
  deps: ReenrolDeps,
): Promise<ReenrolResult> {
  const { rpId, origin, clock, random } = deps;
  return withTransaction(db, async (tx): Promise<ReenrolResult> => {
    await lockActiveAccount(tx, userId);
    const claimed = await tx.query(
      `UPDATE account_resets SET status = 'reenrolled'
        WHERE user_id = $1 AND status = 'done' AND requested_at > $2::timestamptz
        RETURNING user_id`,
      [userId, reenrolFloor(clock.now())],
    );
    if (claimed.rows.length === 0) return { ok: false, reason: "no_completed_reset" };

    const registered = await finishPasskeyRegistration(tx, { userId, response }, { rpId, origin, clock });
    if (!registered.ok) {
      await tx.query(
        "UPDATE account_resets SET status = 'done' WHERE user_id = $1 AND status = 'reenrolled'",
        [userId],
      );
      return { ok: false, reason: "bad_attestation" };
    }

    await tx.query("DELETE FROM passkeys WHERE user_id = $1 AND credential_id <> $2", [
      userId,
      registered.credentialId,
    ]);
    await tx.query("DELETE FROM totp_secrets WHERE user_id = $1", [userId]);
    await tx.query("DELETE FROM sessions WHERE user_id = $1", [userId]);

    const { code } = await issueRecoveryCode(tx, userId, { random });
    const session = await createSession(tx, userId, { clock, random });
    return { ok: true, recoveryCode: code, session };
  });
}
