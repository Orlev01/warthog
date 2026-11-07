// E15-S12 — Household page-data read (list-all) (`src/server/household/page-data.ts`).
//
// RED-first: the module does not exist yet, so importing `./page-data` throws and every
// test here fails (and `tsc --noEmit` reddens on the missing module) until the builder
// writes the minimum code to pass. That absence IS the point of test-first; do NOT
// implement anything to make these pass — the builder writes `page-data.ts` (and any
// storage primitive it needs, e.g. a "list pending invites" read) afterwards.
//
// These tests pin BEHAVIOUR (what the read RETURNS for the session user: their household
// with the member list, shared address, currency, budget, their OWN member limit, their
// address-follow choice, any pending ownership transfer and any pending invites; what it
// REFUSES to expose — any other member's private data; that a non-member of any household
// gets nothing; what a handler rejects; and that the session user id reaches the db
// BOUND), never the source text of the module — a later rename that preserves behaviour
// must not redden them.
//
// WHY this exists (brief "Household sharing" + access.who_can_use: "Household members see
// the shared household items (shared address, household budget totals, member list) but
// never another member's vault, cards, memory, skills, agents or activity details; the
// household owner additionally sets each member's spending limit"; design §4.1). The
// Household page needs ONE member-scoped read that sees the SHARED household items without
// exposing any other member's private data; it is distinct from the per-person reads and
// returns nothing for a user with no household.
//
// Every read is member-scoped by the GIVEN user id (the session's id, never a client
// value, INV-102). Most figures it reads — ids, roles, a budget, a limit, an ISO 4217
// code, a follow flag, an invited email — are PLAINTEXT METADATA (design §4.1); the ONE
// encrypted item is the household's shared postal address, a single DEK-encrypted row per
// household (one ciphertext, so one household key), which the read decrypts under the
// household OWNER's DEK, resolved through the injected `KeyWrapper` seam (read the owner's
// wrapped DEK from `users.wrapped_dek`, unwrap it) — exactly the vault / set-up-checklist
// page-data idiom. The read holds no key of its own and reads no `process.env` (INV-103):
// the db, the key-wrapper and the clock are all INJECTED seams.
//
// ---------------------------------------------------------------------------
// THE PINNED CONTRACT (chosen by the tester; the implementation conforms to it).
//
//   interface HouseholdMemberView {        // the member list — a ROSTER, never another
//     userId: string;                       //   member's private data (brief: members see
//     role: "owner" | "member";             //   "the member list", not each other's limits)
//   }
//
//   interface PendingInviteView {          // one still-open invite (unused + unexpired)
//     email: string;                        //   the invited email the owner typed
//     expiresAt: Date | string;             //   when the 7-day link lapses
//     // deliberately NO token and NO token hash — a credential never leaves the server
//   }
//
//   interface PendingTransferView { toUserId: string; }   // a pending ownership transfer
//
//   interface HouseholdPageData {
//     householdId: string;
//     ownerId: string;                      // the current owner (changes only on accept)
//     currency: string;                     // the household currency every figure is in
//     monthlyBudget: number | null;         // the shared monthly household budget (null until set)
//     members: HouseholdMemberView[];       // the roster incl. the owner
//     sharedAddress: SharedAddress | null;  // the ONE shared postal address (decrypted); null when unset
//     followChoice: boolean;                // the CALLER's own address-follow choice (false until set)
//     ownLimit: number | null;              // the CALLER's own per-member monthly limit (null until set)
//     pendingTransfer: PendingTransferView | null;   // a pending ownership transfer; null when none
//     pendingInvites: PendingInviteView[];  // still-open invites (unused + unexpired at clock.now())
//   }
//
//   readHouseholdPageData(userId, { db, keyWrapper, clock }): Promise<HouseholdPageData | null>
//     • resolves the caller's household FROM `userId` alone (no household id is ever
//       accepted from the client); returns null when the caller is in NO household. For a
//       member it returns the roster, the shared address (decrypted under the owner's DEK),
//       the household currency + budget, the caller's OWN limit + follow choice, any pending
//       transfer and any still-open invites — the SHARED items only, never another member's
//       vault / cards / spending / private data. Every underlying read binds `userId` (and
//       the owner id) as a parameter, so a value shaped like SQL travels as data.
//
// Acceptance criteria → tests:
//   AC1 — the caller's report carries the household (owner, currency, budget), the member
//         roster, the shared address, the caller's OWN limit + follow choice, any pending
//         transfer and any pending invites — read by the owner AND by a plain member.
//   AC2 — it exposes NO other member's vault / cards / spending / private data; the member
//         entries are a bare roster; a pending invite never leaks its token or token hash.
//   AC3 — scoped by the GIVEN user id: a member of another household gets their OWN household
//         (never the other's), and a person in no household gets null.
//   AC4 [obligation:validate-and-parameterize-input] (INV-102) — a handler rejects malformed
//        / oversized / mis-shaped input with a 4xx before any query, takes the user id from
//        the SESSION (never the body), and a SQL-injection probe in the user-id input reaches
//        the db as a BOUND value, never spliced into the SQL. The handler is a test fixture
//        (the intended usage), not an implementation file.
//   AC5 [obligation:secrets-from-env] (INV-103) — the read runs purely from its injected
//        seams and reads no `process.env`, so a decoy secret in the environment never lands
//        in the report.
//
// Every real-db test uses its own `freshDb()` (an isolated in-memory PGlite with the real
// migrations) and closes it in a `finally`, so tests share no state and leave no open handle.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";

