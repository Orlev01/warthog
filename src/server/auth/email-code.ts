// Email one-time codes: issue and verify the 6-digit codes that begin sign-up,
// sign-in and new-device flows (design §5). A code is six digits, emailed to the
// person and valid for ten minutes. The server stores only a keyed HMAC of the
// code (project rule: codes are stored only as an HMAC and appear in plain text
// nowhere except the single email that delivers a person their own code), so this
// table never holds a replayable value; a presented code verifies by recomputing
// the HMAC under the same key and matching the stored digest.
//
// Abuse is throttled: each failed verification is recorded, and once five
// failures fall inside a rolling fifteen-minute window further attempts — even
// with the correct code — are refused with a backoff ({ reason: "throttled",
// retryAfterMs > 0 }) and the account holder is emailed a single alert that
// carries no code. A verified code is single-use (consumed), and both windows are
// measured against the injected Clock, never SQL now(), so they are deterministic
// and testable. Every statement is parameterized (INV-102): the email and the
// recomputed digest reach the query layer only as bound values, never woven in.

import { hmac } from "../crypto/hmac";
import type { Clock } from "../seams/clock";
import type { Random } from "../seams/random";
import type { EmailSender } from "../notify/senders";
import type { Db } from "../db/index";

const CODE_DIGITS = 6;
const CODE_MODULUS = 10 ** CODE_DIGITS; // reduce entropy into [0, 999999]
const CODE_ENTROPY_BYTES = 4; // 32 bits, reduced to the 6-digit space

const MINUTE_MS = 60 * 1000;
const CODE_TTL_MS = 10 * MINUTE_MS; // a code lapses ten minutes after issue
const ATTEMPT_WINDOW_MS = 15 * MINUTE_MS; // the rolling failure window
const MAX_FAILURES = 5; // failures in the window before attempts back off

// What verify reports back — a discriminated union on `ok`. A correct, unexpired,
// un-throttled code is accepted; every other outcome names its reason, and a
// throttled refusal also says how long the caller should wait before retrying.
export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: "invalid" }
  | { ok: false; reason: "expired" }
  | { ok: false; reason: "throttled"; retryAfterMs: number };

// issue needs entropy to draw a code; verify does not.
export interface IssueDeps {
  readonly clock: Clock;
  readonly random: Random;
  readonly hmacKey: Uint8Array;
  readonly emailSender: EmailSender;
}

export interface VerifyDeps {
  readonly clock: Clock;
  readonly hmacKey: Uint8Array;
  readonly emailSender: EmailSender;
}

// Draw a 6-digit code from the entropy seam: 32 random bits reduced into the
// [0, 999999] space, rendered as a zero-padded six-character string.
function drawCode(random: Random): string {
  const n = Buffer.from(random.randomBytes(CODE_ENTROPY_BYTES)).readUInt32BE(0) % CODE_MODULUS;
  return String(n).padStart(CODE_DIGITS, "0");
}

// Issue a code to `email`: draw six digits, store them as HMAC(hmacKey, code) with
// a ten-minute expiry, and deliver the code in exactly one email. The raw code is
// returned to no caller and written to no column — it lives only in that email.
export async function issueEmailCode(db: Db, email: string, deps: IssueDeps): Promise<void> {
  const code = drawCode(deps.random);
  const now = deps.clock.now();
  const expiresAt = new Date(now.getTime() + CODE_TTL_MS);
  await db.query(
    `INSERT INTO email_codes (email, code_hmac, created_at, expires_at)
     VALUES ($1, $2, $3::timestamptz, $4::timestamptz)`,
    [email, hmac(deps.hmacKey, code), now.toISOString(), expiresAt.toISOString()],
  );
  await deps.emailSender.sendEmail({
    recipient: email,
    body:
      `Your Warthog verification code is ${code}. ` +
      `It expires in 10 minutes. If you did not request this, you can ignore this email.`,
  });
}

// Verify a presented code for `email`. Throttling is checked first, so once the
// failure threshold is crossed even a correct code backs off. Otherwise the code
// is matched by its keyed digest: a miss or an already-spent code is a failed
// attempt ("invalid"), a lapsed code is "expired" (reported, not counted), and a
// live code is consumed (single use) and accepted.
export async function verifyEmailCode(
  db: Db,
  email: string,
  code: string,
  deps: VerifyDeps,
): Promise<VerifyResult> {
  const now = deps.clock.now();

  // Throttle first: count failures inside the rolling window. Once the threshold
  // is reached every further attempt — correct code included — backs off, and no
  // new failure is recorded, so the window clears from the last real failure.
  const windowFloor = new Date(now.getTime() - ATTEMPT_WINDOW_MS);
  const recent = await db.query(
    `SELECT COUNT(*)::int AS failures, MIN(attempted_at) AS oldest
     FROM email_code_attempts
     WHERE email = $1 AND attempted_at > $2::timestamptz`,
    [email, windowFloor.toISOString()],
  );
  const summary = recent.rows[0];
  const priorFailures = Number(summary?.failures ?? 0);
  if (priorFailures >= MAX_FAILURES) {
    const oldest = new Date((summary?.oldest ?? now) as string | number | Date);
    return { ok: false, reason: "throttled", retryAfterMs: oldest.getTime() + ATTEMPT_WINDOW_MS - now.getTime() };
  }

  // Match the presented code by its keyed digest, bound as data. The most recent
  // matching row is the one under test.
  const found = await db.query(
    `SELECT id, expires_at, consumed_at
     FROM email_codes
     WHERE email = $1 AND code_hmac = $2
     ORDER BY created_at DESC
     LIMIT 1`,
    [email, hmac(deps.hmacKey, code)],
  );
  const row = found.rows[0];

  // No matching digest, or a code already spent, is a failed attempt.
  if (!row || row.consumed_at != null) {
    return registerFailure(db, email, now, priorFailures, deps.emailSender);
  }

  // Past its ten-minute expiry: lapsed, not a wrong guess — reported, not counted.
  if (new Date(row.expires_at as string | number | Date).getTime() <= now.getTime()) {
    return { ok: false, reason: "expired" };
  }

  // Live code: consume it so it cannot be replayed. The `consumed_at IS NULL`
  // guard makes the spend atomic — a code already spent matches nothing here.
  const consumed = await db.query(
    `UPDATE email_codes SET consumed_at = $2::timestamptz
     WHERE id = $1 AND consumed_at IS NULL
     RETURNING id`,
    [row.id, now.toISOString()],
  );
  if (consumed.rows.length === 0) {
    return registerFailure(db, email, now, priorFailures, deps.emailSender);
  }
  return { ok: true };
}

// Record one failed attempt and, when this failure is the one that crosses the
// five-failure threshold, email the account holder a single alert — never the
// code. Returns the "invalid" result for the caller to hand back.
async function registerFailure(
  db: Db,
  email: string,
  now: Date,
  priorFailures: number,
  emailSender: EmailSender,
): Promise<VerifyResult> {
  await db.query(
    `INSERT INTO email_code_attempts (email, attempted_at) VALUES ($1, $2::timestamptz)`,
    [email, now.toISOString()],
  );
  if (priorFailures + 1 === MAX_FAILURES) {
    await emailSender.sendEmail({
      recipient: email,
      body:
        "We noticed several failed verification-code attempts on your Warthog account, " +
        "so we have briefly paused further attempts. If this was not you, no action is " +
        "needed — no code was accepted.",
    });
  }
  return { ok: false, reason: "invalid" };
}
