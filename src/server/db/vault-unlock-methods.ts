// The vault unlock-methods aggregate's data access (design §4.2 "Device-held
// vault"). The browser creates a random 256-bit VAULT KEY (VK) at first use and
// encrypts high-tier values and card data with it; the server stores only
// ciphertext. VK itself is stored server-side ONLY WRAPPED, once per unlock method
// — so the server never holds VK, the passphrase, the PRF output or the recovery
// code in clear. A leak of this store reveals no vault key, passphrase or recovery
// code.
//
// This module owns three facts (one source of truth each; backed by the three
// tables of migration 0021):
//   • per (person, method) the opaque WRAPPED VK + its public params
//     (`vault_unlock_methods`),
//   • the person's FIXED passkey-PRF salt (`vault_prf_salts`), and
//   • the person's one-way recovery-auth verifier (`vault_recovery_auth`).
//
// The PRF salt is a per-person prerequisite the browser feeds to the
// authenticator's PRF eval, NOT an unlock method, so `listMethods` never reports
// it. The recovery-auth verifier is stored APART from the recovery wrapped key: it
// authenticates a recovery unlock without the server learning the code or the
// wrapping key the code derives.
//
// Review fix W1: the 'recovery' method holds VK wrapped under the VAULT RECOVERY
// PHRASE, which the browser generates and never sends (src/client/vault/
// recovery-phrase.ts). No server verifier is used for it — the envelope's GCM tag is
// the check, on the device — so saveRecoveryAuth/verifyRecoveryAuth have no caller.
// Should one ever be wired, it must receive only a value derived from the phrase under
// a DIFFERENT HKDF info than the wrapping key, never the phrase itself.
//
// Entropy is drawn through the `random` seam (conventions: src/server/** never
// calls the crypto library for randomness directly); HKDF and scrypt are
// deterministic transforms, so they come straight from node:crypto, exactly as the
// account-recovery module does. Every statement is parameterized through the `Db`
// seam (INV-102): the user id and every value travel as BOUND values, never
// concatenated into the SQL text, so a value shaped like SQL is stored as data and
// cannot alter the query. Every read/write is member-scoped by the `userId` the
// caller passes — the session's id, never a client value — so one person can never
// read or write another's unlock methods. This module reads no `process.env` and
// holds no key (config flows from `src/server/config.ts` alone, INV-103).

import { hkdfSync, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

import type { Random } from "../seams/random";
import type { Db } from "./index";

// The three unlock methods VK can be wrapped for (design §4.2).
export type UnlockMethod = "passkey_prf" | "passphrase" | "recovery";

// A method's PUBLIC verification inputs (salts, iteration counts) — never a secret.
// Stored and handed back verbatim (e.g. a passphrase's { pbkdf2Salt, iterations }).
export type UnlockParams = Record<string, unknown>;

export interface SaveWrappedKeyInput {
  readonly userId: string; // the session's person id, NEVER a client value
  readonly method: UnlockMethod;
  readonly wrappedKey: string; // opaque ciphertext — VK wrapped by the method's key
  readonly params?: UnlockParams; // public params for this method (omitted ⇒ {})
}

export interface StoredWrappedKey {
  readonly wrappedKey: string; // the opaque wrapped VK stored for this method
  readonly params: UnlockParams; // the public params stored alongside it
}

const PRF_SALT_BYTES = 32; // the fixed per-person 32-byte PRF salt (`salt_v1`)
const RECOVERY_SALT_BYTES = 16; // the per-row scrypt salt for the recovery verifier
// Domain-separates the vault recovery-auth hash from every other use of the code
// (the account-recovery sign-in and the code's own vault wrapping key each use a
// different HKDF info, so none can be derived from another).
const HKDF_INFO = "warthog/vault-recovery-auth/v1";
const HKDF_KEY_LEN = 32; // HKDF-SHA256 output fed to scrypt
const SCRYPT_KEY_LEN = 32; // the stored digest length
// scrypt work factors (Node defaults): N=16384 keeps the derivation deliberately
// slow, so a leaked hash resists brute force.
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 } as const;

