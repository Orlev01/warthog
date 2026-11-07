// E15-S11 — Spending page loader + currency action
// (`src/app/(portal)/(protected)/spending/actions.ts`, mounted by the thin
// `src/app/(portal)/(protected)/spending/page.tsx`).
//
// RED-first: the spending seam does NOT exist yet (the spending dir holds only a
// placeholder `page.tsx` and has no `actions.ts`), so importing `./actions` throws and
// every test here fails until the builder adds it. That absence IS the point of
// test-first — do NOT implement anything to make these pass; the builder writes
// `actions.ts` afterwards as the minimum code that turns these green, and rewrites the
// placeholder `page.tsx` into the thin loader that mounts <SpendingView> over this seam.
//
// These tests pin BEHAVIOUR (what the loader READS and for whom, what the currency
// action CHANGES in the database and what it REFUSES) against an isolated in-memory
// PGlite with the REAL migrations (`@/test/db`) and the REAL sibling reads/stores
// (own-read, household-read, account-currency, households, agents, card-spend-ledger),
// the REAL session seam and a real `KeyWrapper`. No test asserts on the source text of
// any module, so a later behaviour-preserving refactor (a rename, a moved import, a
// different wrapper element in the view) stays green. No test touches the network or
// Azure.
//
// Why a sibling `actions.ts` factory (not `page.tsx`): a Next `page.tsx` entry file may
// export ONLY its framework fields (its default page component), so it cannot carry an
// injectable, unit-testable seam without breaking `next build`. The thin protected-page
// loader reads the session + database and renders <SpendingView>; the testable logic —
// reading this person's OWN-agent spending + their household totals + their account
// currency + the selectable currencies, and persisting a chosen account currency — lives
// in the plain sibling module `actions.ts` (the convention's `createXActions(deps)`
// factory, here `createSpendingActions`, the same shape as the already-built
// notifications / activity / home actions). These tests drive that factory directly with
// real seams; the page wires a thin `"use server"` wrapper over it.
//
// ─── THE PINNED CONTRACT (chosen by the tester; the implementation conforms to it) ──────
//
//   createSpendingActions(deps): {
//     load(session):                        Promise<SpendingData>
//     setAccountCurrency(session, input):   Promise<SetCurrencyResult>   // input: { currency: string }
//   }
//
//   deps: {
//     db: Db;              // the process-wide database
//     clock: Clock;        // the injected clock (the period bucket, never SQL now())
//     keyWrapper: KeyWrapper; // resolves the SESSION person's own DEK for the own-spending read
//   }
//
//   type SpendingData = {
//     own: OwnSpending;                           // the SESSION user's own-agent spending detail
//     household: HouseholdSpendingReport | null;  // the household TOTALS, or null when in no household
//     accountCurrency: string;                    // the session user's current account currency (default AUD)
//     currencyOptions: readonly string[];         // the selectable ISO 4217 codes (each one settable)
//   }
//     — assignable to <SpendingView>'s props, so the page mounts the view with it.
//
//   type SetCurrencyResult = { ok: true; currency?: string } | { ok: false; reason: string }
//
//   • Both methods take the person's VERIFIED Session and derive the acting user id from
//     `session.userId` — NEVER a client-supplied value (CLAUDE.md member scope / design §5).
//     There is no userId on any input, so a signed-in person reads only THEIR OWN spending
//     and can set only THEIR OWN account currency.
//   • load reads ONLY the session user's own agents' spending, and (when they are in a
//     household) the household TOTALS — never another member's merchants or release entries,
//     never a user outside their household.
//   • setAccountCurrency persists a valid ISO code for the session user only; an unknown /
//     malformed code is rejected (a 4xx at the boundary or a { ok: false } refusal) and
//     NOTHING is written (a previously stored value survives).
//
// ─── Acceptance criteria → tests ──────────────────────────────────────────────────────
//   AC1 — the loader reads the session user's own-agent spending + (in a household) the
//         household totals + the account currency + the currency options, and the result
//         mounts in <SpendingView>.
//   AC2 — setAccountCurrency validates the code and persists it for the session user ONLY,
//         rejecting an unknown code (4xx / refusal, nothing stored).
//   AC3 — a signed-in user never sees another household member's merchants or entries, nor
//         any spending of a user outside their own household (filtered by session user id).
//   AC4 [obligation:validate-and-parameterize-input] (INV-102) — malformed / oversized input
//         is rejected with a 4xx HttpError BEFORE any query, and a SQL-injection probe in the
//         currency field cannot alter a query (parameter binding is used; the table survives).
//   AC5 [obligation:secrets-from-env] (INV-103) — the actions run purely from their injected
//         seams and read no `process.env`, so a decoy env secret never lands in the loaded
//         data or the stored currency.
//
// Every db handle is closed in a `finally`; each test uses its own `freshDb()`, so tests
// share no state.

