// E15-S07 — Household + currency card-request context resolver
// (`src/server/spending/household-context.ts`), wired into the policy-context loader
// (`src/server/mcp/context.ts`) so the pure policy engine (E03-S13) can enforce the
// per-member limit and the shared household budget.
//
// RED-first: the module does not exist yet, so importing `./household-context` throws and
// every test here fails (and `tsc --noEmit` reddens on the missing module) until the
// builder writes the minimum code to pass. That absence IS the point of test-first; do NOT
// implement anything to make these pass — the builder writes `household-context.ts`
// afterwards.
//
// These tests pin BEHAVIOUR (what the resolver DOES: what it returns for a member's card
// request, whose data it reads, how it converts a foreign amount, what a handler rejects,
// that every value reaches the db BOUND, and — fed to the real `evaluate` engine — that the
// member limit / household budget / no-rate denials actually fire), never the source text of
// the module — a later rename that preserves behaviour must not redden them.
//
// WHY this exists (brief "Currency" + "Household sharing"; design §8 step 4): a card request
// is checked against the per-member limit and the shared household budget — both in the
// household currency, set by the owner (defaulting to the owner's account currency) — BEFORE
// any release; a request in another currency is converted for the checks with the latest
// daily reference rate (the approval shows both amounts and the rate's date), and a request
// with no available rate is refused with a plain reason. The pure engine already CONSUMES a
// household policy and a reference rate from its context (`CardPolicy.household`, `ctx.rate`);
// this resolver SUPPLIES them, member-scoped by the connection's owning user — never a value
// from the client (INV-102). All figures are plaintext metadata (budgets, limits, an ISO 4217
// code, a daily reference scalar — design §4.1), so the resolver holds no key and reads no
// `process.env` (INV-103): the db and the clock are INJECTED seams.
//
// ---------------------------------------------------------------------------
// THE PINNED CONTRACT (chosen by the tester; the implementation conforms to it).
//
//   interface CardRequest {                 // the card request being evaluated.
//     amount: number;                       // major units, in `currency`.
//     currency: string;                     // the ISO 4217 code the agent asked in.
//   }
//
//   interface CardRequestContextDeps {      // the injected seams — no process.env.
//     db: Db;                               // the parameterizing database seam.
//     clock: Clock;                         // the current instant → today's rate date +
//                                            // the current monthly spend bucket.
//   }
//
//   interface ConvertedAmount {             // present only when a FOREIGN amount was
//     amount: number;                       //   converted via a reference rate:
//     currency: string;                     // === targetCurrency (the household/account ccy)
//     rate: number;                         // the reference rate used (quote per base)
//     rateDate: string;                     // ISO "YYYY-MM-DD" — the date that rate applies to
//   }
//
//   interface HouseholdSpendingContext {    // null when the member has no household.
//     householdId: string;
//     currency: string;                     // the household currency (=== targetCurrency)
//     monthlyBudget: number | null;         // the shared monthly household budget (null until set)
//     budgetSpendToDate: number;            // household spend so far this month (every member's)
//     memberLimit: number | null;           // this member's per-member monthly limit (null until set)
//     memberSpendToDate: number;            // this member's own spend so far this month
//   }
//
//   interface CardRequestContext {
//     accountCurrency: string;              // the member's OWN account currency (default AUD)
//     targetCurrency: string;               // the currency the limit + budget are checked in:
//                                            //   the household currency in a household, else the
//                                            //   account currency.
//     converted: ConvertedAmount | null;    // null for a same-currency request OR when deniable.
//     deniable: boolean;                     // true ONLY when a foreign request has no usable rate.
//     reason: string | null;                 // the plain reason when deniable, else null.
//     household: HouseholdSpendingContext | null;  // null when the member has no household.
//   }
//
//   resolveCardRequestContext(userId: string, request: CardRequest, deps: CardRequestContextDeps)
//     : Promise<CardRequestContext>
//     • reads the member's account currency, their household (if any) with its currency /
//       monthly budget / this member's monthly limit, the household + member spend so far this
//       month, and the latest daily reference rate on or before today for request→target,
//       every read member-scoped by `userId` (bound as a parameter), and returns them as one
//       object. A foreign request with no rate is marked `deniable` with a plain reason.
//
// Acceptance criteria → tests:
//   AC1 — resolving for a member of a household returns their account currency, the amount
//         converted to the household currency via the latest daily rate (with the rate date),
//         their monthly limit and the household monthly budget with spend-to-date.
//   AC2 — no rate → deniable with a plain reason; fed to the engine, a context over the member
//         limit / over the household budget / with no rate DENIES.
//   AC3 — built from the given user id (never a client value); a member with no household gets
//         no household budget or member limit (so their own agent budget still applies).
//   AC4 [obligation:validate-and-parameterize-input] (INV-102) — a handler rejects malformed /
//        oversized / mis-shaped input with a 4xx before the resolver runs, and takes the user id
//        from the session (never the body); a SQL-injection probe in an input field travels as a
//        BOUND value and cannot alter a query. The handler is a test fixture (the intended
//        usage), not an implementation file.
//   AC5 [obligation:secrets-from-env] (INV-103) — the resolver runs purely from its injected
//        seams and reads no `process.env`, so a decoy secret in the environment never lands in
//        the resolved context.
//
// Every real-db test uses its own `freshDb()` (an isolated in-memory PGlite with the real
// migrations) and closes it in a `finally`, so tests share no state and leave no open handle.

