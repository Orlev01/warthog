// E15-S04 — Household and membership store
// (`src/server/db/households.ts`, `db/migrations/0039_households.sql`).
//
// RED-first: neither the data-access module nor the migration exists yet, so importing
// `./households` throws and `freshDb()` has no `households` / `household_members` tables —
// every test here fails until the builder adds them. That absence IS the point of
// test-first; do NOT implement anything to make these pass — the builder writes the module
// and the migration afterwards.
//
// These tests pin BEHAVIOUR (what the functions DO: a household is created with the owner
// as its first member and a currency defaulting to the owner's account currency; members
// are added up to a cap of 8; only the owner may set the budget / a member's limit, remove
// a member, transfer ownership or close the household; a member may leave; ownership
// transfer stays pending until accepted; closing removes the shared container while leaving
// every account intact; who may read what, filtered by the session user id; what a handler
// rejects; that every value is bound as a parameter; that the repo reads no `process.env`),
// never the source text of the module or the SQL file — a later rename that preserves
// behaviour must not redden them.
//
// WHY this exists (task E15-S04; brief "Household sharing": "the owner invites members by
// email (invite link valid 7 days, up to 8 members); members join with their own accounts;
// … the owner sets a shared monthly household budget and a monthly limit per member, both
// in the household currency (set by the owner, defaulting to the owner's account currency)
// … members see the shared address, the member list and household budget totals, never each
// other's private data; the owner can remove a member, a member can leave, the owner can
// transfer ownership to another member (who must accept), and the owner can close the
// household (shared items are removed; every member keeps their own account)"). The
// household is the shared container for an address, a budget and per-member limits. Its
// figures are PLAINTEXT METADATA (ids, roles, budgets, limits, a currency code — needed for
// the budget maths, design §4.1), so — unlike vault fields — they are NOT DEK-encrypted and
// this module holds no key and reads no `process.env`. Every member-scoped read/write is
// scoped to the SESSION's user id, never a value from the client.
//
// ---------------------------------------------------------------------------
// THE PINNED CONTRACT (chosen by the tester; the implementation conforms to it).
//
//   type HouseholdRole = "owner" | "member";
//
//   interface Household {
//     id: string;                     // generated on create
//     ownerId: string;                // the current owner (changes only on an accepted transfer)
//     currency: string;               // ISO 4217; defaults to the owner's account currency
//     monthlyBudget: number | null;   // the shared monthly household budget (null until set)
//     pendingOwnerId: string | null;  // a pending ownership-transfer target (null when none)
//   }
//   interface HouseholdMember {
//     householdId: string;
//     userId: string;
//     role: HouseholdRole;            // the owner's row is 'owner'; everyone else 'member'
//     monthlyLimit: number | null;    // the per-member monthly limit (null until set)
//   }
//
//   createHousehold(db, { ownerId, currency?, monthlyBudget? }): Promise<Household>
//     • inserts the household AND the owner as a member (role 'owner'); `currency` defaults
//       to getAccountCurrency(ownerId) when omitted; `monthlyBudget` defaults to null;
//       `pendingOwnerId` is null.
//   getHouseholdForMember(db, userId): Promise<Household | null>
//     • the household this user belongs to (member-scoped by userId), or null.
//   listMembers(db, householdId, userId): Promise<HouseholdMember[]>
//     • the member list — but ONLY when `userId` is a member of that household; a non-member
//       reads [] (filtered by the session user id).
//   isHouseholdMember(db, householdId, userId): Promise<boolean>
//     • whether `userId` is a member of `householdId` — the authorisation predicate the card
//       spend ledger's household total uses.
//   addMember(db, { householdId, userId }): Promise<
//       { ok: true; member: HouseholdMember } | { ok: false; reason: "household_full" | "already_member" }>
//     • adds `userId` as role 'member'; total membership (incl. the owner) is capped at 8 —
//       the 9th is refused with "household_full"; re-adding an existing member → "already_member".
//   removeMember(db, { householdId, actorId, userId }): Promise<
//       { ok: true } | { ok: false; reason: "not_owner" | "not_a_member" }>
//     • owner-only (actorId must be the owner); the target must be a member; removes it.
//   setMemberLimit(db, { householdId, actorId, userId, monthlyLimit }): Promise<
//       { ok: true; monthlyLimit: number | null } | { ok: false; reason: "not_owner" | "not_a_member" }>
//     • owner-only; sets the named member's monthly limit (reads back via listMembers).
//   setHouseholdBudget(db, { householdId, actorId, monthlyBudget }): Promise<
//       { ok: true; monthlyBudget: number | null } | { ok: false; reason: "not_owner" }>
//     • owner-only; sets the shared monthly household budget (a non-owner / non-member → not_owner).
//   leaveHousehold(db, { householdId, userId }): Promise<
//       { ok: true } | { ok: false; reason: "owner_cannot_leave" | "not_a_member" }>
//     • a non-owner member leaves; the owner cannot leave (must transfer or close first).
//   transferOwnership(db, { householdId, actorId, toUserId }): Promise<
//       { ok: true } | { ok: false; reason: "not_owner" | "not_a_member" }>
//     • owner-only; records a PENDING transfer to `toUserId` (who must be a member). Ownership
//       does NOT change — `pendingOwnerId` is set and the owner stays the owner until accept.
//   acceptOwnership(db, { householdId, userId }): Promise<
//       { ok: true } | { ok: false; reason: "no_pending_transfer" }>
//     • the pending target (userId === pendingOwnerId) accepts: ownerId becomes userId, the
//       old owner becomes a 'member', pendingOwnerId is cleared. Anyone else → no_pending_transfer.
//   closeHousehold(db, { householdId, actorId }): Promise<
//       { ok: true } | { ok: false; reason: "not_owner" }>
//     • owner-only; removes the household and every membership (the shared container is gone);
//       every member's own user account is left intact.
//
// Acceptance criteria → tests:
//   AC1 "Creating a household sets the owner and a currency defaulting to the owner's account
//        currency; adding members is capped at 8 and only the owner can set the household
//        budget, a member's monthly limit, remove a member, transfer ownership or close the
//        household." — createHousehold seeds owner + currency; the cap of 8; each owner-only op.
//   AC2 "Transferring ownership stays pending until the named member accepts, a member can
//        leave on their own, and closing the household removes the shared items while leaving
//        every member's own account intact."
//   AC3 "A non-owner's attempt to set budgets/limits, remove a member, transfer or close is
//        refused, and no member can read or change a household they do not belong to (filtered
//        by session user id)."
//   AC4 [obligation:validate-and-parameterize-input] (INV-102) — a handler on the
//        `../http/validate` boundary rejects malformed / oversized / mis-shaped / mis-typed
//        input with a 4xx before any query runs; a SQL-injection probe routed through the repo
//        travels as a BOUND value (placeholders, never concatenation) and cannot alter a query.
//        The handler below is a test fixture (the intended usage), not an implementation file.
//   AC5 [obligation:secrets-from-env] (INV-103) — the repo takes its db as a dependency, reads
//        no `process.env` and holds no secret, so a decoy secret planted in the environment
//        never lands in a stored or returned household row.
//   Migration: the `households` + `household_members` relations exist after the project
//        migrations and a second run of every migration changes nothing.
//
// Every db handle is closed in a `finally` so node:test leaves no open handle; each real-db
// test uses its own `freshDb()` (an isolated in-memory PGlite with the real migrations), so
// tests share no state.

