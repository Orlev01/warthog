// The household's own data key for shared household content (brief "Household sharing";
// design §4.1; migration 0058).
//
// Shared household content — today the one shared postal address — is encrypted under a
// random 256-bit key that belongs to the HOUSEHOLD, stored only wrapped by the KEK on the
// households row (exactly like a person's `users.wrapped_dek`). It used to be encrypted
// under the owner's DEK, which broke on every ownership transfer (the new owner's DEK
// could not read it, and the old owner deleting their account destroyed it), and made
// every member's read unwrap the owner's WHOLE DEK. With a household key a transfer needs
// no crypto work and no member ever unwraps another member's key.
//
// Two entry points:
//   • `sharedAddressKeyFor` — the key to READ shared content with. The household key
//     when it has one; for a household created before household keys existed, the
//     current owner's DEK, which is what its content is still encrypted under. Reads
//     never create a key.
//   • `ensureHouseholdKey` — the key to WRITE with, creating it on first use. Creating it
//     re-encrypts any existing shared address from the current owner's DEK to the new key
//     in the SAME transaction that stores the key, so content and key commit together.
//     Every write path (an edit, accepting a transfer, creating a household) calls this,
//     so content never stays under a person's key past the next change of owner.
//
// The caller resolves the household FROM the session user id first (member scope); every
// statement binds its ids (INV-102). This module reads no `process.env` and holds no key
// (INV-103): the db, the KeyWrapper and the random source are INJECTED.

import type { KeyWrapper } from "../crypto/key-wrapper";
import type { Db } from "../db/index";
import { withTransaction } from "../db/index";
import { claimHouseholdWrappedKey, getHouseholdWrappedKey } from "../db/households";
import { reencryptSharedAddress } from "../db/household-shared-address";
import { getUserById } from "../db/users";
import type { Random } from "../seams/random";

// A 256-bit data key, the same size as a person's DEK.
const HOUSEHOLD_KEY_BYTES = 32;

export interface HouseholdKeyReadDeps {
  readonly db: Db;
  readonly keyWrapper: KeyWrapper;
}

export interface HouseholdKeyDeps extends HouseholdKeyReadDeps {
  readonly random: Random;
}

// A person's unwrapped DEK (throws when they have no row — never a silent fallback).
async function personDek(db: Db, keyWrapper: KeyWrapper, userId: string): Promise<Uint8Array> {
  const user = await getUserById(db, userId);
  if (!user) {
    throw new Error("household key: the household owner has no user row");
  }
  return keyWrapper.unwrap(user.wrappedDek);
}

// The key the household's shared content is currently encrypted under: its own household
// key, or — for a household that predates household keys and has not been written since —
// the current owner's DEK. `ownerId` is the household's current owner as the caller read it.
export async function sharedAddressKeyFor(
  household: { id: string; ownerId: string },
  deps: HouseholdKeyReadDeps,
): Promise<Uint8Array> {
  const { db, keyWrapper } = deps;
  const wrapped = await getHouseholdWrappedKey(db, household.id);
  if (wrapped != null) return keyWrapper.unwrap(wrapped);
  return personDek(db, keyWrapper, household.ownerId);
}

// The household's data key, created (and any existing shared address re-encrypted under
// it) when the household has none yet. Safe under concurrency: the first claim wins and a
// losing caller reads back the winner's key.
export async function ensureHouseholdKey(householdId: string, deps: HouseholdKeyDeps): Promise<Uint8Array> {
  const { db, keyWrapper, random } = deps;
  const existing = await getHouseholdWrappedKey(db, householdId);
  if (existing != null) return keyWrapper.unwrap(existing);

  const key = random.randomBytes(HOUSEHOLD_KEY_BYTES);
  const wrapped = await keyWrapper.wrap(key);
  const claimed = await withTransaction(db, async (tx) => {
    const claim = await claimHouseholdWrappedKey(tx, householdId, wrapped);
    if (!claim) return false;
    // The claim locked the household row, so the owner it returned is the one whose DEK
    // any pre-existing shared address is encrypted under.
    const ownerDek = await personDek(tx, keyWrapper, claim.ownerId);
    await reencryptSharedAddress(tx, householdId, ownerDek, key);
    return true;
  });
  if (claimed) return key;

  const winner = await getHouseholdWrappedKey(db, householdId);
  if (winner == null) {
    throw new Error("household key: the household does not exist");
  }
  return keyWrapper.unwrap(winner);
}