// The stored recovery-auth hash: scrypt(HKDF(code, info), salt). HKDF
// domain-separates the code (an empty salt, as only the info is named), and scrypt
// makes the result slow to brute-force. Deterministic in the code and salt, so
// verify recomputes it from the stored salt. The async scrypt runs on the libuv pool, so a
// derivation never blocks the event loop (review: the sync form stalled every request).
const scryptAsync = promisify(scrypt) as (
  password: Buffer,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number },
) => Promise<Buffer>;

async function recoveryAuthHash(code: string, salt: Uint8Array): Promise<Buffer> {
  const prk = Buffer.from(
    hkdfSync("sha256", Buffer.from(code, "utf8"), new Uint8Array(0), Buffer.from(HKDF_INFO, "utf8"), HKDF_KEY_LEN),
  );
  return scryptAsync(prk, Buffer.from(salt), SCRYPT_KEY_LEN, SCRYPT_PARAMS);
}

// The person's FIXED passkey-PRF salt, created once on first call and returned
// STABLY on every later call. Member-scoped (a different person's salt is
// independent, drawn freshly through the `random` seam). Returns a hex string
// (32 bytes ⇒ 64 characters).
export async function getOrCreatePrfSalt(
  db: Db,
  userId: string,
  deps: { random: Random },
): Promise<string> {
  const existing = await db.query(`SELECT salt FROM vault_prf_salts WHERE user_id = $1`, [userId]);
  if (existing.rows[0]) return existing.rows[0].salt as string;

  const salt = Buffer.from(deps.random.randomBytes(PRF_SALT_BYTES)).toString("hex");
  // DO NOTHING on conflict so a concurrent first-call race keeps the salt FIXED:
  // the loser inserts nothing and reads the winner's stored value below.
  const inserted = await db.query(
    `INSERT INTO vault_prf_salts (user_id, salt) VALUES ($1, $2)
     ON CONFLICT (user_id) DO NOTHING
     RETURNING salt`,
    [userId, salt],
  );
  if (inserted.rows[0]) return inserted.rows[0].salt as string;

  const reread = await db.query(`SELECT salt FROM vault_prf_salts WHERE user_id = $1`, [userId]);
  const row = reread.rows[0];
  if (!row) throw new Error("getOrCreatePrfSalt: the PRF salt row vanished after insert");
  return row.salt as string;
}

// Store (upsert) the opaque wrapped VK + its public params for `input.userId` +
// `input.method`. Keyed on the (user, method) pair, so saving the same method
// again REPLACES its wrapped key (one wrapped key per method) and a save under
// another person's id writes the caller's OWN row, leaving the other person's
// untouched. An omitted `params` is stored as an empty object.
export async function saveWrappedKey(db: Db, input: SaveWrappedKeyInput): Promise<void> {
  const params = input.params ?? {};
  await db.query(
    `INSERT INTO vault_unlock_methods (user_id, method, wrapped_key, params)
     VALUES ($1, $2, $3, $4::jsonb)
     ON CONFLICT (user_id, method) DO UPDATE SET
       wrapped_key = EXCLUDED.wrapped_key,
       params = EXCLUDED.params`,
    [input.userId, input.method, input.wrappedKey, JSON.stringify(params)],
  );
}

// Store the wrapped VK + params for `input.userId` + `input.method` ONLY when that
// method has none yet, reporting whether it was inserted. An existing row is left
// exactly as it was (ON CONFLICT DO NOTHING — one atomic statement, so two first
// saves racing each other keep exactly one wrapped key instead of the later silently
// replacing the earlier). The unlock-method POST uses this whenever the session has
// no fresh step-up: replacing a method is a security change (review fix W1).
export async function insertWrappedKeyIfAbsent(db: Db, input: SaveWrappedKeyInput): Promise<boolean> {
  const params = input.params ?? {};
  const result = await db.query(
    `INSERT INTO vault_unlock_methods (user_id, method, wrapped_key, params)
     VALUES ($1, $2, $3, $4::jsonb)
     ON CONFLICT (user_id, method) DO NOTHING
     RETURNING method`,
    [input.userId, input.method, input.wrappedKey, JSON.stringify(params)],
  );
  return result.rows.length > 0;
}