import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";

import {
  createHousehold,
  getHouseholdForMember,
  listMembers,
  isHouseholdMember,
  addMember,
  removeMember,
  setMemberLimit,
  setHouseholdBudget,
  leaveHousehold,
  transferOwnership,
  acceptOwnership,
  closeHousehold,
} from "./households";
import { createUser, getUserById } from "./users";
import { getAccountCurrency, setAccountCurrency } from "./account-currency";
import { freshDb } from "../../test/db";
import { loadMigrations, runMigrations, type Db, type QueryResult } from "./index";
import { parseBody, HttpError } from "../http/validate";

// --- pinned shapes, derived from the store's own signatures so a later type rename that
// preserves behaviour does not redden these tests. ---------------------------------------
type Household = Awaited<ReturnType<typeof createHousehold>>;
type HouseholdMember = Awaited<ReturnType<typeof listMembers>>[number];

// --- fixtures ----------------------------------------------------------------------------

// A stand-in wrapped DEK for createUser (opaque base64; this module never reads it — the
// household store holds only plaintext metadata, no encrypted column).
function wrappedDekFor(who: string): string {
  return Buffer.from(`wrapped-dek-${who}`).toString("base64");
}

// Create a person and return their id (every member-scoped row hangs off this id).
async function makeUser(db: Db, who: string): Promise<string> {
  const user = await createUser(db, {
    email: `${who}@warthog.com.au`,
    wrappedDek: wrappedDekFor(who),
  });
  return user.id;
}

// A db seam stand-in that records every call instead of running it, so a test can prove
// WHAT reached the query layer and HOW (bound value vs. spliced text). It returns no rows
// and satisfies the `Db` shape structurally (query + close).
interface RecordingDb extends Db {
  readonly calls: { text: string; values: unknown[] }[];
}
function recordingDb(): RecordingDb {
  const calls: { text: string; values: unknown[] }[] = [];
  return {
    calls,
    query(text: string, values: unknown[] = []): Promise<QueryResult> {
      calls.push({ text, values });
      return Promise.resolve({ rows: [] as Record<string, unknown>[] });
    },
    close() {
      return Promise.resolve();
    },
  };
}

// Whether a relation of this exact name exists on this handle. `to_regclass` yields the
// relation name when it exists and NULL when it does not — a non-throwing probe scoped to
// the table under test (behaviour, not source text).
async function tableExists(db: Db, name: string): Promise<boolean> {
  const result = await db.query("SELECT to_regclass($1) AS t", [name]);
  return result.rows[0]?.t != null;
}

// Assert a probe reached the query layer as a BOUND value and never as spliced SQL text,
// scoped to each recorded call (the parameterize half of INV-102).
function assertBoundNotSpliced(db: RecordingDb, probe: string): void {
  assert.ok(db.calls.length >= 1, "at least one query was issued");
  assert.ok(db.calls.some((c) => c.values.includes(probe)), "the probe travels as a bound value");
  for (const call of db.calls) {
    assert.ok(!call.text.includes(probe), "the input is bound, never concatenated into the SQL");
    assert.ok(!call.text.includes("DROP TABLE"), "no injected statement appears in the SQL text");
  }
}

// Find one member of a list by user id (the member-list read is unordered).
function memberOf(members: HouseholdMember[], userId: string): HouseholdMember | undefined {
  return members.find((m) => m.userId === userId);
}

// The acceptance walk's figures (brief: "a $500 household budget and a $200 member limit").
const BUDGET = 500;
const LIMIT = 200;

// ===========================================================================
// AC1 — createHousehold seeds the owner + a currency defaulting to the account currency.
// ===========================================================================

test("creating a household sets the owner as a member with role owner", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "create-owner");

    const house: Household = await createHousehold(db, { ownerId: alice });
    assert.equal(typeof house.id, "string", "the household has a generated id");
    assert.ok(house.id.length > 0, "the id is non-empty");
    assert.equal(house.ownerId, alice, "the creator is the owner");
    assert.equal(house.pendingOwnerId, null, "a fresh household has no pending transfer");

    // The owner is enrolled as a member with role 'owner'.
    assert.equal(await isHouseholdMember(db, house.id, alice), true, "the owner is a member of their household");
    const members = await listMembers(db, house.id, alice);
    assert.equal(members.length, 1, "a fresh household has exactly one member (the owner)");
    assert.equal(memberOf(members, alice)?.role, "owner", "the owner's member row has role 'owner'");

    // The owner can find their household.
    const read = await getHouseholdForMember(db, alice);
    assert.equal(read?.id, house.id, "getHouseholdForMember returns the owner's household");
  } finally {
    await db.close();
  }
});

