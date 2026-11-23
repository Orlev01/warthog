// A card's billing address: the one place a card's billing reference is checked and turned
// into text (docs/adr/card-billing-addresses.md; migration 0123).
//
// A card's billing address is EITHER one of the owner's About you postal addresses
// (`cards.billing_address_id`, an identity field) OR an address kept with their cards only
// (`cards.billing_entry_id`, card_billing_addresses). Card-only addresses are never listed as
// identity fields, so agents never read them as everyday details; like the rest of the card, an
// agent receives the text only inside a card release the person approves.
//
// Every read and write is member-scoped by the session's user id. A reference that is not the
// person's own address of the right kind resolves to nothing and can never be saved.

import {
  listCardBillingAddresses,
  ownsCardBillingAddress,
  saveCardBillingAddress,
} from "../db/card-billing-addresses";
import type { CardMetadata } from "../db/cards";
import { listIdentityFields, type IdentityField } from "../db/identity-fields";
import type { Db } from "../db/index";

export type BillingSource = "postal" | "billing";

// What the person chose for a card: one of their postal addresses, one of their card-only
// addresses, or a new address typed for their cards.
export type BillingSelection =
  | { readonly source: "postal"; readonly id: string }
  | { readonly source: "billing"; readonly id: string }
  | { readonly source: "new"; readonly value: string };

export interface ResolvedBilling {
  readonly text: string;
  readonly source: BillingSource;
}

// One address the person can choose for a card.
export interface BillingChoice {
  readonly id: string;
  readonly value: string;
  readonly source: BillingSource;
  // A postal address the person is moving to, not yet current (it is never the default).
  readonly upcoming: boolean;
  readonly movingOn: string | null;
  // The nicknames of the cards that use this address.
  readonly usedBy: readonly string[];
}

export interface BillingRef {
  readonly billingAddressId: string | null;
  readonly billingEntryId: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// A moving-on date takes effect at the start of its day (domain/address/moving.ts).
function isUpcoming(movingOn: Date | string | null, now: Date): boolean {
  if (movingOn === null) return false;
  const day = typeof movingOn === "string" ? movingOn.slice(0, 10) : movingOn.toISOString().slice(0, 10);
  const starts = new Date(`${day}T00:00:00Z`).getTime();
  return Number.isFinite(starts) && now.getTime() < starts;
}

function movingOnText(movingOn: Date | string | null): string | null {
  if (movingOn === null) return null;
  return typeof movingOn === "string" ? movingOn.slice(0, 10) : movingOn.toISOString().slice(0, 10);
}

// The billing text of each card, by card id: the owner's postal address or card-only address it
// points at, or null when it has none or the reference doesn't resolve to one of theirs. Pass the
// person's already-decrypted identity fields to avoid decrypting them twice.
export async function resolveCardBilling(
  db: Db,
  userId: string,
  cards: readonly CardMetadata[],
  dek: Uint8Array,
  options: { readonly identityFields?: readonly IdentityField[] } = {},
): Promise<Map<string, ResolvedBilling | null>> {
  const out = new Map<string, ResolvedBilling | null>();
  if (cards.length === 0) return out;
  const fields = options.identityFields ?? (await listIdentityFields(db, userId, dek));
  const postal = new Map(
    fields.filter((f) => f.userId === userId && f.kind === "postal_address").map((f) => [f.id, f.value] as const),
  );
  const needsEntries = cards.some((c) => c.billingEntryId !== null);
  const entries = needsEntries ? new Map((await listCardBillingAddresses(db, userId, dek)).map((e) => [e.id, e.value] as const)) : new Map<string, string>();
  for (const card of cards) {
    if (card.billingEntryId !== null) {
      const text = entries.get(card.billingEntryId);
      out.set(card.id, text === undefined ? null : { text, source: "billing" });
    } else if (card.billingAddressId !== null) {
      const text = postal.get(card.billingAddressId);
      out.set(card.id, text === undefined ? null : { text, source: "postal" });
    } else {
      out.set(card.id, null);
    }
  }
  return out;
}

// Every address the person can choose for a card: current postal addresses first, then
// card-only addresses (with the cards that use them), then addresses they're moving to.
export async function listBillingChoices(
  db: Db,
  userId: string,
  dek: Uint8Array,
  now: Date,
  cards: readonly CardMetadata[],
  options: { readonly identityFields?: readonly IdentityField[] } = {},
): Promise<BillingChoice[]> {
  const fields = options.identityFields ?? (await listIdentityFields(db, userId, dek));
  const usedBy = (pick: (c: CardMetadata) => string | null, id: string) =>
    cards.filter((c) => pick(c) === id).map((c) => c.nickname);
  const postal = fields
    .filter((f) => f.userId === userId && f.kind === "postal_address")
    .map<BillingChoice>((f) => ({
      id: f.id,
      value: f.value,
      source: "postal",
      upcoming: isUpcoming(f.movingOn, now),
      movingOn: movingOnText(f.movingOn),
      usedBy: usedBy((c) => c.billingAddressId, f.id),
    }));
  const billing = (await listCardBillingAddresses(db, userId, dek)).map<BillingChoice>((e) => ({
    id: e.id,
    value: e.value,
    source: "billing",
    upcoming: false,
    movingOn: null,
    usedBy: usedBy((c) => c.billingEntryId, e.id),
  }));
  return [...postal.filter((c) => !c.upcoming), ...billing, ...postal.filter((c) => c.upcoming)];
}

// Serialise billing changes for one person (adding a card, changing a card's address, removing
// a card), so an address is never deleted while another request is pointing a card at it.
export async function lockCardBilling(tx: Db, userId: string): Promise<void> {
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`card-billing:${userId}`]);
}

// Turn the person's choice into a card's billing reference, inside the caller's transaction:
// their own postal address, their own card-only address, or a new card-only address (an
// identical one is reused rather than duplicated). Null when the reference isn't theirs or isn't
// an address; nothing is written then.
export async function applyBillingSelection(
  tx: Db,
  userId: string,
  selection: BillingSelection,
  dek: Uint8Array,
): Promise<BillingRef | null> {
  if (selection.source === "postal") {
    if (!UUID.test(selection.id)) return null;
    const found = await tx.query(
      `SELECT 1 FROM identity_fields WHERE id = $1 AND user_id = $2 AND kind = 'postal_address'`,
      [selection.id, userId],
    );
    return found.rows.length > 0 ? { billingAddressId: selection.id, billingEntryId: null } : null;
  }
  if (selection.source === "billing") {
    return (await ownsCardBillingAddress(tx, userId, selection.id)) ? { billingAddressId: null, billingEntryId: selection.id } : null;
  }
  const value = selection.value.trim();
  if (value.length === 0) return null;
  const existing = (await listCardBillingAddresses(tx, userId, dek)).find((e) => e.value === value);
  if (existing) return { billingAddressId: null, billingEntryId: existing.id };
  const saved = await saveCardBillingAddress(tx, { userId, value }, dek);
  return { billingAddressId: null, billingEntryId: saved.id };
}
