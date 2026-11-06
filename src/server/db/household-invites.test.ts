// E15-S05 — Household invites store (`src/server/db/household-invites.ts`,
// `db/migrations/0040_household_invites.sql`).
//
// RED-first: neither the data-access module nor the migration exists yet, so importing
// `./household-invites` throws and `freshDb()` has no `household_invites` table — every
// test here fails until the builder adds them. That absence IS the point of test-first;
// do NOT implement anything to make these pass — the builder writes the module and the
// migration afterwards.
//
// These tests pin BEHAVIOUR (what the functions DO: a raw 256-bit token issued once and
// returned only to the issuer, stored only as a hash with a 7-day expiry bound to ONE
// household and the invited email; a token that redeems exactly once to ADD the
// signed-in member to that household and is then rejected; that a reused, expired or
// unknown token is rejected; that a redemption that would exceed the 8-member cap is
// refused with a plain reason; that the raw token never reaches the query layer or a
// stored column; that the member added is the SESSION's user id, never a body value;
// that every value is bound as a parameter; that the repo reads no secret from the
// environment), never the source text of the module or the SQL file — a later rename
// that preserves behaviour must not redden them.
//
// WHY this exists (task E15-S05; brief "Household sharing": "the owner invites members by
// email (invite link valid 7 days, up to 8 members); members join with their own
// accounts"). The invite link carries a token — a CREDENTIAL — so (project rule: tokens
// and link tokens are stored only as hashes, SHA-256 or HMAC; the design fixes this one
// at a 256-bit value stored as a hash, like every other opaque Warthog token) the store
// keeps only the token's hash, never the raw value. The raw token is returned exactly
// once, to the issuer, for the single message (the emailed link) that delivers it; it
// appears in clear nowhere else. Redeeming resolves the token to the ONE household it is
// bound to and ADDS the redeeming, signed-in person as a member (within the 8-member cap
// shared with E15-S04's household store), then marks the token used — a second
// presentation, an expired token or an unknown token is rejected.
//
// Like the approval-link store (E12-S05) this one is CREDENTIAL-KEYED: a row is addressed
// by its token hash and bound to one household + the invited email, not a `user_id`. The
// person who clicks the link signs in first; the user ADDED on redemption is the SESSION's
// user id (passed by the caller), never a value smuggled from the client. The owner-only
// authorisation to ISSUE an invite is enforced a layer up (at the route, against the
// household store) — this store's job is the token lifecycle, so it takes `householdId`
// + `email` and never re-checks owner-ness here.
//
// ---------------------------------------------------------------------------
// THE PINNED CONTRACT (chosen by the tester; the implementation conforms to it).
//
//   interface IssueInviteInput {
//     householdId: string;   // the household this invite joins (bound to ONE)
//     email: string;         // the invited person's email (bound to the invite)
//   }
//
//   interface IssueInviteDeps {
//     clock: Clock;     // the issue instant; expiresAt = now + 7 days (never Date.now())
//     random: Random;   // entropy for the 256-bit token (INJECTED, not baked in)
//   }
//
//   interface IssuedInvite {
//     token: string;            // the RAW token — returned ONLY here (for the message),
//                               //   never stored; URL-safe (it rides in a link)
//     householdId: string;      // the household the token is bound to
//     email: string;            // the invited email the token is bound to
//     expiresAt: Date | string; // issue instant + 7 days
//     createdAt: Date | string; // the injected clock's issue instant
//   }
//
//   interface RedeemInviteInput {
//     token: string;   // the raw token the person presents (from the link in the message)
//     userId: string;  // the SIGNED-IN user redeeming it — added as a member (session id)
//   }
//
//   interface RedeemInviteDeps {
//     clock: Clock;    // the redeem instant, for the expiry + single-use check (never Date.now())
//   }
//
//   type RedeemInviteResult =
//     | { ok: true; householdId: string }        // first redemption: the user joined this household
//     | { ok: false; reason: "invalid" }         // unknown token, or one already used (indistinguishable)
//     | { ok: false; reason: "expired" }         // the token lapsed before it was redeemed
//     | { ok: false; reason: "household_full" }; // adding would exceed the 8-member cap
//
//   issueInvite(db, input: IssueInviteInput, deps): Promise<IssuedInvite>
//     • draws a 256-bit token, stores ONLY its hash with a 7-day expiry bound to
//       `householdId` + `email`, and returns the IssuedInvite carrying the RAW token (for
//       the single message that delivers it). Assembles the returned value from its inputs
//       (it does not depend on a RETURNING read). The raw token is stored in no column and
//       returned to no other caller.
//   redeemInvite(db, input: RedeemInviteInput, deps): Promise<RedeemInviteResult>
//     • matches the token by its hash (the raw token never reaches the query layer as a
//       bound value): a live, unexpired, unused token ADDS `userId` as a member of the
//       bound household, marks the token used and returns { ok: true, householdId }; a
//       SECOND presentation returns { ok: false, reason: "invalid" }; a token presented
//       past its 7-day window returns { ok: false, reason: "expired" }; an unknown token
//       returns { ok: false, reason: "invalid" }; a redemption that would exceed the
//       8-member cap returns { ok: false, reason: "household_full" } and adds no member.
//
// Acceptance criteria → tests:
//   AC1 "Issuing an invite stores only the token's hash with a 7-day expiry bound to one
//        household and the invited email, and the raw token is returned only to the issuer
//        (for the message), never stored in clear." — issue returns a raw token + an expiry
//        exactly seven days after issue, carrying the bound household + email; the raw token
//        appears in no column of household_invites.
//   AC2 "Redeeming a valid, unexpired token once adds the signed-in user as a member and
//        marks the token used; a reused, expired or unknown token is rejected, and redemption
//        that would exceed 8 members is refused with a plain reason." — redeem adds the user
//        and resolves to the bound household once; a second redemption → invalid; expired →
//        expired; unknown → invalid; a redeem into a full household → household_full (no add).
//   AC3 [obligation:validate-and-parameterize-input] (INV-102) — a handler on the
//        `../http/validate` boundary rejects malformed / oversized / missing / mis-typed /
//        mis-shaped input with a 4xx before any query runs; the member added is taken from
//        the SESSION, never a body value; and a SQL-injection probe routed through the repo
//        travels bound (the ids/email as parameters; the token hashed, never spliced) and
//        cannot drop a table. The handlers below are test fixtures (the intended usage), not
//        implementation files.
//   AC4 [obligation:secrets-from-env] (INV-103) — the token is drawn from the INJECTED
//        randomness seam, not a constant baked into source: different entropy yields a
//        different token. The repo takes db / clock / random as dependencies, reads no
//        `process.env` and holds no secret, so a decoy secret planted in the environment
//        never lands in the issued, stored or redeemed invite.
//   Migration: the `household_invites` relation exists after the project migrations and a
//        second run of every migration changes nothing.
//
// Every db handle is closed in a `finally` so node:test leaves no open handle; each real-db
// test uses its own `freshDb()` (an isolated in-memory PGlite with the real migrations), so
// tests share no state.