test("a new household's currency defaults to the owner's account currency", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "create-ccy-set");
    await setAccountCurrency(db, { userId: alice, currency: "USD" });

    const house = await createHousehold(db, { ownerId: alice });
    assert.equal(house.currency, "USD", "the household currency defaults to the owner's account currency");
    assert.equal(
      (await getHouseholdForMember(db, alice))?.currency,
      "USD",
      "the defaulted currency reads back",
    );
  } finally {
    await db.close();
  }
});

test("a new household defaults to AUD when the owner has set no account currency", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "create-ccy-default");
    // Alice has set no account currency, so getAccountCurrency returns the brief's default.
    assert.equal(await getAccountCurrency(db, alice), "AUD", "sanity: the account-currency default is AUD");

    const house = await createHousehold(db, { ownerId: alice });
    assert.equal(house.currency, "AUD", "the household currency falls to AUD via the owner's account default");
  } finally {
    await db.close();
  }
});

test("creating a household with an explicit currency uses it (owner sets the household currency)", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "create-ccy-explicit");
    await setAccountCurrency(db, { userId: alice, currency: "USD" });

    const house = await createHousehold(db, { ownerId: alice, currency: "EUR" });
    assert.equal(house.currency, "EUR", "an explicit currency overrides the account-currency default");
  } finally {
    await db.close();
  }
});

test("a new household has no budget until one is set, and a creation budget is stored", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "create-budget-null");
    const withoutBudget = await createHousehold(db, { ownerId: alice });
    assert.equal(withoutBudget.monthlyBudget, null, "a household created without a budget reads null (not yet set)");

    const bob = await makeUser(db, "create-budget-set");
    const withBudget = await createHousehold(db, { ownerId: bob, monthlyBudget: BUDGET });
    assert.equal(withBudget.monthlyBudget, BUDGET, "a creation budget is stored");
    assert.equal(
      (await getHouseholdForMember(db, bob))?.monthlyBudget,
      BUDGET,
      "the creation budget reads back",
    );
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC1 — adding members, capped at 8.
// ===========================================================================

test("adding a member enrols them as role 'member' and they can then read the household", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "add-owner");
    const bob = await makeUser(db, "add-member");
    const house = await createHousehold(db, { ownerId: alice });

    const result = await addMember(db, { householdId: house.id, userId: bob });
    assert.equal(result.ok, true, "a member is added");
    if (result.ok) {
      assert.equal(result.member.userId, bob, "the added member is the named user");
      assert.equal(result.member.role, "member", "an added member has role 'member'");
    }

    assert.equal(await isHouseholdMember(db, house.id, bob), true, "the added user is now a member");
    assert.equal((await getHouseholdForMember(db, bob))?.id, house.id, "the added member belongs to the household");
    const members = await listMembers(db, house.id, bob);
    assert.equal(members.length, 2, "the household now has two members (owner + added)");
    assert.equal(memberOf(members, bob)?.role, "member", "the added member reads with role 'member'");
    assert.equal(memberOf(members, alice)?.role, "owner", "the owner's role is unchanged by an add");
  } finally {
    await db.close();
  }
});

test("household membership is capped at 8 (the owner plus seven others); a ninth is refused", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "cap-owner");
    const house = await createHousehold(db, { ownerId: alice });

    // The owner is member #1. Seven more fill the household to the cap of 8.
    for (let i = 1; i <= 7; i++) {
      const member = await makeUser(db, `cap-member-${i}`);
      const result = await addMember(db, { householdId: house.id, userId: member });
      assert.equal(result.ok, true, `member #${i + 1} fits within the cap of 8`);
    }
    assert.equal((await listMembers(db, house.id, alice)).length, 8, "the household is full at 8 members");

    // A ninth member is refused and does not land.
    const ninth = await makeUser(db, "cap-member-9");
    const overflow = await addMember(db, { householdId: house.id, userId: ninth });
    assert.equal(overflow.ok, false, "a ninth member exceeds the cap of 8 and is refused");
    if (!overflow.ok) {
      assert.equal(overflow.reason, "household_full", "the refusal names the cap");
    }
    assert.equal(await isHouseholdMember(db, house.id, ninth), false, "the refused ninth member was not enrolled");
    assert.equal((await listMembers(db, house.id, alice)).length, 8, "membership is still 8 after the refusal");
  } finally {
    await db.close();
  }
});

test("re-adding an existing member is refused and never duplicates the membership", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "dup-owner");
    const bob = await makeUser(db, "dup-member");
    const house = await createHousehold(db, { ownerId: alice });

    assert.equal((await addMember(db, { householdId: house.id, userId: bob })).ok, true, "the first add succeeds");
    const again = await addMember(db, { householdId: house.id, userId: bob });
    assert.equal(again.ok, false, "adding the same user a second time is refused");
    if (!again.ok) {
      assert.equal(again.reason, "already_member", "the refusal says the user is already a member");
    }
    assert.equal((await listMembers(db, house.id, alice)).length, 2, "there is no duplicate membership row");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC1 — only the owner may set the budget, set a member's limit, remove a member.
// ===========================================================================

test("the owner sets the shared monthly household budget and it reads back", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "budget-owner");
    const house = await createHousehold(db, { ownerId: alice });

    const result = await setHouseholdBudget(db, { householdId: house.id, actorId: alice, monthlyBudget: BUDGET });
    assert.equal(result.ok, true, "the owner may set the budget");
    if (result.ok) assert.equal(result.monthlyBudget, BUDGET, "the result carries the stored budget");

    assert.equal((await getHouseholdForMember(db, alice))?.monthlyBudget, BUDGET, "the budget reads back");
  } finally {
    await db.close();
  }
});

