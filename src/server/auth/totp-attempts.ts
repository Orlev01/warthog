// Review fix W3.5 — authenticator-app sign-in is limited and single use. verifyTotp alone
// accepted unlimited guesses (3 of the 10^6 codes are valid at any moment) and let a code
// be used again throughout its ±1-step window. The brief: "IF sign-in or code entry fails
// 5 times in 15 minutes for one account … THEN THE SYSTEM SHALL slow further attempts".
//
// checkTotpSignIn, per account (the row in totp_secrets, migration 0077):
//   1. Counts the presentation FIRST, in one guarded UPDATE that refuses once 5 have failed
//      inside the current 15-minute window (a window that has ended starts again at one).
//      Because the count happens before the code is checked, parallel guesses can never
//      get more than the limit checked. A refused presentation is "throttled", with how
//      long until the window ends.
//   2. Matches the code to its 30-second step (current or ±1). No match is "invalid".
//   3. Accepts a match only when its step is LATER than the last accepted one — a guarded
//      compare-and-set that also clears the failures — so each step's code works once and
//      an earlier step's code never works after a later one. A replay is "invalid".
//
// Every statement binds its values (INV-102); time comes from the injected clock. The code
// and the secret never reach a query or a log.

import { matchTotpStep } from "./totp";
import type { Clock } from "../seams/clock";
import type { Db } from "../db/index";

// The brief's limit: 5 failed attempts in 15 minutes.
export const TOTP_MAX_FAILURES = 5;
export const TOTP_FAILURE_WINDOW_MS = 15 * 60 * 1000;

export type TotpSignInResult =
  // `step` is the accepted code's time step: a sign-in re-checks it when it mints the session.
  | { ok: true; step: number }
  | { ok: false; reason: "invalid" }
  | { ok: false; reason: "throttled"; retryAfterMs: number };

export async function checkTotpSignIn(
  db: Db,
  input: { userId: string; secret: string; code: string },
  deps: { clock: Clock },
): Promise<TotpSignInResult> {
  const now = deps.clock.now();
  const windowStartsAfter = new Date(now.getTime() - TOTP_FAILURE_WINDOW_MS);

  // 1. Count this presentation, unless the window's failures are already spent.
  const counted = await db.query(
    `UPDATE totp_secrets
        SET failed_attempts = CASE WHEN failed_window_start IS NULL OR failed_window_start <= $2::timestamptz
                                   THEN 1 ELSE failed_attempts + 1 END,
            failed_window_start = CASE WHEN failed_window_start IS NULL OR failed_window_start <= $2::timestamptz
                                       THEN $3::timestamptz ELSE failed_window_start END
      WHERE user_id = $1
        AND (failed_window_start IS NULL OR failed_window_start <= $2::timestamptz OR failed_attempts < $4::int)
      RETURNING user_id`,
    [input.userId, windowStartsAfter.toISOString(), now.toISOString(), TOTP_MAX_FAILURES],
  );
  if (counted.rows.length === 0) {
    const row = (
      await db.query("SELECT failed_window_start FROM totp_secrets WHERE user_id = $1", [input.userId])
    ).rows[0];
    if (!row || row.failed_window_start == null) return { ok: false, reason: "invalid" };
    const endsAt = new Date(row.failed_window_start as string | Date).getTime() + TOTP_FAILURE_WINDOW_MS;
    return { ok: false, reason: "throttled", retryAfterMs: Math.max(1, endsAt - now.getTime()) };
  }

  // 2. Which step (if any) the code belongs to.
  const step = matchTotpStep(input.secret, input.code, deps);
  if (step === null) return { ok: false, reason: "invalid" };

  // 3. Accept each step once, and never an earlier one; a success clears the failures.
  const accepted = await db.query(
    `UPDATE totp_secrets
        SET last_step = $2::bigint, failed_attempts = 0, failed_window_start = NULL
      WHERE user_id = $1 AND (last_step IS NULL OR last_step < $2::bigint)
      RETURNING user_id`,
    [input.userId, step],
  );
  return accepted.rows.length > 0 ? { ok: true, step } : { ok: false, reason: "invalid" };
}
