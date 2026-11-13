// E15-S14 — Household page loader + actions
// (`src/app/(portal)/(protected)/household/actions.ts`).
//
// RED-first: the household dir holds only a placeholder `page.tsx`; `./actions` does
// NOT exist yet, so importing it throws and every test here fails (and `tsc --noEmit`
// reddens on the missing module) until the builder writes the minimum code to pass.
// That absence IS the point of test-first — do NOT implement anything to make these
// pass. The builder adds `actions.ts` (and any store primitive it still needs, e.g. a
// "set the household currency" write) afterwards as the code that turns these green.
//
// Why a sibling `actions.ts` factory (not `page.tsx`): a Next App-Router `page.tsx`
// entry may export ONLY its framework fields, so the injectable, unit-testable seam —
// the `createHouseholdActions(deps)` factory the thin loader composes and binds its
// server actions over — cannot live there without breaking `next build` (OBS-025). The
// loader reads the session person's household and mounts <HouseholdView/> (E15-S13);
// the testable logic lives in this plain sibling (the convention's `createXActions(deps)`
// factory, the same shape as `createLifeAdminActions` / `createSpendingActions` /
// `createRulesActions`). These tests drive the factory directly against an isolated
// in-memory PGlite with the REAL migrations (`@/test/db`), the REAL household stores, a
// real `KeyWrapper`, and the validation boundary. No test asserts on the source text of
// any module, so a later behaviour-preserving refactor (a rename, a moved import) stays
// green.
//
// ─── The contract this task defines (the builder implements EXACTLY this) ─────────────
//
//   createHouseholdActions(deps: {
//     db: Db;                     // the parameterizing database seam (INV-102)
//     keyWrapper: KeyWrapper;     // unwraps the OWNER's DEK to en/decrypt the shared address
//     clock: Clock;              // the invite window / page-read "now" (never SQL now())
//     random: Random;            // entropy for an invite token
//     notify: SharedAddressNotifier;  // the shared-address edit notifier seam
//     email: EmailSender;        // delivers the invite link (the single message carrying it)
//     publicBaseUrl: string;     // the configured public origin the invite link is built on
//   }): {
//     load(session):                               Promise<HouseholdPageData | null>
//     createHousehold(session, input?):            Promise<Result>
//     inviteMember(session, { email }):            Promise<Result>
//     removeMember(session, { memberId }):         Promise<Result>
//     leaveHousehold(session):                     Promise<Result>
//     transferOwnership(session, { toUserId }):    Promise<Result>
//     acceptOwnership(session):                    Promise<Result>
//     closeHousehold(session):                     Promise<Result>
//     editSharedAddress(session, { current, upcoming?, movingOn? }): Promise<Result>
//     setHouseholdBudget(session, { monthlyBudget }):               Promise<Result>
//     setMemberLimit(session, { memberId, monthlyLimit }):          Promise<Result>
//     setHouseholdCurrency(session, { currency }):                  Promise<Result>
//     setAddressFollow(session, { follow }):                        Promise<Result>
//   }
//   where Result = { ok: true } | { ok: false; reason: string }   (never a silent success)
//
//   • Every method takes the person's VERIFIED Session and derives the acting user id
//     from `session.userId` — NEVER a client value (CLAUDE.md member scope / design §5).
//     The caller's household is resolved FROM the session user id alone (via
//     getHouseholdForMember); NO household id is ever accepted from the client, so a
//     signed-in person acts only on their OWN household and only ever on a member OF it.
//   • `load` returns the caller's own household report (the E15-S12 list-all read) or null
//     when the caller is in no household — the data the loader mounts <HouseholdView/> over.
//   • setHouseholdBudget / setMemberLimit / setHouseholdCurrency / removeMember /
//     transferOwnership / closeHousehold are OWNER-ONLY: a non-owner is refused with a
//     plain reason and nothing changes. editSharedAddress and setAddressFollow are open to
//     ANY member; leaveHousehold is for a NON-owner (the owner must transfer or close first).
//
// ─── Obligations (this task's cross-cutting invariants, as behaviour) ─────────────────
//   [obligation:validate-and-parameterize-input] (INV-102) — a malformed / oversized input
//     is rejected with a 4xx `HttpError` at the boundary BEFORE any query, so nothing is
//     written; a SQL-injection probe in an input field travels as a BOUND value (stored as
//     data, round-tripping unchanged) and never appears concatenated into the SQL text.
//   [obligation:secrets-from-env] (INV-103) — the actions run purely from their injected
//     seams and read no `process.env`, so a decoy env secret never lands in a result or in
//     stored household content.
//
// NOTE on the acceptance-criteria wording "a household or member id that is not a positive
// integer": that is the obligation's GENERIC template phrasing. In THIS codebase every id
// is a `uuid` (users.id / households.id are `gen_random_uuid()`), the household id is NEVER
// taken from the client (it is resolved from the session), and the only client-supplied
// ids are MEMBER ids (removeMember / transferOwnership / setMemberLimit). So the real
// boundary shape here is a well-formed UUID, and these tests pin exactly that: a member id
// that is not a well-formed UUID is rejected with a 4xx before it can reach `WHERE user_id
// = $N` as an unhandled uuid cast (OBS-049) — the same defence the "positive integer"
// phrasing stands in for. (Noted for the build.)
//
// Every real-db test uses its own `freshDb()` (an isolated in-memory PGlite with the real
// migrations) and closes it in a `finally`, so tests share no state and leave no open
// handle. Tests never touch the network or Azure.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";

import { amountInput, createHouseholdActions } from "./actions";