import {
  readHouseholdPageData,
  type HouseholdPageData,
  type HouseholdMemberView,
} from "./page-data";
import { createUser } from "../db/users";
import {
  createHousehold,
  addMember,
  setMemberLimit,
  transferOwnership,
} from "../db/households";
import {
  setSharedAddress,
  setFollowChoice,
  type SharedAddress,
  type SharedAddressNotifier,
} from "../db/household-shared-address";
import { issueInvite, redeemInvite } from "../db/household-invites";
import { recordRelease, periodKeyFor, type PeriodKeys } from "../db/card-spend-ledger";
import { localAesKeyWrapper, type KeyWrapper } from "../crypto/key-wrapper";
import { fixedClock, type Clock } from "../seams/clock";
import { systemRandom } from "../seams/random";
import { freshDb } from "../../test/db";
import { type Db, type QueryResult } from "../db/index";
import { parseBody, HttpError } from "../http/validate";

// --- fixtures ----------------------------------------------------------------------

// The frozen instant every read reads time through (noon mid-month UTC), so an invite's
// 7-day window straddles it unambiguously.
const NOW = new Date("2026-11-15T12:00:00.000Z");

// Eight days before NOW: an invite issued then lapsed one day ago (issue + 7 days < NOW).
const EIGHT_DAYS_AGO = new Date(NOW.getTime() - 8 * 24 * 60 * 60 * 1000);

// The three period buckets NOW falls in, derived through the ledger's own `periodKeyFor`
// (the one source of truth for its bucket keys) — so a seeded release lands in NOW's month.
const KEYS_NOW: PeriodKeys = {
  day: periodKeyFor("day", NOW),
  week: periodKeyFor("week", NOW),
  month: periodKeyFor("month", NOW),
};

// A fixed 256-bit local KEK + its wrapper. The SAME wrapper wraps each person's DEK (stored
// as users.wrapped_dek) and is injected into the read, so the read unwraps the OWNER's DEK
// back to exactly the bytes a seeded shared address was encrypted under.
const KEK = Buffer.alloc(32, 7);
const keyWrapper: KeyWrapper = localAesKeyWrapper(KEK);

// An opaque agent-connection uuid for a seeded release (the ledger binds the column).
const CONN = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