test("the owner sets a member's monthly limit and it reads back on the member list", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "limit-owner");
    const bob = await makeUser(db, "limit-member");
    const house = await createHousehold(db, { ownerId: alice });
    await addMember(db, { householdId: house.id, userId: bob });

    const result = await setMemberLimit(db, { householdId: house.id, actorId: alice, userId: bob, monthlyLimit: LIMIT });
    assert.equal(result.ok, true, "the owner may set a member's limit");
    if (result.ok) assert.equal(result.monthlyLimit, LIMIT, "the result carries the stored limit");

    const members = await listMembers(db, house.id, alice);
    assert.equal(memberOf(members, bob)?.monthlyLimit, LIMIT, "the limit reads back on the member list");
    assert.equal(memberOf(members, alice)?.monthlyLimit, null, "another member's limit is untouched");
  } finally {
    await db.close();
  }
});

test("setting a limit for someone who is not a member is refused", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "limit-nonmember-owner");
    const stranger = await makeUser(db, "limit-nonmember-stranger");
    const house = await createHousehold(db, { ownerId: alice });

    const result = await setMemberLimit(db, { householdId: house.id, actorId: alice, userId: stranger, monthlyLimit: LIMIT });
    assert.equal(result.ok, false, "a limit cannot be set for a non-member");
    if (!result.ok) assert.equal(result.reason, "not_a_member", "the refusal says the target is not a member");
  } finally {
    await db.close();
  }
});

test("the owner can remove a member", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "remove-owner");
    const bob = await makeUser(db, "remove-member");
    const house = await createHousehold(db, { ownerId: alice });
    await addMember(db, { householdId: house.id, userId: bob });

    const result = await removeMember(db, { householdId: house.id, actorId: alice, userId: bob });
    assert.equal(result.ok, true, "the owner may remove a member");

    assert.equal(await isHouseholdMember(db, house.id, bob), false, "the removed user is no longer a member");
    assert.equal(await getHouseholdForMember(db, bob), null, "the removed user belongs to no household");
    assert.equal((await listMembers(db, house.id, alice)).length, 1, "only the owner remains");
    assert.ok(await getUserById(db, bob), "the removed member keeps their own account");
  } finally {
    await db.close();
  }
});

test("removing someone who is not a member is refused", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "remove-nonmember-owner");
    const stranger = await makeUser(db, "remove-nonmember-stranger");
    const house = await createHousehold(db, { ownerId: alice });

    const result = await removeMember(db, { householdId: house.id, actorId: alice, userId: stranger });
    assert.equal(result.ok, false, "removing a non-member is refused");
    if (!result.ok) assert.equal(result.reason, "not_a_member", "the refusal says the target is not a member");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC2 — transfer stays pending until accepted; a member can leave; close removes
// the shared container while leaving accounts intact.
// ===========================================================================

test("transferring ownership stays pending until the named member accepts", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "xfer-alice");
    const bob = await makeUser(db, "xfer-bob");
    const house = await createHousehold(db, { ownerId: alice });
    await addMember(db, { householdId: house.id, userId: bob });

    const transfer = await transferOwnership(db, { householdId: house.id, actorId: alice, toUserId: bob });
    assert.equal(transfer.ok, true, "the owner may initiate a transfer to a member");

    // PENDING: ownership has NOT changed. Alice is still the owner; Bob is still a member.
    const pending = await getHouseholdForMember(db, alice);
    assert.equal(pending?.ownerId, alice, "Alice is still the owner until Bob accepts");
    assert.equal(pending?.pendingOwnerId, bob, "the pending transfer names Bob");

    assert.equal(
      (await setHouseholdBudget(db, { householdId: house.id, actorId: alice, monthlyBudget: BUDGET })).ok,
      true,
      "the current owner still acts while the transfer is pending",
    );
    assert.equal(
      (await setHouseholdBudget(db, { householdId: house.id, actorId: bob, monthlyBudget: 600 })).ok,
      false,
      "the pending new owner cannot act as owner until he accepts",
    );

    // Bob accepts → ownership moves across.
    const accept = await acceptOwnership(db, { householdId: house.id, userId: bob });
    assert.equal(accept.ok, true, "the named member accepts the transfer");

    const after = await getHouseholdForMember(db, bob);
    assert.equal(after?.ownerId, bob, "Bob is now the owner");
    assert.equal(after?.pendingOwnerId, null, "the pending transfer is cleared on acceptance");

    const members = await listMembers(db, house.id, bob);
    assert.equal(memberOf(members, bob)?.role, "owner", "Bob's member row is now role 'owner'");
    assert.equal(memberOf(members, alice)?.role, "member", "Alice is now a plain member");

    assert.equal(
      (await setHouseholdBudget(db, { householdId: house.id, actorId: bob, monthlyBudget: 700 })).ok,
      true,
      "the new owner can now act",
    );
    assert.equal(
      (await setHouseholdBudget(db, { householdId: house.id, actorId: alice, monthlyBudget: 800 })).ok,
      false,
      "the former owner can no longer act as owner",
    );
  } finally {
    await db.close();
  }
});

test("only the named member can accept a pending transfer", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "accept-alice");
    const bob = await makeUser(db, "accept-bob");
    const carol = await makeUser(db, "accept-carol");
    const house = await createHousehold(db, { ownerId: alice });
    await addMember(db, { householdId: house.id, userId: bob });
    await addMember(db, { householdId: house.id, userId: carol });

    await transferOwnership(db, { householdId: house.id, actorId: alice, toUserId: bob });

    // Carol is a member but not the named target.
    const carolAccepts = await acceptOwnership(db, { householdId: house.id, userId: carol });
    assert.equal(carolAccepts.ok, false, "a member who is not the named target cannot accept");
    if (!carolAccepts.ok) assert.equal(carolAccepts.reason, "no_pending_transfer", "the refusal has a plain reason");

    assert.equal((await getHouseholdForMember(db, alice))?.ownerId, alice, "ownership is unchanged by the wrong accepter");
    assert.equal((await getHouseholdForMember(db, alice))?.pendingOwnerId, bob, "the pending transfer still names Bob");
  } finally {
    await db.close();
  }
});