import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";

import {
  resolveCardRequestContext,
  type CardRequest,
  type CardRequestContext,
} from "./household-context";
import { createUser } from "../db/users";
import { setAccountCurrency } from "../db/account-currency";
import { createHousehold, addMember, setMemberLimit } from "../db/households";
import { recordRelease, periodKeyFor, type PeriodKeys } from "../db/card-spend-ledger";
import { upsertRate } from "../db/exchange-rates";
import { freshDb } from "../../test/db";
import { type Db, type QueryResult } from "../db/index";
import { parseBody, HttpError } from "../http/validate";
import { fixedClock, type Clock } from "../seams/clock";
import { evaluate, type PolicyContext, type PolicyCall } from "../../domain/policy/evaluate";
import type { ReferenceRate } from "../../domain/currency/convert";

// --- fixtures ----------------------------------------------------------------------

// The frozen instant every resolve reads time through. Noon mid-month UTC, so today's rate
// date ("2026-11-15") and the current month bucket ("2026-11") are unambiguous in UTC.
const NOW = new Date("2026-11-15T12:00:00.000Z");

// Two opaque agent-connection uuids (the connections table arrives in a later migration; the
// ledger binds the column rather than a FK). The resolver never scopes by these — a member's
// spend spans ALL their connections — but a release needs one.
const CONN_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const CONN_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

// The three period buckets NOW falls in (derived through the ledger's own `periodKeyFor`, the
// one source of truth for its bucket keys — so a release here lands in the month the resolver
// sums over).
const KEYS_NOW: PeriodKeys = {
  day: periodKeyFor("day", NOW),
  week: periodKeyFor("week", NOW),
  month: periodKeyFor("month", NOW),
};

// A person with a throwaway wrapped DEK (the resolver reads only plaintext metadata, so the
// DEK is never exercised — but `users.wrapped_dek` is NOT NULL).
async function makeUser(db: Db, who: string): Promise<string> {
  const user = await createUser(db, { email: `${who}@warthog.com.au`, wrappedDek: `wrapped-${who}` });
  return user.id;
}

// Record one approved card release this month for `userId`, counting toward `householdId`
// (null for a solo member). The merchant is incidental — the resolver sums amounts only.
async function record(
  db: Db,
  opts: { userId: string; householdId: string | null; amount: number; connectionId: string; currency?: string },
): Promise<void> {
  await recordRelease(db, {
    userId: opts.userId,
    connectionId: opts.connectionId,
    householdId: opts.householdId,
    amount: opts.amount,
    currency: opts.currency ?? "AUD",
    merchant: "BoxCo",
    periodKeys: KEYS_NOW,
  });
}

// A card-request PolicyCall in the engine's shape (connector === null, request "card").
function cardCall(request: CardRequest, overrides: Partial<PolicyCall> = {}): PolicyCall {
  return {
    connector: null,
    tool: "request_card",
    makesChange: false,
    request: "card",
    amount: request.amount,
    currency: request.currency,
    merchant: "BoxCo",
    ...overrides,
  };
}