import * as React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { renderToStaticMarkup } from "react-dom/server";

import { createSpendingActions } from "./actions";

import { SpendingView } from "@/components/spending/spending-view";
import { createUser } from "@/server/db/users";
import { createSession, type Session } from "@/server/auth/session";
import { getAccountCurrency } from "@/server/db/account-currency";
import { createHousehold, addMember, setMemberLimit } from "@/server/db/households";
import { createAgent } from "@/server/db/agents";
import { upsertPermissions } from "@/server/db/agent-permissions";
import { recordRelease, periodKeyFor, type PeriodKeys, type StoredRelease } from "@/server/db/card-spend-ledger";
import { HttpError } from "@/server/http/validate";
import { localAesKeyWrapper, type KeyWrapper } from "@/server/crypto/key-wrapper";
import { fixedClock, type Clock } from "@/server/seams/clock";
import { systemRandom } from "@/server/seams/random";
import { freshDb } from "@/test/db";
import type { Db, QueryResult } from "@/server/db/index";

// --- the contract result type, declared here so the tests read cleanly (see header) -----

type SetCurrencyResult = { ok: true; currency?: string } | { ok: false; reason: string };

// --- fixtures ---------------------------------------------------------------------------

const DEK_BYTES = 32; // a 256-bit per-person data key
const KEK_BYTES = 32; // the local AES-256 key-encryption key for the KeyWrapper seam

// The frozen instant every read derives its period bucket through — noon mid-month UTC, so
// the month/day/week buckets are unambiguous in UTC calendar arithmetic (the convention the
// sibling spending reads use). A loader that wrongly called Date.now() would land elsewhere.
const NOW = new Date("2026-11-15T12:00:00.000Z");
const clock: Clock = fixedClock(NOW);

// The three period buckets NOW falls in, derived through the ledger's own `periodKeyFor`
// (the one source of truth for its bucket keys), so a release here lands in the current
// bucket whichever period the budget uses.
const KEYS_NOW: PeriodKeys = {
  day: periodKeyFor("day", NOW),
  week: periodKeyFor("week", NOW),
  month: periodKeyFor("month", NOW),
};

// pg `numeric` may come back as a number or a string depending on the driver; compare the
// VALUE, not its representation.
const num = (value: unknown): number => Number(value);

function keyWrapperFor(): KeyWrapper {
  return localAesKeyWrapper(randomBytes(KEK_BYTES));
}

// Build the spending actions over the injected seams (db, clock, keyWrapper) — exactly what
// the thin page composes from `getServerDb()` + `systemClock` + `selectKeyWrapper(...)`.
function makeActions(db: Db, keyWrapper: KeyWrapper): ReturnType<typeof createSpendingActions> {
  return createSpendingActions({ db, clock, keyWrapper });
}

// Create a person whose wrapped DEK really unwraps under `keyWrapper` (the resolution path
// the loader uses to decrypt this person's own-agent activity), returning their id + raw DEK.
async function makePerson(
  db: Db,
  keyWrapper: KeyWrapper,
  who: string,
): Promise<{ userId: string; dek: Uint8Array }> {
  const dek = randomBytes(DEK_BYTES);
  const user = await createUser(db, {
    email: `${who}-${randomUUID()}@warthog.com.au`,
    wrappedDek: await keyWrapper.wrap(dek),
  });
  return { userId: user.id, dek };
}

