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

import { getUserByEmail } from "../db/users";
import { listMobileNumbers } from "../db/mobile-numbers";
import { verifyEmailCode } from "./email-code";
import { enqueue } from "../db/jobs";
import { withTransaction } from "../db/index";
import type { Clock } from "../seams/clock";
import type { Senders } from "../notify/senders";
import type { Db } from "../db/index";

const MINUTE_MS = 60 * 1000;
const SEVEN_DAYS_MS = 7 * 24 * 60 * MINUTE_MS;

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
    // completion job — so a re-request (after a cancel, OR while a reset was still
    // pending) would otherwise leave an EARLIER job in the queue that fires first and
    // completes this fresh reset before its own 7 days have elapsed. Completion is
    // claimed on status alone (the pending row looks identical whichever timer fires,
    // and the direct action takes only a userId), so the 7-day window is protected
    // HERE, by clearing the superseded timer so only this request's job survives to
    // fire. Scoped to this person's still-pending completion jobs; the id is a bound
    // value, never woven into the SQL (INV-102).
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
  const mobiles = (await listMobileNumbers(db, person.id)).filter((number) => number.verified);
  const sends: Promise<void>[] = [
    deps.senders.push.sendPush({ recipient: person.id, body: ALERT_BODY }),
    deps.senders.email.sendEmail({ recipient: person.email, body: ALERT_BODY }),
    ...mobiles.map((mobile) => deps.senders.sms.sendSms({ recipient: mobile.number, body: ALERT_BODY })),
  ];
  const outcomes = await Promise.allSettled(sends);
  if (!outcomes.some((outcome) => outcome.status === "fulfilled")) {
    // Nobody could be told: withdraw the reset and its timer rather than let it run
    // unannounced. The send errors are not logged (they may name a recipient).
    await withTransaction(db, async (tx) => {
      await tx.query(
        "UPDATE account_resets SET status = 'cancelled' WHERE user_id = $1 AND status = 'pending'",
        [person.id],
      );
      await clearCompletionJobs(tx, person.id);
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

// The action the 7-day timer fires. Claiming the completion is a guarded, atomic
// status transition: ONLY a still-'pending' reset moves to 'done' and returns a
// row. When it does, the erase and the revoke run once each for that person; a
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
  return withTransaction(db, async (tx) => {
    const claimed = await tx.query(
      `UPDATE account_resets SET status = 'done'
       WHERE user_id = $1 AND status = 'pending'
       RETURNING user_id`,
      [userId],
    );
    if (claimed.rows.length === 0) return { ok: false, reason: "no_pending_reset" };

    await deps.executor.eraseVaultData(userId, tx);
    await deps.executor.revokeAgentsAndConnections(userId, tx);
    return { ok: true };
  });
}