// A marker baked into every seeded merchant: this read is household-governance only (no
// spending entries), so this substring must never appear anywhere in a report.
const MERCHANT_MARKER = "SECRET-MERCHANT-must-never-appear";

// A no-op notifier for seeding the shared address (the edit notifies other members; the
// read never notifies). The read under test is given no notifier at all.
const noNotify: SharedAddressNotifier = { async notifyMember() {} };

// Create a person with a REAL wrapped DEK (a fresh 256-bit key wrapped under the shared
// KEK). Returns the id and the raw DEK so a test can seed the shared address under the
// owner's own key — the key the read later unwraps from users.wrapped_dek.
async function makeUser(db: Db, who: string): Promise<{ id: string; dek: Uint8Array }> {
  const dek = randomBytes(32);
  const wrappedDek = await keyWrapper.wrap(dek);
  const user = await createUser(db, { email: `${who}@people.example`, wrappedDek });
  return { id: user.id, dek };
}

// Record one approved card release this month for `userId`, counting toward `householdId`.
// The merchant carries the marker so an absence check proves the read never surfaces it.
async function seedRelease(
  db: Db,
  opts: { userId: string; householdId: string },
): Promise<string> {
  const stored = await recordRelease(db, {
    userId: opts.userId,
    connectionId: CONN,
    householdId: opts.householdId,
    amount: 42,
    currency: "AUD",
    merchant: MERCHANT_MARKER,
    periodKeys: KEYS_NOW,
  });
  return stored.id;
}

// Find a roster entry by user id (order is not asserted — a report must not depend on it).
function memberOf(data: HouseholdPageData, userId: string): HouseholdMemberView | undefined {
  return data.members.find((m) => m.userId === userId);
}

// ===========================================================================
// AC1 — the caller's report carries the household, the roster, the shared address, the
// caller's OWN limit + follow choice, any pending transfer and any pending invites.
// ===========================================================================

test("the owner's report carries the household, roster, shared address, own limit, follow choice, pending transfer and pending invites", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "ac1-owner");
    const bob = await makeUser(db, "ac1-member");
    const carol = await makeUser(db, "ac1-transfer-target");

    const house = await createHousehold(db, { ownerId: alice.id, currency: "AUD", monthlyBudget: 1200 });
    const hid = house.id;
    await addMember(db, { householdId: hid, userId: bob.id });
    await addMember(db, { householdId: hid, userId: carol.id });

    // The owner sets her OWN limit (300) and Bob's (200) — only her own is surfaced as ownLimit.
    await setMemberLimit(db, { householdId: hid, actorId: alice.id, userId: alice.id, monthlyLimit: 300 });
    await setMemberLimit(db, { householdId: hid, actorId: alice.id, userId: bob.id, monthlyLimit: 200 });

    // The owner follows the household address, and sets the ONE shared address under her DEK.
    await setFollowChoice(db, { householdId: hid, userId: alice.id, follow: true });
    await setSharedAddress(
      db,
      { householdId: hid, actorId: alice.id, current: "1 Shared St, Sydney", upcoming: "2 New Rd, Perth", movingOn: "2027-01-01" },
      alice.dek,
      { notify: noNotify },
    );

    // A pending ownership transfer to Carol, and one still-open invite.
    assert.ok((await transferOwnership(db, { householdId: hid, actorId: alice.id, toUserId: carol.id })).ok);
    const invite = await issueInvite(db, { householdId: hid, email: "newcomer@invites.example" }, { clock: fixedClock(NOW), random: systemRandom });

    const data: HouseholdPageData | null = await readHouseholdPageData(alice.id, { db, keyWrapper, clock: fixedClock(NOW) });

    assert.ok(data, "the owner gets a report");
    assert.equal(data.householdId, hid);
    assert.equal(data.ownerId, alice.id, "the current owner (unchanged by a pending transfer)");
    assert.equal(data.currency, "AUD", "the household currency");
    assert.equal(data.monthlyBudget, 1200, "the shared monthly household budget");

    // The roster: all three, incl. the owner, each with a role.
    assert.equal(data.members.length, 3, "the roster lists every member incl. the owner");
    assert.equal(memberOf(data, alice.id)?.role, "owner");
    assert.equal(memberOf(data, bob.id)?.role, "member");
    assert.equal(memberOf(data, carol.id)?.role, "member");

    // The caller's OWN limit + follow choice.
    assert.equal(data.ownLimit, 300, "the caller's own per-member limit (not Bob's 200)");
    assert.equal(data.followChoice, true, "the caller's own address-follow choice");

    // The shared address, decrypted (round-trips through the owner's DEK).
    assert.ok(data.sharedAddress, "the shared address is present");
    assert.equal(data.sharedAddress.current, "1 Shared St, Sydney");
    assert.equal(data.sharedAddress.upcoming, "2 New Rd, Perth");

    // The pending ownership transfer.
    assert.ok(data.pendingTransfer, "a pending transfer is present");
    assert.equal(data.pendingTransfer.toUserId, carol.id, "the transfer's accepting target");

    // The pending invite — by email, never the token.
    assert.equal(data.pendingInvites.length, 1, "one still-open invite");
    assert.equal(data.pendingInvites[0].email, "newcomer@invites.example");
    assert.ok(data.pendingInvites[0].expiresAt != null, "the invite carries its expiry");
    const serialized = JSON.stringify(data);
    assert.ok(!serialized.includes(invite.token), "the raw invite token never leaves the server");
    assert.ok(
      !serialized.includes(createHash("sha256").update(invite.token).digest("hex")),
      "the invite token hash never leaves the server",
    );
  } finally {
    await db.close();
  }
});

