// Operator-only recovery primitive. Never expose this through an application
// route or agent tool. The caller must independently verify an isolated clone,
// stopped writers and a snapshot of the ORIGINAL external deletion journal.
import { withTransaction, type Db } from "../db/index";
import type { BlobStore } from "../storage/blob";
import { planDeletionReconciliation, type JournalSnapshot } from "./deletion-journal";

// Restoring a database can resurrect credentials revoked after its restore point.
// Invalidate them rather than infer that they remain authorized. Reenrollment is
// a separate, explicitly approved recovery procedure; this never opens traffic.
const CREDENTIAL_TABLES = [
  "sessions", "oauth_auth_codes", "oauth_tokens", "oauth_access_keys", "connections",
  "provider_mcp_flows", "email_codes", "passkey_challenges", "passkeys", "totp_secrets",
  "recovery_codes", "vault_unlock_proofs", "vault_passkey_envelopes", "vault_recovery_auth",
  "vault_unlock_methods", "vault_prf_salts",
  "push_subscriptions", "mobile_numbers", "household_invites", "account_resets",
] as const;

export async function prepareIsolatedRestore(options: {
  db: Db; blobs: BlobStore; snapshot: JournalSnapshot; restorePoint: Date; now: Date;
}): Promise<{
  deletedAccounts: number; deletedReceiptBlobs: number;
  requiresCredentialReenrollment: true; trafficMayOpen: false;
}> {
  const journalIds = planDeletionReconciliation(options.snapshot, options.restorePoint, options.now);
  return withTransaction(options.db, async tx => {
    const queued = await tx.query("SELECT q.user_id, u.wrapped_dek FROM account_purge_queue q JOIN users u ON u.id = q.user_id");
    if (queued.rows.some(row => row.wrapped_dek !== "")) throw new Error("Restored database has inconsistent deletion evidence");
    // A snapshot can itself contain committed deletions made before journal
    // activation. Empty keys also remain inaccessible if a historical queue was lost.
    const emptyKeys = await tx.query("SELECT id FROM users WHERE wrapped_dek = ''");
    const ids = [...new Set([...journalIds, ...emptyKeys.rows.map(row => String(row.id))])].sort();
    const ownership = await tx.query("SELECT id FROM households WHERE owner_id = ANY($1::uuid[])", [ids]);
    if (ownership.rows.length) throw new Error("Reconcile historical household ownership before recovery");
    const receipts = await tx.query("SELECT blob_key FROM receipt_files WHERE user_id = ANY($1::uuid[])", [ids]);
    // The blob store must also be isolated. A failed delete rolls back SQL and
    // leaves traffic closed; idempotent blob removal permits a bounded retry.
    for (const row of receipts.rows) await options.blobs.delete(String(row.blob_key));
    for (const table of CREDENTIAL_TABLES) await tx.query(`DELETE FROM ${table}`);
    await tx.query("UPDATE agents SET status = 'disconnected'");
    await tx.query("DELETE FROM jobs");
    await tx.query("DELETE FROM approvals");
    const removed = await tx.query("DELETE FROM users WHERE id = ANY($1::uuid[]) RETURNING id", [ids]);
    return { deletedAccounts: removed.rows.length, deletedReceiptBlobs: receipts.rows.length,
      requiresCredentialReenrollment: true, trafficMayOpen: false };
  });
}
