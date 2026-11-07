// E16-S09 — Account-purge job (brief §"Australian Privacy Act and GDPR-style
// rights"; design §4.1 "Account deletion = crypto-shredding: deleting the wrapped
// DEK makes everything unreadable before the confirmation is shown; a job deletes
// the rows within 24 hours"; design §9 "a separate `warthog_purge` role is used
// only by the account-deletion job").
//
// Crypto-shredding (E16-S08) makes a deleted account's data unreadable immediately,
// but the ROWS must still be removed within 24 hours. This job is that removal — the
// single, auditable code path permitted to delete the append-only activity rows
// (activity_entries / activity_disputes; the application role is INSERT+SELECT only,
// the `warthog_purge` role holds the DELETE). It reads the WHOLE pending purge queue
// and, for each enqueued account, removes the account's `users` row, which cascades
// to every personal row across every table — its activity entries and disputes
// (users → activity_entries → activity_disputes, each `ON DELETE CASCADE`) alongside
// every other member table — and to its own queue entry (account_purge_queue also
// cascades on account deletion), so the one removal clears the queue behind it.
//
// Because removing the account is a single cascading statement, it is already an
// atomic, idempotent unit: a re-run that finds some rows (or the whole account)
// already gone deletes what remains without throwing, and a run over an empty queue
// changes nothing and reports nothing. The job only ever touches accounts PRESENT on
// the queue — an account never enqueued is left wholly intact.
//
// Takes `db` as its only dependency: it holds no secret and reads no `process.env`
// (INV-103), and every statement binds the account id as a parameter, never
// concatenated into the SQL text (INV-102 — a queued value shaped like SQL is handled
// as data and cannot alter a query).

import { listPendingPurges } from "../db/account-purge";
import type { Db } from "../db/index";

// The account ids purged on this run (empty when the queue was empty / already clear).
export interface PurgeRunResult {
  readonly purged: string[];
}

// Purge every account currently on the queue. Reads the whole pending queue (E16-S07),
// then removes each account's `users` row — the cascade carries away all of that
// account's personal rows across every table (including the append-only activity
// entries and disputes) and its own queue entry. Returns the account ids purged.
export async function runAccountPurge(db: Db): Promise<PurgeRunResult> {
  const pending = await listPendingPurges(db);
  const purged: string[] = [];
  for (const request of pending) {
    // Delete the account root; the schema's `ON DELETE CASCADE` references remove
    // every child row (and the queue entry) in one atomic statement. The id is a
    // bound parameter, never spliced into the SQL. Idempotent: an account whose rows
    // are already partly or wholly gone simply deletes what remains.
    await db.query("DELETE FROM users WHERE id = $1", [request.userId]);
    purged.push(request.userId);
  }
  return { purged };
}