test("a plain member gets the shared household items: roster, shared address, their OWN limit + follow choice, and the pending transfer", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "ac1b-owner");
    const bob = await makeUser(db, "ac1b-member");

    const house = await createHousehold(db, { ownerId: alice.id, currency: "NZD", monthlyBudget: 800 });
    const hid = house.id;
    await addMember(db, { householdId: hid, userId: bob.id });
    await setMemberLimit(db, { householdId: hid, actorId: alice.id, userId: bob.id, monthlyLimit: 150 });
    await setFollowChoice(db, { householdId: hid, userId: bob.id, follow: true });

    // The OWNER sets the shared address (encrypted under the owner's DEK) — a NON-owner member
    // must still be able to read its content: the read decrypts under the owner's key.
    await setSharedAddress(
      db,
      { householdId: hid, actorId: alice.id, current: "7 Family Ave, Auckland" },
      alice.dek,
      { notify: noNotify },
    );
    assert.ok((await transferOwnership(db, { householdId: hid, actorId: alice.id, toUserId: bob.id })).ok);

    const data = await readHouseholdPageData(bob.id, { db, keyWrapper, clock: fixedClock(NOW) });

    assert.ok(data, "a plain member gets a report");
    assert.equal(data.householdId, hid);
    assert.equal(data.ownerId, alice.id, "the owner (Bob is only a pending target until he accepts)");
    assert.equal(data.currency, "NZD");
    assert.equal(data.monthlyBudget, 800);
    assert.equal(data.members.length, 2, "the roster incl. the owner");
    assert.equal(data.ownLimit, 150, "the member's OWN limit");
    assert.equal(data.followChoice, true, "the member's OWN follow choice");

    assert.ok(data.sharedAddress, "a plain member sees the shared address content");
    assert.equal(data.sharedAddress.current, "7 Family Ave, Auckland", "decrypted under the owner's DEK");
    assert.equal(data.sharedAddress.upcoming, null, "no upcoming address was set");

    assert.ok(data.pendingTransfer, "a member sees the pending transfer");
    assert.equal(data.pendingTransfer.toUserId, bob.id);
  } finally {
    await db.close();
  }
});

