// The household + membership aggregate's data access (brief "Household sharing";
// design §4.1). A household is the shared container for an address, a budget and
// per-member limits: its owner invites members (capped at 8, incl. the owner), sets
// a shared monthly household budget and a monthly limit per member, removes a member,
// transfers ownership (pending until the new owner accepts) or closes the household;
// a member may leave on their own. Members see the shared figures and the member
// list; only the owner may change them.
//
// These are PLAINTEXT METADATA (ids, roles, budgets, limits, an ISO 4217 code —
// needed for the budget maths, design §4.1), so — unlike vault values, cards or
// released values — they are NOT DEK-encrypted and this module holds no key and reads
// no `process.env` (INV-103): config flows from `src/server/config.ts` alone. The one
// key-shaped column, `wrapped_dek` (the household's own data key for shared content,
// 0058), is stored and handed back only in its KEK-WRAPPED form; wrapping, unwrapping and
// generating it is `src/server/household/household-key.ts`'s job, never this store's.
//
// Every statement is parameterized through the `Db` seam (INV-102): the ids and the
// amounts travel as BOUND values, never concatenated into the SQL text, so a value
// shaped like SQL is stored as data and cannot alter the query. Every member-scoped
// read/write is scoped to the `userId` the caller passes — the session's id, never a
// client value — so one person can never read or change a household they do not
// belong to; the owner-only operations are gated by the caller BEING the owner.

import { randomUUID } from "node:crypto";

import type { Db, Row } from "./index";
import { withTransaction } from "./index";
import { getAccountCurrency, isKnownCurrency } from "./account-currency";

// The two membership roles: the owner's row is 'owner'; everyone else is 'member'.
export type HouseholdRole = "owner" | "member";

// The membership cap: the owner plus up to seven others.
export const MAX_MEMBERS = 8;

// A household row, as handed back to callers.
export interface Household {
  readonly id: string;
  readonly ownerId: string; // the current owner (changes only on an accepted transfer)
  readonly currency: string; // ISO 4217; defaults to the owner's account currency
  readonly monthlyBudget: number | null; // the shared monthly household budget (null until set)
  readonly pendingOwnerId: string | null; // a pending ownership-transfer target (null when none)
}

// A membership row, as handed back to callers.
export interface HouseholdMember {
  readonly householdId: string;
  readonly userId: string;
  readonly role: HouseholdRole; // the owner's row is 'owner'; everyone else 'member'
  readonly monthlyLimit: number | null; // the per-member monthly limit (null until set)
}

// What createHousehold takes: the owner (the SESSION's id, never a client value), an
// optional currency (defaults to the owner's account currency) and an optional
// creation budget (defaults to null).
export interface NewHousehold {
  readonly ownerId: string;
  readonly currency?: string;
  readonly monthlyBudget?: number;
}

// Map a raw households row to a Household. `monthly_budget` is a `numeric` column, so
// the driver hands it back as a number or a string; normalise to a number (null stays
// null). The ids / currency are plain text.
function toHousehold(row: Row): Household {
  return {
    id: String(row.id),
    ownerId: String(row.owner_id),
    currency: String(row.currency),
    monthlyBudget: row.monthly_budget == null ? null : Number(row.monthly_budget),
    pendingOwnerId: row.pending_owner_id == null ? null : String(row.pending_owner_id),
  };
}

// Map a raw household_members row to a HouseholdMember.
function toMember(row: Row): HouseholdMember {
  return {
    householdId: String(row.household_id),
    userId: String(row.user_id),
    role: row.role as HouseholdRole,
    monthlyLimit: row.monthly_limit == null ? null : Number(row.monthly_limit),
  };
}

// Whether `actorId` is the CURRENT owner of `householdId` (both bound). The owner-only
// operations gate on this — a non-owner, and a complete stranger, both read false.
async function isOwner(db: Db, householdId: string, actorId: string): Promise<boolean> {
  const result = await db.query(
    "SELECT 1 FROM households WHERE id = $1 AND owner_id = $2",
    [householdId, actorId],
  );
  return result.rows.length > 0;
}

