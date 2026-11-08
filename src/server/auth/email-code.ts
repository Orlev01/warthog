// Email one-time codes: issue and verify the 6-digit codes that begin sign-up,
// sign-in and new-device flows (design §5). A code is six digits, emailed to the
// person and valid for ten minutes. The server stores only a keyed HMAC of the
// code (project rule: codes are stored only as an HMAC and appear in plain text
// nowhere except the single email that delivers a person their own code), so this
// table never holds a replayable value; a presented code verifies by recomputing
// the HMAC under the same key and matching the stored digest.
//
// Abuse is throttled at both ends (review fix B1):
//   • Verify: each attempt is RESERVED (a row in email_code_attempts) before it is
//     judged, then the window is counted including that reservation. Because every
//     request counts only after its own reservation is written, the j-th concurrent
//     request always sees at least j rows, so at most five guesses are ever judged in
//     a rolling fifteen-minute window, however many arrive in parallel. Beyond that,
//     attempts — even with the correct code — are refused with a backoff
//     ({ reason: "throttled", retryAfterMs > 0 }); a refused, correct or lapsed attempt
//     gives its reservation back, so only real failures stay counted. The account
//     holder is emailed one alert per window (claimed atomically in
//     email_code_alerts) that carries no code.
//   • Verify judges the presented code against the address's NEWEST live code only,
//     compared in constant time, so a burst of issued codes never multiplies the odds.
//   • Issue: an address gets at most one code a minute and five an hour (the same
//     reserve-then-count discipline, so a parallel burst sends at most one), issuing
//     retires every earlier live code, and a code whose email could not be sent is
//     retired at once rather than left usable.
// A verified code is single-use (consumed), and every window is measured against the
// injected Clock, never SQL now(), so they are deterministic and testable. Every
// statement is parameterized (INV-102): the email and the recomputed digest reach the
// query layer only as bound values, never woven in.

import { hmac, verifyHmac } from "../crypto/hmac";
import { normaliseEmail } from "../db/users";
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
const ISSUE_INTERVAL_MS = MINUTE_MS; // at most one code a minute to one address
const ISSUE_WINDOW_MS = 60 * MINUTE_MS; // ... and at most MAX_ISSUES_PER_WINDOW an hour
const MAX_ISSUES_PER_WINDOW = 5;

// What verify reports back — a discriminated union on `ok`. A correct, unexpired,
// un-throttled code is accepted; every other outcome names its reason, and a
// throttled refusal also says how long the caller should wait before retrying.
export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: "invalid" }
  | { ok: false; reason: "expired" }
  | { ok: false; reason: "throttled"; retryAfterMs: number };

// What issue reports back. A code is sent unless the address has had one in the last
// minute or five in the last hour; then nothing is sent and the caller is told how
// long to wait.
export type IssueResult =
  | { ok: true }
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

// A stored instant read back from the driver (a Date from pg/PGlite, or a string).
function instant(value: unknown): Date {
  return new Date(value as string | number | Date);
}

// Issue a code to `email`: draw six digits, store them as HMAC(hmacKey, code) with
// a ten-minute expiry, and deliver the code in exactly one email. The raw code is
// returned to no caller and written to no column — it lives only in that email.
//
// The new row is written FIRST and the address's recent codes counted after it (the
// row counts itself), so of any number of parallel issues at most one sees itself
// alone in the minute and sends; the others delete their row and send nothing. Once
// sent-for, the earlier live codes are retired so only this one verifies. If the
// email cannot be sent the new code is retired too, and the failure surfaces.
export async function issueEmailCode(
  db: Db,
  rawEmail: string,
  deps: IssueDeps,
): Promise<IssueResult> {
  // One address whatever its case or spacing: one code, one budget (review fix B8).
  const email = normaliseEmail(rawEmail);
  const code = drawCode(deps.random);
  const now = deps.clock.now();
  const expiresAt = new Date(now.getTime() + CODE_TTL_MS);
  const inserted = await db.query(
    `INSERT INTO email_codes (email, code_hmac, created_at, expires_at)
     VALUES ($1, $2, $3::timestamptz, $4::timestamptz)
     RETURNING id`,
    [email, hmac(deps.hmacKey, code), now.toISOString(), expiresAt.toISOString()],
  );
  const id = inserted.rows[0]?.id as string;

  const recent = await db.query(
    `SELECT COUNT(*) FILTER (WHERE created_at > $3::timestamptz)::int AS last_interval,
            COUNT(*)::int AS last_window,
            MAX(created_at) FILTER (WHERE id <> $4) AS newest_other,
            MIN(created_at) FILTER (WHERE id <> $4) AS oldest_other
     FROM email_codes
     WHERE email = $1 AND created_at > $2::timestamptz`,
    [
      email,
      new Date(now.getTime() - ISSUE_WINDOW_MS).toISOString(),
      new Date(now.getTime() - ISSUE_INTERVAL_MS).toISOString(),
      id,
    ],
  );
  const counts = recent.rows[0] ?? {};
  const overInterval = Number(counts.last_interval ?? 0) > 1;
  const overWindow = Number(counts.last_window ?? 0) > MAX_ISSUES_PER_WINDOW;
  if (overInterval || overWindow) {
    await db.query(`DELETE FROM email_codes WHERE id = $1`, [id]);
    const waits = [1];
    if (overInterval && counts.newest_other != null) {
      waits.push(instant(counts.newest_other).getTime() + ISSUE_INTERVAL_MS - now.getTime());
    }
    if (overWindow && counts.oldest_other != null) {
      waits.push(instant(counts.oldest_other).getTime() + ISSUE_WINDOW_MS - now.getTime());
    }
    return { ok: false, reason: "throttled", retryAfterMs: Math.max(...waits) };
  }

  // Only the newest code may verify: retire every earlier live code for the address.
  await db.query(
    `UPDATE email_codes SET consumed_at = $3::timestamptz
     WHERE email = $1 AND consumed_at IS NULL AND id <> $2`,
    [email, id, now.toISOString()],
  );

  try {
    await deps.emailSender.sendEmail({
      recipient: email,
      body:
        `Your Warthog verification code is ${code}. ` +
        `It expires in 10 minutes. If you did not request this, you can ignore this email.`,
    });
  } catch (error) {
    // Undelivered: the code must not stay usable (nobody legitimate can know it).
    await db.query(`UPDATE email_codes SET consumed_at = $2::timestamptz WHERE id = $1`, [
      id,
      now.toISOString(),
    ]);
    throw error;
  }
  return { ok: true };
}

