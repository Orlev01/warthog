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
// Three things a person owns live outside that cascade, so the job removes them itself
// (review fix W3.2; review 2026-11-23):
//   • Receipt files keep their ciphertext in blob storage under `receipt_files.blob_key`.
//     Every such blob is deleted BEFORE the rows, so the key is never lost while its blob
//     still exists: a blob delete that fails leaves the account (and its queue entry) for
//     the next run, which tries again. Blob deletes are idempotent, so a retry after a
//     partial run is safe.
//   • The person's agents' OAuth tokens, authorization codes and access keys are keyed by
//     the agent's connection id with no foreign key to users, so they are deleted, by the
//     person's own agents, in the same transaction as the account row.
//   • Their email address in the sign-in code tables and in household invites sent to them,
//     which are keyed by the address (the code flow runs before an account may exist; an
//     invite is bound to the address it went to). The address is read from the account row,
//     which deletion leaves in place for this job, and those rows are deleted by it in the
//     same transaction — so once the account is gone, no table still holds the address.
// Each account is its own unit: a failure is collected and the sweep carries on with the
// rest, then reports every failure together (one bad account never blocks the others).
//
// Takes `db` and the blob store as its dependencies: it holds no secret and reads no
// `process.env` (INV-103), and every statement binds the account id as a parameter, never
// concatenated into the SQL text (INV-102 — a queued value shaped like SQL is handled as
// data and cannot alter a query).

import { deleteAccountJobs, listPendingPurges } from "../db/account-purge";
import { withTransaction, type Db } from "../db/index";
import type { BlobStore } from "../storage/blob";
import { lockUserOAuthConnections } from "../oauth/connection-lock";
import { deleteEmailCodeRecords } from "../auth/email-code";
import { deleteInvitesTo } from "../db/household-invites";
import type { DeletionJournal } from "./deletion-journal";

// The account ids purged on this run (empty when the queue was empty / already clear).
export interface PurgeRunResult {
  readonly purged: string[];
}

// The blob store receipt ciphertext lives in (the same store the life-admin page writes).
export interface PurgeDeps {
  readonly blobStore: BlobStore;
  readonly journal?: DeletionJournal;
}

// Purge one account: its receipt blobs, then (in one transaction) its agents' credentials,
// the rows holding its address and its `users` row, whose cascade carries away every
// personal row (including the append-only activity entries and disputes) and its own queue
// entry. Idempotent: an account whose rows are already partly or wholly gone simply deletes
// what remains.
async function purgeAccount(db: Db, userId: string, deps: PurgeDeps): Promise<void> {
  if (deps?.journal) {
    const person = await db.query("SELECT wrapped_dek FROM users WHERE id = $1", [userId]);
    if (!person.rows[0] || person.rows[0].wrapped_dek !== "") {
      throw new Error("Refusing to certify an account without a committed deletion");
    }
    // Repair a post-commit journal outage before destroying the database evidence.
    await deps.journal.requested(userId);
    await deps.journal.completed(userId);
  }
  const receipts = await db.query("SELECT blob_key FROM receipt_files WHERE user_id = $1", [userId]);
  for (const row of receipts.rows) {
    await deps.blobStore.delete(String(row.blob_key));
  }
  await withTransaction(db, async (tx) => {
    // Match deletion's user -> OAuth-connection -> agent lock order.
    const person = await tx.query("SELECT email FROM users WHERE id = $1 FOR NO KEY UPDATE", [userId]);
    await lockUserOAuthConnections(tx, userId);
    const agents = "SELECT connection_id FROM agents WHERE user_id = $1";
    await tx.query(`DELETE FROM oauth_tokens WHERE connection_id IN (${agents})`, [userId]);
    await tx.query(`DELETE FROM oauth_auth_codes WHERE connection_id IN (${agents})`, [userId]);
    await tx.query(`DELETE FROM oauth_access_keys WHERE connection_id IN (${agents})`, [userId]);
    const email = person.rows[0]?.email;
    if (typeof email === "string" && email !== "") {
      await deleteEmailCodeRecords(tx, email);
      await deleteInvitesTo(tx, email);
    }
    await deleteAccountJobs(tx, userId);
    await tx.query("DELETE FROM users WHERE id = $1", [userId]);
  });
}

// Purge every account currently on the queue (E16-S07's whole pending queue). Returns the
// account ids purged; when any account failed, the rest are still purged and the run then
// throws one AggregateError carrying each failure (the failed accounts stay queued).
export async function runAccountPurge(db: Db, deps: PurgeDeps): Promise<PurgeRunResult> {
  const pending = await listPendingPurges(db);
  const purged: string[] = [];
  const failures: unknown[] = [];
  for (const request of pending) {
    try {
      await purgeAccount(db, request.userId, deps);
      purged.push(request.userId);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, `account-purge: ${failures.length} account(s) could not be purged`);
  }
  return { purged };
}
