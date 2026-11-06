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
// no `process.env` (INV-103): config flows from `src/server/config.ts` alone.
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
import { getAccountCurrency } from "./account-currency";

// The two membership roles: the owner's row is 'owner'; everyone else is 'member'.
export type HouseholdRole = "owner" | "member";

// The membership cap: the owner plus up to seven others.
const MAX_MEMBERS = 8;

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
// belongs to one household, so this returns that one.
export async function getHouseholdForMember(db: Db, userId: string): Promise<Household | null> {
  const result = await db.query(
    `SELECT h.id, h.owner_id, h.currency, h.monthly_budget, h.pending_owner_id
       FROM households h
       JOIN household_members m ON m.household_id = h.id
      WHERE m.user_id = $1`,
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

// Add `userId` as role 'member'. Total membership (incl. the owner) is capped at 8 —
// the 9th is refused with "household_full"; re-adding an existing member is refused
// with "already_member" and never duplicates the membership.
export async function addMember(
  db: Db,
  { householdId, userId }: { householdId: string; userId: string },
): Promise<{ ok: true; member: HouseholdMember } | { ok: false; reason: "household_full" | "already_member" }> {
  const members = await db.query(
    "SELECT user_id FROM household_members WHERE household_id = $1",
    [householdId],
  );
  if (members.rows.some((row) => String(row.user_id) === userId)) {
    return { ok: false, reason: "already_member" };
  }
  if (members.rows.length >= MAX_MEMBERS) {
    return { ok: false, reason: "household_full" };
  }
  await db.query(
    `INSERT INTO household_members (household_id, user_id, role)
     VALUES ($1, $2, 'member')`,
    [householdId, userId],
  );
  return { ok: true, member: { householdId, userId, role: "member", monthlyLimit: null } };
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
  const pending = await db.query(
    "SELECT owner_id FROM households WHERE id = $1 AND pending_owner_id = $2",
    [householdId, userId],
  );
  const row = pending.rows[0];
  if (!row) {
    return { ok: false, reason: "no_pending_transfer" };
  }
  const oldOwnerId = String(row.owner_id);

  await withTransaction(db, async (tx) => {
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
  });

  return { ok: true };
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