// A real verified session for `userId` — the actions read `session.userId` from it.
async function sessionFor(db: Db, userId: string): Promise<Session> {
  return (await createSession(db, userId, { clock, random: systemRandom })).session;
}

// A fully-populated grants record (mirrors the sibling own-read test's fixture); a caller
// overrides only what it is about. Built via a helper so excess-property checks never bite.
type Grants = Parameters<typeof upsertPermissions>[1];
type CardBudget = NonNullable<Grants["cardBudget"]>;
function baseGrants(userId: string, connectionId: string, overrides: Partial<Grants> = {}): Grants {
  return {
    userId,
    connectionId,
    grantedConnectors: ["gmail"],
    readTools: true,
    changeTools: "ask_first",
    identityAccess: false,
    highTierAccess: false,
    cardAccess: true,
    cardBudget: { amount: 500, currency: "AUD", period: "month" },
    skillsScope: [],
    memoryRead: false,
    sharing: false,
    rulesScope: [],
    rateLimit: 120,
    ...overrides,
  } as Grants;
}

// Give `userId` one of their own agents (a card budget) plus one approved release this
// period (its merchant is distinctive so a "this is shown / this is hidden" assertion is
// honest). When `householdId` is set, the release also counts toward that household total —
// but it still appears in the OWNER's own detail regardless. Returns ids for assertions.
async function setupOwnAgent(
  db: Db,
  userId: string,
  opts: { displayName: string; merchant: string; amount: number; householdId?: string | null },
): Promise<{ agentId: string; connectionId: string; releaseId: string }> {
  const connectionId = randomUUID();
  const agent = await createAgent(
    db,
    { userId, connectionId, displayName: opts.displayName, platform: "Claude Desktop" },
    clock,
  );
  await upsertPermissions(
    db,
    baseGrants(userId, connectionId, {
      cardAccess: true,
      cardBudget: { amount: 500, currency: "AUD", period: "month" } as CardBudget,
    }),
  );
  const rel = await recordRelease(db, {
    userId,
    connectionId,
    householdId: opts.householdId ?? null,
    amount: opts.amount,
    currency: "AUD",
    merchant: opts.merchant,
    periodKeys: KEYS_NOW,
  });
  return { agentId: agent.id, connectionId, releaseId: rel.id };
}

// Record one approved household release this period for `userId` (no agent needed — the
// household total sums per member across any connection). The merchant is distinctive so an
// absence check can prove the loader never surfaces another member's merchant.
async function recordHouseholdRelease(
  db: Db,
  opts: { userId: string; householdId: string; merchant: string; amount: number },
): Promise<StoredRelease> {
  return recordRelease(db, {
    userId: opts.userId,
    connectionId: randomUUID(),
    householdId: opts.householdId,
    amount: opts.amount,
    currency: "AUD",
    merchant: opts.merchant,
    periodKeys: KEYS_NOW,
  });
}

// Whether a relation of this exact name exists on this handle (a non-throwing probe scoped
// to the one table under test — behaviour, not source text).
async function tableExists(db: Db, name: string): Promise<boolean> {
  const result = await db.query("SELECT to_regclass($1) AS t", [name]);
  return result.rows[0]?.t != null;
}

// A recording proxy over a real db: passes queries through while capturing (text, values),
// so "every value is bound, never spliced into the SQL text" is observable (INV-102).
interface RecordingProxy extends Db {
  readonly calls: { text: string; values: unknown[] }[];
}
function recordingProxy(real: Db): RecordingProxy {
  const calls: { text: string; values: unknown[] }[] = [];
  return {
    calls,
    query(text: string, values: unknown[] = []): Promise<QueryResult> {
      calls.push({ text, values });
      return real.query(text, values);
    },
    close(): Promise<void> {
      return real.close();
    },
  };
}

// Assert that awaiting `fn()` rejects with a 4xx HttpError at the validation boundary.
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
      (err as HttpError).status >= 400 && (err as HttpError).status < 500,
      `${label}: the rejection must carry a 4xx status, got ${(err as HttpError).status}`,
    );
  }
  assert.ok(threw, `${label}: must be rejected (nothing was thrown)`);
}