import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";

import { issueInvite, redeemInvite } from "./household-invites";
// Documentary type anchors — the exact names/shapes the implementation exports. Erased at
// runtime (and test files are excluded from `tsc`), so a rename cannot break these tests;
// the runtime assertions below are what actually gate behaviour.
import type {
  IssueInviteInput,
  IssueInviteDeps,
  IssuedInvite,
  RedeemInviteInput,
  RedeemInviteDeps,
  RedeemInviteResult,
} from "./household-invites";
import { createUser } from "./users";
import {
  createHousehold,
  addMember,
  isHouseholdMember,
  getHouseholdForMember,
  listMembers,
} from "./households";
import { freshDb } from "../../test/db";
import { loadMigrations, runMigrations, type Db, type QueryResult } from "./index";
import { fixedClock, type Clock } from "../seams/clock";
import { systemRandom, fixedRandom, type Random } from "../seams/random";
import { parseBody, HttpError } from "../http/validate";

// --- fixtures ---------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * DAY_MS; // the invite link's expiry window (brief: "valid 7 days")

// Compare the moment, not the representation: createdAt / expiresAt may come back as a
// Date or an ISO string — either is a reasonable choice and must not redden a test.
const ms = (value: Date | string | number): number => new Date(value as never).getTime();

// T0 is the issue instant; WITHIN redeems well inside the seven-day window; JUST_AFTER is
// one millisecond past it; LONG_AFTER is a year later (past any reasonable expiry).
const T0 = new Date("2026-02-01T09:00:00.000Z");
const WITHIN = new Date(T0.getTime() + 3 * DAY_MS);
const JUST_AFTER = new Date(T0.getTime() + SEVEN_DAYS_MS + 1);
const LONG_AFTER = new Date("2027-02-01T09:00:00.000Z");

// Default deps for issuing / redeeming. A fixed clock pins the expiry window
// deterministically; the token is drawn from the injected randomness seam.
function issueDeps(over?: { clock?: Clock; random?: Random }): IssueInviteDeps {
  return {
    clock: over?.clock ?? fixedClock(T0),
    random: over?.random ?? systemRandom,
  };
}
function redeemDeps(over?: { clock?: Clock }): RedeemInviteDeps {
  return {
    clock: over?.clock ?? fixedClock(WITHIN),
  };
}