import { createUser } from "@/server/db/users";
import {
  createHousehold as seedHousehold,
  addMember as seedMember,
  getHouseholdForMember,
} from "@/server/db/households";
import { setSharedAddress, type SharedAddressNotifier } from "@/server/db/household-shared-address";
import { decrypt } from "@/server/crypto/envelope";
import type { EmailSender, OutgoingMessage } from "@/server/notify/senders";
import type { Session } from "@/server/auth/session";
import { localAesKeyWrapper, type KeyWrapper } from "@/server/crypto/key-wrapper";
import { fixedClock } from "@/server/seams/clock";
import { systemRandom } from "@/server/seams/random";
import { HttpError } from "@/server/http/validate";
import { freshDb } from "@/test/db";
import type { Db, QueryResult } from "@/server/db/index";

// --- fixtures --------------------------------------------------------------------------

// The frozen instant every read/invite reads time through (noon mid-month UTC), so an
// invite's 7-day window straddles it unambiguously.
const NOW = new Date("2026-11-15T12:00:00.000Z");

// The configured public origin the invite link is built on (never the request host).
const PUBLIC_BASE_URL = "https://warthog.com.au";

// One fixed local KEK + its wrapper, shared across the test: the SAME wrapper wraps each
// person's DEK (stored as users.wrapped_dek) AND is injected into the actions, so the
// actions unwrap the OWNER's DEK back to exactly the bytes the shared address was
// encrypted under — the shared-address edit + the page read round-trip under one key.
const keyWrapper: KeyWrapper = localAesKeyWrapper(randomBytes(32));

// The factory's own dep bag shape — derived from the factory so a later type rename that
// preserves behaviour does not redden these tests, and so the builder's dep names must
// match this pinned contract exactly.
type HouseholdActions = ReturnType<typeof createHouseholdActions>;
type Deps = Parameters<typeof createHouseholdActions>[0];

// Default no-op seams (overridden per test when a capture is wanted).
const noopNotify: SharedAddressNotifier = { async notifyMember() {} };
const noopEmail: EmailSender = { async sendEmail() {} };

// Build the actions with the real seams, a frozen clock and no-op sender fakes; a test
// that cares about delivery passes a capturing `email` (or `notify`) override.
function makeActions(db: Db, overrides: Partial<Deps> = {}): HouseholdActions {
  const deps: Deps = {
    db,
    keyWrapper,
    clock: fixedClock(NOW),
    random: systemRandom,
    notify: noopNotify,
    email: noopEmail,
    publicBaseUrl: PUBLIC_BASE_URL,
    ...overrides,
  };
  return createHouseholdActions(deps);
}

// A verified session carrying only what the actions read — the user id. The actions take
// an already-verified Session and never re-derive identity, so a plain object suffices
// (no session row needed), and identity is always the SESSION's, never a client value.
function sessionFor(userId: string): Session {
  return { id: `sess-${userId}`, userId, createdAt: NOW, lastSeenAt: NOW, steppedUpAt: null };
}

// Create a person with a REAL wrapped DEK (a fresh 256-bit key wrapped under the shared
// KEK), so the actions resolve their DEK the production way (getUserById + unwrap). The
// email is unique so the users table's UNIQUE(email) never collides within one db.
async function makeUser(db: Db, who: string): Promise<{ id: string; dek: Uint8Array }> {
  const dek = randomBytes(32);
  const user = await createUser(db, {
    email: `${who}-${randomUUID()}@people.example`,
    wrappedDek: await keyWrapper.wrap(dek),
  });
  return { id: user.id, dek };
}

// --- narrowers (assert.fail is `never`, so the result narrows after) -------------------

function expectOk(r: { ok: boolean }, label: string): void {
  if (!r.ok) assert.fail(`${label}: expected success, got a refusal`);
}
function expectRefused(r: { ok: boolean; reason?: string }, label: string): void {
  if (r.ok) assert.fail(`${label}: expected a refusal, got success`);
  assert.ok(typeof r.reason === "string" && r.reason.length > 0, `${label}: carries a plain reason`);
}

// Assert that awaiting `fn()` rejects with a 4xx HttpError (the validation boundary).
async function assertRejects4xx(label: string, fn: () => Promise<unknown>): Promise<void> {
  let threw = false;
  try {
    await fn();
  } catch (err) {
    threw = true;
    assert.ok(
      err instanceof HttpError,
      `${label}: must be rejected at the validation boundary (HttpError), got ${String(err)}`,
    );
    assert.ok(
      err.status >= 400 && err.status < 500,
      `${label}: the rejection must carry a 4xx status, got ${err.status}`,
    );
  }
  assert.ok(threw, `${label}: must be rejected (nothing was thrown)`);
}

// A db seam that records every call and passes it through to a real db (so a test can
// prove WHAT reached the query layer and HOW). Satisfies `Db` structurally.
interface RecordingProxy extends Db {
  readonly calls: { text: string; values: unknown[] }[];
}
function recordingProxy(real: Db): RecordingProxy {
  const calls: { text: string; values: unknown[] }[] = [];
  const proxy: RecordingProxy = {
    calls,
    query(text: string, values: unknown[] = []): Promise<QueryResult> {
      calls.push({ text, values });
      return real.query(text, values);
    },
    close(): Promise<void> {
      return real.close();
    },
  };
  if (real.transaction) proxy.transaction = (fn) => real.transaction!(fn);
  return proxy;
}

// =====================================================================================
// AC1 — the loader reads the caller's household and mounts <HouseholdView/> with every
// control wired. At the seam that is: the factory exposes `load` plus all twelve named
// actions, and `load` returns the caller's OWN household report (or null for none).
// =====================================================================================