// Assert a set was REJECTED — EITHER a thrown 4xx HttpError at the boundary OR a returned
// { ok: false } domain refusal (the builder may map an unknown code either way; the page
// turns a refusal into a 4xx notice). The caller then proves nothing was persisted.
async function assertSetRejected(label: string, fn: () => Promise<SetCurrencyResult>): Promise<void> {
  try {
    const result = await fn();
    assert.equal(result.ok, false, `${label}: an unknown/invalid code must be rejected, not a success`);
    if (!result.ok) {
      assert.ok(result.reason.length > 0, `${label}: a refusal carries a plain reason`);
    }
  } catch (err) {
    assert.ok(
      err instanceof HttpError && err.status >= 400 && err.status < 500,
      `${label}: a thrown rejection must be a 4xx HttpError, got ${String(err)}`,
    );
  }
}

// Render the loaded data through the real <SpendingView> (server render, no DOM — the ADR
// forbids jsdom), returning the markup. Proves the loader's output is a mountable SpendingView
// prop set. Merchant markers below carry no HTML-special characters, so a raw substring check
// is honest.
function renderView(view: Parameters<typeof SpendingView>[0]): string {
  return renderToStaticMarkup(<SpendingView {...view} />);
}

// ========================================================================================
// AC1 — the loader reads the session user's own-agent spending + the household totals + the
// account currency + the currency options, and the result mounts in <SpendingView>.
// ========================================================================================

test("load reads the session user's own-agent spending, household totals, account currency and options — and mounts in SpendingView", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const alice = await makePerson(db, keyWrapper, "ac1-owner");
    const bob = await makePerson(db, keyWrapper, "ac1-member");

    const hid = (await createHousehold(db, { ownerId: alice.userId, currency: "AUD", monthlyBudget: 1000 })).id;
    assert.ok((await addMember(db, { householdId: hid, userId: bob.userId })).ok, "bob joins the household");
    await setMemberLimit(db, { householdId: hid, actorId: alice.userId, userId: bob.userId, monthlyLimit: 200 });

    const ALICE_MERCHANT = `OWN-MERCHANT-ALICE-${randomUUID()}`;
    await setupOwnAgent(db, alice.userId, {
      displayName: "Shopping Assistant",
      merchant: ALICE_MERCHANT,
      amount: 40.17,
      householdId: hid,
    });
    await recordHouseholdRelease(db, { userId: bob.userId, householdId: hid, merchant: `HH-BOB-${randomUUID()}`, amount: 25 });

    const session = await sessionFor(db, alice.userId);
    const view = await makeActions(db, keyWrapper).load(session);

    // Own-agent spending detail: Alice's agent + her release's merchant.
    assert.ok(Array.isArray(view.own.agents), "own spending carries an agents list");
    const aliceAgent = view.own.agents.find((a: { displayName: string }) => a.displayName === "Shopping Assistant");
    assert.ok(aliceAgent, "the session user's own agent appears in the own-spending detail");
    const merchants = aliceAgent.releases.map((r: { merchant: string }) => r.merchant);
    assert.ok(merchants.includes(ALICE_MERCHANT), "the own agent's release merchant is loaded");

    // Household totals (the session user is in a household): both members appear, totals-only.
    assert.ok(view.household, "the household totals are loaded for a member");
    assert.equal(view.household.householdId, hid, "the household is resolved from the session user's id");
    const memberIds = view.household.members.map((m: { userId: string }) => m.userId);
    assert.ok(memberIds.includes(alice.userId) && memberIds.includes(bob.userId), "both members are totalled");

    // Account currency + options.
    assert.equal(view.accountCurrency, "AUD", "the session user's current account currency (the default) is loaded");
    assert.ok(Array.isArray(view.currencyOptions) && view.currencyOptions.length > 0, "a non-empty currency option list is loaded");

    // And it mounts in the real view: the markup shows the own merchant and the currency code.
    const markup = renderView(view);
    assert.ok(markup.length > 0, "SpendingView renders from the loaded data");
    assert.ok(markup.includes(ALICE_MERCHANT), "the mounted view shows the session user's own merchant");
    assert.ok(markup.includes("AUD"), "the mounted view shows the account currency");
  } finally {
    await db.close();
  }
});

