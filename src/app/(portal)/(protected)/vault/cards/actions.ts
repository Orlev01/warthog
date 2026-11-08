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
import type { Db } from "@/server/db/index";
import { getUserById } from "@/server/db/users";
import { listIdentityFields } from "@/server/db/identity-fields";
import {
  addCard as addCardRow,
  listCards,
  removeCard as removeCardRow,
  type CardMetadata,
} from "@/server/db/cards";
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
}

// A billing-address choice the add-card picker offers — a postal-address low-tier
// field, decrypted ({ id, value }), exactly the <CardsView/> `VaultAddress` shape.
export interface BillingAddress {
  readonly id: string;
  readonly value: string;
}

// What `load` returns — the owner's cards as METADATA ONLY plus their billing-address
// choices, the two props <CardsView/> is mounted over.
export interface CardsViewData {
  readonly cards: CardMetadata[];
  readonly billingAddresses: BillingAddress[];
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
  readonly billingAddressId: string;
  readonly numberCiphertext: string;
}

// Remove one of the session person's own cards by id.
export interface RemoveCardInput {
  readonly cardId: string;
}

export interface CardsActions {
  load(session: Session): Promise<CardsViewData>;
  addCard(session: Session, input: AddCardInput): Promise<ActionResult>;
  removeCard(session: Session, input: RemoveCardInput): Promise<ActionResult>;
}

// ---- boundary validation shapes (INV-102) -----------------------------------------
//
// A brand / nickname is bounded free text (a grossly oversized one is rejected); the
// last four is exactly four digits; the device number ciphertext is a short opaque `v1:`
// envelope, capped well above any genuine one. The billing-address reference and the
// card id are uuids (identity_fields.id / cards.id — db/migrations), shape-guarded so a
// non-uuid never reaches `WHERE id = $1` as a cast (OBS-049). The object schemas STRIP
// unknown keys (zod's default), so a smuggled `securityCode` or `userId` is dropped and
// reaches no column rather than being rejected.
const BRAND_MAX = 256;
const NICKNAME_MAX = 256;
const CIPHERTEXT_MAX = 64 * 1024;

const addCardSchema = z.object({
  brand: z.string().min(1).max(BRAND_MAX),
  // Exactly four digits, so a full card number can never land in the plaintext column.
  lastFour: z.string().regex(/^\d{4}$/),
  expiryMonth: z.number().int(),
  expiryYear: z.number().int(),
  nickname: z.string().min(1).max(NICKNAME_MAX),
  billingAddressId: z.uuid(),
  // A sealed device envelope (`v1:` …), never a plaintext number stored as "ciphertext".
  numberCiphertext: z.string().min(1).max(CIPHERTEXT_MAX).regex(/^v1:/),
});
const removeCardSchema = z.object({
  cardId: z.uuid(),
});

export function createCardsActions(deps: CardsActionsDeps): CardsActions {
  const { db, keyWrapper } = deps;

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

  // Read ONLY the session person's cards (metadata) and their postal addresses (the
  // billing-address choices, decrypted under their DEK). Member-scoped by
  // `session.userId` — another person's cards/addresses never appear.
  async function load(session: Session): Promise<CardsViewData> {
    const cards = await listCards(db, session.userId);
    const dek = await dataKeyFor(session.userId);
    const fields = await listIdentityFields(db, session.userId, dek);
    const billingAddresses = fields
      .filter((field) => field.kind === "postal_address")
      .map((field) => ({ id: field.id, value: field.value }));
    return { cards, billingAddresses };
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
    await addCardRow(db, {
      userId: session.userId,
      brand: valid.brand,
      lastFour: valid.lastFour,
      expiryMonth: valid.expiryMonth,
      expiryYear: valid.expiryYear,
      nickname: valid.nickname,
      billingAddressId: valid.billingAddressId,
      numberCiphertext: valid.numberCiphertext,
    });
    return { ok: true };
  }

  // Remove ONE of the session person's own cards by id. Validate at the boundary (a
  // malformed id is a 4xx before any query, OBS-049), then DELETE scoped to this person
  // — a card that is not theirs (or does not exist) matches nothing and removes nothing
  // ({ ok: false }).
  async function removeCard(session: Session, input: RemoveCardInput): Promise<ActionResult> {
    const valid = parseParams(removeCardSchema, input);
    const removed = await removeCardRow(db, session.userId, valid.cardId);
    return removed ? { ok: true } : { ok: false, reason: "not_found" };
  }

  return { load, addCard, removeCard };
}