test("the factory wires load and every household action the triad mounts", async () => {
  const db = await freshDb();
  try {
    const actions = makeActions(db) as unknown as Record<string, unknown>;
    for (const name of [
      "load",
      "createHousehold",
      "inviteMember",
      "removeMember",
      "leaveHousehold",
      "transferOwnership",
      "acceptOwnership",
      "closeHousehold",
      "editSharedAddress",
      "setHouseholdBudget",
      "setMemberLimit",
      "setHouseholdCurrency",
      "setAddressFollow",
    ]) {
      assert.equal(typeof actions[name], "function", `the factory wires "${name}"`);
    }
  } finally {
    await db.close();
  }
});

test("load reads only the caller's own household and returns null for a person in no household", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "owner");
    const bob = await makeUser(db, "member");
    const carol = await makeUser(db, "other-owner");
    const dave = await makeUser(db, "no-household");

    // Household X (Alice owner, Bob member); a SEPARATE household Y (Carol alone).
    const x = (await seedHousehold(db, { ownerId: alice.id, currency: "AUD", monthlyBudget: 900 })).id;
    await seedMember(db, { householdId: x, userId: bob.id });
    const y = (await seedHousehold(db, { ownerId: carol.id, currency: "USD" })).id;

    const actions = makeActions(db);

    // The owner and the plain member each resolve the SAME household from their session —
    // never a client id — and see the shared report.
    const forAlice = await actions.load(sessionFor(alice.id));
    const forBob = await actions.load(sessionFor(bob.id));
    assert.ok(forAlice && forBob, "a member of a household gets a report");
    assert.equal(forAlice.householdId, x, "resolved from Alice's session user id");
    assert.equal(forBob.householdId, x, "Bob resolves the same household he belongs to");
    assert.equal(forAlice.ownerId, alice.id);
    assert.equal(forAlice.currency, "AUD");
    assert.equal(forAlice.monthlyBudget, 900);
    assert.equal(forAlice.members.length, 2, "the roster lists both members");

    // Carol sees HER OWN household, never Alice's — even though both exist in one db.
    const forCarol = await actions.load(sessionFor(carol.id));
    assert.ok(forCarol);
    assert.equal(forCarol.householdId, y, "Carol's own household, resolved from her session");
    assert.ok(!JSON.stringify(forCarol).includes(x), "the other household's id never leaks");

    // A person in no household gets nothing (the loader then offers to create one).
    assert.equal(await actions.load(sessionFor(dave.id)), null, "no household → null");
  } finally {
    await db.close();
  }
});

// =====================================================================================
// createHousehold — a person in no household makes one they own; a person already in a
// household is refused (a person belongs to exactly one household).
// =====================================================================================

