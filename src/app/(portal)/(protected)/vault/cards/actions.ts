// E11-S16 — Vault cards page loader + actions (the injectable, unit-testable seam
// the thin `page.tsx` composes — the convention's `createXActions(deps)` factory, as
// the sibling identity `vault/actions.ts`, `connectors/actions.ts` and
// `settings/security/actions.ts` do). A Next entry file may export only its framework
// fields, so the cards-triad logic lives here and the entry stays thin (OBS-025).
//
// The cards triad is the "Add a card" surface (brief "Identity vault"; constitution
// §17 "No readable card numbers or security codes"; design §4.2 device-held vault).
// `load` reads the SESSION person's cards server-side — as METADATA ONLY (brand, last
// four, expiry, nickname, billing reference; never the number or its ciphertext) — and
// the person's postal addresses (DEK-decrypted) as the billing-address choices, then
// shapes both into the already-render-tested <CardsView/>'s props (E11-S14). The
// actions persist a new card and remove one, with the card NUMBER arriving ONLY as
// device ciphertext, gated by an unlock method existing, and NEVER a security code.
//
// Security (each a reviewer veto; CLAUDE.md + the safety invariants):
//   • Every read/write is member-scoped by `session.userId` — the session's verified
//     id, NEVER a value smuggled in the input. `load` reads only the session person;
//     every mutation is scoped by `user_id`, so another person's card id matches
//     nothing and changes nothing (a safe refusal, never a silent write).
//   • The card number arrives ONLY as device ciphertext (design §4.2: the server holds
//     no vault key and never decrypts), and NO security code is ever persisted (§17):
//     the schema reads only its named fields, so a smuggled `securityCode` (or a
//     smuggled `userId`) is stripped and reaches no column. A save is REFUSED via the
//     reused vault unlock gate (`assertVaultUnlockable`) when the account has no unlock
//     method set — the gate treats a recovery code alone as insufficient.
//   • Input is validated at the boundary (INV-102): a malformed / oversized / mis-shaped
//     body is refused with a 4xx `HttpError` BEFORE any query, so nothing is written. A
//     malformed card id is rejected at the boundary (OBS-049) before it can reach
//     `WHERE id = $1` as a cast. Every value reaches storage bound as a query
//     parameter, so a value shaped like SQL is stored as data and cannot alter a query.
//   • This module reads no `process.env` and holds no secret (INV-103): the db and the
//     KeyWrapper are INJECTED seams, so no ambient env value can surface in the loaded
//     screen or a stored row.

import { z } from "zod";

import { parseParams } from "@/server/http/validate";
import { withTransaction, type Db } from "@/server/db/index";
import { getUserById } from "@/server/db/users";
import { listIdentityFields } from "@/server/db/identity-fields";
import {
  addCard as addCardRow,
  listCards,
  removeCard as removeCardRow,
  setCardBilling,
  type CardMetadata,
} from "@/server/db/cards";
import { deleteCardBillingAddressIfUnused } from "@/server/db/card-billing-addresses";
import {
  applyBillingSelection,
  listBillingChoices,
  lockCardBilling,
  resolveCardBilling,
  type BillingChoice,
  type BillingSelection,
  type ResolvedBilling,
} from "@/server/vault/card-billing";
import { systemClock, type Clock } from "@/server/seams/clock";
import { createVaultUnlockActions } from "@/server/vault/unlock";
import { systemRandom } from "@/server/seams/random";
import type { KeyWrapper } from "@/server/crypto/key-wrapper";
import type { Session } from "@/server/auth/session";

// The injected seams — no process.env, no secret (INV-103). `db` is the parameterizing
// database seam; `keyWrapper` unwraps the session person's own DEK (from
// users.wrapped_dek) so their postal addresses can be decrypted into billing choices.
export interface CardsActionsDeps {
  readonly db: Db;
  readonly keyWrapper: KeyWrapper;
  // Decides which postal addresses are still upcoming moves (never offered as a default).
  readonly clock?: Clock;
}

// A billing-address choice the card screens offer: one of the person's About you postal
// addresses or one of their card-only addresses (docs/adr/card-billing-addresses.md).
export type BillingAddress = BillingChoice;

// A saved card as the page shows it: its metadata plus the billing address it resolves to (or
// null when it has none yet).
export type CardView = CardMetadata & { readonly billing: ResolvedBilling | null };

// What `load` returns — the owner's cards as METADATA ONLY plus their billing-address
// choices, the props <CardsView/> is mounted over, and the person's saved name from About
// you, which pre-fills the add form's "Name on card" ("" when they have not saved one —
// review fix W6).
export interface CardsViewData {
  readonly cards: CardView[];
  readonly billingAddresses: BillingAddress[];
  readonly defaultCardholderName: string;
}

// Every mutation reports its outcome — success, or a refusal naming its reason (the
// unlock gate is closed, or the card is not this person's). Never a silent success
// (conventions: a server action reports success, the refusal reason, or a 4xx).
export type ActionResult = { readonly ok: true } | { readonly ok: false; readonly reason: string };