// Create a household: inserts the household AND the owner as a member (role 'owner')
// in one transaction. `currency` defaults to the owner's account currency when
// omitted; `monthlyBudget` defaults to null; `pendingOwnerId` starts null.
export async function createHousehold(db: Db, input: NewHousehold): Promise<Household> {
  const id = randomUUID();
  const currency = input.currency ?? (await getAccountCurrency(db, input.ownerId));
  const monthlyBudget = input.monthlyBudget ?? null;

  await withTransaction(db, async (tx) => {
    await tx.query(
      `INSERT INTO households (id, owner_id, currency, monthly_budget)
       VALUES ($1, $2, $3, $4)`,
      [id, input.ownerId, currency, monthlyBudget],
    );
    await tx.query(
      `INSERT INTO household_members (household_id, user_id, role)
       VALUES ($1, $2, 'owner')`,
      [id, input.ownerId],
    );
  });

  return { id, ownerId: input.ownerId, currency, monthlyBudget, pendingOwnerId: null };
}

// The household this user belongs to (member-scoped by userId), or null. A person
// belongs to one household (enforced by addMember and, where it could be added, the
// unique index of 0060), so this returns that one; the ORDER BY only keeps the answer
// deterministic — the household they own first — for data from before that was enforced.
export async function getHouseholdForMember(db: Db, userId: string): Promise<Household | null> {
  const result = await db.query(
    `SELECT h.id, h.owner_id, h.currency, h.monthly_budget, h.pending_owner_id
       FROM households h
       JOIN household_members m ON m.household_id = h.id
      WHERE m.user_id = $1
      ORDER BY (m.role = 'owner') DESC, h.id
      LIMIT 1`,
    [userId],
  );
  const row = result.rows[0];
  return row ? toHousehold(row) : null;
}

// The member list — but ONLY when `userId` is a member of that household; a non-member
// reads [] (filtered by the session user id). The EXISTS gate and the list both bind
// the same ids, so a non-member's read never returns another household's rows.
export async function listMembers(
  db: Db,
  householdId: string,
  userId: string,
): Promise<HouseholdMember[]> {
  const result = await db.query(
    `SELECT household_id, user_id, role, monthly_limit
       FROM household_members
      WHERE household_id = $1
        AND EXISTS (
          SELECT 1 FROM household_members me
           WHERE me.household_id = $1 AND me.user_id = $2
        )`,
    [householdId, userId],
  );
  return result.rows.map(toMember);
}

// Whether `userId` is a member of `householdId` — the authorisation predicate the card
// spend ledger's household total uses. Member-scoped (both ids bound).
export async function isHouseholdMember(
  db: Db,
  householdId: string,
  userId: string,
): Promise<boolean> {
  const result = await db.query(
    "SELECT 1 FROM household_members WHERE household_id = $1 AND user_id = $2",
    [householdId, userId],
  );
  return result.rows.length > 0;
}

// Why addMember refused.
export type AddMemberRefusal = "household_full" | "already_member" | "already_in_household";

// Add `userId` as role 'member'. Total membership (incl. the owner) is capped at 8 —
// the 9th is refused with "household_full"; re-adding an existing member is refused
// with "already_member" and never duplicates the membership; a person who already
// belongs to ANOTHER household (as its owner or a member) is refused with
// "already_in_household" — a person belongs to one household.
//
// Both rules hold under concurrency. The household row is locked first, so on Postgres
// concurrent adds to one household serialise (call this inside a transaction, as
// redeemInvite does, so the lock is held until the insert commits); and the insert itself
// re-checks the cap and the one-household rule in the same statement, so adds that share
// one session (PGlite) cannot both pass a count taken before either inserted. A clash with
// the one-household unique index (two joins racing into different households) inserts
// nothing rather than raising, and is reported as "already_in_household".
export async function addMember(
  db: Db,
  { householdId, userId }: { householdId: string; userId: string },
): Promise<{ ok: true; member: HouseholdMember } | { ok: false; reason: AddMemberRefusal }> {
  await db.query("SELECT 1 FROM households WHERE id = $1 FOR UPDATE", [householdId]);
  const inserted = await db.query(
    `INSERT INTO household_members (household_id, user_id, role)
     SELECT $1, $2, 'member'
      WHERE (SELECT count(*) FROM household_members WHERE household_id = $1) < $3
        AND NOT EXISTS (SELECT 1 FROM household_members WHERE user_id = $2)
     ON CONFLICT DO NOTHING
     RETURNING user_id`,
    [householdId, userId, MAX_MEMBERS],
  );
  if (inserted.rows.length > 0) {
    return { ok: true, member: { householdId, userId, role: "member", monthlyLimit: null } };
  }

  // Nothing was inserted: report why.
  const memberships = await db.query(
    "SELECT household_id FROM household_members WHERE user_id = $1",
    [userId],
  );
  if (memberships.rows.some((row) => String(row.household_id) === householdId)) {
    return { ok: false, reason: "already_member" };
  }
  if (memberships.rows.length > 0) {
    return { ok: false, reason: "already_in_household" };
  }
  return { ok: false, reason: "household_full" };
}

