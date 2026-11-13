// Evict the lost factors (sign-in audit, founder decision 13 November 2026). Account
// recovery (recovery code + a new passkey) and re-enrolment after a completed reset both
// exist because the person lost their devices, and whoever has those devices still holds
// their passkeys, their authenticator app and their signed-in sessions. So once the new
// passkey is saved, everything else that signs in goes: every OTHER passkey, the
// authenticator app and every session. Agent access keys and OAuth connections are not
// sign-in methods and are kept (recovery names them in its alert instead).
//
// The caller runs this inside the transaction that saved the new passkey, AFTER taking the
// account lock (`lockActiveAccount`), so the lock order matches deletion, removal and
// re-enrolment: account row first, then the factor and session rows.

import type { Db } from "../db/index";
import type { Clock } from "../seams/clock";
import { discardDeviceSignInRequests } from "./new-device";
import { discardTotpEnrolment } from "./totp-enrolment";

export interface EvictedFactors {
  readonly passkeys: number;
  readonly authenticator: boolean;
  readonly sessions: number;
}

export async function evictLostFactors(tx: Db, userId: string, keepCredentialId: string): Promise<EvictedFactors> {
  const passkeys = await tx.query("DELETE FROM passkeys WHERE user_id = $1 AND credential_id <> $2 RETURNING id", [
    userId,
    keepCredentialId,
  ]);
  const authenticator = await tx.query("DELETE FROM totp_secrets WHERE user_id = $1 RETURNING user_id", [userId]);
  const sessions = await tx.query("DELETE FROM sessions WHERE user_id = $1 RETURNING id", [userId]);
  return {
    passkeys: passkeys.rows.length,
    authenticator: authenticator.rows.length > 0,
    sessions: sessions.rows.length,
  };
}

// After the eviction commits: a sign-in request another device is waiting on (possibly
// approved from a session that no longer exists) must not be collected afterwards, and an
// authenticator set-up begun from an evicted session must not be handed to the owner.
export function discardPendingSignIns(userId: string, deps: { clock: Clock }): void {
  discardDeviceSignInRequests(userId, deps);
  discardTotpEnrolment(userId);
}
