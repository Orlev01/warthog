// The saved-cards store's data access (brief "Identity vault" + §17 "No readable
// card numbers or security codes"; design §4.2 "Device-held vault (high-tier
// details and cards)").
//
// Cards are DEVICE-HELD, exactly like high-tier identity values
// (`high-tier-fields`): the card NUMBER is encrypted IN THE BROWSER with the
// device-held vault key (VK) BEFORE it leaves the device. THE SERVER STORES
// CIPHERTEXT ONLY: it holds no vault key, never decrypts, and hands the number
// ciphertext back to the owner's own device solely so the device can decrypt it
// locally for a card release. So this module takes NO `dek` and imports NO crypto —
// it is pure opaque-ciphertext storage plus plaintext metadata (brand, last four,
// expiry, nickname, billing-address reference), exactly like the high-tier store.
//
// The card SECURITY CODE (CVV) is NEVER stored in any form (constitution §17): the
// API accepts no security-code parameter and the table has no column for one, so
// neither a plaintext number nor a CVV can reach a column — this store reads only
// its named fields.
//
// A person may hold SEVERAL cards, so each save is its own row with a distinct id —
// not an upsert. Every statement is parameterized through the `Db` seam (INV-102):
// the ids and every value travel as BOUND values, never concatenated into the SQL
// text, so a value shaped like SQL is stored as data and cannot alter the query.
// Every read/write is member-scoped by the `userId` the caller passes — the
// session's id, never a client value — so one person can never read, add or remove
// another's card. This module reads no `process.env` and holds no key (it never
// encrypts — the browser does; config flows from `src/server/config.ts` alone,
// INV-103).

import { randomUUID } from "node:crypto";

import type { Db, Row } from "./index";

// What addCard records: the owner (the session's id, never a client value), the
// plaintext metadata the interface shows and budgets need, and the OPAQUE
// device-produced ciphertext of the card NUMBER (VK-encrypted in the browser) the
// server stores verbatim and never decrypts. There is deliberately NO security-code
// field.
export interface NewCard {
  readonly userId: string;
  readonly brand: string;
  readonly lastFour: string;
  readonly expiryMonth: number;
  readonly expiryYear: number;
  readonly nickname: string;
  readonly billingAddressId: string;
  readonly numberCiphertext: string;
}

// What a read hands back — METADATA ONLY, never the stored number / its ciphertext
// and never a security code.
export interface CardMetadata {
  readonly id: string;
  readonly userId: string;
  readonly brand: string;
  readonly lastFour: string;
  readonly expiryMonth: number;
  readonly expiryYear: number;
  readonly nickname: string;
  readonly billingAddressId: string;
}

// Map a raw row to its metadata (snake_case columns → camelCase fields). The number
// ciphertext is never selected into a metadata read.
function toMetadata(row: Row): CardMetadata {
  return {
    id: row.id as string,
    userId: row.user_id as string,
    brand: row.brand as string,
    lastFour: row.last_four as string,
    expiryMonth: Number(row.expiry_month),
    expiryYear: Number(row.expiry_year),
    nickname: row.nickname as string,
    billingAddressId: row.billing_address_id as string,
  };
}

// Save a card for `input.userId`, storing ONLY the opaque number ciphertext plus the
// plaintext metadata — this reads only its named fields, so any security code (or
// plaintext number) smuggled onto the input object reaches no column. The id is
// generated up front and the returned metadata is assembled from the inputs (no
// dependency on a RETURNING read), so a save never hands back the stored ciphertext.
export async function addCard(db: Db, input: NewCard): Promise<CardMetadata> {
  const id = randomUUID();

  await db.query(
    `INSERT INTO cards
       (id, user_id, brand, last_four, expiry_month, expiry_year, nickname,
        billing_address_id, number_ciphertext)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      id,
      input.userId,
      input.brand,
      input.lastFour,
      input.expiryMonth,
      input.expiryYear,
      input.nickname,
      input.billingAddressId,
      input.numberCiphertext,
    ],
  );

  return {
    id,
    userId: input.userId,
    brand: input.brand,
    lastFour: input.lastFour,
    expiryMonth: input.expiryMonth,
    expiryYear: input.expiryYear,
    nickname: input.nickname,
    billingAddressId: input.billingAddressId,
  };
}

// List ALL of `userId`'s cards as METADATA ONLY — id, brand, last four, expiry,
// nickname, billing-address reference, never the number or its ciphertext (the
// ciphertext column is not even selected). Member-scoped (user_id is bound): never
// another person's cards; an empty array when the person has none.
export async function listCards(db: Db, userId: string): Promise<CardMetadata[]> {
  const result = await db.query(
    `SELECT id, user_id, brand, last_four, expiry_month, expiry_year, nickname,
            billing_address_id
       FROM cards
      WHERE user_id = $1`,
    [userId],
  );
  return result.rows.map(toMetadata);
}

// The stored number ciphertext for ONE card, returned ONLY to its owner (both id AND
// user_id are bound) so the owner's device can decrypt it locally for a release.
// Returns null when the card does not exist OR belongs to someone else — a non-owner
// learns nothing.
export async function getCardCiphertext(
  db: Db,
  userId: string,
  cardId: string,
): Promise<string | null> {
  const result = await db.query(
    `SELECT number_ciphertext FROM cards WHERE id = $1 AND user_id = $2`,
    [cardId, userId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return row.number_ciphertext as string;
}

// Remove the one card OWNED BY `userId` with this id (member-scoped: id AND user_id
// both bound). Returns true when a card was removed, false when none matched for this
// user — so another person's remove is a no-op, and removing an already-removed card
// is idempotent, not an error.
export async function removeCard(db: Db, userId: string, cardId: string): Promise<boolean> {
  const result = await db.query(
    `DELETE FROM cards WHERE id = $1 AND user_id = $2 RETURNING id`,
    [cardId, userId],
  );
  return result.rows.length > 0;
}