test("accepting ownership when none is pending is refused", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "accept-none-alice");
    const bob = await makeUser(db, "accept-none-bob");
    const house = await createHousehold(db, { ownerId: alice });
    await addMember(db, { householdId: house.id, userId: bob });

    const result = await acceptOwnership(db, { householdId: house.id, userId: bob });
    assert.equal(result.ok, false, "there is nothing to accept when no transfer is pending");
    if (!result.ok) assert.equal(result.reason, "no_pending_transfer", "the refusal has a plain reason");
    assert.equal((await getHouseholdForMember(db, alice))?.ownerId, alice, "ownership is unchanged");
  } finally {
    await db.close();
  }
});

test("transferring ownership to a non-member is refused", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "xfer-nonmember-alice");
    const stranger = await makeUser(db, "xfer-nonmember-stranger");
    const house = await createHousehold(db, { ownerId: alice });

    const result = await transferOwnership(db, { householdId: house.id, actorId: alice, toUserId: stranger });
    assert.equal(result.ok, false, "ownership can only be transferred to a member");
    if (!result.ok) assert.equal(result.reason, "not_a_member", "the refusal says the target is not a member");
    assert.equal((await getHouseholdForMember(db, alice))?.pendingOwnerId, null, "no pending transfer is recorded");
  } finally {
    await db.close();
  }
});

test("a member can leave the household on their own", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "leave-owner");
    const bob = await makeUser(db, "leave-member");
    const house = await createHousehold(db, { ownerId: alice });
    await addMember(db, { householdId: house.id, userId: bob });

    const result = await leaveHousehold(db, { householdId: house.id, userId: bob });
    assert.equal(result.ok, true, "a member may leave on their own");

    assert.equal(await isHouseholdMember(db, house.id, bob), false, "the member who left is no longer in the household");
    assert.equal(await getHouseholdForMember(db, bob), null, "the member who left belongs to no household");
    assert.equal((await listMembers(db, house.id, alice)).length, 1, "only the owner remains");
    assert.equal((await getHouseholdForMember(db, alice))?.ownerId, alice, "the owner and household are untouched");
    assert.ok(await getUserById(db, bob), "the member who left keeps their own account");
  } finally {
    await db.close();
  }
});

test("the owner cannot leave the household (must transfer or close first)", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "owner-leave-alice");
    const bob = await makeUser(db, "owner-leave-bob");
    const house = await createHousehold(db, { ownerId: alice });
    await addMember(db, { householdId: house.id, userId: bob });

    const result = await leaveHousehold(db, { householdId: house.id, userId: alice });
    assert.equal(result.ok, false, "the owner cannot simply leave (that would abandon the household)");
    if (!result.ok) assert.equal(result.reason, "owner_cannot_leave", "the refusal explains the owner must transfer or close");
    assert.equal(await isHouseholdMember(db, house.id, alice), true, "the owner is still a member after the refusal");
  } finally {
    await db.close();
  }
});

test("leaving a household you do not belong to is refused", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "leave-stranger-alice");
    const stranger = await makeUser(db, "leave-stranger-x");
    const house = await createHousehold(db, { ownerId: alice });

    const result = await leaveHousehold(db, { householdId: house.id, userId: stranger });
    assert.equal(result.ok, false, "a non-member cannot leave a household they are not in");
    if (!result.ok) assert.equal(result.reason, "not_a_member", "the refusal says they are not a member");
  } finally {
    await db.close();
  }
});

test("the owner can close the household: the shared container is removed, every account intact", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "close-owner");
    const bob = await makeUser(db, "close-member");
    const house = await createHousehold(db, { ownerId: alice });
    await addMember(db, { householdId: house.id, userId: bob });
    await setHouseholdBudget(db, { householdId: house.id, actorId: alice, monthlyBudget: BUDGET });
    await setMemberLimit(db, { householdId: house.id, actorId: alice, userId: bob, monthlyLimit: LIMIT });

    const result = await closeHousehold(db, { householdId: house.id, actorId: alice });
    assert.equal(result.ok, true, "the owner may close the household");

    // The shared container is gone for everyone.
    assert.equal(await getHouseholdForMember(db, alice), null, "the former owner now belongs to no household");
    assert.equal(await getHouseholdForMember(db, bob), null, "the former member now belongs to no household");
    assert.equal(await isHouseholdMember(db, house.id, alice), false, "the owner is no longer a member");
    assert.equal(await isHouseholdMember(db, house.id, bob), false, "the member is no longer a member");
    assert.deepEqual(await listMembers(db, house.id, alice), [], "the member list is empty after close");

    // Every member keeps their own account.
    assert.ok(await getUserById(db, alice), "the owner keeps their own account after close");
    assert.ok(await getUserById(db, bob), "the member keeps their own account after close");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC3 — a non-owner cannot set budgets/limits, remove, transfer or close; and no member
// can read or change a household they do not belong to (filtered by session user id).
// ===========================================================================

test("a non-owner member cannot set the household budget", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "nonowner-budget-alice");
    const bob = await makeUser(db, "nonowner-budget-bob");
    const house = await createHousehold(db, { ownerId: alice });
    await addMember(db, { householdId: house.id, userId: bob });
    await setHouseholdBudget(db, { householdId: house.id, actorId: alice, monthlyBudget: BUDGET });

    const result = await setHouseholdBudget(db, { householdId: house.id, actorId: bob, monthlyBudget: 999 });
    assert.equal(result.ok, false, "a non-owner cannot set the budget");
    if (!result.ok) assert.equal(result.reason, "not_owner", "the refusal says the actor is not the owner");
    assert.equal((await getHouseholdForMember(db, alice))?.monthlyBudget, BUDGET, "the budget is unchanged by the refused set");
  } finally {
    await db.close();
  }
});

