// E16-S06 — device-protected import re-protection (client vault).
//
// An export's `deviceProtected` section carries the person's high-tier identity
// values and card numbers DECRYPTED — plaintext that exists on the device only
// during import. The server import service (src/server/import/import.ts)
// deliberately never touches this section, because Warthog's servers must store
// nothing they can decrypt (constitution 17, 19; design §4.2). This module is the
// browser step that closes the gap: given the plaintext `deviceProtected` section
// and the IMPORTING account's unlocked vault key (VK), it RE-ENCRYPTS each
// high-tier value and card number (AES-256-GCM, via the production `encryptValue`
// seam) so the server only ever receives ciphertext. It is the inverse of
// src/client/vault/export.ts.
//
// Unlike the export build (which rejects the whole section if any one value fails
// to unwrap), an import re-protects what it can and reports the rest: a value that
// cannot be read from the export is reported in `failed` and SKIPPED — never
// re-encrypted, never included in the upload payload, never posted as plaintext.
// One unreadable value never aborts the others.
//
// An absent vault key is a precondition failure (the vault must be unlocked to
// re-protect anything), so it REJECTS and produces no ciphertext — never a
// plaintext fallback (mirrors the export seam).
//
// It is a purely local transform over the `encryptValue` seam: it issues no
// network request and writes nothing to client storage or the console — the only
// output is the ciphertext-only `sealed` payload the caller posts to the server.

import { encryptValue } from "./values";

// The export's plaintext `deviceProtected` section (the E16-S01 schema shape,
// src/server/export/schema.ts): `value` / `number` are plaintext.
export interface PlaintextHighTierField {
  type: string;
  label: string;
  value: string;
}
export interface PlaintextCard {
  expiryMonth?: number;
  expiryYear?: number;
  cardholderName?: string | null;
  billingAddressId?: string;
  brand: string;
  lastFour: string;
  nickname: string;
  number: string;
}
export interface DeviceProtectedSection {
  highTierFields: PlaintextHighTierField[];
  cards: PlaintextCard[];
}

// The ciphertext-only upload shapes (the server's own import upload records): the
// plaintext metadata carried through unchanged, each value replaced by its `v1:`
// envelope sealed under the importing VK.
export interface SealedHighTierField {
  type: string;
  label: string;
  ciphertext: string;
}
export interface SealedCard {
  expiryMonth?: number;
  expiryYear?: number;
  cardholderName?: string | null;
  billingAddressId?: string;
  brand: string;
  lastFour: string;
  nickname: string;
  numberCiphertext: string;
}
export interface SealedDeviceProtected {
  highTierFields: SealedHighTierField[];
  cards: SealedCard[];
}

// A value that could not be read from the export — reported and skipped, never
// uploaded. `label` identifies which value it was so the person knows what to
// re-enter by hand.
export interface ReprotectFailure {
  kind: "highTierField" | "card";
  label: string;
}

export interface ReprotectResult {
  sealed: SealedDeviceProtected;
  failed: ReprotectFailure[];
}

// A value is readable only when it is actually a string. An absent (`undefined`),
// `null`, or non-string value "cannot be read": encrypting it would seal a bogus
// coerced string, so it is reported and skipped instead.
function isReadable(value: unknown): value is string {
  return typeof value === "string";
}

// A human label for a card in a failure report — the person's own nickname when
// present, else the brand and last four they'd recognise it by.
function cardLabel(card: { brand?: unknown; lastFour?: unknown; nickname?: unknown }): string {
  if (typeof card.nickname === "string" && card.nickname.length > 0) {
    return card.nickname;
  }
  const brand = typeof card.brand === "string" ? card.brand : "card";
  const lastFour = typeof card.lastFour === "string" ? card.lastFour : "";
  return lastFour ? `${brand} ending ${lastFour}` : brand;
}

// Re-protect the plaintext device-protected section under the importing account's
// unlocked vault key. Resolves with `sealed` (the ciphertext-only upload payload:
// each readable value re-encrypted under the importing VK with a fresh nonce,
// metadata and order preserved) and `failed` (every value that could not be read,
// reported and skipped). Rejects — producing no ciphertext — when the vault key is
// absent, so there is never a plaintext fallback.
export async function reprotectDeviceProtected(
  vaultKey: Uint8Array<ArrayBuffer> | null | undefined,
  section: DeviceProtectedSection,
): Promise<ReprotectResult> {
  if (!vaultKey) {
    throw new Error("the vault must be unlocked to re-protect the device-protected import section");
  }

  const failed: ReprotectFailure[] = [];

  const highTierFields: SealedHighTierField[] = [];
  for (const field of section.highTierFields) {
    if (!isReadable(field.value)) {
      failed.push({ kind: "highTierField", label: field.label });
      continue;
    }
    highTierFields.push({
      type: field.type,
      label: field.label,
      ciphertext: await encryptValue(vaultKey, field.value),
    });
  }

  const cards: SealedCard[] = [];
  for (const card of section.cards) {
    if (!isReadable(card.number)) {
      failed.push({ kind: "card", label: cardLabel(card) });
      continue;
    }
    cards.push({
      brand: card.brand,
      lastFour: card.lastFour,
      nickname: card.nickname,
      ...(card.expiryMonth !== undefined ? { expiryMonth: card.expiryMonth } : {}),
      ...(card.expiryYear !== undefined ? { expiryYear: card.expiryYear } : {}),
      ...(card.cardholderName !== undefined ? { cardholderName: card.cardholderName } : {}),
      ...(card.billingAddressId !== undefined ? { billingAddressId: card.billingAddressId } : {}),
      numberCiphertext: await encryptValue(vaultKey, card.number),
    });
  }

  return { sealed: { highTierFields, cards }, failed };
}