// Which unlock methods have a saved wrapped key for `userId` (member-scoped: the
// user id is bound). Never another person's, and never the wrapped key itself —
// only which methods exist. Empty array when the person has saved none.
export async function listMethods(db: Db, userId: string): Promise<UnlockMethod[]> {
  const result = await db.query(`SELECT method FROM vault_unlock_methods WHERE user_id = $1
    UNION SELECT 'passkey_prf' AS method FROM vault_passkey_envelopes WHERE user_id = $1`, [userId]);
  return result.rows.map((row) => row.method as UnlockMethod);
}

export interface CredentialEnvelope extends StoredWrappedKey {
  readonly credentialId: string;
}

export async function listPasskeyEnvelopes(db: Db, userId: string): Promise<CredentialEnvelope[]> {
  const result = await db.query("SELECT credential_id, wrapped_key, params FROM vault_passkey_envelopes WHERE user_id = $1 ORDER BY credential_id", [userId]);
  return result.rows.map((row) => ({ credentialId: String(row.credential_id), wrappedKey: String(row.wrapped_key), params: row.params as UnlockParams }));
}

// The ownership FK is the final guard, including concurrent credential removal.
export async function savePasskeyEnvelope(db: Db, input: SaveWrappedKeyInput, credentialId: string, replace: boolean): Promise<boolean> {
  const conflict = replace ? "DO UPDATE SET wrapped_key = EXCLUDED.wrapped_key, params = EXCLUDED.params" : "DO NOTHING";
  const result = await db.query(`INSERT INTO vault_passkey_envelopes (user_id, credential_id, wrapped_key, params)
    VALUES ($1, $2, $3, $4::jsonb) ON CONFLICT (user_id, credential_id) ${conflict} RETURNING credential_id`,
    [input.userId, credentialId, input.wrappedKey, JSON.stringify(input.params ?? {})]);
  return result.rows.length > 0;
}

// The stored wrapped VK + params for `userId` + `method` (to hand the browser so it
// can unwrap VK locally), or null when none is saved. Member-scoped: another
// person's method against this id returns null.
export async function getWrappedKey(
  db: Db,
  userId: string,
  method: UnlockMethod,
): Promise<StoredWrappedKey | null> {
  const result = await db.query(
    `SELECT wrapped_key, params FROM vault_unlock_methods WHERE user_id = $1 AND method = $2`,
    [userId, method],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    wrappedKey: row.wrapped_key as string,
    params: (row.params as UnlockParams | null) ?? {},
  };
}

// Store ONLY a slow one-way verifier of the recovery `code` (scrypt over an
// HKDF-derived value, with a fresh per-row salt) for `userId`; the plaintext code
// is written to no column. Saving again REPLACES the prior verifier (a regenerate),
// so the old code stops verifying and the new one takes over.
export async function saveRecoveryAuth(
  db: Db,
  userId: string,
  code: string,
  deps: { random: Random },
): Promise<void> {
  const salt = deps.random.randomBytes(RECOVERY_SALT_BYTES);
  const hash = await recoveryAuthHash(code, salt);
  await db.query(
    `INSERT INTO vault_recovery_auth (user_id, auth_hash, salt)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id) DO UPDATE SET
       auth_hash = EXCLUDED.auth_hash,
       salt = EXCLUDED.salt,
       created_at = now()`,
    [userId, hash.toString("hex"), Buffer.from(salt).toString("hex")],
  );
}

// Verify a presented `code` against `userId`'s current recovery-auth verifier.
// Reads the one row for the session's userId (the ownership filter — a code never
// matches across accounts), recomputes the hash under the stored salt, and compares
// in constant time. Returns false — never throws — for a wrong code or a person
// with no recovery-auth.
export async function verifyRecoveryAuth(db: Db, userId: string, code: string): Promise<boolean> {
  const result = await db.query(`SELECT auth_hash, salt FROM vault_recovery_auth WHERE user_id = $1`, [userId]);
  const row = result.rows[0];
  if (!row) return false;

  const expected = Buffer.from(row.auth_hash as string, "hex");
  const actual = await recoveryAuthHash(code, Buffer.from(row.salt as string, "hex"));
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