test("load returns household=null for a person in no household, and an empty own list when they have no agents", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const dave = await makePerson(db, keyWrapper, "ac1-lonely");
    const session = await sessionFor(db, dave.userId);

    const view = await makeActions(db, keyWrapper).load(session);

    assert.equal(view.household, null, "a person in no household gets null household totals");
    assert.deepEqual(view.own.agents, [], "a person with no agents gets an empty own-spending list");
    assert.equal(view.accountCurrency, "AUD", "an unset person reads the default account currency");
    assert.ok(view.currencyOptions.length > 0, "the currency options are still offered");

    // Still mounts — the empty-state view renders without throwing.
    assert.ok(renderView(view).length > 0, "the empty-state data mounts in SpendingView");
  } finally {
    await db.close();
  }
});

// ========================================================================================
// AC3 — the loader reads ONLY the session user's own agents' spending (filtered by session
// id): one person's own section never shows another person's agents or merchants.
// ========================================================================================

test("load reads only the session user's own agents — never another person's", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const alice = await makePerson(db, keyWrapper, "own-alice");
    const bob = await makePerson(db, keyWrapper, "own-bob");

    const ALICE_MERCHANT = `OWN-MERCHANT-ALICE-${randomUUID()}`;
    const BOB_MERCHANT = `OWN-MERCHANT-BOB-${randomUUID()}`;
    await setupOwnAgent(db, alice.userId, { displayName: "AliceAgent", merchant: ALICE_MERCHANT, amount: 11 });
    await setupOwnAgent(db, bob.userId, { displayName: "BobAgent", merchant: BOB_MERCHANT, amount: 22 });

    const actions = makeActions(db, keyWrapper);

    const aliceView = await actions.load(await sessionFor(db, alice.userId));
    const aliceAgentNames = aliceView.own.agents.map((a: { displayName: string }) => a.displayName);
    assert.ok(aliceAgentNames.includes("AliceAgent"), "Alice sees her own agent");
    assert.ok(!aliceAgentNames.includes("BobAgent"), "Alice never sees Bob's agent");
    assert.ok(!JSON.stringify(aliceView.own).includes(BOB_MERCHANT), "Bob's merchant never appears in Alice's own section");

    const bobView = await actions.load(await sessionFor(db, bob.userId));
    const bobAgentNames = bobView.own.agents.map((a: { displayName: string }) => a.displayName);
    assert.ok(bobAgentNames.includes("BobAgent"), "Bob sees his own agent");
    assert.ok(!bobAgentNames.includes("AliceAgent"), "Bob never sees Alice's agent");
    assert.ok(!JSON.stringify(bobView.own).includes(ALICE_MERCHANT), "Alice's merchant never appears in Bob's own section");
  } finally {
    await db.close();
  }
});

// ========================================================================================
// AC3 — a signed-in user never sees another HOUSEHOLD MEMBER'S merchants or release entries:
// the household section is TOTALS only. A member's running total is allowed; a merchant or a
// release id is not.
// ========================================================================================