test("an empty household reads as sensible defaults: null budget, null address, no follow, null own limit, no transfer, no invites", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "ac1c-owner");
    const house = await createHousehold(db, { ownerId: alice.id, currency: "AUD" });

    const data = await readHouseholdPageData(alice.id, { db, keyWrapper, clock: fixedClock(NOW) });

    assert.ok(data, "the owner of an otherwise-empty household still gets a report");
    assert.equal(data.householdId, house.id);
    assert.equal(data.currency, "AUD");
    assert.equal(data.monthlyBudget, null, "no budget set yet");
    assert.equal(data.sharedAddress, null, "no shared address set yet");
    assert.equal(data.followChoice, false, "the follow choice defaults to false (keep own)");
    assert.equal(data.ownLimit, null, "no own limit set yet");
    assert.equal(data.pendingTransfer, null, "no pending transfer");
    assert.deepEqual(data.pendingInvites, [], "no pending invites");
    assert.equal(data.members.length, 1, "just the owner");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC1 (invites) — the pending-invite list shows still-open invites by email, excludes used
// and expired ones, and never leaks a token.
// ===========================================================================

test("pending invites: lists only unused + unexpired invites, by email, excluding expired and redeemed ones", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "ac1d-owner");
    const redeemer = await makeUser(db, "ac1d-redeemer");
    const house = await createHousehold(db, { ownerId: alice.id, currency: "AUD" });
    const hid = house.id;

    // (a) A still-open invite (issued at NOW, lapses in 7 days).
    const open = await issueInvite(db, { householdId: hid, email: "open@invites.example" }, { clock: fixedClock(NOW), random: systemRandom });
    // (b) An expired invite (issued 8 days ago, so it lapsed one day before NOW).
    await issueInvite(db, { householdId: hid, email: "expired@invites.example" }, { clock: fixedClock(EIGHT_DAYS_AGO), random: systemRandom });
    // (c) A redeemed invite (used): issue, then redeem it with a signed-in user.
    const used = await issueInvite(db, { householdId: hid, email: "used@invites.example" }, { clock: fixedClock(NOW), random: systemRandom });
    assert.ok((await redeemInvite(db, { token: used.token, userId: redeemer.id }, { clock: fixedClock(NOW) })).ok);

    const data = await readHouseholdPageData(alice.id, { db, keyWrapper, clock: fixedClock(NOW) });

    assert.ok(data);
    const emails = data.pendingInvites.map((i) => i.email).sort();
    assert.deepEqual(emails, ["open@invites.example"], "only the still-open invite; the expired and redeemed ones are excluded");

    const serialized = JSON.stringify(data.pendingInvites);
    for (const inv of [open, used]) {
      assert.ok(!serialized.includes(inv.token), "no raw invite token appears");
      assert.ok(!serialized.includes(createHash("sha256").update(inv.token).digest("hex")), "no invite token hash appears");
    }
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC2 — exposes NO other member's vault, cards, spending entries or private data; the roster
// entries are bare; read by the owner OR a plain member.
// ===========================================================================