test("a non-owner member cannot set another member's limit, remove, transfer or close", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "nonowner-ops-alice");
    const bob = await makeUser(db, "nonowner-ops-bob");
    const carol = await makeUser(db, "nonowner-ops-carol");
    const house = await createHousehold(db, { ownerId: alice });
    await addMember(db, { householdId: house.id, userId: bob });
    await addMember(db, { householdId: house.id, userId: carol });

    const limit = await setMemberLimit(db, { householdId: house.id, actorId: bob, userId: carol, monthlyLimit: LIMIT });
    assert.equal(limit.ok, false, "a non-owner cannot set a member's limit");
    if (!limit.ok) assert.equal(limit.reason, "not_owner", "limit refusal: not the owner");

    const remove = await removeMember(db, { householdId: house.id, actorId: bob, userId: carol });
    assert.equal(remove.ok, false, "a non-owner cannot remove a member");
    if (!remove.ok) assert.equal(remove.reason, "not_owner", "remove refusal: not the owner");
    assert.equal(await isHouseholdMember(db, house.id, carol), true, "the target is still a member after the refused remove");

    const transfer = await transferOwnership(db, { householdId: house.id, actorId: bob, toUserId: carol });
    assert.equal(transfer.ok, false, "a non-owner cannot transfer ownership");
    if (!transfer.ok) assert.equal(transfer.reason, "not_owner", "transfer refusal: not the owner");

    const close = await closeHousehold(db, { householdId: house.id, actorId: bob });
    assert.equal(close.ok, false, "a non-owner cannot close the household");
    if (!close.ok) assert.equal(close.reason, "not_owner", "close refusal: not the owner");
    assert.equal((await getHouseholdForMember(db, alice))?.id, house.id, "the household still exists after the refused close");
  } finally {
    await db.close();
  }
});

test("a non-member cannot set the budget of a household they do not belong to", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "nonmember-change-alice");
    const stranger = await makeUser(db, "nonmember-change-x");
    const house = await createHousehold(db, { ownerId: alice });
    await setHouseholdBudget(db, { householdId: house.id, actorId: alice, monthlyBudget: BUDGET });

    const result = await setHouseholdBudget(db, { householdId: house.id, actorId: stranger, monthlyBudget: 999 });
    assert.equal(result.ok, false, "a complete stranger cannot change a household");
    if (!result.ok) assert.equal(result.reason, "not_owner", "a non-member is not the owner");
    assert.equal((await getHouseholdForMember(db, alice))?.monthlyBudget, BUDGET, "the budget is unchanged");
  } finally {
    await db.close();
  }
});

test("a member (not the owner) can read the member list and budget figures", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "memberread-alice");
    const bob = await makeUser(db, "memberread-bob");
    const house = await createHousehold(db, { ownerId: alice });
    await addMember(db, { householdId: house.id, userId: bob });
    await setHouseholdBudget(db, { householdId: house.id, actorId: alice, monthlyBudget: BUDGET });
    await setMemberLimit(db, { householdId: house.id, actorId: alice, userId: bob, monthlyLimit: LIMIT });

    // Bob (a non-owner member) reads the shared budget and the member list.
    assert.equal((await getHouseholdForMember(db, bob))?.monthlyBudget, BUDGET, "a member reads the household budget");
    const members = await listMembers(db, house.id, bob);
    assert.equal(members.length, 2, "a member reads the full member list");
    assert.equal(memberOf(members, bob)?.monthlyLimit, LIMIT, "a member reads the limit figures");
  } finally {
    await db.close();
  }
});

test("a non-member cannot read a household's member list or membership (filtered by session user id)", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "nonmember-read-alice");
    const stranger = await makeUser(db, "nonmember-read-x");
    const house = await createHousehold(db, { ownerId: alice });

    assert.deepEqual(await listMembers(db, house.id, stranger), [], "a non-member reads no member list");
    assert.equal(await isHouseholdMember(db, house.id, stranger), false, "a non-member is not a member");
    assert.equal(await getHouseholdForMember(db, stranger), null, "a non-member belongs to no household");
  } finally {
    await db.close();
  }
});

test("one household's members and figures never leak into another household's reads", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "iso-alice");
    const bob = await makeUser(db, "iso-bob");
    const houseA = await createHousehold(db, { ownerId: alice });
    const houseB = await createHousehold(db, { ownerId: bob });
    await setHouseholdBudget(db, { householdId: houseA.id, actorId: alice, monthlyBudget: BUDGET });
    await setHouseholdBudget(db, { householdId: houseB.id, actorId: bob, monthlyBudget: 999 });

    // Each owner reads only their own household.
    assert.equal((await getHouseholdForMember(db, alice))?.id, houseA.id, "Alice reads her own household");
    assert.equal((await getHouseholdForMember(db, alice))?.monthlyBudget, BUDGET, "Alice reads her own budget");
    assert.equal((await getHouseholdForMember(db, bob))?.id, houseB.id, "Bob reads his own household");

    // Alice is not a member of Bob's household: his member list and membership are closed to her.
    assert.deepEqual(await listMembers(db, houseB.id, alice), [], "Alice cannot read Bob's member list");
    assert.equal(await isHouseholdMember(db, houseB.id, alice), false, "Alice is not a member of Bob's household");

    // Alice cannot change Bob's household.
    const result = await setHouseholdBudget(db, { householdId: houseB.id, actorId: alice, monthlyBudget: 1 });
    assert.equal(result.ok, false, "Alice cannot change Bob's household");
    assert.equal((await getHouseholdForMember(db, bob))?.monthlyBudget, 999, "Bob's budget is untouched");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC4 — every statement binds its input as a parameter (no spliced SQL).
