// The account recovery code: a 26-character base32 code shown once at sign-up
// that restores sign-in if every passkey is lost. It is distinct from the
// device-only vault recovery phrase; it never unlocks protected vault data.
// Verification alone does not consume it. Regeneration or a completed passkey
// recovery replaces it and invalidates grants tied to the previous generation.
//
// The server authenticates a recovery sign-in WITHOUT ever holding the code. It
// stores only a slow one-way auth hash — scrypt(HKDF(code, info
// `warthog/recovery-auth/v1`)) — per the project rule that codes are stored only
// as a hash and appear in plain text nowhere except the single message that hands
// a person their own code. verify recomputes that hash under the stored per-row
// salt and compares it in constant time; the plaintext is returned by issue and
// written to no column.
//
// Entropy is drawn through the `random` seam (conventions: src/server/** never
// calls the crypto library for randomness directly); HKDF and scrypt are
// deterministic transforms, so they come straight from node:crypto, exactly as the
// TOTP module takes its HMAC from there. Every statement is parameterized through
// the `Db` seam (INV-102): the userId, salt and digest travel as BOUND values, and
// the userId is the account id from the session — a recovery code is member-scoped,
// so verify filters by it and a code never matches across accounts.
//
// Review fixes B3 and B10:
//   • scrypt runs on libuv's thread pool (the async API), never synchronously on the
//     request thread, so a stream of verifications cannot stall every other request.
//   • A verification for an account with no recovery code (or no account at all) still
//     runs one scrypt against a fixed decoy salt, so its timing matches a real one and
//     cannot reveal which accounts exist.
//   • A presented code is normalised before hashing — upper-cased, everything outside
//     the base32 alphabet (spaces, dashes, grouping) dropped, and the look-alike digits 0
//     and 1 read as O and I — so a handwritten copy verifies. An issued code is already
//     in this canonical form, so stored hashes are unchanged.

import { hkdfSync, scrypt, timingSafeEqual, type ScryptOptions } from "node:crypto";

import type { Random } from "../seams/random";
import type { Db } from "../db/index";

const CODE_ENTROPY_BYTES = 16; // 128 random bits (design §4.2)
const SALT_BYTES = 16; // the per-row scrypt salt
const HKDF_INFO = "warthog/recovery-auth/v1"; // domain-separates this auth hash
const HKDF_KEY_LEN = 32; // HKDF-SHA256 output fed to scrypt
const SCRYPT_KEY_LEN = 32; // the stored digest length
// scrypt work factors (Node defaults): N=16384 keeps the derivation deliberately
// slow, so a leaked hash resists brute force.
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 } as const;

// RFC 4648 base32 alphabet (A–Z, 2–7): the form the recovery code is shown in.
const B32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

// The salt the equal-cost decoy hash runs under when there is no stored code. Public
// and fixed: the decoy's result is never compared with anything that could match.
const DECOY_SALT = new Uint8Array(SALT_BYTES);

// The canonical form of a typed recovery code: upper case, the look-alike digits 0 and
// 1 read as O and I (neither digit is in the base32 alphabet), and every character
// outside the alphabet — spaces, dashes, dots, any grouping — dropped.
export function normaliseRecoveryCode(input: string): string {
  return input
    .toUpperCase()
    .replace(/0/g, "O")
    .replace(/1/g, "I")
    .replace(/[^A-Z2-7]/g, "");
}

// scrypt on the libuv thread pool (node's callback API), so hashing never blocks the
// event loop.
function scryptAsync(
  password: Uint8Array,
  salt: Uint8Array,
  keyLen: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keyLen, options, (error, key) => (error ? reject(error) : resolve(key)));
  });
}

// Encode raw bytes to RFC 4648 base32 (no padding). 16 bytes = 128 bits encode to
// 26 characters (the final character carries the trailing 3 bits), the "26 base32
// characters" of design §4.2.
function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += B32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return out;
}

// The stored auth hash: scrypt(HKDF(code, info `warthog/recovery-auth/v1`), salt),
// over the code's canonical form. HKDF domain-separates the code (an empty salt, as
// the design names only the info), and scrypt makes the result slow to brute-force.
// Deterministic in the code and salt, so verify recomputes it from the stored salt.
async function authHash(code: string, salt: Uint8Array): Promise<Buffer> {
  const prk = Buffer.from(
    hkdfSync(
      "sha256",
      Buffer.from(normaliseRecoveryCode(code), "utf8"),
      new Uint8Array(0),
      Buffer.from(HKDF_INFO, "utf8"),
      HKDF_KEY_LEN,
    ),
  );
  return scryptAsync(prk, Buffer.from(salt), SCRYPT_KEY_LEN, SCRYPT_PARAMS);
}

// Issue (or regenerate) the recovery code for `userId`: draw 128 fresh random bits
// as a 26-character base32 code, store ONLY scrypt(HKDF(code, …)) with a fresh
// per-row salt, and return the plaintext — the single place it is ever handed out
// (shown once). Issuing again for the same user REPLACES the prior row (a
// regenerate), so exactly one code is current and the old one stops verifying.
export async function issueRecoveryCode(
  db: Db,
  userId: string,
  deps: { random: Random },
): Promise<{ code: string }> {
  const code = base32Encode(deps.random.randomBytes(CODE_ENTROPY_BYTES));
  const salt = deps.random.randomBytes(SALT_BYTES);
  const hash = await authHash(code, salt);

  await db.query(
    `INSERT INTO recovery_codes (user_id, auth_hash, salt, created_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (user_id) DO UPDATE
       SET auth_hash = EXCLUDED.auth_hash,
           salt = EXCLUDED.salt,
           created_at = EXCLUDED.created_at`,
    [userId, hash.toString("hex"), Buffer.from(salt).toString("hex")],
  );

  return { code };
}

// Verify a presented `code` against `userId`'s current recovery code. Reads the
// one row for the session's userId (the ownership filter — a code never matches
// across accounts), recomputes the auth hash under the stored salt, and compares in
// constant time. Returns false — never throws — for a wrong code, a user with no
// recovery code, or `userId` null (no such account); the last two still pay for one
// decoy hash so they answer in the same time as a real verification.
export async function verifyRecoveryCode(
  db: Db,
  userId: string | null,
  code: string,
): Promise<boolean> {
  return (await verifyRecoveryCodeGeneration(db, userId, code)) !== null;
}

// A successful multi-step recovery retains only this nonsecret generation ID,
// never the presented code or its auth hash. The fresh random salt changes on
// every rotation. Callers must lock and compare the current row before adding a
// factor, so a proof verified before regeneration cannot authorize one afterward.
export async function verifyRecoveryCodeGeneration(
  db: Db,
  userId: string | null,
  code: string,
): Promise<string | null> {
  const row =
    userId === null
      ? undefined
      : (await db.query(`SELECT auth_hash, salt FROM recovery_codes WHERE user_id = $1`, [userId]))
          .rows[0];
  if (!row) {
    await authHash(code, DECOY_SALT);
    return null;
  }

  const expected = Buffer.from(row.auth_hash as string, "hex");
  const actual = await authHash(code, Buffer.from(row.salt as string, "hex"));
  return expected.length === actual.length && timingSafeEqual(expected, actual) ? row.salt as string : null;
}
