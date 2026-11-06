// The high-tier identity aggregate's data access (brief "Identity vault" +
// "Device-held protection"; design §4.2 "Device-held vault"). High-tier identity
// details — date of birth, passport, driver licence, car registration and any
// custom field the person marks high — are PERSONAL CONTENT at the top
// sensitivity tier, released only after an approved, stepped-up request.
//
// Unlike the LOW-tier store (`identity-fields`), which the server DEK-encrypts
// itself, high-tier values are encrypted IN THE BROWSER with the device-held
// vault key (VK) BEFORE they leave the device. THE SERVER STORES CIPHERTEXT ONLY:
// it holds no vault key, never decrypts, and hands a value back to the owner's own
// device solely so the device can decrypt it locally for a release. So this module
// takes NO `dek` and imports NO crypto — it is pure opaque-ciphertext storage plus
// plaintext metadata (label, type), exactly like the wrapped-key store
// (`vault-unlock-methods`).
//
// A person may hold SEVERAL fields of the same type (two passports, several custom
// fields), so each save is its own row with a distinct id — not an upsert keyed on
// type.
//
// Every statement is parameterized through the `Db` seam (INV-102): the ids and
// every value travel as BOUND values, never concatenated into the SQL text, so a
// value shaped like SQL is stored as data and cannot alter the query. Every
// read/write is member-scoped by the `userId` the caller passes — the session's
// id, never a client value — so one person can never read or write another's
// high-tier fields. This module reads no `process.env` and holds no key (it never
// encrypts — the browser does; config flows from `src/server/config.ts` alone,
// INV-103).

import { randomUUID } from "node:crypto";

import type { Db, Row } from "./index";

// The five high-tier field types (brief: the four defaults plus custom).
export type HighTierFieldType =
  | "date_of_birth"
  | "passport"
  | "driver_licence"
  | "car_registration"
  | "custom";

// What saveHighTierField records: the owner (the session's id, never a client
// value), which high-tier field this is, its plaintext label, and the OPAQUE
// device-produced ciphertext (VK-encrypted in the browser) the server stores
// verbatim and never decrypts.
export interface NewHighTierField {
  readonly userId: string;
  readonly type: HighTierFieldType;
  readonly label: string;
  readonly ciphertext: string;
}

// What a read hands back — METADATA ONLY, never the stored value. Every row in
// this store is high tier, so `tier` is the constant "high".
export interface HighTierFieldMetadata {
  readonly id: string;
  readonly userId: string;
  readonly type: HighTierFieldType;
  readonly label: string;
  readonly tier: "high";
}

// Map a raw row to its metadata (snake_case columns → camelCase fields), stamping
// the invariant tier. The ciphertext is never selected into a metadata read.
function toMetadata(row: Row): HighTierFieldMetadata {
  return {
    id: row.id as string,
    userId: row.user_id as string,
    type: row.type as HighTierFieldType,
    label: row.label as string,
    tier: "high",
  };
}

// Save a high-tier field for `input.userId`, storing ONLY the opaque device
// ciphertext plus the plaintext metadata (type, label) — no plaintext value ever
// reaches a column (the API accepts none). The id is generated up front and the
// returned metadata is assembled from the inputs (no dependency on a RETURNING
// read), so a save never hands back the stored ciphertext.
export async function saveHighTierField(
  db: Db,
  input: NewHighTierField,
): Promise<HighTierFieldMetadata> {
  const id = randomUUID();

  await db.query(
    `INSERT INTO high_tier_fields (id, user_id, type, label, ciphertext)
     VALUES ($1, $2, $3, $4, $5)`,
    [id, input.userId, input.type, input.label, input.ciphertext],
  );

  return {
    id,
    userId: input.userId,
    type: input.type,
    label: input.label,
    tier: "high",
  };
}

// List ALL of `userId`'s high-tier fields as METADATA ONLY — label, type, tier,
// never the ciphertext or any value (the ciphertext column is not even selected).
// Member-scoped (user_id is bound): never another person's fields; an empty array
// when the person has none.
export async function listHighTierFields(
  db: Db,
  userId: string,
): Promise<HighTierFieldMetadata[]> {
  const result = await db.query(
    `SELECT id, user_id, type, label FROM high_tier_fields WHERE user_id = $1`,
    [userId],
  );
  return result.rows.map(toMetadata);
}

// The stored ciphertext for ONE field, returned ONLY to its owner (both id AND
// user_id are bound) so the owner's device can decrypt it locally for a release.
// Returns null when the field does not exist OR belongs to someone else — a
// non-owner learns nothing.
export async function getHighTierCiphertext(
  db: Db,
  userId: string,
  fieldId: string,
): Promise<string | null> {
  const result = await db.query(
    `SELECT ciphertext FROM high_tier_fields WHERE id = $1 AND user_id = $2`,
    [fieldId, userId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return row.ciphertext as string;
}