// ===========================================================================

test("createHousehold binds the owner id as a parameter, never woven into the SQL text", async () => {
  const db = recordingDb();
  const probe = "o'); DROP TABLE households; --";
  // The recording db returns no rows; an implementation that reads its result back may throw
  // — but by then the statements (with the probe BOUND) have been recorded, which is the point.
  try {
    await createHousehold(db, { ownerId: probe });
  } catch {
    /* tolerate a no-rows-returned error — the binding is what this test checks */
  }
  assertBoundNotSpliced(db, probe);
});

test("addMember binds the household id and user id as parameters", async () => {
  const db = recordingDb();
  const probe = "m'); DROP TABLE household_members; --";
  try {
    await addMember(db, { householdId: probe, userId: probe });
  } catch {
    /* tolerate a no-rows-returned error — the binding is what this test checks */
  }
  assertBoundNotSpliced(db, probe);
});

test("setHouseholdBudget binds the household id and actor id as parameters", async () => {
  const db = recordingDb();
  const probe = "b'); DROP TABLE households; --";
  // The recording db returns no rows, so the ownership check concludes "not owner" and the
  // budget is not set — but the ownership-check statement must have BOUND the probe.
  const result = await setHouseholdBudget(db, { householdId: probe, actorId: probe, monthlyBudget: BUDGET });
  assert.equal(result.ok, false, "no rows from the recording db → the actor is not the owner");
  assertBoundNotSpliced(db, probe);
});

test("removeMember binds the household id and the ids as parameters", async () => {
  const db = recordingDb();
  const probe = "r'); DROP TABLE household_members; --";
  const result = await removeMember(db, { householdId: probe, actorId: probe, userId: probe });
  assert.equal(result.ok, false, "no rows from the recording db → not owner");
  assertBoundNotSpliced(db, probe);
});

test("a SQL-injection probe in a household id is bound, never run: the household tables survive", async () => {
  const db = await freshDb();
  try {
    const probe = "h'); DROP TABLE households; --";
    // A non-uuid probe either matches nothing or errors on the uuid cast — either way the
    // statement is a bound read/write, never injected SQL.
    try {
      await setHouseholdBudget(db, { householdId: probe, actorId: probe, monthlyBudget: BUDGET });
    } catch {
      /* tolerate a type/cast error — the point is that no injected statement ran */
    }

    assert.equal(await tableExists(db, "households"), true, "the households table survives the probe");
    assert.equal(await tableExists(db, "household_members"), true, "the household_members table survives the probe");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC4 — a handler on the validation boundary rejects bad input and takes the actor from
// the session. A route handler validates external input HERE (`parseBody`), then calls the
// owner-only data-access with the SESSION's user id as the actor (NEVER a body value). A
// rejected input maps to a 4xx Response and never reaches a query; a refusal (not the owner)
// maps to a 4xx too. This handler is a test fixture that EXERCISES the modules — it is not
// an implementation file.
// ===========================================================================

function setBudgetHandler(db: Db, sessionUserId: string): (req: Request) => Promise<Response> {
  // The body carries the household id and the new budget; the actor comes from the session.
  // The household id is validated to the uuid shape at the boundary (OBS-049), so a mis-shaped
  // id is rejected with a 4xx and never reaches a `WHERE id = $1`. The budget must be a
  // non-negative, bounded number.
  const schema = z.object({
    householdId: z.uuid(),
    monthlyBudget: z.number().nonnegative().max(1_000_000_000),
  });
  return async (req: Request): Promise<Response> => {
    try {
      const body = await parseBody(schema, req, { maxBytes: 4 * 1024 });
      const result = await setHouseholdBudget(db, {
        householdId: body.householdId,
        actorId: sessionUserId,
        monthlyBudget: body.monthlyBudget,
      });
      if (!result.ok) {
        // A refusal (not the owner) is a client error, reported honestly — never a silent no-op.
        return new Response(JSON.stringify({ error: result.reason }), { status: 403 });
      }
      return new Response(JSON.stringify({ monthlyBudget: result.monthlyBudget }), { status: 200 });
    } catch (err) {
      if (err instanceof HttpError) {
        return new Response(JSON.stringify({ error: "invalid input" }), { status: err.status });
      }
      // A non-HttpError escaping the boundary is an uncontrolled 500; surface it so a test
      // sees the raw-500 failure rather than a masked success.
      return new Response("internal error", { status: 500 });
    }
  };
}

function jsonRequest(body: string): Request {
  return new Request("https://warthog.com.au/api/household/budget", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

// A fully-valid request body, for the tests that vary one thing.
function validBody(householdId: string, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ householdId, monthlyBudget: BUDGET, ...overrides });
}

// A valid-uuid-shaped household id that does not exist (for the boundary tests that must not
// reach a real row).
const ABSENT_HOUSE = "99999999-9999-4999-8999-999999999999";

test("the handler rejects malformed JSON with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = setBudgetHandler(db, "session-user");

  const res = await handler(jsonRequest("{ not valid json"));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "malformed input must never reach a query");
});

test("the handler rejects an oversized body with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = setBudgetHandler(db, "session-user");

  // ~10 KiB body, well over the handler's 4 KiB cap: rejected by size before parse.
  const res = await handler(jsonRequest(validBody(ABSENT_HOUSE, { note: "a".repeat(10 * 1024) })));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "an oversized body must never reach a query");
});

test("the handler rejects a body missing the budget with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = setBudgetHandler(db, "session-user");

  const bad = JSON.parse(validBody(ABSENT_HOUSE)) as Record<string, unknown>;
  delete bad.monthlyBudget;
  const res = await handler(jsonRequest(JSON.stringify(bad)));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "a schema violation must never reach a query");
});