test("createHousehold makes a household owned by the session user; one already in a household is refused", async () => {
  const db = await freshDb();
  try {
    const dave = await makeUser(db, "founder");
    const alice = await makeUser(db, "already-owner");
    const existing = (await seedHousehold(db, { ownerId: alice.id, currency: "AUD" })).id;

    const actions = makeActions(db);

    // Dave, in no household, creates one and becomes its sole owner.
    expectOk(await actions.createHousehold(sessionFor(dave.id)), "Dave creates a household");
    const daves = await actions.load(sessionFor(dave.id));
    assert.ok(daves, "Dave now has a household");
    assert.equal(daves.ownerId, dave.id, "Dave owns the household he created");
    assert.equal(daves.members.length, 1, "just Dave, as owner");
    assert.equal(daves.members[0]?.role, "owner");
    assert.ok(typeof daves.currency === "string" && daves.currency.length > 0, "it has a currency");

    // Alice already owns one, so a second create is refused and her household is unchanged.
    expectRefused(await actions.createHousehold(sessionFor(alice.id)), "Alice already in a household");
    assert.equal(
      (await actions.load(sessionFor(alice.id)))?.householdId,
      existing,
      "Alice is still in her original household — no second one was created for her",
    );
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC2 — the owner CAN set the budget, a member limit and the currency (not dead controls),
// and each change persists and reads back through `load`.
// =====================================================================================

test("an owner sets the budget, a member's limit and the currency, and each persists", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "owner");
    const bob = await makeUser(db, "member");
    const hid = (await seedHousehold(db, { ownerId: alice.id, currency: "AUD" })).id;
    await seedMember(db, { householdId: hid, userId: bob.id });

    const actions = makeActions(db);
    const owner = sessionFor(alice.id);

    expectOk(await actions.setHouseholdBudget(owner, { monthlyBudget: 1200 }), "set budget");
    expectOk(await actions.setMemberLimit(owner, { memberId: bob.id, monthlyLimit: 250 }), "set Bob's limit");
    expectOk(await actions.setHouseholdCurrency(owner, { currency: "USD" }), "set currency");

    assert.equal((await actions.load(owner))?.monthlyBudget, 1200, "the budget persisted");
    assert.equal((await actions.load(owner))?.currency, "USD", "the currency persisted");
    // Bob's OWN limit (read from his own session) reflects the owner's set.
    assert.equal((await actions.load(sessionFor(bob.id)))?.ownLimit, 250, "Bob's limit persisted");

    // A well-formed but unknown currency is refused (never a silent change); the stored
    // currency survives. Tolerant of EITHER a plain refusal or a 4xx at the boundary.
    const unknown = await actions
      .setHouseholdCurrency(owner, { currency: "ZZZ" })
      .catch((e) => {
        if (e instanceof HttpError) return { ok: false as const, reason: "invalid" };
        throw e;
      });
    assert.equal(unknown.ok, false, "an unknown currency is refused");
    assert.equal((await actions.load(owner))?.currency, "USD", "the currency is left unchanged");
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC2 — the owner-only mutations are refused for a NON-owner with a plain reason, and
// nothing about the household changes.
// =====================================================================================

test("the owner-only mutations are refused for a non-owner with a plain reason, changing nothing", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "owner");
    const bob = await makeUser(db, "member");
    const carol = await makeUser(db, "member2");
    const hid = (await seedHousehold(db, { ownerId: alice.id, currency: "AUD" })).id;
    await seedMember(db, { householdId: hid, userId: bob.id });
    await seedMember(db, { householdId: hid, userId: carol.id });

    const actions = makeActions(db);
    const nonOwner = sessionFor(bob.id); // Bob is a plain member

    expectRefused(await actions.setHouseholdBudget(nonOwner, { monthlyBudget: 500 }), "budget");
    expectRefused(await actions.setMemberLimit(nonOwner, { memberId: carol.id, monthlyLimit: 100 }), "limit");
    expectRefused(await actions.setHouseholdCurrency(nonOwner, { currency: "USD" }), "currency");
    expectRefused(await actions.removeMember(nonOwner, { memberId: carol.id }), "remove");
    expectRefused(await actions.transferOwnership(nonOwner, { toUserId: carol.id }), "transfer");
    expectRefused(await actions.closeHousehold(nonOwner), "close");

    // Nothing moved: the household still stands, with its original figures and roster.
    const after = await actions.load(sessionFor(alice.id));
    assert.ok(after, "the household still exists");
    assert.equal(after.monthlyBudget, null, "the budget is unchanged (never set)");
    assert.equal(after.currency, "AUD", "the currency is unchanged");
    assert.equal(after.members.length, 3, "no member was removed");
    assert.equal(after.pendingTransfer, null, "no transfer was recorded");
    assert.equal((await actions.load(sessionFor(carol.id)))?.ownLimit, null, "Carol's limit is unchanged");
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC2 — editSharedAddress and setAddressFollow are open to ANY member (owner AND plain
// member). The edit round-trips through `load` — proving it is encrypted under the
// owner's DEK the read decrypts under (a non-owner's edit is still readable by everyone).
// =====================================================================================

test("editSharedAddress and setAddressFollow are allowed to any member", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "owner");
    const bob = await makeUser(db, "member");
    const hid = (await seedHousehold(db, { ownerId: alice.id, currency: "AUD" })).id;
    await seedMember(db, { householdId: hid, userId: bob.id });

    const actions = makeActions(db);

    // A PLAIN member edits the one shared address and turns on "use the household address".
    expectOk(await actions.editSharedAddress(sessionFor(bob.id), { current: "5 Shared Rd, Perth" }), "member edit");
    expectOk(await actions.setAddressFollow(sessionFor(bob.id), { follow: true }), "member follow");

    const forBob = await actions.load(sessionFor(bob.id));
    assert.equal(forBob?.sharedAddress?.current, "5 Shared Rd, Perth", "the member's edit reads back (decrypted)");
    assert.equal(forBob?.followChoice, true, "the member's follow choice persisted");

    // The owner may edit it too (any member, including the owner).
    expectOk(await actions.editSharedAddress(sessionFor(alice.id), { current: "9 Owner St, Hobart" }), "owner edit");
    assert.equal(
      (await actions.load(sessionFor(alice.id)))?.sharedAddress?.current,
      "9 Owner St, Hobart",
      "the owner's edit replaces the shared address in place",
    );
    // The member who followed still sees the shared address (unchanged follow choice).
    assert.equal((await actions.load(sessionFor(bob.id)))?.followChoice, true, "Bob still follows");
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC2 — leaveHousehold is for a NON-owner; the owner cannot leave (they must transfer or
// close first).
// =====================================================================================

test("leaveHousehold lets a non-owner leave but refuses the owner", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "owner");
    const bob = await makeUser(db, "member");
    const hid = (await seedHousehold(db, { ownerId: alice.id, currency: "AUD" })).id;
    await seedMember(db, { householdId: hid, userId: bob.id });

    const actions = makeActions(db);

    // The owner cannot leave — refused with a plain reason, still the owner afterwards.
    expectRefused(await actions.leaveHousehold(sessionFor(alice.id)), "owner leave");
    assert.equal((await actions.load(sessionFor(alice.id)))?.ownerId, alice.id, "Alice is still the owner");

    // A plain member leaves on their own; afterwards they belong to no household.
    expectOk(await actions.leaveHousehold(sessionFor(bob.id)), "member leave");
    assert.equal(await actions.load(sessionFor(bob.id)), null, "Bob now belongs to no household");
    assert.equal(await getHouseholdForMember(db, bob.id), null, "and no membership row remains for Bob");
    assert.equal((await actions.load(sessionFor(alice.id)))?.members.length, 1, "only Alice remains");
  } finally {
    await db.close();
  }
});

// =====================================================================================
// transferOwnership then acceptOwnership — ownership passes only when the named target
// accepts; a non-target cannot accept, and accepting with no pending transfer is refused.
// =====================================================================================

test("transferOwnership then acceptOwnership moves ownership; a non-target cannot accept", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "owner");
    const bob = await makeUser(db, "target");
    const carol = await makeUser(db, "bystander");
    const hid = (await seedHousehold(db, { ownerId: alice.id, currency: "AUD" })).id;
    await seedMember(db, { householdId: hid, userId: bob.id });
    await seedMember(db, { householdId: hid, userId: carol.id });

    const actions = makeActions(db);

    // Accepting with no pending transfer is refused.
    expectRefused(await actions.acceptOwnership(sessionFor(bob.id)), "accept with no pending transfer");

    // The owner records a pending transfer to Bob — ownership does NOT change yet.
    expectOk(await actions.transferOwnership(sessionFor(alice.id), { toUserId: bob.id }), "transfer to Bob");
    const pending = await actions.load(sessionFor(alice.id));
    assert.equal(pending?.ownerId, alice.id, "Alice is still the owner until Bob accepts");
    assert.equal(pending?.pendingTransfer?.toUserId, bob.id, "the pending transfer names Bob");

    // A bystander (not the named target) cannot accept it.
    expectRefused(await actions.acceptOwnership(sessionFor(carol.id)), "Carol is not the target");
    assert.equal((await actions.load(sessionFor(alice.id)))?.ownerId, alice.id, "ownership did not move");

    // Bob, the named target, accepts — ownership moves to him and Alice becomes a member.
    expectOk(await actions.acceptOwnership(sessionFor(bob.id)), "Bob accepts");
    const after = await actions.load(sessionFor(bob.id));
    assert.equal(after?.ownerId, bob.id, "Bob is now the owner");
    assert.equal(after?.pendingTransfer, null, "the pending transfer is cleared");
    assert.equal(after?.members.find((m) => m.userId === alice.id)?.role, "member", "Alice is now a member");
  } finally {
    await db.close();
  }
});