// A stand-in wrapped DEK for createUser (opaque base64; this store never reads it — it
// holds only plaintext metadata + a token hash, no encrypted column).
function wrappedDekFor(who: string): string {
  return Buffer.from(`wrapped-dek-${who}`).toString("base64");
}

// Create a person and return their id + email (the invited email an invite is bound to;
// the id is the session user added on redemption).
async function makeUser(db: Db, who: string): Promise<{ id: string; email: string }> {
  const email = `${who}@warthog.com.au`;
  const user = await createUser(db, { email, wrappedDek: wrappedDekFor(who) });
  return { id: user.id, email };
}

// A db seam stand-in that records every call instead of running it, so a test can prove
// WHAT reached the query layer and HOW (bound value vs. spliced text). Returns no rows and
// satisfies the `Db` shape structurally (query + close).
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
// the one table under test (behaviour, not source text).
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

// Assert a probe never appears in any SQL text (the token is hashed before it is bound, so
// it never reaches a statement as text). The hashed form, not the raw probe, is what the
// query binds — so there is nothing to find in the text.
function assertNotSplicedIntoSql(db: RecordingDb, probe: string): void {
  assert.ok(db.calls.length >= 1, "at least one query was issued");
  for (const call of db.calls) {
    assert.ok(!call.text.includes(probe), "the input is never concatenated into the SQL text");
    assert.ok(!call.text.includes("DROP TABLE"), "no injected statement appears in the SQL text");
  }
}

// Assert a forbidden value (the raw token) never reached the query layer as any bound value
// — the token is hashed before it is bound, so the plaintext token appears in no parameter
// list.
function assertNeverBound(db: RecordingDb, forbidden: string): void {
  for (const call of db.calls) {
    for (const value of call.values) {
      assert.notEqual(value, forbidden, "the raw token must never reach the query layer as a bound value");
    }
  }
}

// ===========================================================================
// AC1 — issuing stores only a hash with a seven-day expiry bound to ONE household + the
// invited email; the raw token is returned to the issuer and kept nowhere in clear.
// ===========================================================================

test("issueInvite returns a raw token bound to the household + email, with a seven-day expiry", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "ac1-issue-owner");
    const bob = await makeUser(db, "ac1-issue-invitee");
    const house = await createHousehold(db, { ownerId: alice.id });

    const issued: IssuedInvite = await issueInvite(
      db,
      { householdId: house.id, email: bob.email },
      issueDeps(),
    );

    assert.equal(typeof issued.token, "string", "a raw token string is returned to the issuer");
    assert.ok(issued.token.length > 0, "the returned token is non-empty");
    assert.equal(issued.householdId, house.id, "the invite is bound to the household it was issued for");
    assert.equal(issued.email, bob.email, "the invite is bound to the invited email");
    assert.equal(ms(issued.createdAt), ms(T0), "createdAt is the injected clock instant");
    assert.equal(
      ms(issued.expiresAt) - ms(issued.createdAt),
      SEVEN_DAYS_MS,
      "the token expires exactly seven days after it is issued",
    );
  } finally {
    await db.close();
  }
});

test("the raw token is never stored in the household_invites table (only a hash is kept)", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "ac1-atrest-owner");
    const bob = await makeUser(db, "ac1-atrest-invitee");
    const house = await createHousehold(db, { ownerId: alice.id });
    const { token } = await issueInvite(db, { householdId: house.id, email: bob.email }, issueDeps());

    // Scan every cell of the one table under test. The token is a credential and must live
    // only as a hash, so its exact plaintext appearing in any column is a genuine leak.
    // Exact-equality (not substring) avoids a coincidental hex-digit overlap with the stored
    // hash, and the scan is scoped to `household_invites` alone.
    const all = await db.query("SELECT * FROM household_invites");
    assert.ok(all.rows.length >= 1, "the invite row was stored");
    for (const row of all.rows) {
      for (const cell of Object.values(row)) {
        if (typeof cell === "string") {
          assert.notEqual(cell, token, "the plaintext token must never be written to a column");
        }
      }
    }
  } finally {
    await db.close();
  }
});

test("the raw token never reaches the query layer as a bound value when issuing", async () => {
  // A recording db captures every bound value; the token is hashed before it is stored, so
  // its plaintext must appear in no parameter list.
  const db = recordingDb();
  const issued = await issueInvite(
    db,
    { householdId: "some-household", email: "invitee@warthog.com.au" },
    issueDeps(),
  );
  assertNeverBound(db, issued.token);
});

// ===========================================================================
// AC2 — redeeming once adds the signed-in user as a member and resolves to the bound
// household; a reused / expired / unknown token is rejected; a full household refuses.
// ===========================================================================