// Owner-only: remove a member (the target must be a member). The removed person keeps
// their own account — only the membership row is deleted.
export async function removeMember(
  db: Db,
  { householdId, actorId, userId }: { householdId: string; actorId: string; userId: string },
): Promise<{ ok: true } | { ok: false; reason: "not_owner" | "not_a_member" }> {
  if (!(await isOwner(db, householdId, actorId))) {
    return { ok: false, reason: "not_owner" };
  }
  if (!(await isHouseholdMember(db, householdId, userId))) {
    return { ok: false, reason: "not_a_member" };
  }
  await db.query(
    "DELETE FROM household_members WHERE household_id = $1 AND user_id = $2",
    [householdId, userId],
  );
  return { ok: true };
}

// Owner-only: set the named member's monthly limit (the target must be a member). The
// stored limit reads back via listMembers.
export async function setMemberLimit(
  db: Db,
  {
    householdId,
    actorId,
    userId,
    monthlyLimit,
  }: { householdId: string; actorId: string; userId: string; monthlyLimit: number | null },
): Promise<{ ok: true; monthlyLimit: number | null } | { ok: false; reason: "not_owner" | "not_a_member" }> {
  if (!(await isOwner(db, householdId, actorId))) {
    return { ok: false, reason: "not_owner" };
  }
  if (!(await isHouseholdMember(db, householdId, userId))) {
    return { ok: false, reason: "not_a_member" };
  }
  await db.query(
    "UPDATE household_members SET monthly_limit = $3 WHERE household_id = $1 AND user_id = $2",
    [householdId, userId, monthlyLimit],
  );
  return { ok: true, monthlyLimit };
}

// Owner-only: set the shared monthly household budget. A non-owner / non-member is
// refused with "not_owner" and the budget is unchanged.
export async function setHouseholdBudget(
  db: Db,
  {
    householdId,
    actorId,
    monthlyBudget,
  }: { householdId: string; actorId: string; monthlyBudget: number | null },
): Promise<{ ok: true; monthlyBudget: number | null } | { ok: false; reason: "not_owner" }> {
  if (!(await isOwner(db, householdId, actorId))) {
    return { ok: false, reason: "not_owner" };
  }
  await db.query(
    "UPDATE households SET monthly_budget = $2 WHERE id = $1",
    [householdId, monthlyBudget],
  );
  return { ok: true, monthlyBudget };
}

// Owner-only: set the household currency every figure is in. A non-owner / non-member is
// refused "not_owner" and nothing changes; a code not in the known ISO 4217 set is refused
// "unknown_currency" (the check runs BEFORE the UPDATE, so a refused set writes no row and
// leaves the stored currency untouched). Reuses the ONE currency-validity check
// (account-currency) so valid codes live in a single place.
export async function setHouseholdCurrency(
  db: Db,
  {
    householdId,
    actorId,
    currency,
  }: { householdId: string; actorId: string; currency: string },
): Promise<{ ok: true; currency: string } | { ok: false; reason: "not_owner" | "unknown_currency" }> {
  if (!(await isOwner(db, householdId, actorId))) {
    return { ok: false, reason: "not_owner" };
  }
  if (!isKnownCurrency(currency)) {
    return { ok: false, reason: "unknown_currency" };
  }
  await db.query(
    "UPDATE households SET currency = $2 WHERE id = $1",
    [householdId, currency],
  );
  return { ok: true, currency };
}

// A non-owner member leaves on their own. The owner cannot leave (they must transfer
// or close first); a non-member cannot leave a household they are not in.
export async function leaveHousehold(
  db: Db,
  { householdId, userId }: { householdId: string; userId: string },
): Promise<{ ok: true } | { ok: false; reason: "owner_cannot_leave" | "not_a_member" }> {
  if (!(await isHouseholdMember(db, householdId, userId))) {
    return { ok: false, reason: "not_a_member" };
  }
  if (await isOwner(db, householdId, userId)) {
    return { ok: false, reason: "owner_cannot_leave" };
  }
  await db.query(
    "DELETE FROM household_members WHERE household_id = $1 AND user_id = $2",
    [householdId, userId],
  );
  return { ok: true };
}