test("a household member's merchants and release entries are never exposed — only the member's total", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const alice = await makePerson(db, keyWrapper, "hh-alice");
    const bob = await makePerson(db, keyWrapper, "hh-bob");

    const hid = (await createHousehold(db, { ownerId: alice.userId, currency: "AUD", monthlyBudget: 1000 })).id;
    await addMember(db, { householdId: hid, userId: bob.userId });

    const BOB_MERCHANT = `SECRET-MERCHANT-BOB-${randomUUID()}`;
    const bobRelease = await recordHouseholdRelease(db, {
      userId: bob.userId,
      householdId: hid,
      merchant: BOB_MERCHANT,
      amount: 47.57,
    });

    const aliceView = await makeActions(db, keyWrapper).load(await sessionFor(db, alice.userId));
    const serialized = JSON.stringify(aliceView);

    // Bob's merchant and his individual release id are never surfaced to Alice.
    assert.ok(!serialized.includes(BOB_MERCHANT), "another member's merchant is never surfaced");
    assert.ok(!serialized.includes(bobRelease.id), "another member's individual release entry is never surfaced");

    // But Bob IS totalled as a member (a number), which is allowed — totals only.
    assert.ok(aliceView.household, "Alice, a member, gets the household totals");
    const bobRow = aliceView.household.members.find((m: { userId: string }) => m.userId === bob.userId);
    assert.ok(bobRow, "Bob appears as a household member (a total, not a merchant/entry)");
    assert.equal(typeof bobRow.spendToDate, "number", "a member's spend is a bare total");
  } finally {
    await db.close();
  }
});

// ========================================================================================
// AC3 — a signed-in user never sees any spending of a user OUTSIDE their own household.
// ========================================================================================

test("spending of a user outside the session user's household is never visible", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const alice = await makePerson(db, keyWrapper, "out-alice");
    const carol = await makePerson(db, keyWrapper, "out-carol");

    // Alice owns household X. Carol owns a SEPARATE household Y, with her own spending.
    const x = (await createHousehold(db, { ownerId: alice.userId, currency: "AUD", monthlyBudget: 1000 })).id;
    const y = (await createHousehold(db, { ownerId: carol.userId, currency: "AUD", monthlyBudget: 500 })).id;

    const CAROL_HH_MERCHANT = `OUTSIDE-MERCHANT-CAROL-${randomUUID()}`;
    const CAROL_OWN_MERCHANT = `OUTSIDE-OWN-CAROL-${randomUUID()}`;
    await recordHouseholdRelease(db, { userId: carol.userId, householdId: y, merchant: CAROL_HH_MERCHANT, amount: 10 });
    await setupOwnAgent(db, carol.userId, { displayName: "CarolAgent", merchant: CAROL_OWN_MERCHANT, amount: 33 });

    const aliceView = await makeActions(db, keyWrapper).load(await sessionFor(db, alice.userId));
    const serialized = JSON.stringify(aliceView);

    assert.ok(aliceView.household, "Alice gets her OWN household totals");
    assert.equal(aliceView.household.householdId, x, "resolved from Alice's id — her household X, never Carol's Y");

    // Carol — a user outside Alice's household — never appears: not her merchants, not her id,
    // not her household id.
    assert.ok(!serialized.includes(CAROL_HH_MERCHANT), "Carol's household-spend merchant is never visible to Alice");
    assert.ok(!serialized.includes(CAROL_OWN_MERCHANT), "Carol's own-agent merchant is never visible to Alice");
    assert.ok(!serialized.includes(carol.userId), "Carol's user id never leaks into Alice's loaded data");
    assert.ok(!serialized.includes(y), "the other household's id never leaks into Alice's loaded data");
    const memberIds = aliceView.household.members.map((m: { userId: string }) => m.userId);
    assert.ok(!memberIds.includes(carol.userId), "a user outside the household is never a member of it");
  } finally {
    await db.close();
  }
});

// ========================================================================================
// AC1 / AC2 — the loader reports the session user's account currency (the default, and a set
// value), member-scoped; and the offered options are valid, settable codes including the
// current one (no dead option).
// ========================================================================================

test("load reflects the session user's own account currency (default, then a set value), never another's", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const alice = await makePerson(db, keyWrapper, "cur-alice");
    const bob = await makePerson(db, keyWrapper, "cur-bob");
    const actions = makeActions(db, keyWrapper);
    const aliceSession = await sessionFor(db, alice.userId);

    // Default before anything is set.
    assert.equal((await actions.load(aliceSession)).accountCurrency, "AUD", "an unset person reads the default (AUD)");

    // After the session user sets USD, her load reflects it; Bob is unaffected.
    const set = await actions.setAccountCurrency(aliceSession, { currency: "USD" });
    assert.equal(set.ok, true, "a valid code is accepted");

    assert.equal((await actions.load(aliceSession)).accountCurrency, "USD", "the chosen code reads back for the session user");
    assert.equal(
      (await actions.load(await sessionFor(db, bob.userId))).accountCurrency,
      "AUD",
      "another person still reads the default — one person's currency never leaks to another",
    );
  } finally {
    await db.close();
  }
});