// Map a RESOLVED card-request context onto the pure engine's PolicyContext exactly as the
// pipeline would: the resolved reference rate becomes `ctx.rate` (null when deniable/same
// currency); the per-member limit and the household budget — each with its spend-to-date as a
// single synthetic release at `now` (which falls inside the monthly window) — become
// `card.household`. The agent's own budget is left generous so ONLY the household / currency
// checks can deny, isolating the behaviour under test.
function engineCtxFromResolved(resolved: CardRequestContext, request: CardRequest, now: Date): PolicyContext {
  const rate: ReferenceRate | null = resolved.converted
    ? { from: request.currency, to: resolved.converted.currency, rate: resolved.converted.rate, date: resolved.converted.rateDate }
    : null;
  const h = resolved.household;
  const household = h
    ? {
        currency: h.currency,
        budget: { amount: h.monthlyBudget ?? 0, period: "month" as const },
        budgetReleases: h.budgetSpendToDate > 0 ? [{ amount: h.budgetSpendToDate, at: now }] : [],
        memberLimit: { amount: h.memberLimit ?? Number.MAX_SAFE_INTEGER, period: "month" as const },
        memberReleases: h.memberSpendToDate > 0 ? [{ amount: h.memberSpendToDate, at: now }] : [],
      }
    : undefined;
  return {
    connectionActive: true,
    agentId: "agent-1",
    permission: { connectorGranted: false, grantedTools: [], readsAllowed: true, changes: "allow", highTierAllowed: true },
    rules: [],
    accountCurrency: resolved.accountCurrency,
    card: { access: true, budget: { amount: 1_000_000, period: "month" }, releases: [], household },
    rate,
    now,
  };
}

// ===========================================================================
// AC1 — resolving a household member's card-request context.
// ===========================================================================

test("resolves a household member's context: account currency, converted amount with rate date, member limit, household budget with spend-to-date", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "ac1-owner");
    const bob = await makeUser(db, "ac1-member");
    // The member's OWN account currency differs from the household's — the checks use the
    // household currency, but `accountCurrency` still reports the member's own.
    await setAccountCurrency(db, { userId: bob, currency: "NZD" });

    const hid = (await createHousehold(db, { ownerId: alice, currency: "AUD", monthlyBudget: 500 })).id;
    const added = await addMember(db, { householdId: hid, userId: bob });
    assert.ok(added.ok, "bob joins the household");
    await setMemberLimit(db, { householdId: hid, actorId: alice, userId: bob, monthlyLimit: 200 });

    // The LATEST daily USD→AUD rate on or before today is 1.5 (an older 1.2 is ignored).
    await upsertRate(db, { rateDate: "2026-11-10", baseCurrency: "USD", quoteCurrency: "AUD", rate: 1.2 });
    await upsertRate(db, { rateDate: "2026-11-14", baseCurrency: "USD", quoteCurrency: "AUD", rate: 1.5 });

    // Spend so far this month (in the household currency): Alice 100 + Bob 40 = 140 household;
    // Bob's own total = 40.
    await record(db, { userId: alice, householdId: hid, amount: 100, connectionId: CONN_A });
    await record(db, { userId: bob, householdId: hid, amount: 40, connectionId: CONN_B });

    const resolved = await resolveCardRequestContext(bob, { amount: 100, currency: "USD" }, { db, clock: fixedClock(NOW) });

    assert.equal(resolved.accountCurrency, "NZD", "the member's own account currency");
    assert.equal(resolved.targetCurrency, "AUD", "household amounts are checked in the household currency");
    assert.equal(resolved.deniable, false, "a request with a usable rate is not deniable");
    assert.equal(resolved.reason, null);

    const conv = resolved.converted;
    assert.ok(conv, "a foreign-currency request carries the converted amount");
    assert.equal(conv.amount, 150, "100 USD × 1.5 = 150 AUD");
    assert.equal(conv.currency, "AUD", "converted into the household (target) currency");
    assert.equal(conv.rate, 1.5, "the latest daily rate on or before today");
    assert.equal(conv.rateDate, "2026-11-14", "and the date that rate applies to");

    const hh = resolved.household;
    assert.ok(hh, "a household member carries the household context");
    assert.equal(hh.householdId, hid);
    assert.equal(hh.currency, "AUD");
    assert.equal(hh.monthlyBudget, 500, "the shared monthly household budget");
    assert.equal(hh.budgetSpendToDate, 140, "household spend so far this month (every member's)");
    assert.equal(hh.memberLimit, 200, "this member's per-member monthly limit");
    assert.equal(hh.memberSpendToDate, 40, "this member's own spend so far this month");
  } finally {
    await db.close();
  }
});

