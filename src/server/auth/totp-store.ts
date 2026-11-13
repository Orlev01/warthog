// The authenticator-app (TOTP) secret store (design §4, §5): per person exactly one
// base32 authenticator-app secret, stored DEK-encrypted. The sign-in handler reads a
// returning person's secret through the `TotpSecretStore` shape this module returns
// (`get(userId) -> base32 secret | null`); until now that store was only ever a test
// fake, so this is the real, persistent one.
//
// A secret is personal content, so it is stored only DEK-encrypted (never plaintext):
// the store resolves the person's own 256-bit data key itself — it reads that
// person's wrapped DEK (`users.wrapped_dek`) and unwraps it through the KeyWrapper
// seam — then envelope-encrypts/decrypts the secret under it (src/server/crypto/
// envelope.ts, AES-256-GCM with the AAD bound to this table/column/row). A leak of
// the `totp_secrets` row reveals no usable secret.
//
// Every statement is parameterized through the `Db` seam (INV-102): the userId and
// the envelope ciphertext travel as BOUND values, never concatenated into the SQL
// text, so a value shaped like SQL is stored as data and cannot alter the query.
// Every read/write is filtered by `user_id` — the account id the session carries, not
// a value from the client — so a secret is read only by its own owner (member-scoped).

import { decrypt, encrypt } from "../crypto/envelope";
import type { KeyWrapper } from "../crypto/key-wrapper";
import { withTransaction, type Db } from "../db/index";

// The table and column the envelope's AAD binds the ciphertext to (so a ciphertext
// lifted into a different row/column/table fails to decrypt) and that the statements
// below read and write.
const TABLE = "totp_secrets";
const SECRET_COLUMN = "secret_enc";

// The store the sign-in handler injects: `get` alone is the handler's contract
// (TotpSecretStore), with `set`/`remove` for enrolment.
export interface TotpSecretStore {
  // The base32 secret for that person (decrypted), or null when they have none.
  get(userId: string): Promise<string | null>;
  // Enrol OR replace: store the person's single authenticator-app secret,
  // DEK-encrypted. A second set for the same person replaces the first.
  set(userId: string, secret: string): Promise<void>;
  // Clear that person's secret; get then returns null. Safe when none exists.
  remove(userId: string): Promise<void>;
  // First enrolment after sign-up (Settings › Security): store the secret DEK-encrypted
  // with the time step its verification code was accepted at (so that code is spent for
  // sign-in and step-up too), ONLY when the person has none yet. Resolves false — and
  // changes nothing — when an authenticator is already on the account: this never replaces.
  // With `guard`, the insert runs in a transaction that runs the guard first and stores
  // nothing, resolving null, when it says no (the session setting it up has ended).
  enrol(userId: string, secret: string, acceptedStep: number, guard?: (tx: Db) => Promise<boolean>): Promise<boolean | null>;
}

export interface TotpSecretStoreDeps {
  readonly db: Db;
  readonly keyWrapper: KeyWrapper;
}

// Build a TotpSecretStore bound to a db + keyWrapper, so callers (and the sign-in
// handler) invoke its methods with a userId alone — the store resolves the person's
// data key and runs the parameterized statements itself.
export function createTotpSecretStore(deps: TotpSecretStoreDeps): TotpSecretStore {
  const { db, keyWrapper } = deps;

  // Resolve the person's unwrapped 256-bit DEK: read their wrapped DEK (bound by
  // userId) and unwrap it through the KeyWrapper seam. Throws when the person has no
  // row — only ever called once a secret row for that userId has been found.
  async function dataKeyFor(userId: string): Promise<Uint8Array> {
    const result = await db.query("SELECT wrapped_dek FROM users WHERE id = $1", [userId]);
    const row = result.rows[0];
    if (!row) throw new Error("totp-store: no data key for this user");
    return keyWrapper.unwrap(row.wrapped_dek as string);
  }

  return {
    async get(userId: string): Promise<string | null> {
      const result = await db.query(
        `SELECT ${SECRET_COLUMN} FROM ${TABLE} WHERE user_id = $1`,
        [userId],
      );
      const row = result.rows[0];
      if (!row) return null;
      const dek = await dataKeyFor(userId);
      return decrypt(dek, TABLE, SECRET_COLUMN, userId, row[SECRET_COLUMN] as string);
    },

    async set(userId: string, secret: string): Promise<void> {
      const dek = await dataKeyFor(userId);
      const ciphertext = await encrypt(dek, TABLE, SECRET_COLUMN, userId, secret);
      await db.query(
        `INSERT INTO ${TABLE} (user_id, ${SECRET_COLUMN})
         VALUES ($1, $2)
         ON CONFLICT (user_id) DO UPDATE
           SET ${SECRET_COLUMN} = EXCLUDED.${SECRET_COLUMN}`,
        [userId, ciphertext],
      );
    },

    async remove(userId: string): Promise<void> {
      await db.query(`DELETE FROM ${TABLE} WHERE user_id = $1`, [userId]);
    },

    async enrol(
      userId: string,
      secret: string,
      acceptedStep: number,
      guard?: (tx: Db) => Promise<boolean>,
    ): Promise<boolean | null> {
      // Encrypted before any transaction opens, so the guard's lock never waits on the key service.
      const dek = await dataKeyFor(userId);
      const ciphertext = await encrypt(dek, TABLE, SECRET_COLUMN, userId, secret);
      const insert = async (q: Db): Promise<boolean> => (await q.query(
        `INSERT INTO ${TABLE} (user_id, ${SECRET_COLUMN}, last_step)
         VALUES ($1, $2, $3::bigint)
         ON CONFLICT (user_id) DO NOTHING
         RETURNING user_id`,
        [userId, ciphertext, acceptedStep],
      )).rows.length > 0;
      if (!guard) return insert(db);
      return withTransaction(db, async (tx) => ((await guard(tx)) ? insert(tx) : null));
    },
  };
}
