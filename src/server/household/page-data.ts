// E15-S12 — Household page-data read (list-all) (brief "Household sharing" +
// access.who_can_use; design §4.1).
//
// The Household page needs ONE member-scoped read that sees the SHARED household items —
// the shared address, the household currency, the shared budget and the member list —
// without exposing any other member's private data (vault, cards, spending, memory,
// skills, agents or activity). It is distinct from the per-person reads and returns
// nothing for a person who is in no household.
//
// It COMPOSES the already-built stores — `households` (the household + roster),
// `household-shared-address` (the one shared address + the caller's follow choice) and
// `household-invites` (the still-open invites) — and adds NO SQL of its own. The one
// encrypted item is the shared postal address, a single DEK-encrypted row per household;
// it is encrypted under the household OWNER's DEK, so the read resolves the OWNER's DEK
// through the injected `KeyWrapper` seam (read the owner's wrapped DEK from
// `users.wrapped_dek`, unwrap it) and decrypts under it — exactly the vault / set-up
// page-data idiom. The read holds no key of its own and reads no `process.env` (INV-103):
// the db, the key-wrapper and the clock are all INJECTED seams.
//
// Every underlying read is member-scoped by the GIVEN `userId` (the session's id, never a
// client value) and binds its ids as parameters (INV-102), so a value shaped like SQL
// travels as data and cannot alter a query. The caller's household is resolved FROM the
// user id alone — no household id is ever accepted from the client.

import type { KeyWrapper } from "../crypto/key-wrapper";
import type { Db } from "../db/index";
import { getHouseholdForMember, listMembers, type HouseholdRole } from "../db/households";
import {
  getFollowChoice,
  getSharedAddress,
  type SharedAddress,
} from "../db/household-shared-address";
import { listPendingInvites, type PendingInvite } from "../db/household-invites";
import { getUserById } from "../db/users";
import type { Clock } from "../seams/clock";

// One member of the household — a bare ROSTER entry, never another member's private data
// (no email, no limit, no address, no spending): the member list the brief grants every
// member, not each other's figures.
export interface HouseholdMemberView {
  readonly userId: string;
  readonly role: HouseholdRole;
}

// A pending ownership transfer: just the member it would pass to on accept.
export interface PendingTransferView {
  readonly toUserId: string;
}

// The member-scoped, shared-items-only report the Household page renders.
export interface HouseholdPageData {
  readonly householdId: string;
  readonly ownerId: string; // the current owner (changes only on an accepted transfer)
  readonly currency: string; // the household currency every figure is in
  readonly monthlyBudget: number | null; // the shared monthly household budget (null until set)
  readonly members: HouseholdMemberView[]; // the roster incl. the owner
  readonly sharedAddress: SharedAddress | null; // the one shared address (decrypted); null when unset
  readonly followChoice: boolean; // the CALLER's own address-follow choice (false until set)
  readonly ownLimit: number | null; // the CALLER's own per-member monthly limit (null until set)
  readonly pendingTransfer: PendingTransferView | null; // a pending transfer; null when none
  readonly pendingInvites: PendingInvite[]; // still-open invites (unused + unexpired at clock.now())
}

// The injected seams — no process.env. `db` is the parameterizing database seam;
// `keyWrapper` unwraps the OWNER's DEK (from users.wrapped_dek) to decrypt the shared
// address; `clock` fixes "still open" for the pending-invite window.
export interface HouseholdPageDataDeps {
  readonly db: Db;
  readonly keyWrapper: KeyWrapper;
  readonly clock: Clock;
}

// Assemble the caller's household report for `userId` (the session's id, NEVER a client
// value). Resolves the household FROM the user id alone; returns null when the caller is
// in no household. For a member it returns the roster, the shared address (decrypted under
// the owner's DEK), the currency + budget, the caller's OWN limit + follow choice, any
// pending transfer and any still-open invites — the SHARED items only.
export async function readHouseholdPageData(
  userId: string,
  deps: HouseholdPageDataDeps,
): Promise<HouseholdPageData | null> {
  const { db, keyWrapper, clock } = deps;

  // Resolve the caller's household from their user id alone (member-scoped, binds userId).
  // A person in no household gets nothing.
  const household = await getHouseholdForMember(db, userId);
  if (!household) return null;

  // The shared address is encrypted under the OWNER's DEK, so resolve the owner's key (read
  // their wrapped DEK, unwrap it through the injected seam) — the owner always has a row.
  const owner = await getUserById(db, household.ownerId);
  if (!owner) {
    throw new Error("readHouseholdPageData: household owner has no user row");
  }
  const ownerDek = await keyWrapper.unwrap(owner.wrappedDek);

  // The shared items, each member-scoped by the caller's userId.
  const members = await listMembers(db, household.id, userId);
  const sharedAddress = await getSharedAddress(db, { householdId: household.id, userId }, ownerDek);
  const followChoice = await getFollowChoice(db, { householdId: household.id, userId });
  const pendingInvites = await listPendingInvites(db, { householdId: household.id, userId }, { clock });

  // The caller's OWN limit — read from their own roster entry, never another member's.
  const ownLimit = members.find((m) => m.userId === userId)?.monthlyLimit ?? null;

  return {
    householdId: household.id,
    ownerId: household.ownerId,
    currency: household.currency,
    monthlyBudget: household.monthlyBudget,
    // A bare roster — strip every per-member figure so no other member's private data leaks.
    members: members.map((m) => ({ userId: m.userId, role: m.role })),
    sharedAddress,
    followChoice,
    ownLimit,
    pendingTransfer: household.pendingOwnerId == null ? null : { toUserId: household.pendingOwnerId },
    pendingInvites,
  };
}