// Verify a presented code for `email`. The attempt is reserved and the window
// counted first, so once five attempts are in the window every further one backs off,
// correct code included. Otherwise the code is compared, in constant time, with the
// address's newest live code: a mismatch (or no live code) is a failed attempt
// ("invalid"), a lapsed code is "expired" (reported, not counted), and a live code is
// consumed (single use) and accepted.
export async function verifyEmailCode(
  db: Db,
  rawEmail: string,
  code: string,
  deps: VerifyDeps,
): Promise<VerifyResult> {
  const email = normaliseEmail(rawEmail);
  const now = deps.clock.now();

  // Reserve this attempt, then count the window INCLUDING it. Each request counts only
  // after its own reservation is written, so parallel guesses cannot all slip in under
  // the limit: the sixth (and every later) one sees six or more rows.
  const reserved = await db.query(
    `INSERT INTO email_code_attempts (email, attempted_at) VALUES ($1, $2::timestamptz)
     RETURNING id`,
    [email, now.toISOString()],
  );
  const attemptId = reserved.rows[0]?.id as string;

  const windowFloor = new Date(now.getTime() - ATTEMPT_WINDOW_MS);
  const recent = await db.query(
    `SELECT COUNT(*)::int AS attempts,
            MIN(attempted_at) FILTER (WHERE id <> $3) AS oldest_other
     FROM email_code_attempts
     WHERE email = $1 AND attempted_at > $2::timestamptz`,
    [email, windowFloor.toISOString(), attemptId],
  );
  const summary = recent.rows[0];
  const attempts = Number(summary?.attempts ?? 0);

  if (attempts > MAX_FAILURES) {
    // Throttled: the refusal records nothing (the window clears from the last real
    // failure), and the holder is told once per window.
    await releaseAttempt(db, attemptId);
    await alertHolderOnce(db, email, now, deps.emailSender);
    const oldest = summary?.oldest_other == null ? now : instant(summary.oldest_other);
    return {
      ok: false,
      reason: "throttled",
      retryAfterMs: Math.max(1, oldest.getTime() + ATTEMPT_WINDOW_MS - now.getTime()),
    };
  }

  // Judge the presented code against the address's NEWEST live code only (issuing a
  // new code retires the older ones), comparing the keyed digests in constant time.
  const found = await db.query(
    `SELECT id, code_hmac, expires_at
     FROM email_codes
     WHERE email = $1 AND consumed_at IS NULL
     ORDER BY created_at DESC
     LIMIT 1`,
    [email],
  );
  const row = found.rows[0];
  if (!row || !verifyHmac(deps.hmacKey, code, row.code_hmac as string)) {
    return registerFailure(db, email, now, attempts, deps.emailSender);
  }

  // Past its ten-minute expiry: lapsed, not a wrong guess — reported, not counted.
  if (instant(row.expires_at).getTime() <= now.getTime()) {
    await releaseAttempt(db, attemptId);
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
    return registerFailure(db, email, now, attempts, deps.emailSender);
  }
  await releaseAttempt(db, attemptId);
  return { ok: true };
}

// Give back a reserved attempt that turned out not to be a failure (accepted, lapsed
// or refused by the throttle), so only real failures count against the window.
async function releaseAttempt(db: Db, attemptId: string): Promise<void> {
  await db.query(`DELETE FROM email_code_attempts WHERE id = $1`, [attemptId]);
}

// The reserved attempt was a failure: it stays recorded. When it is the failure that
// reaches the five-failure threshold, the holder is alerted (once per window).
async function registerFailure(
  db: Db,
  email: string,
  now: Date,
  attempts: number,
  emailSender: EmailSender,
): Promise<VerifyResult> {
  if (attempts >= MAX_FAILURES) {
    await alertHolderOnce(db, email, now, emailSender);
  }
  return { ok: false, reason: "invalid" };
}

// Email the account holder a single alert — never the code — at most once per
// fifteen-minute window. The send is claimed with one atomic upsert that succeeds only
// when no alert went to this address inside the window, so parallel refusals cannot
// each send one.
async function alertHolderOnce(
  db: Db,
  email: string,
  now: Date,
  emailSender: EmailSender,
): Promise<void> {
  const claimed = await db.query(
    `INSERT INTO email_code_alerts (email, sent_at) VALUES ($1, $2::timestamptz)
     ON CONFLICT (email) DO UPDATE SET sent_at = EXCLUDED.sent_at
       WHERE email_code_alerts.sent_at <= $3::timestamptz
     RETURNING email`,
    [email, now.toISOString(), new Date(now.getTime() - ATTEMPT_WINDOW_MS).toISOString()],
  );
  if (claimed.rows.length === 0) return;
  await emailSender.sendEmail({
    recipient: email,
    body:
      "We noticed several failed verification-code attempts on your Warthog account, " +
      "so we have briefly paused further attempts. If this was not you, no action is " +
      "needed — no code was accepted.",
  });
}