test("currencyOptions offers only settable codes, including the default and the current currency", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const alice = await makePerson(db, keyWrapper, "opt-alice");
    const actions = makeActions(db, keyWrapper);
    const session = await sessionFor(db, alice.userId);

    const view = await actions.load(session);
    assert.ok(view.currencyOptions.includes(view.accountCurrency), "the current account currency is always a selectable option");
    assert.ok(view.currencyOptions.includes("AUD"), "the default (AUD) is offered");
    assert.ok(view.currencyOptions.includes("USD"), "a common currency (USD) is offered");

    // No dead option: EVERY offered code is one setAccountCurrency actually accepts.
    for (const code of view.currencyOptions) {
      const result = await actions.setAccountCurrency(session, { currency: code });
      assert.equal(result.ok, true, `the offered currency option ${code} must be settable`);
    }
  } finally {
    await db.close();
  }
});

// ========================================================================================
// AC2 — setAccountCurrency persists a valid code for the session user only, and rejects an
// unknown code (storing nothing — a previously saved value survives).
// ========================================================================================

test("setAccountCurrency persists a valid code for the session user only", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const alice = await makePerson(db, keyWrapper, "set-alice");
    const bob = await makePerson(db, keyWrapper, "set-bob");
    const actions = makeActions(db, keyWrapper);

    const result = await actions.setAccountCurrency(await sessionFor(db, alice.userId), { currency: "EUR" });
    assert.equal(result.ok, true, "a valid code is accepted");

    assert.equal(await getAccountCurrency(db, alice.userId), "EUR", "the code is persisted for the session user");
    assert.equal(await getAccountCurrency(db, bob.userId), "AUD", "no other person's currency is touched (they read the default)");
  } finally {
    await db.close();
  }
});

test("setAccountCurrency rejects an unknown currency and stores nothing (a previous value survives)", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const alice = await makePerson(db, keyWrapper, "unknown-alice");
    const actions = makeActions(db, keyWrapper);
    const session = await sessionFor(db, alice.userId);

    // A valid baseline first, so a later rejected set has something it must NOT overwrite.
    assert.equal((await actions.setAccountCurrency(session, { currency: "GBP" })).ok, true, "baseline set");

    // "ZZZ" is well-formed (three uppercase letters) but not an assigned ISO 4217 code: it
    // proves the action checks a KNOWN SET, not merely a shape. It is rejected (4xx/refusal).
    await assertSetRejected("set unknown code ZZZ", () => actions.setAccountCurrency(session, { currency: "ZZZ" }));

    assert.equal(
      await getAccountCurrency(db, alice.userId),
      "GBP",
      "the rejected unknown code stored nothing — the earlier valid code survives (neither overwritten nor cleared)",
    );
  } finally {
    await db.close();
  }
});

// ========================================================================================
// AC4 [obligation:validate-and-parameterize-input] — malformed / oversized input is rejected
// with a 4xx HttpError at the validation boundary BEFORE any query, persisting nothing.
// ========================================================================================

test("setAccountCurrency rejects malformed or oversized input with a 4xx, persisting nothing", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const alice = await makePerson(db, keyWrapper, "malformed-alice");
    const actions = makeActions(db, keyWrapper);
    const session = await sessionFor(db, alice.userId);

    // A mis-typed currency (a number, not a string) — rejected at the boundary.
    await assertRejects4xx("mis-typed currency", () =>
      actions.setAccountCurrency(session, { currency: 12345 as unknown as string }),
    );
    // An absurdly oversized currency string — rejected by the length cap before any query.
    await assertRejects4xx("oversized currency", () =>
      actions.setAccountCurrency(session, { currency: "A".repeat(100_000) }),
    );

    // Nothing was persisted by either rejected call — the person still reads the default.
    assert.equal(await getAccountCurrency(db, alice.userId), "AUD", "a rejected set stores nothing");
  } finally {
    await db.close();
  }
});

