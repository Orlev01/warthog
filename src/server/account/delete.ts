// E16-S08 — Account-deletion service (brief §"Australian Privacy Act and
// GDPR-style rights"; design §4.1 "Account deletion = crypto-shredding: deleting
// the wrapped DEK makes everything unreadable before the confirmation is shown; a
// job deletes the rows within 24 hours").
//
// A person deletes their OWN account. FIRST, any household they OWN must be
// transferred or closed — until then deletion is refused with a plain reason and
// NOTHING changes. Otherwise, in one unit and before returning success, the service:
//   – crypto-shreds the person's wrapped DEK (clears the column: the KEK can only
//     unwrap the ORIGINAL wrapped form, so once the only wrapped reference is gone
//     the DEK — and every DEK-encrypted datum — can never be recovered, even though
//     the users row itself PERSISTS until the purge job removes it within 24h);
//   – revokes every agent and service connection, so an agent's next request is
//     refused;
//   – enqueues the account for the 24-hour purge;
//   – sends a confirmation email to the person.
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

import { enqueueAccountPurge } from "../db/account-purge";
import type { Db } from "../db/index";
import type { Senders } from "../notify/senders";

// The cross-aggregate revocation a deletion performs, injected because the agent /
// connection / credential stores live in other aggregates. The account module owns
// the deletion unit and calls this seam to cut every agent off; the app wires the
// real revoker at the composition root (the dev path is the prod path with the real
// stores behind the same seam).
export interface DeletionExecutor {
  revokeAgentsAndConnections(userId: string): Promise<void>;
}

// Every seam injected — no process.env, no secret (INV-103). The confirmation email
// goes through `senders.email`.
export interface DeleteAccountDeps {
  readonly db: Db;
  readonly revoker: DeletionExecutor;
  readonly senders: Senders;
}

// The plain reason shown to a person who still owns a household — they must transfer
// ownership or close the household before their own account can be deleted.
const OWNS_HOUSEHOLD_REASON =
  "Transfer or close the household you own before you can delete your account.";

// A fixed, code-free confirmation message. It carries no sensitive value (no code,
// token, key or vault datum) and reads nothing from the environment, so no ambient
// value can leak into it (INV-103).
const CONFIRMATION_BODY =
  "Your Warthog account has been deleted. Your data is now unreadable, every agent " +
  "and connection has been cut off, and the rest will be removed within 24 hours.";

// Delete the SESSION person's account. Returns { ok: true } once the whole unit has
// run, or { ok: false, reason } when the person still owns a household (in which case
// nothing is changed, enqueued, sent or revoked).
export async function deleteAccount(
  deps: DeleteAccountDeps,
  session: { userId: string },
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const { db, revoker, senders } = deps;
  const userId = session.userId;

  // Refuse while the person still OWNS a household (households.owner_id = userId):
  // the shared container must be transferred or closed first. The id is bound, never
  // woven into the SQL. Nothing else runs on this path — the DEK stays intact,
  // nothing is enqueued, no email is sent and the revoker is not called.
  const owned = await db.query("SELECT 1 FROM households WHERE owner_id = $1", [userId]);
  if (owned.rows.length > 0) {
    return { ok: false, reason: OWNS_HOUSEHOLD_REASON };
  }

  // Crypto-shred the wrapped DEK: clear the only wrapped reference so the DEK can no
  // longer be unwrapped (the content is unreadable before the confirmation is shown).
  // The users row PERSISTS — the purge job removes it within 24h — so RETURNING the
  // email gives the confirmation recipient without a second read.
  const shredded = await db.query(
    "UPDATE users SET wrapped_dek = '' WHERE id = $1 RETURNING email",
    [userId],
  );
  const row = shredded.rows[0];
  if (!row) throw new Error("deleteAccount: no account for the session user");
  const email = row.email as string;

  // Cut off every agent and service connection for this person (their next request
  // is refused), then enqueue the account for the 24-hour purge and confirm by email
  // — all awaited, so each has happened before success is returned.
  await revoker.revokeAgentsAndConnections(userId);
  await enqueueAccountPurge(db, userId);
  await senders.email.sendEmail({ recipient: email, body: CONFIRMATION_BODY });

  return { ok: true };
}
