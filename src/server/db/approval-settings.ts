// The approval expiry setting's data access (brief "Rules and approvals": rules include
// "an approval expiry time"; "approvals expire after the configured time (default 15
// minutes, adjustable from 2 minutes to 24 hours) and an expired request is denied").
//
// One person's expiry lives in exactly one place: the pipeline reads it when it holds a
// call, the Rules page shows and saves it. It is PLAINTEXT METADATA (a whole number of
// minutes), so it is not DEK-encrypted and this module holds no key and reads no
// `process.env`. Every statement is parameterized through the `Db` seam and member-scoped
// by the `userId` the caller passes — the session's (or the connection owner's) id, never
// a client value — so one person can never read or change another's expiry.

import {
  DEFAULT_EXPIRY_MINUTES,
  MAX_EXPIRY_MINUTES,
  MIN_EXPIRY_MINUTES,
} from "../../domain/approvals/state-machine";
import type { Db } from "./index";

export interface SetApprovalExpiryInput {
  readonly userId: string;
  readonly minutes: number;
  // Stamped as updated_at (time comes from the caller's clock, never SQL now()).
  readonly now: Date;
}

// The persisted minutes, or a refusal when the value is not a whole number in range — in
// which case nothing was written.
export type SetApprovalExpiryResult =
  | { ok: true; minutes: number }
  | { ok: false; reason: "invalid_expiry" };

// Whether `minutes` is an allowed expiry: a whole number from 2 minutes to 24 hours.
export function isValidExpiryMinutes(minutes: number): boolean {
  return Number.isInteger(minutes) && minutes >= MIN_EXPIRY_MINUTES && minutes <= MAX_EXPIRY_MINUTES;
}

// The person's approval expiry in minutes, or the 15-minute default when they have set
// none (no row).
export async function getApprovalExpiryMinutes(db: Db, userId: string): Promise<number> {
  const result = await db.query("SELECT expiry_minutes FROM approval_settings WHERE user_id = $1", [userId]);
  const row = result.rows[0];
  return row ? Number(row.expiry_minutes) : DEFAULT_EXPIRY_MINUTES;
}

// Save the person's ONE row, inserting it or overwriting it in place. An invalid value is
// refused BEFORE any query, so a refusal writes nothing and a saved value is left as it was.
export async function setApprovalExpiryMinutes(
  db: Db,
  input: SetApprovalExpiryInput,
): Promise<SetApprovalExpiryResult> {
  if (!isValidExpiryMinutes(input.minutes)) return { ok: false, reason: "invalid_expiry" };
  await db.query(
    `INSERT INTO approval_settings (user_id, expiry_minutes, updated_at)
     VALUES ($1, $2, $3::timestamptz)
     ON CONFLICT (user_id) DO UPDATE
       SET expiry_minutes = EXCLUDED.expiry_minutes, updated_at = EXCLUDED.updated_at`,
    [input.userId, input.minutes, input.now.toISOString()],
  );
  return { ok: true, minutes: input.minutes };
}
