// Card-only billing addresses (docs/adr/card-billing-addresses.md; migration 0123).
//
// A billing address a person types for their cards, kept apart from their About you details so
// it is never listed as an everyday detail or shown to agents through get_context. Like an
// identity field it is personal content, so the value is stored only DEK-ENCRYPTED: the id is
// generated up front and the envelope binds the ciphertext to its exact (table, column, row).
//
// Every statement is parameterized (INV-102) and member-scoped by the `userId` the caller passes
// (the session's id, never a client value). The DEK is injected; this module reads no env.

import { randomUUID } from "node:crypto";

import { decrypt, encrypt } from "../crypto/envelope";
import type { Db } from "./index";

const TABLE = "card_billing_addresses";
const VALUE_COLUMN = "value";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface CardBillingAddress {
  readonly id: string;
  readonly userId: string;
  readonly value: string;
}

// Save a card-only billing address for `input.userId`, DEK-encrypted and bound to its row.
export async function saveCardBillingAddress(
  db: Db,
  input: { readonly userId: string; readonly value: string },
  dek: Uint8Array,
): Promise<CardBillingAddress> {
  const id = randomUUID();
  const envelope = await encrypt(dek, TABLE, VALUE_COLUMN, id, input.value);
  await db.query(`INSERT INTO card_billing_addresses (id, user_id, value) VALUES ($1, $2, $3)`, [id, input.userId, envelope]);
  return { id, userId: input.userId, value: input.value };
}

// The person's card-only billing addresses, decrypted, oldest first. A wrong DEK rejects.
export async function listCardBillingAddresses(db: Db, userId: string, dek: Uint8Array): Promise<CardBillingAddress[]> {
  const result = await db.query(
    `SELECT id, user_id, value FROM card_billing_addresses WHERE user_id = $1 ORDER BY created_at, id`,
    [userId],
  );
  const out: CardBillingAddress[] = [];
  for (const row of result.rows) {
    const id = row.id as string;
    out.push({ id, userId: row.user_id as string, value: await decrypt(dek, TABLE, VALUE_COLUMN, id, row.value as string) });
  }
  return out;
}

// Whether `id` is one of the person's card-only billing addresses. A malformed id is simply not
// theirs (it is never cast in SQL).
export async function ownsCardBillingAddress(db: Db, userId: string, id: string): Promise<boolean> {
  if (!UUID.test(id)) return false;
  const result = await db.query(`SELECT 1 FROM card_billing_addresses WHERE id = $1 AND user_id = $2`, [id, userId]);
  return result.rows.length > 0;
}

// Delete one of the person's card-only billing addresses when no card of theirs uses it any more
// (a card-only address exists only while a card uses it). Returns whether it was deleted.
export async function deleteCardBillingAddressIfUnused(db: Db, userId: string, id: string): Promise<boolean> {
  if (!UUID.test(id)) return false;
  const result = await db.query(
    `DELETE FROM card_billing_addresses a
      WHERE a.id = $1 AND a.user_id = $2
        AND NOT EXISTS (SELECT 1 FROM cards c WHERE c.user_id = $2 AND c.billing_entry_id = $1)
      RETURNING a.id`,
    [id, userId],
  );
  return result.rows.length > 0;
}