test("the report exposes the shared items only — never a member's spending entry, and the roster carries no private fields", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "ac2-owner");
    const bob = await makeUser(db, "ac2-member");
    const hid = (await createHousehold(db, { ownerId: alice.id, currency: "AUD", monthlyBudget: 500 })).id;
    await addMember(db, { householdId: hid, userId: bob.id });

    // Both members have spending this month; the Household page is governance-only, so NO
    // release (its marker merchant or its id) may appear — not even for the reader's own.
    const aliceReleaseId = await seedRelease(db, { userId: alice.id, householdId: hid });
    const bobReleaseId = await seedRelease(db, { userId: bob.id, householdId: hid });

    for (const [who, reader] of [["owner", alice.id], ["member", bob.id]] as const) {
      const data = await readHouseholdPageData(reader, { db, keyWrapper, clock: fixedClock(NOW) });
      assert.ok(data, `${who} gets a report`);

      const serialized = JSON.stringify(data);
      assert.ok(!serialized.includes(MERCHANT_MARKER), `${who}: no merchant is surfaced anywhere`);
      assert.ok(!serialized.includes(aliceReleaseId), `${who}: no release id is surfaced (alice)`);
      assert.ok(!serialized.includes(bobReleaseId), `${who}: no release id is surfaced (bob)`);
      // A member's own account email is private — the roster is keyed by id, not email.
      assert.ok(!serialized.includes("@people.example"), `${who}: no member account email is surfaced`);

      // The top-level shape carries no spending / card / vault collection.
      const raw = data as unknown as Record<string, unknown>;
      for (const forbidden of ["releases", "spending", "spendToDate", "cards", "vault", "fields", "entries", "memories", "skills", "agents"]) {
        assert.equal(raw[forbidden], undefined, `${who}: the report has no "${forbidden}" field`);
      }
      // Each roster entry is a bare {userId, role} — no email, card, address or spend.
      for (const m of data.members) {
        assert.equal(typeof m.userId, "string", `${who}: a roster entry has a user id`);
        assert.ok(m.role === "owner" || m.role === "member", `${who}: a roster entry has a role`);
        const rawMember = m as unknown as Record<string, unknown>;
        for (const forbidden of ["email", "cards", "card", "vault", "address", "releases", "spending", "spendToDate", "entries"]) {
          assert.equal(rawMember[forbidden], undefined, `${who}: a roster entry has no "${forbidden}" field`);
        }
      }
    }
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC3 — scoped by the GIVEN user id: a member of another household never sees it; a person
// in no household gets null.
// ===========================================================================

test("the report is scoped by the GIVEN user id: a member of another household sees only their OWN", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "ac3-alice");
    const bob = await makeUser(db, "ac3-bob");
    const carol = await makeUser(db, "ac3-carol");

    // Household X (Alice owner, Bob member) with a budget, a shared address and an invite.
    const x = (await createHousehold(db, { ownerId: alice.id, currency: "AUD", monthlyBudget: 1000 })).id;
    await addMember(db, { householdId: x, userId: bob.id });
    await setSharedAddress(db, { householdId: x, actorId: alice.id, current: "99 Other St, Darwin" }, alice.dek, { notify: noNotify });
    await issueInvite(db, { householdId: x, email: "x-invitee@invites.example" }, { clock: fixedClock(NOW), random: systemRandom });

    // A SEPARATE household Y (Carol alone) with its own budget.
    const y = (await createHousehold(db, { ownerId: carol.id, currency: "USD", monthlyBudget: 777 })).id;

    // Carol reads HER OWN household, never Alice's — even though both exist in one db.
    const forCarol = await readHouseholdPageData(carol.id, { db, keyWrapper, clock: fixedClock(NOW) });
    assert.ok(forCarol, "Carol gets her own household");
    assert.equal(forCarol.householdId, y, "resolved from Carol's user id, not a client-supplied id");
    assert.equal(forCarol.monthlyBudget, 777, "Carol's budget, never Alice's");
    assert.equal(forCarol.currency, "USD");
    assert.equal(forCarol.members.length, 1, "only Carol is in her household");
    assert.equal(forCarol.sharedAddress, null, "Carol's household has no shared address");
    assert.deepEqual(forCarol.pendingInvites, [], "Alice's invite is not Carol's");

    const serialized = JSON.stringify(forCarol);
    assert.ok(!serialized.includes(x), "the other household's id never leaks into Carol's report");
    assert.ok(!serialized.includes(alice.id), "Alice's user id never leaks");
    assert.ok(!serialized.includes(bob.id), "Bob's user id never leaks");
    assert.ok(!serialized.includes("99 Other St, Darwin"), "the other household's shared address never leaks");
    assert.ok(!serialized.includes("x-invitee@invites.example"), "the other household's invite never leaks");
  } finally {
    await db.close();
  }
});

