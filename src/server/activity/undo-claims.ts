// The single-shot undo guard (`activity_undo_claims`, migration 0108): every statement the
// undo service runs against it, and the read the activity list joins in, kept in ONE place
// so the service and the Activity page always agree on what a claim means.
//
// A claim's state comes from plaintext metadata only (the claim and its approval's status;
// nothing is decrypted):
//   • "done"    — the claim names no approval (the reversal ran, or is still running), or
//                 its approval was approved;
//   • "waiting" — its approval is pending, or the person asked for more detail;
//   • stale     — its approval was denied, expired, or no longer exists for this person
//                 (an approval is matched on its id AND its owner, so another person's
//                 approval never holds this person's entry). A stale claim undid nothing,
//                 so it counts as no claim: Undo is offered again, and the next undo
//                 clears exactly that claim and claims afresh.
//
// Member-scoped and parameterized (INV-102): the user id, seq and approval id always travel
// as BOUND values; the statement text carries only fixed column names and the fixed approval
// status literals. This module reads no `process.env` and holds no key (INV-103).

import type { Db } from "../db/index";

export type UndoClaimState = "done" | "waiting";

// The claim `u` and its approval `a`, LEFT JOINed on the approval's id AND owner.
const CLAIM_FROM_SQL = `FROM activity_undo_claims u
      LEFT JOIN approvals a ON a.id = u.approval_id AND a.user_id = u.user_id`;

// A claim's state; NULL when it is stale.
const CLAIM_STATE_SQL = `CASE
        WHEN u.approval_id IS NULL OR a.status = 'approved' THEN 'done'
        WHEN a.status IN ('pending', 'more_detail') THEN 'waiting'
      END`;

// Joined onto an UNALIASED activity_entries row, adds `undo_state` ('done' | 'waiting' |
// NULL — no claim, or a stale one) and `undo_approval_id`. A LATERAL subquery exposes only
// those two columns, so the entry's own column names stay unambiguous in the caller's WHERE.
export const UNDO_CLAIM_JOIN_SQL = `LEFT JOIN LATERAL (
    SELECT ${CLAIM_STATE_SQL} AS undo_state, u.approval_id AS undo_approval_id
      ${CLAIM_FROM_SQL}
     WHERE u.user_id = activity_entries.user_id AND u.entry_seq = activity_entries.seq
  ) AS undo_claim ON true`;

// Claim `userId`'s entry `entrySeq`. Atomic: of two concurrent claims exactly one wins.
export async function claimUndo(db: Db, userId: string, entrySeq: number, claimedAt: Date): Promise<boolean> {
  const claimed = await db.query(
    `INSERT INTO activity_undo_claims (user_id, entry_seq, claimed_at) VALUES ($1, $2, $3::timestamptz)
     ON CONFLICT (user_id, entry_seq) DO NOTHING RETURNING entry_seq`,
    [userId, entrySeq, claimedAt.toISOString()],
  );
  return claimed.rows.length > 0;
}

// Release the claim, so a retry can run.
export async function releaseUndo(db: Db, userId: string, entrySeq: number): Promise<void> {
  await db.query("DELETE FROM activity_undo_claims WHERE user_id = $1 AND entry_seq = $2", [userId, entrySeq]);
}

// Record the approval a held undo waits on, on the person's own claim.
export async function holdUndoForApproval(db: Db, userId: string, entrySeq: number, approvalId: string): Promise<void> {
  await db.query(
    "UPDATE activity_undo_claims SET approval_id = $3 WHERE user_id = $1 AND entry_seq = $2",
    [userId, entrySeq, approvalId],
  );
}

// When the person's claim on the entry is stale, delete exactly that claim — matched on its
// stale approval id too, so a fresh claim another request made meanwhile (which names no
// approval, or a new one) is never removed — and report true so the caller claims once
// more. A live claim, or none, is left alone and reports false.
export async function clearStaleUndo(db: Db, userId: string, entrySeq: number): Promise<boolean> {
  const found = await db.query(
    `SELECT u.approval_id, ${CLAIM_STATE_SQL} AS state
      ${CLAIM_FROM_SQL}
     WHERE u.user_id = $1 AND u.entry_seq = $2`,
    [userId, entrySeq],
  );
  const claim = found.rows[0];
  if (!claim || claim.approval_id == null || claim.state != null) return false;
  await db.query(
    "DELETE FROM activity_undo_claims WHERE user_id = $1 AND entry_seq = $2 AND approval_id = $3",
    [userId, entrySeq, String(claim.approval_id)],
  );
  return true;
}
