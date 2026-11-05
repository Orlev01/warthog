// Opened-tracking for approvals (design §10 Notifications, brief "SMS fallback").
//
// The SMS/email fallback job fires ONLY while an approval is still unopened. This
// module is the primitive both the inbox (which marks an approval opened when the
// person views it) and the fallback job (which checks whether it is still unopened
// before firing) depend on: once the person has viewed the approval, the fallback is
// suppressed.
//
// Every statement is parameterized through the `Db` seam (INV-102): the id and user
// id travel as BOUND values, never concatenated into the SQL text, so a value shaped
// like SQL is stored as data and cannot alter the query. `markOpened` is member-scoped
// by the `userId` the caller passes — the session's id, never a client value (INV-102)
// — so one person can never mark another's approval opened. Time enters through the
// injected Clock (never SQL now()). This module reads no `process.env` and holds no
// secret (INV-103): it works purely from the injected db + clock.

import type { Clock } from "../seams/clock";
import type { Db } from "../db/index";

// What markOpened needs: the approval being viewed and the SESSION's user id (the
// member scope), never a value from the request body.
export interface MarkOpenedInput {
  readonly id: string;
  readonly userId: string;
}

// Record that the owner viewed their approval: set `opened_at = clock.now()` for the
// approval with `input.id` OWNED BY `input.userId` (member-scoped: id AND user_id both
// bound). Returns true when the caller's approval was found and recorded opened; false
// when no approval with that id is owned by this user — so a non-owner marks nothing.
export async function markOpened(
  db: Db,
  input: MarkOpenedInput,
  clock: Clock,
): Promise<boolean> {
  const result = await db.query(
    `UPDATE approvals
        SET opened_at = $1::timestamptz
      WHERE id = $2 AND user_id = $3
      RETURNING id`,
    [clock.now().toISOString(), input.id, input.userId],
  );
  return result.rows.length > 0;
}

// Whether the approval with `id` is BOTH unopened (opened_at IS NULL) AND still
// pending — the only state in which the fallback is still armed. False once it has
// been opened, once it has been decided (approved/denied/expired), or when no such
// approval exists. Credential-/id-keyed like the fallback job that calls it (no user
// scope): the member-scope check happens a layer up, where the approval is loaded.
export async function isUnopened(db: Db, id: string): Promise<boolean> {
  const result = await db.query(
    `SELECT 1 AS present FROM approvals
      WHERE id = $1 AND opened_at IS NULL AND status = 'pending'`,
    [id],
  );
  return result.rows.length > 0;
}