test("a person in no household gets null — there is no household to expose", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "ac3b-alice");
    const dave = await makeUser(db, "ac3b-dave");
    await createHousehold(db, { ownerId: alice.id, currency: "AUD" }); // Dave belongs to none.

    const forDave = await readHouseholdPageData(dave.id, { db, keyWrapper, clock: fixedClock(NOW) });
    assert.equal(forDave, null, "a non-member of any household gets no report");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC4 — a handler on the validation boundary rejects malformed / oversized / mis-shaped
// input with a 4xx before any query, and takes the user id from the SESSION, never the body.
// The handler is a test fixture (the intended usage), not an implementation file.
// ===========================================================================

function jsonRequest(body: string): Request {
  return new Request("https://warthog.com.au/household", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

function householdPageHandler(
  deps: { db: Db; keyWrapper: KeyWrapper; clock: Clock },
  sessionUserId: string,
): (req: Request) => Promise<Response> {
  // The read is driven ENTIRELY by the session user id — no household id or user id is ever
  // taken from the client. The body must still be a well-formed, size-capped JSON object;
  // anything mis-shaped / malformed / oversized is rejected with a 4xx before any query, and
  // any smuggled field is ignored (never used to pick a household).
  const schema = z.object({});
  return async (req: Request): Promise<Response> => {
    try {
      await parseBody(schema, req, { maxBytes: 4 * 1024 });
      const data = await readHouseholdPageData(sessionUserId, deps);
      // A NON-secret summary: whether the session user is in a household and the roster size.
      return new Response(
        JSON.stringify({ inHousehold: data !== null, memberCount: data?.members.length ?? 0 }),
        { status: 200 },
      );
    } catch (err) {
      if (err instanceof HttpError) {
        return new Response(JSON.stringify({ error: "invalid input" }), { status: err.status });
      }
      return new Response("internal error", { status: 500 });
    }
  };
}

// A db seam stand-in that records every call instead of running it (so a test can prove WHAT
// reached the query layer and HOW), returning no rows. Satisfies `Db` structurally.
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

test("the handler rejects malformed JSON with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = householdPageHandler({ db, keyWrapper, clock: fixedClock(NOW) }, "session-user");

  const res = await handler(jsonRequest("{ not valid json"));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "malformed input must never reach the read / a query");
});

test("the handler rejects an oversized body with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = householdPageHandler({ db, keyWrapper, clock: fixedClock(NOW) }, "session-user");

  // ~10 KiB body, well over the handler's 4 KiB cap: rejected by size before parse.
  const res = await handler(jsonRequest(JSON.stringify({ pad: "a".repeat(10 * 1024) })));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "an oversized body must never reach the read / a query");
});

test("the handler rejects a mis-shaped (non-object) body with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = householdPageHandler({ db, keyWrapper, clock: fixedClock(NOW) }, "session-user");

  const asArray = await handler(jsonRequest(JSON.stringify([1, 2, 3])));
  const asString = await handler(jsonRequest(JSON.stringify("not-an-object")));
  const asNumber = await handler(jsonRequest(JSON.stringify(42)));

  for (const res of [asArray, asString, asNumber]) {
    assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  }
  assert.equal(db.calls.length, 0, "a mis-shaped body must never reach the read / a query");
});