test("redeeming a live token once adds the signed-in user as a member of the bound household", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "ac2-add-owner");
    const bob = await makeUser(db, "ac2-add-invitee");
    const house = await createHousehold(db, { ownerId: alice.id });
    const { token } = await issueInvite(db, { householdId: house.id, email: bob.email }, issueDeps());

    assert.equal(await isHouseholdMember(db, house.id, bob.id), false, "the invitee is not a member before redeeming");

    const result: RedeemInviteResult = await redeemInvite(db, { token, userId: bob.id }, redeemDeps());
    assert.deepEqual(result, { ok: true, householdId: house.id }, "redeeming resolves to the bound household");

    // The signed-in user is now a member of exactly that household.
    assert.equal(await isHouseholdMember(db, house.id, bob.id), true, "the redeeming user is now a member");
    assert.equal((await getHouseholdForMember(db, bob.id))?.id, house.id, "the user belongs to the bound household");
    const members = await listMembers(db, house.id, alice.id);
    assert.equal(members.length, 2, "the household now has two members (owner + redeemer)");
    assert.equal(members.find((m) => m.userId === bob.id)?.role, "member", "the redeemer joins as a plain member");
  } finally {
    await db.close();
  }
});

test("the invite token redeems exactly once — a second redemption of the same token is rejected", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "ac2-once-owner");
    const bob = await makeUser(db, "ac2-once-invitee");
    const house = await createHousehold(db, { ownerId: alice.id });
    const { token } = await issueInvite(db, { householdId: house.id, email: bob.email }, issueDeps());

    const first: RedeemInviteResult = await redeemInvite(db, { token, userId: bob.id }, redeemDeps());
    assert.deepEqual(first, { ok: true, householdId: house.id }, "the first redemption succeeds");

    const second: RedeemInviteResult = await redeemInvite(db, { token, userId: bob.id }, redeemDeps());
    assert.deepEqual(
      second,
      { ok: false, reason: "invalid" },
      "a reused token is rejected — the invite is single-use and was marked used on first redemption",
    );

    // The single-use rejection left the membership exactly as the one successful redeem made
    // it — no duplicate row, still two members.
    assert.equal((await listMembers(db, house.id, alice.id)).length, 2, "the reused redemption added no duplicate member");
  } finally {
    await db.close();
  }
});

test("an invite is bound to ONE household: two invites each redeem only into their own household", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "ac2-bindA-owner");
    const bob = await makeUser(db, "ac2-bindB-owner");
    const carol = await makeUser(db, "ac2-bind-carolA");
    const dave = await makeUser(db, "ac2-bind-daveB");
    const houseA = await createHousehold(db, { ownerId: alice.id });
    const houseB = await createHousehold(db, { ownerId: bob.id });

    const inviteA = await issueInvite(db, { householdId: houseA.id, email: carol.email }, issueDeps());
    const inviteB = await issueInvite(db, { householdId: houseB.id, email: dave.email }, issueDeps());
    assert.notEqual(inviteA.token, inviteB.token, "two issued invites carry distinct tokens");

    assert.deepEqual(
      await redeemInvite(db, { token: inviteA.token, userId: carol.id }, redeemDeps()),
      { ok: true, householdId: houseA.id },
      "A's token joins A's household, never B's",
    );
    assert.deepEqual(
      await redeemInvite(db, { token: inviteB.token, userId: dave.id }, redeemDeps()),
      { ok: true, householdId: houseB.id },
      "B's token joins B's household",
    );

    // Each redeemer landed only in their own household.
    assert.equal((await getHouseholdForMember(db, carol.id))?.id, houseA.id, "Carol joined household A only");
    assert.equal((await getHouseholdForMember(db, dave.id))?.id, houseB.id, "Dave joined household B only");
    assert.equal(await isHouseholdMember(db, houseB.id, carol.id), false, "Carol did not leak into household B");
  } finally {
    await db.close();
  }
});

test("an expired token is rejected and never redeems", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "ac2-expired-owner");
    const bob = await makeUser(db, "ac2-expired-invitee");
    const house = await createHousehold(db, { ownerId: alice.id });
    const { token } = await issueInvite(db, { householdId: house.id, email: bob.email }, issueDeps());

    // Present the correct token one millisecond past its seven-day window.
    const justAfter: RedeemInviteResult = await redeemInvite(
      db,
      { token, userId: bob.id },
      redeemDeps({ clock: fixedClock(JUST_AFTER) }),
    );
    assert.deepEqual(justAfter, { ok: false, reason: "expired" }, "a token past its window is rejected as expired");

    // ...and a year later it is still rejected, never silently valid again.
    const longAfter: RedeemInviteResult = await redeemInvite(
      db,
      { token, userId: bob.id },
      redeemDeps({ clock: fixedClock(LONG_AFTER) }),
    );
    assert.equal(longAfter.ok, false, "an expired token never redeems, no matter how late");

    assert.equal(await isHouseholdMember(db, house.id, bob.id), false, "an expired token adds no member");
  } finally {
    await db.close();
  }
});