// =====================================================================================
// removeMember and closeHousehold work for the owner.
// =====================================================================================

test("removeMember removes a member and closeHousehold tears the household down, for the owner", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "owner");
    const bob = await makeUser(db, "member");
    const hid = (await seedHousehold(db, { ownerId: alice.id, currency: "AUD" })).id;
    await seedMember(db, { householdId: hid, userId: bob.id });

    const actions = makeActions(db);
    const owner = sessionFor(alice.id);

    // Remove Bob — only the membership goes; his own account stays (he is in no household).
    expectOk(await actions.removeMember(owner, { memberId: bob.id }), "remove Bob");
    assert.equal((await actions.load(owner))?.members.length, 1, "only Alice remains");
    assert.equal(await actions.load(sessionFor(bob.id)), null, "Bob now belongs to no household");

    // Close the household — the shared container is gone for the owner too.
    expectOk(await actions.closeHousehold(owner), "close the household");
    assert.equal(await actions.load(owner), null, "the household no longer exists");
  } finally {
    await db.close();
  }
});

// =====================================================================================
// inviteMember — the OWNER invites by email: the invite is issued, delivered to the
// invited address (the single message carrying the link) and shows as a pending invite; a
// NON-owner's attempt is refused and sends nothing.
// =====================================================================================

test("inviteMember issues an owner's invite (emailed + shown as pending) and refuses a non-owner", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "owner");
    const bob = await makeUser(db, "member");
    const hid = (await seedHousehold(db, { ownerId: alice.id, currency: "AUD" })).id;
    await seedMember(db, { householdId: hid, userId: bob.id });

    const sent: OutgoingMessage[] = [];
    const email: EmailSender = {
      async sendEmail(message) {
        sent.push(message);
      },
    };
    const actions = makeActions(db, { email });

    // The owner invites a newcomer by email.
    expectOk(
      await actions.inviteMember(sessionFor(alice.id), { email: "newcomer@invites.example" }),
      "owner invites a newcomer",
    );
    assert.ok(
      sent.some((m) => m.recipient === "newcomer@invites.example"),
      "the invite is delivered to the invited address (the single message carrying the link)",
    );
    const afterInvite = await actions.load(sessionFor(alice.id));
    assert.ok(
      afterInvite?.pendingInvites.some((i) => i.email === "newcomer@invites.example"),
      "the still-open invite shows for the owner",
    );

    // A plain member cannot invite — refused with a plain reason, and nothing is sent.
    const before = sent.length;
    expectRefused(
      await actions.inviteMember(sessionFor(bob.id), { email: "stranger@invites.example" }),
      "a non-owner invites",
    );
    assert.equal(sent.length, before, "a refused invite sends no message");
    assert.ok(
      !(await actions.load(sessionFor(alice.id)))?.pendingInvites.some((i) => i.email === "stranger@invites.example"),
      "a refused invite creates no pending invite",
    );
  } finally {
    await db.close();
  }
});

// Review fix W3.1 — invites are bounded: past the household's free places, or past the
// hourly invite allowance, inviteMember refuses with a plain reason and sends nothing.

test("the invite email is branded: the invite link is its one button, with the 7-day expiry and no personal content", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "owner-branded");
    await seedHousehold(db, { ownerId: alice.id, currency: "AUD" });
    const sent: OutgoingMessage[] = [];
    const actions = makeActions(db, { email: { async sendEmail(message) { sent.push(message); } } });
    expectOk(await actions.inviteMember(sessionFor(alice.id), { email: "branded@invites.example" }), "owner invites");
    const message = sent[0]!;
    const email = message.email!;
    assert.equal(email.subject, "You're invited to join a household on Warthog");
    assert.equal(email.heading, "Join a household on Warthog");
    assert.deepEqual(email.action, { label: "Open invitation", url: message.link }, "the invite link is the button");
    assert.match(email.paragraphs.join(" "), /expires in 7 days/);
    assert.match(email.footnote ?? "", /If you weren't expecting this, you can ignore this email/);
    assert.ok(!JSON.stringify(email).includes(alice.id), "nothing about the inviter is in the email");
    assert.ok(!email.subject.includes(message.link!), "the link is never in the subject");
  } finally {
    await db.close();
  }
});