// ========================================================================================
// AC4 [obligation:validate-and-parameterize-input] — input values travel BOUND, and a
// SQL-injection probe in the currency field cannot alter a query: proven with a recording
// proxy over a real db that passes queries through while capturing text + values.
// ========================================================================================

test("setAccountCurrency binds its values, and a SQL-injection probe cannot alter a query", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const alice = await makePerson(db, keyWrapper, "probe-alice");
    const session = await sessionFor(db, alice.userId); // minted on the real db
    const proxy = recordingProxy(db);
    const actions = makeActions(proxy, keyWrapper); // the set path runs through the proxy

    // Phase 1 — a clean, valid set binds the session user id and the chosen code as VALUES,
    // never concatenated into the SQL text (proves parameter binding is used).
    const ok = await actions.setAccountCurrency(session, { currency: "USD" });
    assert.equal(ok.ok, true, "a valid code is accepted");
    const bound = proxy.calls.flatMap((c) => c.values);
    assert.ok(bound.includes(session.userId), "the session user id travels as a bound value");
    assert.ok(bound.includes("USD"), "the chosen code travels as a bound value");
    for (const call of proxy.calls) {
      assert.ok(!call.text.includes("'USD'"), "the code is bound, never concatenated into the SQL");
      assert.ok(!call.text.includes(session.userId), "the user id is bound, never concatenated into the SQL");
    }

    // Phase 2 — a SQL-injection probe in the currency field is rejected and cannot alter a
    // query: no injected statement ever appears in a query's SQL text, and the table survives.
    const PROBE = "AUD'); DROP TABLE account_currency; --";
    await assertSetRejected("probe currency", () => actions.setAccountCurrency(session, { currency: PROBE }));
    for (const call of proxy.calls) {
      assert.ok(!/\bDROP\s+TABLE\b/i.test(call.text), "no injected statement appears in the SQL text");
      assert.ok(!call.text.includes(PROBE), "the probe is never spliced into the SQL text");
    }
    assert.equal(await tableExists(db, "account_currency"), true, "the account_currency table survives the probe");
    assert.equal(await getAccountCurrency(db, alice.userId), "USD", "the probe changed nothing (still USD)");
  } finally {
    await db.close();
  }
});

// ========================================================================================
// AC5 [obligation:secrets-from-env] — the actions run purely from their injected seams and
// read no `process.env`: a decoy env secret never lands in the loaded data or the stored
// currency.
// ========================================================================================

test("the actions read no process.env: a decoy env secret never appears in loaded data or the stored currency", async () => {
  const DECOY = "sk_live_DECOY_must_never_appear_in_warthog_spending";
  const prev = process.env.WARTHOG_DECOY_SECRET;
  process.env.WARTHOG_DECOY_SECRET = DECOY;
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const alice = await makePerson(db, keyWrapper, "env-alice");
    const actions = makeActions(db, keyWrapper);
    const session = await sessionFor(db, alice.userId);

    await setupOwnAgent(db, alice.userId, { displayName: "EnvAgent", merchant: `OWN-ENV-${randomUUID()}`, amount: 12.25 });

    // The loader and the set run from ONLY their injected seams (db, clock, keyWrapper) — no
    // connection string, no key read from env — and still produce the data / persist the code.
    const view = await actions.load(session);
    assert.ok(!JSON.stringify(view).includes(DECOY), "no ambient env value is folded into the loaded data");

    const set = await actions.setAccountCurrency(session, { currency: "USD" });
    assert.equal(set.ok, true, "the set runs from injected deps alone — no app env needed");
    assert.ok(!JSON.stringify(set).includes(DECOY), "no ambient env value is folded into the result");
    assert.equal(await getAccountCurrency(db, alice.userId), "USD", "the stored code is the chosen one — no env value substituted");
  } finally {
    await db.close();
    if (prev === undefined) delete process.env.WARTHOG_DECOY_SECRET;
    else process.env.WARTHOG_DECOY_SECRET = prev;
  }
});
