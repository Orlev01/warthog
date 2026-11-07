// The account-purge queue's data access (brief §"Australian Privacy Act and
// GDPR-style rights"; design §4.1 "Account deletion = crypto-shredding …; a job
// deletes the rows within 24 hours"; design §9 "a separate `warthog_purge` role is
// used only by the account-deletion job").
//
// Deleting a person's wrapped DEK crypto-shreds their data immediately, but the
// rows must still be REMOVED within 24 hours by a dedicated job. This module writes
// and reads the queue of accounts awaiting that purge: enqueue an account, and read
// back the whole pending queue. The queue read is deliberately NOT member-scoped —
// the purge job reads every pending account across the whole system, which is why
// `listPendingPurges` takes no `userId` and the HANDLER that enqueues takes the
// account from the SESSION, never a client value.
//
// Every statement is parameterized through the `Db` seam (INV-102): the account id
// travels as a BOUND value, never concatenated into the SQL text, so a value shaped
// like SQL is stored as data and cannot alter the query. This module takes `db` as
// its only dependency — it holds no secret and reads no `process.env` (INV-103).

import type { Db, Row } from "./index";

// An account awaiting purge. `userId` is the account to purge (the session's id,
// never a client value); `requestedAt` is when the purge was first requested —
// plaintext metadata, the 24-hour clock starts here and is NOT bumped by a
// re-enqueue.
export interface PurgeRequest {
  readonly userId: string;
  readonly requestedAt: string | Date;
}

// The columns every read returns, in one place so enqueue and the list hand back
// the same shape.
const COLUMNS = "user_id, requested_at";

// Normalise an instant (Date or string) to a canonical ISO-8601 string, so a
// `timestamptz` round-trips the same regardless of driver.
function toIso(value: unknown): string {
  return new Date(value as string | number | Date).toISOString();
}

// Map a raw row to a PurgeRequest, translating the snake_case columns to the
// module's camelCase fields.
function toRequest(row: Row): PurgeRequest {
  return {
    userId: row.user_id as string,
    requestedAt: toIso(row.requested_at),
  };
}

// Enqueue `userId` for purge and return the pending request. IDEMPOTENT: the
// account id is the primary key, so a second call for the same account conflicts
// and the `DO UPDATE` is a no-op that leaves `requested_at` untouched — no duplicate
// pending entry is created and the original request time (the 24-hour deadline) is
// preserved. RETURNING hands back the surviving row either way, so a first enqueue
// and a repeat both return the account's one pending request.
export async function enqueueAccountPurge(db: Db, userId: string): Promise<PurgeRequest> {
  const result = await db.query(
    `INSERT INTO account_purge_queue (user_id)
     VALUES ($1)
     ON CONFLICT (user_id) DO UPDATE SET user_id = EXCLUDED.user_id
     RETURNING ${COLUMNS}`,
    [userId],
  );
  const row = result.rows[0];
  if (!row) throw new Error("enqueueAccountPurge: INSERT returned no row");
  return toRequest(row);
}

// Read the WHOLE pending queue — every account awaiting purge, oldest request
// first (closest to its 24-hour deadline). Deliberately NOT member-scoped: the
// purge job reads across all accounts. An empty array when nothing is queued.
export async function listPendingPurges(db: Db): Promise<PurgeRequest[]> {
  const result = await db.query(
    `SELECT ${COLUMNS} FROM account_purge_queue ORDER BY requested_at ASC`,
  );
  return result.rows.map(toRequest);
}