test("inviteMember refuses once open invites fill the free places, and when the hourly allowance is spent", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "owner");
    const hid = (await seedHousehold(db, { ownerId: alice.id, currency: "AUD" })).id;
    for (let i = 0; i < 6; i++) {
      await seedMember(db, { householdId: hid, userId: (await makeUser(db, `filler-${i}`)).id });
    }

    const sent: OutgoingMessage[] = [];
    const email: EmailSender = {
      async sendEmail(message) {
        sent.push(message);
      },
    };
    const actions = makeActions(db, { email });
    const owner = sessionFor(alice.id);

    // 7 members: one free place.
    expectOk(await actions.inviteMember(owner, { email: "first@invites.example" }), "the last place is invited");
    const refused = await actions.inviteMember(owner, { email: "second@invites.example" });
    assert.deepEqual(refused, { ok: false, reason: "invite_no_room" }, "no free place is left for a second invite");
    assert.equal(sent.length, 1, "a refused invite sends nothing");

    // Resending to the same address is allowed until the hourly allowance runs out.
    let last: { ok: boolean; reason?: string } = { ok: true };
    for (let i = 0; i < 20 && last.ok; i++) {
      last = await actions.inviteMember(owner, { email: "first@invites.example" });
    }
    assert.deepEqual(last, { ok: false, reason: "invite_throttled" }, "the hourly allowance is enforced");
    const sentBefore = sent.length;
    expectRefused(await actions.inviteMember(owner, { email: "first@invites.example" }), "still throttled");
    assert.equal(sent.length, sentBefore, "a throttled invite sends nothing");
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC3 [obligation:validate-and-parameterize-input] — a mis-shaped MEMBER id (not a
// well-formed UUID; see the NOTE at the top on the "positive integer" wording) is rejected
// at the boundary with a 4xx for removeMember / transferOwnership / setMemberLimit, and
// never reaches a query as an unhandled uuid cast. The roster is untouched.
// =====================================================================================

test("a mis-shaped member id is rejected with a 4xx at the boundary, never cast into a query", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "owner");
    const bob = await makeUser(db, "member");
    const hid = (await seedHousehold(db, { ownerId: alice.id, currency: "AUD" })).id;
    await seedMember(db, { householdId: hid, userId: bob.id });

    const actions = makeActions(db);
    const owner = sessionFor(alice.id);

    for (const bad of ["not-a-uuid-at-all", "42", "'; DROP TABLE household_members; --", "", "   "]) {
      await assertRejects4xx(`removeMember(${bad})`, () => actions.removeMember(owner, { memberId: bad }));
      await assertRejects4xx(`transferOwnership(${bad})`, () => actions.transferOwnership(owner, { toUserId: bad }));
      await assertRejects4xx(`setMemberLimit(${bad})`, () =>
        actions.setMemberLimit(owner, { memberId: bad, monthlyLimit: 100 }),
      );
    }

    // The roster is intact — no cast ran and no injected statement executed.
    assert.equal((await actions.load(owner))?.members.length, 2, "no mis-shaped id altered the roster");
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC3 — a signed-in user can never act on a household or a member they do not belong to.
// The household is resolved from the session, so another household's member (a valid uuid,
// just not THEIRS) is refused, and a user in no household cannot run an owner-only action.
// =====================================================================================

test("a signed-in user cannot act on a household or member they do not belong to", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "x-owner");
    const bob = await makeUser(db, "x-member");
    const carol = await makeUser(db, "y-owner");
    const dave = await makeUser(db, "no-household");

    // Household X (Alice + Bob); a separate household Y (Carol alone).
    const x = (await seedHousehold(db, { ownerId: alice.id, currency: "AUD" })).id;
    await seedMember(db, { householdId: x, userId: bob.id });
    await seedHousehold(db, { ownerId: carol.id, currency: "USD" });

    const actions = makeActions(db);

    // Carol owns Y, so by Bob's VALID uuid (a member of X, not Y) she is refused on every
    // member-targeting action — her household resolves to Y, where Bob is not a member.
    const carolSession = sessionFor(carol.id);
    expectRefused(await actions.removeMember(carolSession, { memberId: bob.id }), "Carol removes an X member");
    expectRefused(await actions.setMemberLimit(carolSession, { memberId: bob.id, monthlyLimit: 50 }), "Carol limits an X member");
    expectRefused(await actions.transferOwnership(carolSession, { toUserId: bob.id }), "Carol transfers to an X member");

    // X is untouched — Bob is still a member of Alice's household.
    assert.equal((await actions.load(sessionFor(alice.id)))?.members.length, 2, "Bob is still a member of X");

    // Dave is in no household, so an owner-only action is refused (no household to own).
    expectRefused(await actions.setHouseholdBudget(sessionFor(dave.id), { monthlyBudget: 100 }), "Dave with no household");
    assert.equal(await actions.load(sessionFor(dave.id)), null, "Dave still has no household");
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC4 [obligation:validate-and-parameterize-input] — a malformed or grossly oversized
// input is rejected with a 4xx at the boundary BEFORE any write; nothing is stored.
// =====================================================================================

test("a handler rejects malformed or oversized input with a 4xx and writes nothing", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "owner");
    const bob = await makeUser(db, "member");
    const hid = (await seedHousehold(db, { ownerId: alice.id, currency: "AUD" })).id;
    await seedMember(db, { householdId: hid, userId: bob.id });

    const actions = makeActions(db);
    const owner = sessionFor(alice.id);

    // A non-numeric money amount.
    await assertRejects4xx("non-numeric budget", () =>
      actions.setHouseholdBudget(owner, { monthlyBudget: "heaps" as never }),
    );
    await assertRejects4xx("non-numeric limit", () =>
      actions.setMemberLimit(owner, { memberId: bob.id, monthlyLimit: "lots" as never }),
    );
    // A grossly oversized free-text / code field (a payload, not a value).
    await assertRejects4xx("oversized address", () =>
      actions.editSharedAddress(owner, { current: "a".repeat(1_000_000) }),
    );
    await assertRejects4xx("oversized currency", () =>
      actions.setHouseholdCurrency(owner, { currency: "A".repeat(10_000) }),
    );
    // A malformed and an oversized invite email.
    await assertRejects4xx("malformed email", () => actions.inviteMember(owner, { email: "not-an-email" }));
    await assertRejects4xx("oversized email", () =>
      actions.inviteMember(owner, { email: `${"a".repeat(100_000)}@x.example` }),
    );

    // Nothing was written by any rejected call.
    const after = await actions.load(owner);
    assert.equal(after?.monthlyBudget, null, "no budget was written");
    assert.equal(after?.sharedAddress, null, "no shared address was written");
    assert.equal(after?.currency, "AUD", "the currency is unchanged");
    assert.deepEqual(after?.pendingInvites, [], "no invite was issued");
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC4 [obligation:validate-and-parameterize-input] — a SQL-injection probe in an input
// field is BOUND and stored as data: it round-trips unchanged through `load` (the table is
// not dropped and the value is not executed), and never appears concatenated into the SQL
// text. The acting user id likewise travels as a bound value. Proven with a recording
// proxy over a real db that passes queries through while capturing text + values.
// =====================================================================================

test("a SQL-injection probe in an input field is bound and stored as data, never altering a query", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "owner");
    const hid = (await seedHousehold(db, { ownerId: alice.id, currency: "AUD" })).id;
    assert.ok(hid, "a household exists to edit");

    const proxy = recordingProxy(db);
    const actions = makeActions(proxy);
    const owner = sessionFor(alice.id);

    const PROBE = "'; DROP TABLE households; -- 5 Example St";
    expectOk(await actions.editSharedAddress(owner, { current: PROBE }), "editSharedAddress with a SQL probe");

    // The probe round-trips as DATA: the households table survives (load still resolves the
    // household) and the stored address reads back verbatim, not executed.
    const after = await actions.load(owner);
    assert.ok(after, "the household still exists (the table was not dropped)");
    assert.equal(after.sharedAddress?.current, PROBE, "the probe is stored verbatim as data");

    // Parameterization: the acting user id travels as a BOUND value, and neither the probe
    // nor an injected statement ever appears spliced into the SQL text.
    assert.ok(proxy.calls.length >= 1, "the action issues at least one member-scoped query");
    const allValues = proxy.calls.flatMap((c) => c.values);
    assert.ok(allValues.includes(alice.id), "the acting user id travels as a bound value");
    for (const call of proxy.calls) {
      assert.ok(!call.text.includes("DROP TABLE"), "no injected statement appears in the SQL text");
      assert.ok(!call.text.includes(PROBE), "the probe is bound, never concatenated into the SQL");
    }
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC5 [obligation:secrets-from-env] — the actions run purely from their injected seams and
// read no `process.env`: a decoy secret set in the environment never appears in a result or
// in stored household content.
// =====================================================================================

test("the actions read no process.env: a decoy env secret never appears in a result or stored content", async () => {
  const DECOY = "sk_live_DECOY_must_never_appear_in_warthog_household";
  const prev = process.env.WARTHOG_DECOY_SECRET;
  process.env.WARTHOG_DECOY_SECRET = DECOY;
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "owner");
    const bob = await makeUser(db, "member");
    const hid = (await seedHousehold(db, { ownerId: alice.id, currency: "AUD" })).id;
    await seedMember(db, { householdId: hid, userId: bob.id });

    const actions = makeActions(db);
    const owner = sessionFor(alice.id);

    const budget = await actions.setHouseholdBudget(owner, { monthlyBudget: 300 });
    const address = await actions.editSharedAddress(owner, { current: "1 Env St, Darwin" });
    assert.equal(budget.ok, true, "the action works purely from its injected seams");
    assert.equal(address.ok, true, "the address edit works purely from its injected seams");
    assert.ok(!JSON.stringify(budget).includes(DECOY), "no ambient env value is folded into a result");

    const loaded = await actions.load(owner);
    assert.ok(loaded, "the report loads purely from the injected seams");
    assert.equal(loaded.sharedAddress?.current, "1 Env St, Darwin", "the address decrypts under the injected DEK");
    assert.ok(!JSON.stringify(loaded).includes(DECOY), "no ambient env value is folded into the loaded report");
  } finally {
    await db.close();
    if (prev === undefined) delete process.env.WARTHOG_DECOY_SECRET;
    else process.env.WARTHOG_DECOY_SECRET = prev;
  }
});