// Owner-only: record a PENDING transfer to `toUserId` (who must be a member). Ownership
// does NOT change here — `pendingOwnerId` is set and the owner stays the owner until
// the target accepts.
export async function transferOwnership(
  db: Db,
  { householdId, actorId, toUserId }: { householdId: string; actorId: string; toUserId: string },
): Promise<{ ok: true } | { ok: false; reason: "not_owner" | "not_a_member" }> {
  if (!(await isOwner(db, householdId, actorId))) {
    return { ok: false, reason: "not_owner" };
  }
  if (!(await isHouseholdMember(db, householdId, toUserId))) {
    return { ok: false, reason: "not_a_member" };
  }
  await db.query(
    "UPDATE households SET pending_owner_id = $2 WHERE id = $1",
    [householdId, toUserId],
  );
  return { ok: true };
}

// The pending target accepts (userId === pendingOwnerId): ownerId becomes userId, the
// old owner becomes a 'member', and pendingOwnerId is cleared — all in one
// transaction. Anyone who is not the named target is refused "no_pending_transfer".
export async function acceptOwnership(
  db: Db,
  { householdId, userId }: { householdId: string; userId: string },
): Promise<{ ok: true } | { ok: false; reason: "no_pending_transfer" }> {
  return withTransaction(db, async (tx) => {
    // Read (and lock) the pending transfer INSIDE the transaction, so two concurrent
    // accepts — or an accept racing a new transfer — act on one consistent owner.
    const pending = await tx.query(
      "SELECT owner_id FROM households WHERE id = $1 AND pending_owner_id = $2 FOR UPDATE",
      [householdId, userId],
    );
    const row = pending.rows[0];
    if (!row) {
      return { ok: false, reason: "no_pending_transfer" } as const;
    }
    const oldOwnerId = String(row.owner_id);

    await tx.query(
      "UPDATE households SET owner_id = $2, pending_owner_id = NULL WHERE id = $1",
      [householdId, userId],
    );
    await tx.query(
      "UPDATE household_members SET role = 'member' WHERE household_id = $1 AND user_id = $2",
      [householdId, oldOwnerId],
    );
    await tx.query(
      "UPDATE household_members SET role = 'owner' WHERE household_id = $1 AND user_id = $2",
      [householdId, userId],
    );
    return { ok: true } as const;
  });
}

// The household's KEK-wrapped data key (0058), or null when it has none yet (a household
// created before household keys existed). Unscoped by person on purpose — the key belongs
// to the household, and callers resolve the household from the SESSION user first.
export async function getHouseholdWrappedKey(db: Db, householdId: string): Promise<string | null> {
  const result = await db.query("SELECT wrapped_dek FROM households WHERE id = $1", [householdId]);
  const value = result.rows[0]?.wrapped_dek;
  return value == null ? null : String(value);
}

// Store `wrappedKey` as the household's data key ONLY if it has none yet, returning the
// owner at that moment when this call won (null when the household already had a key or
// does not exist). The conditional UPDATE makes the first writer win: a concurrent second
// claim updates nothing (on Postgres it waits on the row lock, then sees the key set), so
// a household never ends up with two keys. Run it inside the transaction that re-encrypts
// any existing shared content, so the key and the content under it commit together.
export async function claimHouseholdWrappedKey(
  db: Db,
  householdId: string,
  wrappedKey: string,
): Promise<{ ownerId: string } | null> {
  const result = await db.query(
    `UPDATE households SET wrapped_dek = $2
      WHERE id = $1 AND wrapped_dek IS NULL
      RETURNING owner_id`,
    [householdId, wrappedKey],
  );
  const row = result.rows[0];
  return row ? { ownerId: String(row.owner_id) } : null;
}

// Owner-only: close the household — removes the household and (by cascade) every
// membership, so the shared container is gone. Every member's own user account is left
// intact.
export async function closeHousehold(
  db: Db,
  { householdId, actorId }: { householdId: string; actorId: string },
): Promise<{ ok: true } | { ok: false; reason: "not_owner" }> {
  if (!(await isOwner(db, householdId, actorId))) {
    return { ok: false, reason: "not_owner" };
  }
  await db.query("DELETE FROM households WHERE id = $1", [householdId]);
  return { ok: true };
}
