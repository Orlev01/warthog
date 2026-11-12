// E16-S08 — Account-deletion service (brief §"Australian Privacy Act and
// GDPR-style rights"). Removes the live wrapped-DEK reference and revokes access;
// queued work purges live rows within 24 hours. This is not cryptographic erasure of
// retained backups, which may still contain the earlier wrapped DEK.
//
// A person deletes their OWN account. FIRST, any household they OWN must be
// transferred or closed — until then deletion is refused with a plain reason and
// NOTHING changes. Otherwise, in one unit and before returning success, the service:
//   – clears the live wrapped-DEK column so normal application reads cannot unwrap
//     it. Historical backups may retain that wrapped key while the shared KEK still
//     exists; backup restores must reconcile later deletions before opening traffic.
//     Provider records have separate retention controls;
//   – revokes every agent and service connection, so an agent's next request is
//     refused;
//   – ends every session of the person (every device is signed out);
//   – enqueues the account for the 24-hour purge;
//   – sends a confirmation email to the person (best effort: a channel failure is
//     reported but never undoes or fails the completed deletion).
//
// The agent / connection / credential stores live in other aggregates, so the
// cross-aggregate revocation is DELEGATED through an injected `DeletionExecutor`
// seam — exactly as account-reset delegates its erase/revoke through a
// `ResetExecutor`, persistence flows through the `Db` seam and delivery through the
// notification senders. Every seam is injected, so this module holds no secret and
// reads no `process.env` (INV-103).
//
// Every member-scoped read/write takes `userId` from the SESSION, never a client
// value — a caller can never delete another person's account — and every statement
// is parameterized (INV-102): the account id travels as a BOUND value, never
// concatenated into the SQL text, so a value shaped like SQL is stored/compared as
// data and cannot alter the query.

import { deleteAccountJobs, enqueueAccountPurge } from "../db/account-purge";
import { withTransaction, type Db } from "../db/index";
import { releaseStore, type ReleaseStore } from "../crypto/release-store";
import type { Senders } from "../notify/senders";
import type { DeletionJournal } from "./deletion-journal";

// The cross-aggregate revocation a deletion performs, injected because the agent /
// connection / credential stores live in other aggregates. The account module owns
// the deletion unit and calls this seam to cut every agent off; the app wires the
// real revoker at the composition root (the dev path is the prod path with the real
// stores behind the same seam).
export interface DeletionExecutor {
  // Implementations must use this transaction for every durable revocation.
  revokeAgentsAndConnections(userId: string, tx: Db): Promise<void>;
}

// Every seam injected — no process.env, no secret (INV-103). The confirmation email
// goes through `senders.email`.
export interface DeleteAccountDeps {
  readonly db: Db;
  readonly revoker: DeletionExecutor;
  readonly senders: Senders;
  readonly releases?: Pick<ReleaseStore, "discardScope">;
  readonly journal?: DeletionJournal;
}

// The plain reason shown to a person who still owns a household — they must transfer
// ownership or close the household before their own account can be deleted.
const OWNS_HOUSEHOLD_REASON =
  "Transfer or close the household you own before you can delete your account.";

// A fixed, code-free confirmation message. It carries no sensitive value (no code,
// token, key or vault datum) and reads nothing from the environment, so no ambient
// value can leak into it (INV-103).
const CONFIRMATION_BODY =
  "Your Warthog account has been deleted. Every agent and service has been disconnected and you've been signed out " +
  "everywhere. We've removed the link to the key that protects your data from our live systems, and what's left is " +
  "deleted within 24 hours. Backups, messages we've already sent and records kept by the services we use follow " +
  "their own timelines, set out in our privacy policy.";

// Delete the SESSION person's account. Returns { ok: true } once the whole unit has
// run, or { ok: false, reason } when the person still owns a household (in which case
// nothing is changed, enqueued, sent or revoked).
export async function deleteAccount(
  deps: DeleteAccountDeps,
  session: { userId: string },
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const { db, revoker, senders } = deps;
  const userId = session.userId;

  // One pinned transaction owns the entire deletion, including the executor's
  // credential writes. A failed revoke, queue insert or commit must leave the
  // account usable, rather than stranded with a missing key and no purge request.
  const outcome = await withTransaction(db, async (tx) => {
    // A key-share FK check in an in-flight release must remain compatible here:
    // the account id is not changed, and the agent row serializes its revocation.
    const person = await tx.query("SELECT id FROM users WHERE id = $1 FOR NO KEY UPDATE", [userId]);
    if (!person.rows[0]) throw new Error("deleteAccount: no account for the session user");
    const owned = await tx.query("SELECT 1 FROM households WHERE owner_id = $1", [userId]);
    if (owned.rows.length > 0) return { ok: false as const, reason: OWNS_HOUSEHOLD_REASON };

    // Durable recovery intent MUST precede commit. If commit becomes ambiguous,
    // this marker blocks restore until independently resolved. A failed write
    // leaves the database unchanged. The production composition always supplies it.
    await deps.journal?.requested(userId);
    await revoker.revokeAgentsAndConnections(userId, tx);
    await tx.query("DELETE FROM sessions WHERE user_id = $1", [userId]);
    await deleteAccountJobs(tx, userId);
    const shredded = await tx.query(
      "UPDATE users SET wrapped_dek = '' WHERE id = $1 RETURNING email", [userId],
    );
    await enqueueAccountPurge(tx, userId);
    return { ok: true as const, email: shredded.rows[0]!.email as string };
  });
  if (!outcome.ok) return outcome;

  // Release keys start with the exact `userId:` namespace, then connection and
  // approval IDs. In-memory effects follow commit so rollback never loses a live
  // release. DEKs are resolved per request; there is no persistent DEK cache.
  (deps.releases ?? releaseStore).discardScope(`${userId}:`);

  try {
    await deps.journal?.completed(userId);
  } catch {
    // The deletion is committed. Keep the purge queue until its sweep can persist
    // the completion; the request marker already makes recovery fail closed.
    console.error("[warthog account] deletion journal completion requires retry");
  }

  // Confirm by email. The deletion above is already complete and irreversible, so a
  // channel failure here must not turn it into an error the person would retry: it is
  // reported (with no address or other personal detail) and the deletion stands.
  try {
    await senders.email.sendEmail({ recipient: outcome.email, body: CONFIRMATION_BODY });
  } catch {
    console.error("[warthog account] deletion confirmation email could not be sent");
  }

  return { ok: true };
}