// =====================================================================================
// The shared address survives an ownership transfer (review finding: it was encrypted
// under the OWNER's DEK and never re-encrypted, so after an accepted transfer every
// member's read threw, and the old owner deleting their account destroyed it for good).
// =====================================================================================

// Whether `ciphertext` (a stored shared-address column) decrypts under `key`.
async function decryptsUnder(key: Uint8Array, householdId: string, ciphertext: string): Promise<boolean> {
  try {
    await decrypt(key, "household_shared_address", "current", householdId, ciphertext);
    return true;
  } catch {
    return false;
  }
}

test("the shared address still reads for every member after an ownership transfer, even once the old owner's key is gone", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "owner");
    const bob = await makeUser(db, "member");
    const hid = (await seedHousehold(db, { ownerId: alice.id, currency: "AUD" })).id;
    await seedMember(db, { householdId: hid, userId: bob.id });
    const actions = makeActions(db);

    // A MEMBER edits the address, then ownership moves from Alice to Bob.
    expectOk(await actions.editSharedAddress(sessionFor(bob.id), { current: "1 Main St, Hobart" }), "edit");
    expectOk(await actions.transferOwnership(sessionFor(alice.id), { toUserId: bob.id }), "transfer");
    expectOk(await actions.acceptOwnership(sessionFor(bob.id)), "accept");

    assert.equal((await actions.load(sessionFor(alice.id)))?.sharedAddress?.current, "1 Main St, Hobart");
    assert.equal((await actions.load(sessionFor(bob.id)))?.sharedAddress?.current, "1 Main St, Hobart");

    // The address is held under a HOUSEHOLD key, not any one person's data key: neither
    // member's DEK opens it (so a member's read never needs another person's whole DEK).
    const row = (await db.query("SELECT current FROM household_shared_address WHERE household_id = $1", [hid]))
      .rows[0];
    assert.ok(row, "the shared address row exists");
    assert.equal(await decryptsUnder(alice.dek, hid, String(row.current)), false, "not under Alice's DEK");
    assert.equal(await decryptsUnder(bob.dek, hid, String(row.current)), false, "not under Bob's DEK");

    // The former owner's key is destroyed (account deletion crypto-shreds it): the address
    // still reads for the remaining member.
    await db.query("UPDATE users SET wrapped_dek = $2 WHERE id = $1", [
      alice.id,
      await keyWrapper.wrap(randomBytes(32)),
    ]);
    assert.equal((await actions.load(sessionFor(bob.id)))?.sharedAddress?.current, "1 Main St, Hobart");
  } finally {
    await db.close();
  }
});