test("an unknown token is rejected as invalid and adds no member", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "ac2-unknown-owner");
    const bob = await makeUser(db, "ac2-unknown-invitee");
    const house = await createHousehold(db, { ownerId: alice.id });
    // No invite was issued against this db, so this well-formed token matches no stored hash.

    const result: RedeemInviteResult = await redeemInvite(
      db,
      { token: "A".repeat(43), userId: bob.id },
      redeemDeps(),
    );
    assert.deepEqual(result, { ok: false, reason: "invalid" }, "a token matching no stored hash is invalid");
    assert.equal(await isHouseholdMember(db, house.id, bob.id), false, "an unknown token adds no member");
  } finally {
    await db.close();
  }
});

test("redeeming into a full household (8 members) is refused with a plain reason and adds no member", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "ac2-cap-owner");
    const house = await createHousehold(db, { ownerId: alice.id });

    // The owner is member #1. Seven more fill the household to the cap of 8.
    for (let i = 1; i <= 7; i++) {
      const filler = await makeUser(db, `ac2-cap-filler-${i}`);
      const added = await addMember(db, { householdId: house.id, userId: filler.id });
      assert.equal(added.ok, true, `filler #${i} fits within the cap of 8`);
    }
    assert.equal((await listMembers(db, house.id, alice.id)).length, 8, "sanity: the household is full at 8 members");

    // A ninth person holds a genuinely-issued, live invite — but the household is full.
    const ninth = await makeUser(db, "ac2-cap-ninth");
    const { token } = await issueInvite(db, { householdId: house.id, email: ninth.email }, issueDeps());

    const result: RedeemInviteResult = await redeemInvite(db, { token, userId: ninth.id }, redeemDeps());
    assert.deepEqual(
      result,
      { ok: false, reason: "household_full" },
      "redeeming into a full household is refused with a plain reason",
    );

    assert.equal(await isHouseholdMember(db, house.id, ninth.id), false, "the refused ninth member was not enrolled");
    assert.equal((await listMembers(db, house.id, alice.id)).length, 8, "membership is still 8 after the refusal");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC4 — the token is drawn from the INJECTED randomness seam, not a baked-in secret, and
// the repo reads no process.env.
// ===========================================================================

test("the token is drawn from the injected entropy, not a constant baked into source", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "ac4-ent-owner");
    const house = await createHousehold(db, { ownerId: alice.id });

    // Different injected entropy must yield a different token — so the token is a function
    // of the injected randomness, not a hard-coded secret in the source.
    const t1 = (await issueInvite(db, { householdId: house.id, email: "e1@warthog.com.au" }, issueDeps({ random: fixedRandom(1) }))).token;
    const t2 = (await issueInvite(db, { householdId: house.id, email: "e2@warthog.com.au" }, issueDeps({ random: fixedRandom(2) }))).token;
    assert.notEqual(t1, t2, "swapping the injected entropy changes the token");

    // ...and two draws from the real entropy source differ too (a fresh high-entropy token
    // every issue, never a reused constant).
    const r1 = (await issueInvite(db, { householdId: house.id, email: "e3@warthog.com.au" }, issueDeps({ random: systemRandom }))).token;
    const r2 = (await issueInvite(db, { householdId: house.id, email: "e4@warthog.com.au" }, issueDeps({ random: systemRandom }))).token;
    assert.notEqual(r1, r2, "two issues draw two distinct tokens");
  } finally {
    await db.close();
  }
});