test("the handler resolves the SESSION user's household, never a body-smuggled one", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "handler-alice");
    const bob = await makeUser(db, "handler-bob");
    const carol = await makeUser(db, "handler-carol");
    // Bob is a member of Alice's household (2 members); Carol is in no household.
    const hid = (await createHousehold(db, { ownerId: alice.id, currency: "AUD" })).id;
    await addMember(db, { householdId: hid, userId: bob.id });

    // Session is Bob; the body smuggles Carol's id and a household id. The handler must ignore
    // the body and resolve BOB's household (2 members), never Carol's (none).
    const asBob = householdPageHandler({ db, keyWrapper, clock: fixedClock(NOW) }, bob.id);
    const bobRes = await asBob(jsonRequest(JSON.stringify({ userId: carol.id, householdId: "deadbeef" })));
    assert.equal(bobRes.status, 200, "a well-formed body is accepted");
    const bobBody = (await bobRes.json()) as { inHousehold: boolean; memberCount: number };
    assert.equal(bobBody.inHousehold, true, "Bob's household (the session user's), not the smuggled Carol");
    assert.equal(bobBody.memberCount, 2, "Alice + Bob — resolved from the session id, not the body");

    // Session is Carol; even smuggling Bob's id, she resolves her OWN (empty) household state.
    const asCarol = householdPageHandler({ db, keyWrapper, clock: fixedClock(NOW) }, carol.id);
    const carolRes = await asCarol(jsonRequest(JSON.stringify({ userId: bob.id })));
    assert.equal(carolRes.status, 200);
    const carolBody = (await carolRes.json()) as { inHousehold: boolean; memberCount: number };
    assert.equal(carolBody.inHousehold, false, "Carol's own state (no household), never the smuggled Bob");
    assert.equal(carolBody.memberCount, 0);
  } finally {
    await db.close();
  }
});

test("the session user id reaches the db as a BOUND parameter, never spliced into the SQL", async () => {
  const db = recordingDb();

  const userProbe = "u'; DROP TABLE household_members; --";

  // The read short-circuits on the (empty) recording db (no household / no user row); we only
  // care that whatever reached the db was bound. Swallow any resulting rejection.
  await readHouseholdPageData(userProbe, { db, keyWrapper, clock: fixedClock(NOW) }).catch(() => undefined);

  assert.ok(db.calls.length >= 1, "the read issues at least one query");
  const bound = db.calls.flatMap((c) => c.values);
  assert.ok(bound.includes(userProbe), "the session user id travels as a bound value");
  for (const call of db.calls) {
    assert.ok(!call.text.includes(userProbe), "the user id is bound, never concatenated into the SQL");
    assert.ok(!call.text.includes("DROP TABLE"), "no injected statement appears in the SQL text");
  }
});

// ===========================================================================
// AC5 — the read runs purely from its injected seams and reads no process.env, so a decoy
// secret in the environment never lands in the report.
// ===========================================================================

test("the read reads no process.env: a decoy secret in the environment never appears in the report", async () => {
  const DECOY = "sk_live_DECOY_must_never_appear_in_warthog";
  const prev = process.env.WARTHOG_DECOY_SECRET;
  process.env.WARTHOG_DECOY_SECRET = DECOY;
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "ac5-owner");
    const bob = await makeUser(db, "ac5-member");
    const hid = (await createHousehold(db, { ownerId: alice.id, currency: "AUD", monthlyBudget: 500 })).id;
    await addMember(db, { householdId: hid, userId: bob.id });
    await setSharedAddress(db, { householdId: hid, actorId: alice.id, current: "5 Env St, Hobart" }, alice.dek, { notify: noNotify });

    // The read is given ONLY its injected seams — no config object, no env — and still
    // assembles the report, proving it reads configuration from injected seams alone.
    const data = await readHouseholdPageData(bob.id, { db, keyWrapper, clock: fixedClock(NOW) });

    assert.ok(data, "the read works purely from its injected seams");
    assert.equal(data.currency, "AUD");
    assert.ok(data.sharedAddress, "the shared address decrypts under the owner's injected DEK");
    assert.ok(!JSON.stringify(data).includes(DECOY), "no ambient env value is folded into the report");
  } finally {
    await db.close();
    if (prev === undefined) delete process.env.WARTHOG_DECOY_SECRET;
    else process.env.WARTHOG_DECOY_SECRET = prev;
  }
});
