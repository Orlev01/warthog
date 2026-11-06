// The low-tier identity aggregate's data access (brief "Identity vault"; design
// §4.1). Low-tier identity — name, preferred name, email addresses, phone
// numbers, postal addresses (with an optional "moving on" date), language, time
// zone and general preferences — is PERSONAL CONTENT shared freely with permitted
// agents via get_context, so each field's value is stored only DEK-ENCRYPTED
// (`../crypto/envelope`, design §4.1): the id is generated up front so the
// envelope's associated data binds the ciphertext to its exact (table, column,
// row) — the plaintext never lands in a column. High-tier details live in the
// device-held vault (design §4.2), NOT here.
//
// A person may hold several fields of the SAME kind (the brief's "email
// addresses" / "phone numbers" / "postal addresses" are plural), so each save is
// its own row with a distinct id — not an upsert keyed on kind.
//
// Every statement is parameterized through the `Db` seam (INV-102): the ids and
// every value travel as BOUND values, never concatenated into the SQL text, so a
// value shaped like SQL is stored as data and cannot alter the query. Every
// read/write is member-scoped by the `userId` the caller passes — the session's
// id, never a client value — so one person can never read or write another's
// identity fields. The DEK is injected (this module reads no `process.env` and
// holds no key, INV-103).

import { randomUUID } from "node:crypto";

import { decrypt, encrypt } from "../crypto/envelope";
import type { Db, Row } from "./index";

// The envelope's associated data binds each `value` ciphertext to its exact
// location, so a row lifted into another row/column/table fails to decrypt.
const TABLE = "identity_fields";
const VALUE_COLUMN = "value";

// The eight low-tier structured field kinds (brief). High-tier details (passport,
// card, …) are NOT here — they live in the device-held vault.
export type IdentityFieldKind =
  | "name"
  | "preferred_name"
  | "email"
  | "phone"
  | "postal_address"
  | "language"
  | "time_zone"
  | "preference";

// What saveIdentityField records: the owner (the session's id, never a client
// value), which low-tier field this is, its value (stored DEK-encrypted), and the
// optional "moving on" date a postal address may carry (ISO calendar date,
// e.g. "2027-03-01"; absent ⇒ null).
export interface NewIdentityField {
  readonly userId: string;
  readonly kind: IdentityFieldKind;
  readonly value: string;
  readonly movingOn?: string | null;
}

// A field as handed back to its owner: the generated id, the owner, the kind, the
// DECRYPTED value, and the moving-on date stored alongside it (or null).
export interface IdentityField {
  readonly id: string;
  readonly userId: string;
  readonly kind: IdentityFieldKind;
  readonly value: string;
  readonly movingOn: Date | string | null;
}

// The columns a read returns. `moving_on` is cast to text so it round-trips as a
// stable "YYYY-MM-DD" string regardless of the driver's date handling (a bare
// `date` comes back as a UTC-midnight Date that would shift a day in a timezone
// behind UTC); `value` comes back as ciphertext and is decrypted separately.
const SELECT_COLUMNS = "id, user_id, kind, value, moving_on::text AS moving_on";

// Map a raw row (plus its already-decrypted value) to an IdentityField,
// translating the snake_case columns to the module's camelCase fields.
function toField(row: Row, value: string): IdentityField {
  return {
    id: row.id as string,
    userId: row.user_id as string,
    kind: row.kind as IdentityFieldKind,
    value,
    movingOn: (row.moving_on as string | null) ?? null,
  };
}

// Save a low-tier identity field for `input.userId`, storing its value
// DEK-encrypted plus the optional moving-on date. The id is generated up front so
// the value's envelope binds to the row; the returned IdentityField is assembled
// from the inputs (no dependency on a RETURNING read).
export async function saveIdentityField(
  db: Db,
  input: NewIdentityField,
  dek: Uint8Array,
): Promise<IdentityField> {
  const id = randomUUID();
  const movingOn = input.movingOn ?? null;
  const envelope = await encrypt(dek, TABLE, VALUE_COLUMN, id, input.value);

  await db.query(
    `INSERT INTO identity_fields (id, user_id, kind, value, moving_on)
     VALUES ($1, $2, $3, $4, $5::date)`,
    [id, input.userId, input.kind, envelope, movingOn],
  );

  return {
    id,
    userId: input.userId,
    kind: input.kind,
    value: input.value,
    movingOn,
  };
}

// List ALL of `userId`'s identity fields (member-scoped: user_id is bound), each
// value DECRYPTED under the owner's `dek`. Never another person's fields; an empty
// array when the person has none. A wrong DEK fails the GCM tag and rejects.
export async function listIdentityFields(
  db: Db,
  userId: string,
  dek: Uint8Array,
): Promise<IdentityField[]> {
  const result = await db.query(
    `SELECT ${SELECT_COLUMNS} FROM identity_fields WHERE user_id = $1`,
    [userId],
  );

  const fields: IdentityField[] = [];
  for (const row of result.rows) {
    const value = await decrypt(dek, TABLE, VALUE_COLUMN, row.id as string, row.value as string);
    fields.push(toField(row, value));
  }
  return fields;
}