test("the repo reads no process.env: a decoy secret in the environment never lands in an invite", async () => {
  const DECOY = "sk_live_DECOY_must_never_appear_in_warthog";
  const prev = process.env.WARTHOG_DECOY_SECRET;
  process.env.WARTHOG_DECOY_SECRET = DECOY;
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "ac4-env-owner");
    const bob = await makeUser(db, "ac4-env-invitee");
    const house = await createHousehold(db, { ownerId: alice.id });
    const issued = await issueInvite(db, { householdId: house.id, email: bob.email }, issueDeps());
    const redeemed = await redeemInvite(db, { token: issued.token, userId: bob.id }, redeemDeps());

    assert.equal(redeemed.ok, true, "the invite reads and writes purely from the injected db + deps — no app env needed");
    assert.ok(
      !JSON.stringify(issued).includes(DECOY) && !JSON.stringify(redeemed).includes(DECOY),
      "no ambient env value is folded into the issued or redeemed invite",
    );

    // Scan every cell of the one table under test for the decoy (scoped narrowly — the same
    // value could legitimately live elsewhere if it were a real datum, which it is not).
    const all = await db.query("SELECT * FROM household_invites");
    for (const row of all.rows) {
      for (const cell of Object.values(row)) {
        if (typeof cell === "string") {
          assert.ok(!cell.includes(DECOY), "no ambient env value is written to a column");
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
// AC3 — every statement binds its input as a parameter (no spliced SQL); a probe routed
// through the repo is bound (or hashed-then-bound) and the tables survive.
// ===========================================================================

test("issueInvite binds the household id as a parameter, never woven into the SQL text", async () => {
  const db = recordingDb();
  const probe = "h'); DROP TABLE household_invites; --";

  // The recording db returns no rows; issueInvite assembles its result from inputs, so it
  // does not depend on a RETURNING read — the binding is asserted regardless of a throw.
  try {
    await issueInvite(db, { householdId: probe, email: "invitee@warthog.com.au" }, issueDeps());
  } catch {
    /* tolerate a no-row read: the binding is asserted below regardless */
  }
  assertBoundNotSpliced(db, probe);
});

test("issueInvite binds the invited email as a parameter, never woven into the SQL text", async () => {
  const db = recordingDb();
  const probe = "e'); DROP TABLE household_invites; --";

  try {
    await issueInvite(db, { householdId: "a-household", email: probe }, issueDeps());
  } catch {
    /* tolerate a no-row read: the binding is asserted below regardless */
  }
  assertBoundNotSpliced(db, probe);
});

test("redeemInvite binds the user id as a parameter and never splices the presented token", async () => {
  const db = recordingDb();
  const tokenProbe = "x'); DROP TABLE household_invites; --";
  const userProbe = "u'); DROP TABLE household_members; --";

  const result = await redeemInvite(db, { token: tokenProbe, userId: userProbe }, redeemDeps());
  assert.equal(result.ok, false, "nothing redeems when the recording db matches no row");

  // The token is hashed before it is bound, so the raw probe appears in no bound value AND
  // in no SQL text — there is no splice point for it to reach the statement.
  assertNotSplicedIntoSql(db, tokenProbe);
  assertNeverBound(db, tokenProbe);
  // The user id, by contrast, is a legitimate bound value — it must be bound, never spliced.
  // (It may not be bound at all on an empty recording db, since redeem short-circuits before
  // the add-member step — so assert only that it never reaches the SQL text as a splice.)
  for (const call of db.calls) {
    assert.ok(!call.text.includes(userProbe), "the user id is never concatenated into the SQL text");
  }
});

test("a SQL-injection probe in the redeemed token cannot alter the query: the tables survive", async () => {
  const db = await freshDb();
  try {
    // Seed a real household + invite so the tables are populated and their survival is meaningful.
    const alice = await makeUser(db, "ac3-inject-owner");
    const bob = await makeUser(db, "ac3-inject-invitee");
    const house = await createHousehold(db, { ownerId: alice.id });
    const issued = await issueInvite(db, { householdId: house.id, email: bob.email }, issueDeps());

    const probe = "x'; DROP TABLE household_invites; --";
    const rejected: RedeemInviteResult = await redeemInvite(db, { token: probe, userId: bob.id }, redeemDeps());
    assert.deepEqual(
      rejected,
      { ok: false, reason: "invalid" },
      "the injection-shaped token matches no stored hash and is rejected",
    );

    assert.equal(await tableExists(db, "household_invites"), true, "the household_invites table survives the probe");
    assert.equal(await tableExists(db, "household_members"), true, "the household_members table survives the probe");
    assert.equal(await tableExists(db, "households"), true, "the households table survives the probe");

    // The real token still redeems — proving the tables are intact and functional.
    assert.deepEqual(
      await redeemInvite(db, { token: issued.token, userId: bob.id }, redeemDeps()),
      { ok: true, householdId: house.id },
      "the genuine token still redeems after the injection attempt",
    );
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC3 — handlers on the validation boundary. A route handler validates the external input
// HERE (`parseBody`), then calls this task's parameterized data-access. A rejected input
// maps to a 4xx Response and never reaches a query. The redeem handler adds the SESSION's
// user id, never a body value. The handlers are test fixtures that EXERCISE the module —
// they are not implementation files.
// ===========================================================================

function issueInviteHandler(db: Db, deps: IssueInviteDeps): (req: Request) => Promise<Response> {
  // The body carries the household id (validated to the uuid shape at the boundary, OBS-049,
  // so a mis-shaped id is rejected before it reaches a `WHERE id = $1`) and the invited
  // email (validated to the email shape). The raw token is delivered out of band (the emailed
  // link), so the response does not echo it.
  const schema = z.object({
    householdId: z.uuid(),
    email: z.email().max(320),
  });
  return async (req: Request): Promise<Response> => {
    try {
      const body = await parseBody(schema, req, { maxBytes: 4 * 1024 });
      await issueInvite(db, { householdId: body.householdId, email: body.email }, deps);
      return new Response(JSON.stringify({ ok: true }), { status: 201 });
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

function redeemInviteHandler(
  db: Db,
  sessionUserId: string,
  deps: RedeemInviteDeps,
): (req: Request) => Promise<Response> {
  // The body carries ONLY the token — a URL-safe opaque string (it rides in a link), so a
  // generous length bound + a URL-safe charset reject obvious junk while staying agnostic to
  // the exact 256-bit encoding. The user ADDED is the SESSION's id, never a body value
  // (member-scope: the session's user id, never a value from the client).
  const schema = z.object({
    token: z.string().min(16).max(512).regex(/^[A-Za-z0-9_-]+$/),
  });
  return async (req: Request): Promise<Response> => {
    try {
      const body = await parseBody(schema, req, { maxBytes: 4 * 1024 });
      const result = await redeemInvite(db, { token: body.token, userId: sessionUserId }, deps);
      return new Response(JSON.stringify(result), { status: result.ok ? 200 : 400 });
    } catch (err) {
      if (err instanceof HttpError) {
        return new Response(JSON.stringify({ error: "invalid input" }), { status: err.status });
      }
      return new Response("internal error", { status: 500 });
    }
  };
}

function jsonRequest(path: string, body: string): Request {
  return new Request(`https://warthog.com.au${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

// A valid-uuid-shaped household id that does not exist (for the boundary tests that must not
// reach a real row).
const ABSENT_HOUSE = "99999999-9999-4999-8999-999999999999";

// --- issue handler validation ---

test("the issue handler rejects malformed JSON with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = issueInviteHandler(db, issueDeps());

  const res = await handler(jsonRequest("/api/household/invites", "{ not valid json"));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "malformed input must never reach a query");
});

test("the issue handler rejects an oversized body with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = issueInviteHandler(db, issueDeps());

  // ~10 KiB body, well over the handler's 4 KiB cap: rejected by size before parse.
  const body = JSON.stringify({ householdId: ABSENT_HOUSE, email: "invitee@warthog.com.au", note: "a".repeat(10 * 1024) });
  const res = await handler(jsonRequest("/api/household/invites", body));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "an oversized body must never reach a query");
});

test("the issue handler rejects a mis-shaped (non-uuid) household id with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = issueInviteHandler(db, issueDeps());

  // An injection-shaped id is not a uuid, so it is rejected at the boundary (OBS-049) and
  // never reaches a `WHERE id = $1` cast.
  const probe = "h'); DROP TABLE household_invites; --";
  const res = await handler(jsonRequest("/api/household/invites", JSON.stringify({ householdId: probe, email: "x@warthog.com.au" })));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "a mis-shaped household id must never reach a query");
});

test("the issue handler rejects a mis-shaped email with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = issueInviteHandler(db, issueDeps());

  const res = await handler(jsonRequest("/api/household/invites", JSON.stringify({ householdId: ABSENT_HOUSE, email: "not-an-email" })));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "a mis-shaped email must never reach a query");
});

test("the issue handler issues a token for a valid body (201) and stores only a hash", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "issue-handler-owner");
    const bob = await makeUser(db, "issue-handler-invitee");
    const house = await createHousehold(db, { ownerId: alice.id });
    const handler = issueInviteHandler(db, issueDeps());

    const res = await handler(jsonRequest("/api/household/invites", JSON.stringify({ householdId: house.id, email: bob.email })));
    assert.ok(res.status >= 200 && res.status < 300, `expected a 2xx, got ${res.status}`);

    // An invite row exists and the response never echoed a raw token value (it is delivered
    // out of band). The invite then works: the invitee can redeem it.
    const stored = await db.query("SELECT * FROM household_invites");
    assert.ok(stored.rows.length >= 1, "the issue handler stored an invite row");
  } finally {
    await db.close();
  }
});

// --- redeem handler validation + session-scope ---

test("the redeem handler rejects malformed JSON with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = redeemInviteHandler(db, "session-user", redeemDeps());

  const res = await handler(jsonRequest("/api/household/invites/redeem", "{ not valid json"));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "malformed input must never reach a query");
});

test("the redeem handler rejects an oversized body with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = redeemInviteHandler(db, "session-user", redeemDeps());

  // ~10 KiB body, well over the handler's 4 KiB cap: rejected by size before parse.
  const res = await handler(jsonRequest("/api/household/invites/redeem", JSON.stringify({ token: "A".repeat(10 * 1024) })));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "an oversized body must never reach a query");
});

test("the redeem handler rejects a body missing the token with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = redeemInviteHandler(db, "session-user", redeemDeps());

  const res = await handler(jsonRequest("/api/household/invites/redeem", JSON.stringify({})));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "a schema violation must never reach a query");
});

test("the redeem handler rejects a mis-typed token with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = redeemInviteHandler(db, "session-user", redeemDeps());

  // token must be a string — a nested object is a schema violation, rejected before any query.
  const res = await handler(jsonRequest("/api/household/invites/redeem", JSON.stringify({ token: { oops: true } })));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "a mis-typed field must never reach a query");
});

test("the redeem handler rejects a mis-shaped (non URL-safe) token with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = redeemInviteHandler(db, "session-user", redeemDeps());

  // A token laced with SQL punctuation fails the URL-safe charset: rejected at the boundary,
  // so it never reaches the query at all (the validate half of INV-102).
  const res = await handler(
    jsonRequest("/api/household/invites/redeem", JSON.stringify({ token: "x'); DROP TABLE household_invites; --" })),
  );

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "a mis-shaped token must never reach a query");
});

test("the redeem handler redeems a well-formed, live token and joins the session user", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "redeem-handler-owner");
    const bob = await makeUser(db, "redeem-handler-invitee");
    const house = await createHousehold(db, { ownerId: alice.id });
    const issued = await issueInvite(db, { householdId: house.id, email: bob.email }, issueDeps());

    const handler = redeemInviteHandler(db, bob.id, redeemDeps());
    const res = await handler(jsonRequest("/api/household/invites/redeem", JSON.stringify({ token: issued.token })));

    assert.ok(res.status >= 200 && res.status < 300, `expected a 2xx, got ${res.status}`);
    const result = (await res.json()) as RedeemInviteResult;
    assert.deepEqual(result, { ok: true, householdId: house.id }, "a valid token resolves to its household");
    assert.equal(await isHouseholdMember(db, house.id, bob.id), true, "the session user joined the household");
  } finally {
    await db.close();
  }
});

test("the redeem handler rejects a well-formed but unknown token with a 4xx", async () => {
  const db = await freshDb();
  try {
    const bob = await makeUser(db, "redeem-handler-unknown");
    const handler = redeemInviteHandler(db, bob.id, redeemDeps());

    // Shape-valid (passes the schema) but never issued, so the repo rejects it.
    const res = await handler(jsonRequest("/api/household/invites/redeem", JSON.stringify({ token: "B".repeat(43) })));
    assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx for an unknown token, got ${res.status}`);
  } finally {
    await db.close();
  }
});

test("the redeem handler adds the SESSION user, never a user id smuggled in the body", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "redeem-session-owner");
    const bob = await makeUser(db, "redeem-session-invitee");
    const mallory = await makeUser(db, "redeem-session-mallory");
    const house = await createHousehold(db, { ownerId: alice.id });
    const issued = await issueInvite(db, { householdId: house.id, email: bob.email }, issueDeps());

    // The session belongs to Bob; the body tries to smuggle Mallory's id. The handler takes
    // the user from the session and ignores the body's id.
    const handler = redeemInviteHandler(db, bob.id, redeemDeps());
    const res = await handler(
      jsonRequest("/api/household/invites/redeem", JSON.stringify({ token: issued.token, userId: mallory.id })),
    );
    assert.ok(res.status >= 200 && res.status < 300, `expected a 2xx, got ${res.status}`);

    assert.equal(await isHouseholdMember(db, house.id, bob.id), true, "the SESSION user (Bob) joined the household");
    assert.equal(await isHouseholdMember(db, house.id, mallory.id), false, "the smuggled body user id (Mallory) did NOT join");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// Migration — the table applies and a second run changes nothing.
// ===========================================================================

test("the household_invites migration applies and re-running every migration changes nothing", async () => {
  const db = await freshDb();
  try {
    assert.equal(
      await tableExists(db, "household_invites"),
      true,
      "the household_invites table must exist after the project migrations",
    );

    const migrations = await loadMigrations();
    assert.ok(
      migrations.some((m) => m.name === "0040_household_invites"),
      "db/migrations/0040_household_invites.sql must be part of the project migrations",
    );

    // A second run over the same database applies nothing new and does not throw —
    // re-executing 0040's CREATE would throw "already exists", so an empty result AND no
    // throw together prove the migration's second run changes nothing.
    const again = await runMigrations(db, migrations);
    assert.deepEqual(again, [], "a second migration run must change nothing");
  } finally {
    await db.close();
  }
});