test("a same-currency card request needs no conversion: converted is null and it is not deniable", async () => {
  const db = await freshDb();
  try {
    const bob = await makeUser(db, "same-ccy");
    await createHousehold(db, { ownerId: bob, currency: "AUD", monthlyBudget: 500 });

    const resolved = await resolveCardRequestContext(bob, { amount: 42, currency: "AUD" }, { db, clock: fixedClock(NOW) });

    assert.equal(resolved.targetCurrency, "AUD");
    assert.equal(resolved.converted, null, "a request already in the target currency needs no conversion");
    assert.equal(resolved.deniable, false, "a same-currency request never fails for lack of a rate");
    assert.equal(resolved.reason, null);
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC2 — no rate → deniable; and the policy engine, fed the resolved context, denies a
// request over the member limit, over the household budget, or with no rate.
// ===========================================================================

test("fed to the policy engine, a resolved context over the member limit denies the card request", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "eng-ml-owner");
    const bob = await makeUser(db, "eng-ml-member");
    const hid = (await createHousehold(db, { ownerId: alice, currency: "AUD", monthlyBudget: 500 })).id;
    await addMember(db, { householdId: hid, userId: bob });
    await setMemberLimit(db, { householdId: hid, actorId: alice, userId: bob, monthlyLimit: 200 });
    await record(db, { userId: bob, householdId: hid, amount: 180, connectionId: CONN_B }); // member spend 180

    const request = { amount: 50, currency: "AUD" };
    const resolved = await resolveCardRequestContext(bob, request, { db, clock: fixedClock(NOW) });
    const result = evaluate(cardCall(request), engineCtxFromResolved(resolved, request, NOW));

    assert.equal(result.decision, "deny", "180 + 50 = 230 is over the 200 member limit → deny");
  } finally {
    await db.close();
  }
});

test("fed to the policy engine, a resolved context over the household budget denies the card request", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "eng-hb-owner");
    const bob = await makeUser(db, "eng-hb-member");
    const hid = (await createHousehold(db, { ownerId: alice, currency: "AUD", monthlyBudget: 500 })).id;
    await addMember(db, { householdId: hid, userId: bob });
    // A generous member limit so the MEMBER check is not the one that trips — the household
    // budget is.
    await setMemberLimit(db, { householdId: hid, actorId: alice, userId: bob, monthlyLimit: 1000 });
    await record(db, { userId: alice, householdId: hid, amount: 300, connectionId: CONN_A });
    await record(db, { userId: bob, householdId: hid, amount: 180, connectionId: CONN_B }); // household 480, member 180

    const request = { amount: 50, currency: "AUD" };
    const resolved = await resolveCardRequestContext(bob, request, { db, clock: fixedClock(NOW) });
    const result = evaluate(cardCall(request), engineCtxFromResolved(resolved, request, NOW));

    assert.equal(result.decision, "deny", "480 + 50 = 530 is over the 500 household budget → deny");
  } finally {
    await db.close();
  }
});

test("when no reference rate is available the resolved context is deniable, and the engine denies the foreign request", async () => {
  const db = await freshDb();
  try {
    const bob = await makeUser(db, "eng-norate");
    // No USD→AUD rate is stored at all.
    const request = { amount: 100, currency: "USD" };
    const resolved = await resolveCardRequestContext(bob, request, { db, clock: fixedClock(NOW) });

    assert.equal(resolved.deniable, true, "a foreign request with no rate is deniable");
    assert.equal(resolved.converted, null, "there is no converted amount without a rate");
    assert.equal(typeof resolved.reason, "string", "a deniable context carries a reason");
    assert.ok((resolved.reason ?? "").length > 0, "the deniable reason is a plain, non-empty string");

    const result = evaluate(cardCall(request), engineCtxFromResolved(resolved, request, NOW));
    assert.equal(result.decision, "deny", "no rate for a foreign request → the engine denies");
  } finally {
    await db.close();
  }
});

test("fed to the policy engine, a resolved context within every limit is not denied (the card request asks)", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "eng-ok-owner");
    const bob = await makeUser(db, "eng-ok-member");
    const hid = (await createHousehold(db, { ownerId: alice, currency: "AUD", monthlyBudget: 500 })).id;
    await addMember(db, { householdId: hid, userId: bob });
    await setMemberLimit(db, { householdId: hid, actorId: alice, userId: bob, monthlyLimit: 200 });
    await record(db, { userId: bob, householdId: hid, amount: 10, connectionId: CONN_B });

    const request = { amount: 20, currency: "AUD" };
    const resolved = await resolveCardRequestContext(bob, request, { db, clock: fixedClock(NOW) });
    const result = evaluate(cardCall(request), engineCtxFromResolved(resolved, request, NOW));

    assert.equal(result.decision, "ask", "within every limit, a card request is not denied — it asks for approval");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC3 — built from the given user id; a member with no household gets no household context.