test("the handler rejects a mis-typed or negative budget with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = setBudgetHandler(db, "session-user");

  const asString = await handler(jsonRequest(validBody(ABSENT_HOUSE, { monthlyBudget: "lots" })));
  assert.ok(asString.status >= 400 && asString.status < 500, `expected a 4xx, got ${asString.status}`);

  const negative = await handler(jsonRequest(validBody(ABSENT_HOUSE, { monthlyBudget: -5 })));
  assert.ok(negative.status >= 400 && negative.status < 500, `expected a 4xx, got ${negative.status}`);

  assert.equal(db.calls.length, 0, "a mis-typed or negative budget must never reach a query");
});

test("the handler rejects a mis-shaped (non-uuid) household id with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = setBudgetHandler(db, "session-user");

  // An injection-shaped id is not a uuid, so it is rejected at the boundary (OBS-049) and
  // never reaches a `WHERE id = $1` cast.
  const probe = "h'); DROP TABLE households; --";
  const res = await handler(jsonRequest(validBody(probe)));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "a mis-shaped household id must never reach a query");
});

test("the handler takes the actor from the session, not the body", async () => {
  const db = await freshDb();
  try {
    const owner = await makeUser(db, "handler-owner");
    const attacker = await makeUser(db, "handler-attacker");
    const house = await createHousehold(db, { ownerId: owner });

    // The owner's session may set the budget.
    const ownerHandler = setBudgetHandler(db, owner);
    const ok = await ownerHandler(jsonRequest(validBody(house.id, { monthlyBudget: BUDGET })));
    assert.ok(ok.status >= 200 && ok.status < 300, `owner expected a 2xx, got ${ok.status}`);
    assert.equal((await getHouseholdForMember(db, owner))?.monthlyBudget, BUDGET, "the owner's set landed");

    // The attacker's session smuggles the owner's id in the body; the handler ignores it and
    // uses the SESSION id (the attacker), so the owner-only check refuses.
    const attackerHandler = setBudgetHandler(db, attacker);
    const refused = await attackerHandler(jsonRequest(validBody(house.id, { monthlyBudget: 999, actorId: owner, ownerId: owner })));
    assert.ok(refused.status >= 400 && refused.status < 500, `attacker expected a 4xx, got ${refused.status}`);
    assert.equal(
      (await getHouseholdForMember(db, owner))?.monthlyBudget,
      BUDGET,
      "the smuggled actor id is ignored — the budget is unchanged",
    );
  } finally {
    await db.close();
  }
});

test("the budget handler binds the household id as a parameter (never spliced)", async () => {
  const db = recordingDb();
  const handler = setBudgetHandler(db, "session-user");

  // A valid-uuid id that will not match any row in the recording db: it passes validation,
  // reaches the repo, and must be bound (not spliced) into the ownership-check statement.
  const res = await handler(jsonRequest(validBody(ABSENT_HOUSE)));
  assert.ok(res.status >= 400 && res.status < 500, "no owner row → a 4xx refusal");

  assert.ok(db.calls.length >= 1, "the handler reached a query");
  assert.ok(db.calls.some((c) => c.values.includes(ABSENT_HOUSE)), "the household id travels as a bound value");
  for (const call of db.calls) {
    assert.ok(!call.text.includes(ABSENT_HOUSE), "the id is bound, never concatenated into the SQL");
  }
});

// ===========================================================================
// AC5 — the repo reads no process.env: a decoy secret in the environment never lands in a
// stored or returned household row.
// ===========================================================================

test("the repo reads no process.env: a decoy secret in the environment never lands in a household row", async () => {
  const DECOY = "sk_live_DECOY_must_never_appear_in_warthog";
  const prev = process.env.WARTHOG_DECOY_SECRET;
  process.env.WARTHOG_DECOY_SECRET = DECOY;
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "ac5-env-owner");
    const bob = await makeUser(db, "ac5-env-member");
    const house = await createHousehold(db, { ownerId: alice, monthlyBudget: BUDGET });
    await addMember(db, { householdId: house.id, userId: bob });
    await setMemberLimit(db, { householdId: house.id, actorId: alice, userId: bob, monthlyLimit: LIMIT });

    assert.ok(!JSON.stringify(house).includes(DECOY), "no ambient env value is folded into a returned household");
    const members = await listMembers(db, house.id, alice);
    assert.ok(!JSON.stringify(members).includes(DECOY), "no ambient env value is folded into the member list");

    // Scan every cell of the two tables under test for the decoy (scoped narrowly — the same
    // value could legitimately live elsewhere if it were a real datum, which it is not).
    for (const relation of ["households", "household_members"]) {
      const all = await db.query(`SELECT * FROM ${relation}`);
      for (const row of all.rows) {
        for (const cell of Object.values(row)) {
          if (typeof cell === "string") {
            assert.ok(!cell.includes(DECOY), `no ambient env value is written to ${relation}`);
          }
        }
      }
    }
  } finally {
    await db.close();
    if (prev === undefined) delete process.env.WARTHOG_DECOY_SECRET;
    else process.env.WARTHOG_DECOY_SECRET = prev;
  }
});

// ===========================================================================
// Migration — the tables apply and a second run changes nothing.
// ===========================================================================

test("the households migration applies and re-running every migration changes nothing", async () => {
  const db = await freshDb();
  try {
    assert.equal(await tableExists(db, "households"), true, "the households table must exist after the project migrations");
    assert.equal(
      await tableExists(db, "household_members"),
      true,
      "the household_members table must exist after the project migrations",
    );

    const migrations = await loadMigrations();
    assert.ok(
      migrations.some((m) => m.name === "0039_households"),
      "db/migrations/0039_households.sql must be part of the project migrations",
    );

    // A second run over the same database applies nothing new and does not throw —
    // re-executing 0039's CREATE would throw "already exists", so an empty result AND no
    // throw together prove the migration's second run changes nothing.
    const again = await runMigrations(db, migrations);
    assert.deepEqual(again, [], "a second migration run must change nothing");
  } finally {
    await db.close();
  }
});
