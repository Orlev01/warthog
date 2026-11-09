import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { vaultProofTranscript, type VaultProof, type VaultProofPayload, type VaultProofChallenge } from "../../domain/vault-unlock-proof";
import { withTransaction, type Db } from "../db/index";
import { encrypt, decrypt } from "../crypto/envelope";
import { createVaultUnlockActions } from "./unlock";
import { systemRandom } from "../seams/random";
import { processSingleton } from "../seams/process-singleton";
import type { UnlockMethod } from "../db/vault-unlock-methods";

export class VaultProofError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}

export function createProofChallenges(limits = { maxTotal: 1000, maxPerUser: 5 }) {
  const entries = new Map<string, { user: string; session: string; method: string; expires: number }>();
  const prune = (now: number) => { for (const [key, entry] of entries) if (entry.expires <= now) entries.delete(key); };
  return {
    issue(user: string, session: string, method: string, now: number): string {
      prune(now);
      const own = [...entries].filter(([, entry]) => entry.user === user);
      while (own.length >= limits.maxPerUser) entries.delete(own.shift()![0]);
      if (entries.size >= limits.maxTotal) throw new Error("Too many pending vault challenges");
      const nonce = randomBytes(32).toString("base64url");
      entries.set(nonce, { user, session, method, expires: now + 5 * 60_000 });
      return nonce;
    },
    take(nonce: string, user: string, session: string, method: string, now: number): boolean {
      prune(now);
      const entry = entries.get(nonce);
      if (!entry || entry.user !== user || entry.session !== session || entry.method !== method) return false;
      entries.delete(nonce);
      return true;
    },
  };
}
export const proofChallenges = () => processSingleton("vault.proofChallenges", () => createProofChallenges());

async function hasLegacyVault(db: Db, userId: string): Promise<boolean> {
  const result = await db.query(`SELECT EXISTS (SELECT 1 FROM vault_unlock_methods WHERE user_id = $1)
    OR EXISTS (SELECT 1 FROM vault_passkey_envelopes WHERE user_id = $1)
    OR EXISTS (SELECT 1 FROM cards WHERE user_id = $1)
    OR EXISTS (SELECT 1 FROM high_tier_fields WHERE user_id = $1) AS present`, [userId]);
  return result.rows[0]?.present === true;
}

export async function vaultProofMode(db: Db, userId: string): Promise<VaultProofChallenge["mode"]> {
  const result = await db.query("SELECT 1 FROM vault_unlock_proofs WHERE user_id = $1", [userId]);
  return result.rows.length ? "prove" : await hasLegacyVault(db, userId) ? "legacy" : "enroll";
}

export async function saveProvenMethod(input: {
  db: Db; userId: string; body: VaultProofPayload & { method: UnlockMethod; proof: VaultProof };
  replace: boolean; getDek: (userId: string, tx: Db) => Promise<Uint8Array>;
}): Promise<void> {
  const { db, userId, body } = input;
  if (body.method === "passkey_prf" && (typeof body.params?.credentialId !== "string" || !/^[A-Za-z0-9_-]{1,2048}$/.test(body.params.credentialId))) {
    throw new VaultProofError(400, "invalid_credential");
  }
  let transcript: string;
  try { transcript = vaultProofTranscript(body.proof.challenge, body); }
  catch { throw new VaultProofError(400, "invalid_request"); }
  await withTransaction(db, async (tx) => {
    const user = await tx.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [userId]);
    if (!user.rows.length) throw new VaultProofError(401, "unauthenticated");
    const stored = await tx.query("SELECT encrypted_key FROM vault_unlock_proofs WHERE user_id = $1", [userId]);
    const envelope = stored.rows[0]?.encrypted_key;
    if (envelope && body.proof.verifier) throw new VaultProofError(409, "vault_setup_conflict");
    if (!envelope && await hasLegacyVault(tx, userId)) throw new VaultProofError(409, "vault_proof_upgrade_required");
    if (!envelope && !body.proof.verifier) throw new VaultProofError(403, "vault_unlock_required");
    const dek = await input.getDek(userId, tx);
    let verifier: Buffer | undefined;
    try {
      const encoded = envelope ? await decrypt(dek, "vault_unlock_proofs", "encrypted_key", userId, String(envelope)) : body.proof.verifier!;
      verifier = Buffer.from(encoded, "base64url");
      if (verifier.length !== 32 || verifier.toString("base64url") !== encoded) throw new VaultProofError(403, "vault_unlock_required");
      const expected = createHmac("sha256", verifier).update(transcript).digest();
      const actual = Buffer.from(body.proof.mac, "base64url");
      if (expected.length !== actual.length || actual.toString("base64url") !== body.proof.mac || !timingSafeEqual(expected, actual)) {
        throw new VaultProofError(403, "vault_unlock_required");
      }
      const result = await createVaultUnlockActions({ db: tx, random: systemRandom }).saveUnlockMethod(userId, body, { replace: input.replace });
      if (!result.ok) throw new VaultProofError(result.reason === "step_up_required" ? 403 : 400, result.reason);
      if (!envelope) {
        const encrypted = await encrypt(dek, "vault_unlock_proofs", "encrypted_key", userId, encoded);
        await tx.query("INSERT INTO vault_unlock_proofs (user_id, encrypted_key) VALUES ($1, $2)", [userId, encrypted]);
      }
    } finally { verifier?.fill(0); dek.fill(0); }
  });
}