// ===========================================================================

test("a member with no household still resolves account currency and converts a foreign request (their own agent budget path)", async () => {
  const db = await freshDb();
  try {
    const bob = await makeUser(db, "ac3-solo");
    await upsertRate(db, { rateDate: "2026-11-14", baseCurrency: "USD", quoteCurrency: "AUD", rate: 1.5 });

    const resolved = await resolveCardRequestContext(bob, { amount: 100, currency: "USD" }, { db, clock: fixedClock(NOW) });

    assert.equal(resolved.household, null, "a member with no household has no household budget or member limit");
    assert.equal(resolved.accountCurrency, "AUD");
    assert.equal(resolved.targetCurrency, "AUD", "with no household, the target currency is the account currency");
    const conv = resolved.converted;
    assert.ok(conv, "a foreign request still converts via the latest rate, so the own agent budget can be checked");
    assert.equal(conv.amount, 150);
    assert.equal(conv.currency, "AUD");
    assert.equal(conv.rateDate, "2026-11-14");
    assert.equal(resolved.deniable, false);
  } finally {
    await db.close();
  }
});

test("the context is built from the GIVEN user id: another person's household never leaks in", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "scope-alice");
    const bob = await makeUser(db, "scope-bob");
    const hid = (await createHousehold(db, { ownerId: alice, currency: "AUD", monthlyBudget: 500 })).id;
    // Bob is NOT a member of Alice's household.

    const forBob = await resolveCardRequestContext(bob, { amount: 10, currency: "AUD" }, { db, clock: fixedClock(NOW) });
    assert.equal(forBob.household, null, "Bob is not in Alice's household, so he gets no household context");

    const forAlice = await resolveCardRequestContext(alice, { amount: 10, currency: "AUD" }, { db, clock: fixedClock(NOW) });
    const ah = forAlice.household;
    assert.ok(ah, "Alice, the owner-member, gets her own household");
    assert.equal(ah.householdId, hid, "resolved by the GIVEN user id, not a client-supplied one");
    assert.equal(ah.monthlyBudget, 500);
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC4 — a handler on the validation boundary rejects malformed / oversized / mis-shaped input
// with a 4xx before the resolver runs, and takes the user id from the session, never the body.
// The handler is a test fixture (the intended usage), not an implementation file.
// ===========================================================================

function jsonRequest(body: string): Request {
  return new Request("https://warthog.com.au/mcp/card_request", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

function cardContextHandler(
  deps: { db: Db; clock: Clock },
  sessionUserId: string,
): (req: Request) => Promise<Response> {
  // The body carries only the request amount + currency; the user id comes from the SESSION,
  // never a body value. `amount` must be a positive finite number, `currency` a 3-letter code.
  const schema = z.object({ amount: z.number().positive().finite(), currency: z.string().length(3) });
  return async (req: Request): Promise<Response> => {
    try {
      const { amount, currency } = await parseBody(schema, req, { maxBytes: 4 * 1024 });
      const ctx = await resolveCardRequestContext(sessionUserId, { amount, currency }, deps);
      // Return a NON-secret summary (currency + whether in a household + deniable flag).
      return new Response(
        JSON.stringify({ targetCurrency: ctx.targetCurrency, inHousehold: ctx.household !== null, deniable: ctx.deniable }),
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
  const handler = cardContextHandler({ db, clock: fixedClock(NOW) }, "session-user");

  const res = await handler(jsonRequest("{ not valid json"));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "malformed input must never reach the resolver / a query");
});

test("the handler rejects an oversized body with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = cardContextHandler({ db, clock: fixedClock(NOW) }, "session-user");

  // ~10 KiB body, well over the handler's 4 KiB cap: rejected by size before parse.
  const res = await handler(jsonRequest(JSON.stringify({ amount: 10, currency: "AUD", pad: "a".repeat(10 * 1024) })));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "an oversized body must never reach the resolver / a query");
});

test("the handler rejects mis-shaped fields with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = cardContextHandler({ db, clock: fixedClock(NOW) }, "session-user");

  const asString = await handler(jsonRequest(JSON.stringify({ amount: "lots", currency: "AUD" })));
  const negative = await handler(jsonRequest(JSON.stringify({ amount: -5, currency: "AUD" })));
  const badCurrency = await handler(jsonRequest(JSON.stringify({ amount: 5, currency: "AUSTRALIAN" })));

  for (const res of [asString, negative, badCurrency]) {
    assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  }
  assert.equal(db.calls.length, 0, "a mis-shaped field must never reach the resolver / a query");
});