// A NEW card submission (the device-seal step's output): the plaintext metadata plus
// the device-produced number ciphertext. The owner is taken from the session, never
// from this input; a security code is never part of it.
export interface AddCardInput {
  readonly brand: string;
  readonly lastFour: string;
  readonly expiryMonth: number;
  readonly expiryYear: number;
  readonly nickname: string;
  // The name on the card: printed on it, so plaintext metadata like the expiry (W6).
  readonly cardholderName: string;
  // The card's billing address: one of the person's postal addresses, one of their card-only
  // addresses, or a new address typed for their cards. `billingAddressId` is the older form (a
  // postal address id) still accepted from a page loaded before this change.
  readonly billing?: BillingSelection;
  readonly billingAddressId?: string;
  readonly numberCiphertext: string;
}

// Remove one of the session person's own cards by id.
export interface RemoveCardInput {
  readonly cardId: string;
}

// Give one of the session person's saved cards a different billing address.
export interface ChangeBillingInput {
  readonly cardId: string;
  readonly billing: BillingSelection;
}

export interface CardsActions {
  load(session: Session): Promise<CardsViewData>;
  addCard(session: Session, input: AddCardInput): Promise<ActionResult>;
  removeCard(session: Session, input: RemoveCardInput): Promise<ActionResult>;
  changeBillingAddress(session: Session, input: ChangeBillingInput): Promise<ActionResult>;
}

// ---- boundary validation shapes (INV-102) -----------------------------------------
//
// A brand / nickname / name on the card is bounded free text (a grossly oversized one is
// rejected; the name on the card is trimmed and must not be blank); the
// last four is exactly four digits; the device number ciphertext is a short opaque `v1:`
// envelope, capped well above any genuine one. The billing-address reference and the
// card id are uuids (identity_fields.id / cards.id — db/migrations), shape-guarded so a
// non-uuid never reaches `WHERE id = $1` as a cast (OBS-049). The object schemas STRIP
// unknown keys (zod's default), so a smuggled `securityCode` or `userId` is dropped and
// reaches no column rather than being rejected.
const BRAND_MAX = 256;
const NICKNAME_MAX = 256;
const CARDHOLDER_NAME_MAX = 256;
const CIPHERTEXT_MAX = 64 * 1024;
// The same bound as an About you postal address, so a release always fits its size cap.
export const BILLING_ADDRESS_MAX = 4096;

const billingSchema = z.discriminatedUnion("source", [
  z.object({ source: z.literal("postal"), id: z.uuid() }),
  z.object({ source: z.literal("billing"), id: z.uuid() }),
  z.object({ source: z.literal("new"), value: z.string().trim().min(1).max(BILLING_ADDRESS_MAX) }),
]);

const addCardSchema = z.object({
  brand: z.string().min(1).max(BRAND_MAX),
  // Exactly four digits, so a full card number can never land in the plaintext column.
  lastFour: z.string().regex(/^\d{4}$/),
  expiryMonth: z.number().int(),
  expiryYear: z.number().int(),
  nickname: z.string().min(1).max(NICKNAME_MAX),
  cardholderName: z.string().trim().min(1).max(CARDHOLDER_NAME_MAX),
  billing: billingSchema.optional(),
  billingAddressId: z.uuid().optional(),
  // A sealed device envelope (`v1:` …), never a plaintext number stored as "ciphertext".
  numberCiphertext: z.string().min(1).max(CIPHERTEXT_MAX).regex(/^v1:/),
}).refine((value) => (value.billing === undefined) !== (value.billingAddressId === undefined), {
  message: "Give exactly one billing address",
});
const removeCardSchema = z.object({
  cardId: z.uuid(),
});
const changeBillingSchema = z.object({
  cardId: z.uuid(),
  billing: billingSchema,
});

// A billing reference that isn't the person's own address (or is no longer saved).
const BILLING_NOT_FOUND = { ok: false, reason: "billing_address_not_found" } as const;

