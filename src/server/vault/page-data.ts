// E11-S12 — Vault page-data read (list-all) (brief "Identity vault"; design §4.1
// low-tier + §4.2 device-held vault).
//
// The Vault pages need ONE owner-scoped read that sees every field and card
// regardless of tier: the low-tier values DECRYPTED, the high-tier fields as
// METADATA only (label/type, never the value or its ciphertext), the saved cards
// as METADATA only (brand + last four, never the number or its ciphertext) and
// which unlock methods are set (never the wrapped key). This list-all read is
// distinct from any agent-facing filter (get_context) and never returns another
// person's data.
//
// It COMPOSES the already-built stores — `identity-fields` (low tier,
// DEK-decrypted), `high-tier-fields` (metadata only), `cards` (metadata only) and
// `vault-unlock-methods` (`listMethods`) — and adds NO SQL and NO crypto of its
// own. Like the agent policy-context loader it resolves the person's DEK through
// the injected `KeyWrapper` seam (read the wrapped DEK from `users.wrapped_dek`,
// unwrap it) so it can decrypt the low-tier values; it reads no `process.env` and
// holds no key (INV-103). Every read is member-scoped by the session's `userId`,
// never a client value, and each underlying store binds its ids as parameters, so
// an id shaped like SQL travels as data and cannot alter a query (INV-102).

import { listCards, type CardMetadata } from "../db/cards";
import {
  listHighTierFields,
  type HighTierFieldMetadata,
} from "../db/high-tier-fields";
import {
  listIdentityFields,
  type IdentityField,
} from "../db/identity-fields";
import type { Db } from "../db/index";
import { getUserById } from "../db/users";
import {
  listMethods,
  type UnlockMethod,
} from "../db/vault-unlock-methods";
import type { KeyWrapper } from "../crypto/key-wrapper";

// The injected seams — no process.env. `db` is the parameterizing database seam;
// `keyWrapper` unwraps the person's DEK (from users.wrapped_dek) to decrypt the
// low-tier values.
export interface VaultPageDataDeps {
  readonly db: Db;
  readonly keyWrapper: KeyWrapper;
}

// The owner-scoped list-all the Vault pages render.
export interface VaultPageData {
  // The owner's low-tier fields, values DECRYPTED (exactly what listIdentityFields
  // returns).
  readonly lowTierFields: IdentityField[];
  // The owner's high-tier fields as METADATA ONLY — label + type + tier, never the
  // value or its ciphertext (exactly what listHighTierFields returns).
  readonly highTierFields: HighTierFieldMetadata[];
  // The owner's saved cards as METADATA ONLY — brand + last four (+ expiry,
  // nickname, billing-address ref), never the number or its ciphertext (exactly
  // what listCards returns).
  readonly cards: CardMetadata[];
  // Which unlock methods have a wrapped key set (exactly what listMethods returns)
  // — never the wrapped key itself.
  readonly unlockMethods: UnlockMethod[];
}

// Resolve the person's unwrapped 256-bit DEK: read their wrapped DEK (bound by
// userId through the users store) and unwrap it through the KeyWrapper seam.
// Throws when the person has no row (never fails silently) — the totp-store /
// agent-context idiom.
async function dataKeyFor(
  db: Db,
  keyWrapper: KeyWrapper,
  userId: string,
): Promise<Uint8Array> {
  const user = await getUserById(db, userId);
  if (!user) {
    throw new Error("loadVaultPageData: no data key for this user");
  }
  return keyWrapper.unwrap(user.wrappedDek);
}

// Assemble the four owner-scoped parts for `userId` (the session's id, NEVER a
// client value): the low-tier values decrypted under the person's resolved DEK,
// the high-tier fields as metadata only, the cards as metadata only, and the set
// of unlock methods present. Every read is member-scoped by `userId`.
export async function loadVaultPageData(
  deps: VaultPageDataDeps,
  userId: string,
): Promise<VaultPageData> {
  const { db, keyWrapper } = deps;

  // Resolve the person's data key first (the low-tier read needs it to decrypt the
  // values; the member-scoped lookup also binds `userId` as a parameter).
  const dek = await dataKeyFor(db, keyWrapper, userId);

  const lowTierFields = await listIdentityFields(db, userId, dek);
  const highTierFields = await listHighTierFields(db, userId);
  const cards = await listCards(db, userId);
  const unlockMethods = await listMethods(db, userId);

  return { lowTierFields, highTierFields, cards, unlockMethods };
}