test("the handler accepts a well-formed body and resolves the SESSION user's context, never a body-smuggled user", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "handler-alice");
    const bob = await makeUser(db, "handler-bob");
    // Alice is in a household; Bob is not.
    await createHousehold(db, { ownerId: alice, currency: "AUD", monthlyBudget: 500 });

    // The session is Alice's; the body smuggles Bob's id. The handler must ignore the body id
    // and resolve ALICE's context (she is in a household; Bob is not).
    const handler = cardContextHandler({ db, clock: fixedClock(NOW) }, alice);
    const res = await handler(jsonRequest(JSON.stringify({ amount: 20, currency: "AUD", userId: bob })));

    assert.equal(res.status, 200, "a well-formed body is accepted");
    const body = (await res.json()) as { targetCurrency: string; inHousehold: boolean; deniable: boolean };
    assert.equal(body.inHousehold, true, "Alice's context (the session user's), not Bob's — the body id is ignored");
    assert.equal(body.targetCurrency, "AUD");
  } finally {
    await db.close();
  }
});

test("the owning user id and the request currency reach the db as BOUND parameters, never spliced into the SQL", async () => {
  const db = recordingDb();

  const userProbe = "u'; DROP TABLE household_members; --";
  const currencyProbe = "X'; DROP TABLE exchange_rates; --";

  // The resolver may deny the (unseeded) request partway; we only care that whatever reached
  // the db was bound. Swallow any resulting rejection.
  await resolveCardRequestContext(userProbe, { amount: 100, currency: currencyProbe }, { db, clock: fixedClock(NOW) }).catch(
    () => undefined,
  );

  assert.ok(db.calls.length >= 1, "the resolver issues at least one query");
  const bound = db.calls.flatMap((c) => c.values);
  assert.ok(bound.includes(userProbe), "the owning user id travels as a bound value");
  assert.ok(bound.includes(currencyProbe), "the request currency travels as a bound value");
  for (const call of db.calls) {
    assert.ok(!call.text.includes(userProbe), "the user id is bound, never concatenated into the SQL");
    assert.ok(!call.text.includes(currencyProbe), "the currency is bound, never concatenated into the SQL");
    assert.ok(!call.text.includes("DROP TABLE"), "no injected statement appears in the SQL text");
  }
});

// ===========================================================================
// AC5 — the resolver runs purely from its injected seams and reads no process.env, so a decoy
// secret in the environment never lands in the resolved context.
// ===========================================================================

test("the resolver reads no process.env: a decoy secret in the environment never appears in the resolved context", async () => {
  const DECOY = "sk_live_DECOY_must_never_appear_in_warthog";
  const prev = process.env.WARTHOG_DECOY_SECRET;
  process.env.WARTHOG_DECOY_SECRET = DECOY;
  const db = await freshDb();
  try {
    const bob = await makeUser(db, "ac5-env");
    await createHousehold(db, { ownerId: bob, currency: "AUD", monthlyBudget: 500 });
    await upsertRate(db, { rateDate: "2026-11-14", baseCurrency: "USD", quoteCurrency: "AUD", rate: 1.5 });

    // The resolver is given ONLY its injected seams — no config object, no env — and still
    // assembles the context, proving it reads configuration from injected seams alone.
    const resolved = await resolveCardRequestContext(bob, { amount: 100, currency: "USD" }, { db, clock: fixedClock(NOW) });

    assert.equal(resolved.targetCurrency, "AUD", "the resolver works purely from its injected seams");
    assert.ok(!JSON.stringify(resolved).includes(DECOY), "no ambient env value is folded into the resolved context");
  } finally {
    await db.close();
    if (prev === undefined) delete process.env.WARTHOG_DECOY_SECRET;
    else process.env.WARTHOG_DECOY_SECRET = prev;
  }
});