export function createCardsActions(deps: CardsActionsDeps): CardsActions {
  const { db, keyWrapper } = deps;
  const clock = deps.clock ?? systemClock;

  // Reuse the vault unlock gate (one source of truth for the policy): a card save is
  // allowed only when the person has a PRF-passkey or a passphrase — a recovery code
  // alone is insufficient. The gate's "save_protected" question never draws entropy,
  // so the real `systemRandom` is passed and never invoked.
  const vaultGate = createVaultUnlockActions({ db, random: systemRandom });

  // Resolve the session person's unwrapped 256-bit DEK: read their wrapped DEK (bound
  // by userId) and unwrap it through the injected KeyWrapper. Throws when the person
  // has no row (never fails silently) — the page-data idiom shared with identity.
  async function dataKeyFor(userId: string): Promise<Uint8Array> {
    const user = await getUserById(db, userId);
    if (!user) {
      throw new Error("createCardsActions: no data key for this user");
    }
    return keyWrapper.unwrap(user.wrappedDek);
  }

  // Read ONLY the session person's cards (metadata), their postal addresses (the
  // billing-address choices, decrypted under their DEK) and their saved name (the
  // "Name on card" default). Member-scoped by `session.userId` — another person's
  // cards/addresses/name never appear.
  async function load(session: Session): Promise<CardsViewData> {
    const cards = await listCards(db, session.userId);
    const dek = await dataKeyFor(session.userId);
    const fields = await listIdentityFields(db, session.userId, dek);
    const resolved = await resolveCardBilling(db, session.userId, cards, dek, { identityFields: fields });
    const billingAddresses = await listBillingChoices(db, session.userId, dek, clock.now(), cards, { identityFields: fields });
    const defaultCardholderName = fields.find((field) => field.kind === "name")?.value ?? "";
    return {
      cards: cards.map((card) => ({ ...card, billing: resolved.get(card.id) ?? null })),
      billingAddresses,
      defaultCardholderName,
    };
  }

  // Store a NEW card for the session person — ONLY the device ciphertext plus the
  // plaintext metadata (the server holds no key and stores no security code). Validate
  // at the boundary first (a 4xx before any write; a smuggled securityCode/userId is
  // stripped), then refuse via the unlock gate when the account has no unlock method
  // set (nothing is stored). The owner is the session's id, never a client value.
  async function addCard(session: Session, input: AddCardInput): Promise<ActionResult> {
    const valid = parseParams(addCardSchema, input);
    const gate = await vaultGate.assertVaultUnlockable(session.userId, { action: "save_protected" });
    if (!gate.ok) return gate;
    const selection: BillingSelection = valid.billing ?? { source: "postal", id: valid.billingAddressId! };
    // The data key is needed only to keep a new card-only address; unwrap it before the
    // transaction (an unwrap can be slow).
    const dek = selection.source === "new" ? await dataKeyFor(session.userId) : new Uint8Array();
    return withTransaction(db, async (tx) => {
      await lockCardBilling(tx, session.userId);
      // Only the person's own address of the right kind (or a new one) can be a card's billing
      // address; anything else saves nothing.
      const ref = await applyBillingSelection(tx, session.userId, selection, dek);
      if (!ref) return BILLING_NOT_FOUND;
      await addCardRow(tx, {
        userId: session.userId,
        brand: valid.brand,
        lastFour: valid.lastFour,
        expiryMonth: valid.expiryMonth,
        expiryYear: valid.expiryYear,
        nickname: valid.nickname,
        cardholderName: valid.cardholderName,
        billingAddressId: ref.billingAddressId,
        billingEntryId: ref.billingEntryId,
        numberCiphertext: valid.numberCiphertext,
      });
      return { ok: true } as const;
    });
  }

  // Give one of the session person's cards a different billing address. The card number is
  // not involved, so no vault unlock is needed (the same as editing a postal address). A
  // card-only address the card no longer uses is deleted if no other card uses it.
  async function changeBillingAddress(session: Session, input: ChangeBillingInput): Promise<ActionResult> {
    const valid = parseParams(changeBillingSchema, input);
    const selection = valid.billing as BillingSelection;
    const dek = selection.source === "new" ? await dataKeyFor(session.userId) : new Uint8Array();
    return withTransaction(db, async (tx) => {
      await lockCardBilling(tx, session.userId);
      // The card must be this person's before anything is created for it.
      const owned = await tx.query(`SELECT 1 FROM cards WHERE id = $1 AND user_id = $2`, [valid.cardId, session.userId]);
      if (owned.rows.length === 0) return { ok: false, reason: "not_found" } as const;
      const ref = await applyBillingSelection(tx, session.userId, selection, dek);
      if (!ref) return BILLING_NOT_FOUND;
      const changed = await setCardBilling(tx, session.userId, valid.cardId, ref);
      if (!changed) return { ok: false, reason: "not_found" } as const;
      if (changed.previousEntryId && changed.previousEntryId !== ref.billingEntryId) {
        await deleteCardBillingAddressIfUnused(tx, session.userId, changed.previousEntryId);
      }
      return { ok: true } as const;
    });
  }

  // Remove ONE of the session person's own cards by id. Validate at the boundary (a
  // malformed id is a 4xx before any query, OBS-049), then DELETE scoped to this person
  // — a card that is not theirs (or does not exist) matches nothing and removes nothing
  // ({ ok: false }).
  async function removeCard(session: Session, input: RemoveCardInput): Promise<ActionResult> {
    const valid = parseParams(removeCardSchema, input);
    return withTransaction(db, async (tx) => {
      await lockCardBilling(tx, session.userId);
      const before = await tx.query(`SELECT billing_entry_id FROM cards WHERE id = $1 AND user_id = $2`, [valid.cardId, session.userId]);
      const removed = await removeCardRow(tx, session.userId, valid.cardId);
      if (!removed) return { ok: false, reason: "not_found" } as const;
      // A card-only billing address exists only while a card uses it.
      const entryId = (before.rows[0]?.billing_entry_id as string | null | undefined) ?? null;
      if (entryId) await deleteCardBillingAddressIfUnused(tx, session.userId, entryId);
      return { ok: true } as const;
    });
  }

  return { load, addCard, removeCard, changeBillingAddress };
}