test("a shared address written under the owner's key before the household key existed survives a transfer", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "owner");
    const bob = await makeUser(db, "member");
    const hid = (await seedHousehold(db, { ownerId: alice.id, currency: "AUD" })).id;
    await seedMember(db, { householdId: hid, userId: bob.id });
    // The pre-fix layout: the address encrypted directly under the owner's DEK.
    await setSharedAddress(
      db,
      { householdId: hid, actorId: alice.id, current: "2 Legacy Rd, Perth", upcoming: "3 Next St, Perth" },
      alice.dek,
      { notify: noopNotify },
    );
    const actions = makeActions(db);
    assert.equal((await actions.load(sessionFor(bob.id)))?.sharedAddress?.current, "2 Legacy Rd, Perth");

    expectOk(await actions.transferOwnership(sessionFor(alice.id), { toUserId: bob.id }), "transfer");
    expectOk(await actions.acceptOwnership(sessionFor(bob.id)), "accept");

    for (const who of [alice.id, bob.id]) {
      const loaded = await actions.load(sessionFor(who));
      assert.equal(loaded?.sharedAddress?.current, "2 Legacy Rd, Perth", "the current address reads after transfer");
      assert.equal(loaded?.sharedAddress?.upcoming, "3 Next St, Perth", "and so does the upcoming one");
    }
  } finally {
    await db.close();
  }
});

// =====================================================================================
// UI/UX pass (interaction-13 / newcomer-09 / interaction-20) — the member list names each
// member by their account email, never an internal id; a blank address or amount is a
// missing value, never saved as blank or as a budget of 0.
// =====================================================================================

test("load names every member (and a pending transfer's target) by their account email", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "owner");
    const bob = await makeUser(db, "member");
    const x = (await seedHousehold(db, { ownerId: alice.id, currency: "AUD" })).id;
    await seedMember(db, { householdId: x, userId: bob.id });
    const actions = makeActions(db);
    expectOk(await actions.transferOwnership(sessionFor(alice.id), { toUserId: bob.id }), "transfer started");

    const report = await actions.load(sessionFor(alice.id));
    assert.ok(report);
    const emails = Object.fromEntries(report.members.map((m) => [m.userId, m.email]));
    assert.match(emails[alice.id] ?? "", /^owner-.*@people\.example$/);
    assert.match(emails[bob.id] ?? "", /^member-.*@people\.example$/);
    assert.equal(report.pendingTransfer?.toEmail, emails[bob.id]);
    // Nothing else about the other member is added (no limit, no spending, no address).
    assert.deepEqual(Object.keys(report.members.find((m) => m.userId === bob.id)!).sort(), ["email", "role", "userId"]);
  } finally {
    await db.close();
  }
});

test("a shared address made only of spaces is refused at the boundary and nothing changes", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "owner");
    await seedHousehold(db, { ownerId: alice.id, currency: "AUD" });
    const actions = makeActions(db);
    expectOk(await actions.editSharedAddress(sessionFor(alice.id), { current: "  9 Owner St, Hobart  " }), "a real address");
    await assertRejects4xx("blank address", () => actions.editSharedAddress(sessionFor(alice.id), { current: "    " }));
    assert.equal((await actions.load(sessionFor(alice.id)))?.sharedAddress?.current, "9 Owner St, Hobart", "kept, trimmed");
  } finally {
    await db.close();
  }
});

test("an empty budget or limit field is a missing amount, never a budget of 0", () => {
  for (const raw of [null, "", "   "]) assert.equal(amountInput(raw), null, JSON.stringify(raw));
  assert.equal(amountInput("500"), 500);
  assert.equal(amountInput(" 12.50 "), 12.5);
  assert.equal(amountInput("0"), 0, "an explicit 0 is still allowed");
  assert.ok(Number.isNaN(amountInput("lots")!), "a non-number reaches the boundary, which refuses it");
});
