// Sign-ins and new sign-in methods versus the eviction (sign-in audit, 14 November 2026;
// docs/adr/signin-audit-fixes-2026-11.md §7).
//
// Recovery and re-enrolment after a reset remove what the lost devices hold: every other
// passkey, the authenticator app and every session (recover-session.ts). But a sign-in on a
// lost device checks its passkey or code first and mints its session a moment later, and a
// change a signed-in session makes to the ways in (a passkey, an authenticator app, the
// recovery code) checks the session first and writes a moment later. Either could land just
// after the eviction and survive it.
//
// So both sides take the account row. The eviction takes it FOR NO KEY UPDATE
// (`lockAccountForEviction`) before it removes anything. A sign-in mints its session
// (`createSessionWhileProofHolds`), and a signed-in change writes (`whileSignedIn`), in a
// transaction that first takes the row FOR SHARE and then checks again, under that lock,
// that what proved it is still there. Whichever commits first, the other sees it: after an
// eviction there is nothing left to re-check, so the sign-in or change is refused; a session
// or method that committed first is removed by the eviction with everything else. Settings
// removals take the row FOR UPDATE, so a sign-in with a passkey being removed is refused too.

import { withTransaction, type Db } from "../db/index";
import type { Clock } from "../seams/clock";
import type { Random } from "../seams/random";
import { createSession, lockActiveAccount, recordStepUp, type CreatedSession, type Session } from "./session";

// What proved a sign-in, re-checked when its session is minted.
export type SignInProof =
  // The passkey the assertion verified against.
  | { readonly kind: "passkey"; readonly credentialId: string }
  // The authenticator app that accepted a code from this time step (or a later one).
  | { readonly kind: "authenticator"; readonly step: number }
  // The recovery code generation (its salt) the presented code matched.
  | { readonly kind: "recovery_code"; readonly generation: string }
  // The signed-in session that approved a new device's request.
  | { readonly kind: "approval"; readonly sessionId: string };

async function proofHolds(tx: Db, userId: string, proof: SignInProof): Promise<boolean> {
  switch (proof.kind) {
    case "passkey":
      return (await tx.query("SELECT 1 FROM passkeys WHERE user_id = $1 AND credential_id = $2", [userId, proof.credentialId]))
        .rows.length > 0;
    case "authenticator":
      // The row that accepted the code: removing the app deletes it, and later codes only move it on.
      return (await tx.query("SELECT 1 FROM totp_secrets WHERE user_id = $1 AND last_step >= $2::bigint", [userId, proof.step]))
        .rows.length > 0;
    case "recovery_code":
      return (await tx.query("SELECT 1 FROM recovery_codes WHERE user_id = $1 AND salt = $2", [userId, proof.generation]))
        .rows.length > 0;
    case "approval":
      return (await tx.query("SELECT 1 FROM sessions WHERE user_id = $1 AND id = $2", [userId, proof.sessionId]))
        .rows.length > 0;
  }
}

// Mint a session for a sign-in, only while what proved it is still on the account. Null when
// it is gone (an eviction or a removal committed first): the caller refuses the sign-in as it
// would a failed check. With `stepUp`, the new session also carries the step-up the sign-in
// itself was, in the same transaction.
export async function createSessionWhileProofHolds(
  db: Db,
  userId: string,
  proof: SignInProof,
  deps: { clock: Clock; random: Random },
  options: { stepUp?: boolean } = {},
): Promise<CreatedSession | null> {
  return withTransaction(db, async (tx) => {
    await lockActiveAccount(tx, userId);
    if (!(await proofHolds(tx, userId, proof))) return null;
    const created = await createSession(tx, userId, deps);
    if (!options.stepUp) return created;
    return { ...created, session: await recordStepUp(tx, created.session.id, { clock: deps.clock }) };
  });
}

// Run a signed-in change to the ways into the account (adding a passkey or an authenticator
// app, issuing a recovery code) only while the session making it still exists, with `change`
// inside the same transaction. Null when the session is gone (signed out, or evicted by a
// recovery that committed first): nothing was written.
export async function whileSignedIn<T>(
  db: Db,
  session: Pick<Session, "id" | "userId">,
  change: (tx: Db) => Promise<T>,
): Promise<T | null> {
  return withTransaction(db, async (tx) => ((await stillSignedIn(tx, session)) ? change(tx) : null));
}

// The check `whileSignedIn` runs, for a store that opens its own transaction: take the account
// lock, then whether the session still exists. Must be the transaction's first statement.
export async function stillSignedIn(tx: Db, session: Pick<Session, "id" | "userId">): Promise<boolean> {
  await lockActiveAccount(tx, session.userId);
  const live = await tx.query("SELECT 1 FROM sessions WHERE id = $1 AND user_id = $2", [session.id, session.userId]);
  return live.rows.length > 0;
}
