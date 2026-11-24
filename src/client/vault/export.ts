// E16-S03 — device-protected export section (client vault).
//
// High-tier identity values and card numbers are encrypted on the person's own
// device with the vault key (VK) and Warthog cannot read them, so the server-only
// export builder (src/server/export/build.ts) OMITS the schema's optional
// `deviceProtected` block. The ONLY place those details can be added to an export
// is the browser, after a step-up and unlock — otherwise a portable backup would
// silently omit them. This module is that browser step: given the stored
// ciphertext and the unlocked VK it decrypts the high-tier values and card numbers
// and returns them in the `deviceProtected` SECTION SHAPE of the E16-S01 export
// schema (src/server/export/schema.ts), ready to merge into the downloaded file.
//
// It is a purely local transform over the `decryptValue` seam: it issues no network
// request and never writes a plaintext value to client storage or the console — the
// decrypted plaintext only ever appears in the returned section. Decrypt is always
// GCM-tag verified, so an absent vault key or any value that fails to unwrap (a
// wrong key or a tampered envelope) makes the whole build REJECT with no plaintext
// — it reports failure rather than returning a partial section or guessing.

import { decryptValue } from "./values";

// The opaque ciphertext records the browser holds for the person (high-tier-fields.ts
// / cards.ts): plaintext metadata alongside each value's `v1:` envelope.
export interface StoredHighTierField {
  type: string;
  label: string;
  ciphertext: string;
}
export interface StoredCard {
  expiryMonth?: number;
  expiryYear?: number;
  cardholderName?: string | null;
  // The billing address: a postal identity field id OR a card-only address id
  // (docs/adr/card-billing-addresses.md), never both; neither means none yet.
  billingAddressId?: string;
  billingEntryId?: string;
  brand: string;
  lastFour: string;
  nickname: string;
  numberCiphertext: string;
}
export interface StoredVault {
  highTierFields: StoredHighTierField[];
  cards: StoredCard[];
}

// The E16-S01 `deviceProtected` section: the same metadata carried through, each
// envelope replaced by its decrypted plaintext (`value` / `number`).
export interface ExportedHighTierField {
  type: string;
  label: string;
  value: string;
}
export interface ExportedCard {
  expiryMonth?: number;
  expiryYear?: number;
  cardholderName?: string | null;
  billingAddressId?: string;
  billingEntryId?: string;
  brand: string;
  lastFour: string;
  nickname: string;
  number: string;
}
export interface DeviceProtected {
  highTierFields: ExportedHighTierField[];
  cards: ExportedCard[];
}

// Build the device-protected export section from the stored ciphertext under the
// unlocked vault key. Resolves with every high-tier value and card number
// decrypted, in the order given, with the plaintext metadata unchanged. Rejects —
// returning no plaintext — when the vault key is absent, or when any one value
// fails to unwrap (a GCM tag mismatch from a wrong key or a tampered envelope): the
// `Promise.all` below propagates the first failure, so no partial section is built.
export async function buildDeviceProtected(
  vaultKey: Uint8Array<ArrayBuffer> | null | undefined,
  stored: StoredVault,
): Promise<DeviceProtected> {
  if (!vaultKey) {
    throw new Error("the vault must be unlocked to build the device-protected export section");
  }

  const highTierFields = await Promise.all(
    stored.highTierFields.map(async (field) => ({
      type: field.type,
      label: field.label,
      value: await decryptValue(vaultKey, field.ciphertext),
    })),
  );

  const cards = await Promise.all(
    stored.cards.map(async (card) => ({
      brand: card.brand,
      lastFour: card.lastFour,
      nickname: card.nickname,
      ...(card.expiryMonth !== undefined ? { expiryMonth: card.expiryMonth } : {}),
      ...(card.expiryYear !== undefined ? { expiryYear: card.expiryYear } : {}),
      ...(card.cardholderName !== undefined ? { cardholderName: card.cardholderName } : {}),
      ...(card.billingAddressId !== undefined ? { billingAddressId: card.billingAddressId } : {}),
      ...(card.billingEntryId !== undefined ? { billingEntryId: card.billingEntryId } : {}),
      number: await decryptValue(vaultKey, card.numberCiphertext),
    })),
  );

  return { highTierFields, cards };
}
