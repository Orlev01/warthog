// E15-S09 — Household spending totals read (`src/server/spending/household-read.ts`).
//
// RED-first: the module does not exist yet, so importing `./household-read` throws and
// every test here fails (and `tsc --noEmit` reddens on the missing module) until the
// builder writes the minimum code to pass. That absence IS the point of test-first; do NOT
// implement anything to make these pass — the builder writes `household-read.ts` afterwards.
//
// These tests pin BEHAVIOUR (what the read RETURNS for a member of a household, whose data
// it reads, how it converts other-currency releases, what it REFUSES to expose, what a
// handler rejects, and that the session user id reaches the db BOUND), never the source text
// of the module — a later rename that preserves behaviour must not redden them.
//
// WHY this exists (brief "Household sharing" + "Spending view"; design §8 step 4): within a
// household both the owner and members see ONLY each member's total approved spend this
// period against that member's monthly limit and the household total against the shared
// household budget — never each other's merchants or individual release entries. Amounts are
// summed in the household currency, converting an other-currency release via the latest daily
// reference rate. Every read is member-scoped by the GIVEN user id (the session's id, never a
// client value, INV-102), and every figure it reads — budgets, limits, an ISO 4217 code,
// amounts, a daily reference scalar — is PLAINTEXT METADATA (design §4.1), so the read holds
// no key and reads no `process.env` (INV-103): the db and the clock are INJECTED seams.
//
// ---------------------------------------------------------------------------
// THE PINNED CONTRACT (chosen by the tester; the implementation conforms to it).
//
//   interface HouseholdMemberSpending {     // one household member's totals — NO merchant,
//     userId: string;                        //   NO release entry, NO other personal content.
//     monthlyLimit: number | null;          // this member's per-member monthly limit (null until set)
//     spendToDate: number;                   // this member's approved spend this month, IN THE
//                                             //   household currency (other currencies converted)
//   }
//
//   interface HouseholdSpendingReport {
//     householdId: string;
//     currency: string;                      // the household currency every figure is expressed in
//     monthlyBudget: number | null;          // the shared monthly household budget (null until set)
//     budgetSpendToDate: number;             // the household total this month, in the household
//                                             //   currency (every member's, converted)
//     members: HouseholdMemberSpending[];    // one entry per member (incl. the owner)
//   }
//
//   readHouseholdSpending(userId: string, deps: { db: Db; clock: Clock })
//     : Promise<HouseholdSpendingReport | null>
//     • resolves the caller's household FROM `userId` alone (no household id is ever accepted
//       from the client); returns null when the caller is in no household. For a member it
//       returns each member's monthly limit + converted spend-to-date and the household budget
//       + converted spend-to-date, in the household currency — TOTALS only, never a merchant or
//       a release entry. Every read is member-scoped by `userId` (bound as a parameter); an
//       other-currency release is converted via the latest daily reference rate on or before
//       today (the injected clock), a same-currency amount counts at face value.
//
// Acceptance criteria → tests:
//   AC1 — a member's report carries each member's monthly limit + converted spend-to-date and
//         the household budget + converted spend-to-date, all in the household currency (the
//         LATEST daily rate; same-currency amounts at face value).
//   AC2 — the report exposes TOTALS only: no merchant, no release entry/id, no member email,
//         no other personal content — for any member, read by the owner OR a plain member.
//   AC3 — only a member can read, scoped by the GIVEN user id: a member of another household
//         gets their OWN household (never the other's), a person in no household gets null.
//   AC4 [obligation:validate-and-parameterize-input] (INV-102) — a handler rejects malformed /
//        oversized / mis-shaped input with a 4xx before any query, takes the user id from the
//        SESSION (never the body), and a SQL-injection probe in the user-id input reaches the
//        db as a BOUND value, never spliced into the SQL. The handler is a test fixture (the
//        intended usage), not an implementation file.
//   AC5 [obligation:secrets-from-env] (INV-103) — the read runs purely from its injected seams
//        and reads no `process.env`, so a decoy secret in the environment never lands in the
//        report.
//
// Every real-db test uses its own `freshDb()` (an isolated in-memory PGlite with the real
// migrations) and closes it in a `finally`, so tests share no state and leave no open handle.

import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";

import {
  readHouseholdSpending,
  type HouseholdSpendingReport,
  type HouseholdMemberSpending,
} from "./household-read";
import { createUser } from "../db/users";
import { setAccountCurrency } from "../db/account-currency";
import { createHousehold, addMember, setMemberLimit } from "../db/households";
import { recordRelease, periodKeyFor, type PeriodKeys, type StoredRelease } from "../db/card-spend-ledger";
import { upsertRate } from "../db/exchange-rates";
import { freshDb } from "../../test/db";
import { type Db, type QueryResult } from "../db/index";
import { parseBody, HttpError } from "../http/validate";
import { fixedClock, type Clock } from "../seams/clock";

// --- fixtures ----------------------------------------------------------------------

// The frozen instant every read reads time through. Noon mid-month UTC, so today's rate date
// ("2026-11-15") and the current month bucket ("2026-11") are unambiguous in UTC.
const NOW = new Date("2026-11-15T12:00:00.000Z");

// Opaque agent-connection uuids (the connections table arrives in a later migration; the
// ledger binds the column rather than a FK). A member's spend spans ALL their connections —
// the read sums per member, not per connection — but a release row needs one.
const CONN_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const CONN_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const CONN_C = "cccccccc-cccc-cccc-cccc-cccccccccccc";

// The three period buckets NOW falls in (derived through the ledger's own `periodKeyFor`, the
// one source of truth for its bucket keys — so a release here lands in the month the read sums
// over).
const KEYS_NOW: PeriodKeys = {
  day: periodKeyFor("day", NOW),
  week: periodKeyFor("week", NOW),
  month: periodKeyFor("month", NOW),
};

// A marker baked into every seeded merchant: the read is TOTALS-only, so this substring must
// never appear anywhere in a report.
const MERCHANT_MARKER = "SECRET-MERCHANT";

// A person with a throwaway wrapped DEK (the read touches only plaintext metadata, so the DEK
// is never exercised — but `users.wrapped_dek` is NOT NULL).
async function makeUser(db: Db, who: string): Promise<string> {
  const user = await createUser(db, { email: `${who}@warthog.com.au`, wrappedDek: `wrapped-${who}` });
  return user.id;
}

// Record one approved card release this month for `userId`, counting toward `householdId`. The
// merchant carries the marker so an absence check can prove the read never surfaces it. Returns
// the stored release so a test can collect its id and prove THAT never surfaces either.
async function record(
  db: Db,
  opts: { userId: string; householdId: string; amount: number; connectionId: string; currency?: string; who?: string },
): Promise<StoredRelease> {
  return recordRelease(db, {
    userId: opts.userId,
    connectionId: opts.connectionId,
    householdId: opts.householdId,
    amount: opts.amount,
    currency: opts.currency ?? "AUD",
    merchant: `${MERCHANT_MARKER}-${opts.who ?? "x"}`,
    periodKeys: KEYS_NOW,
  });
}

// Find a member's entry in a report by user id (order is not asserted — a report must not
// depend on row order).
function memberOf(report: HouseholdSpendingReport, userId: string): HouseholdMemberSpending | undefined {
  return report.members.find((m) => m.userId === userId);
}

// ===========================================================================
// AC1 — a household member's report: per-member limit + converted spend-to-date, and the
// household budget + converted spend-to-date, all in the household currency.
// ===========================================================================

test("reports each member's converted spend against their limit and the household total against the budget, in the household currency", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "ac1-owner");
    const bob = await makeUser(db, "ac1-member");

    const hid = (await createHousehold(db, { ownerId: alice, currency: "AUD", monthlyBudget: 1000 })).id;
    assert.ok((await addMember(db, { householdId: hid, userId: bob })).ok, "bob joins the household");
    // Bob's limit is set (200); Alice (the owner) leaves hers unset → null.
    await setMemberLimit(db, { householdId: hid, actorId: alice, userId: bob, monthlyLimit: 200 });

    // Latest daily rates on or before today. A STALE USD→AUD (1.2) is ignored in favour of the
    // 2026-11-14 one (1.5); EUR→AUD is 2.0. No AUD→AUD rate exists — a same-currency amount
    // must count at face value, never be dropped for lack of a rate.
    await upsertRate(db, { rateDate: "2026-11-10", baseCurrency: "USD", quoteCurrency: "AUD", rate: 1.2 });
    await upsertRate(db, { rateDate: "2026-11-14", baseCurrency: "USD", quoteCurrency: "AUD", rate: 1.5 });
    await upsertRate(db, { rateDate: "2026-11-14", baseCurrency: "EUR", quoteCurrency: "AUD", rate: 2.0 });

    // Alice: 100 AUD + 100 USD → 100 + (100 × 1.5) = 250 AUD.
    await record(db, { userId: alice, householdId: hid, amount: 100, currency: "AUD", connectionId: CONN_A, who: "alice" });
    await record(db, { userId: alice, householdId: hid, amount: 100, currency: "USD", connectionId: CONN_A, who: "alice" });
    // Bob: 40 AUD + 30 EUR → 40 + (30 × 2.0) = 100 AUD.
    await record(db, { userId: bob, householdId: hid, amount: 40, currency: "AUD", connectionId: CONN_B, who: "bob" });
    await record(db, { userId: bob, householdId: hid, amount: 30, currency: "EUR", connectionId: CONN_B, who: "bob" });

    const report: HouseholdSpendingReport | null = await readHouseholdSpending(bob, { db, clock: fixedClock(NOW) });

    assert.ok(report, "a household member gets a report");
    assert.equal(report.householdId, hid);
    assert.equal(report.currency, "AUD", "every figure is expressed in the household currency");
    assert.equal(report.monthlyBudget, 1000, "the shared monthly household budget");
    assert.equal(report.budgetSpendToDate, 350, "household total this month: 250 (Alice) + 100 (Bob) = 350 AUD");

    assert.equal(report.members.length, 2, "both members (incl. the owner) appear");

    const aliceRow = memberOf(report, alice);
    assert.ok(aliceRow, "the owner is listed as a member");
    assert.equal(aliceRow.spendToDate, 250, "Alice: 100 AUD + 100 USD × latest 1.5 = 250 AUD (NOT the stale 1.2)");
    assert.equal(aliceRow.monthlyLimit, null, "the owner's per-member limit was never set");

    const bobRow = memberOf(report, bob);
    assert.ok(bobRow, "the reading member is listed");
    assert.equal(bobRow.spendToDate, 100, "Bob: 40 AUD + 30 EUR × 2.0 = 100 AUD");
    assert.equal(bobRow.monthlyLimit, 200, "Bob's per-member monthly limit");
  } finally {
    await db.close();
  }
});

test("a member's own account currency does not change the report currency: totals stay in the household currency", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "ac1b-owner");
    const bob = await makeUser(db, "ac1b-member");
    // Bob's OWN account currency differs from the household's; the report is still in AUD.
    await setAccountCurrency(db, { userId: bob, currency: "NZD" });

    const hid = (await createHousehold(db, { ownerId: alice, currency: "AUD", monthlyBudget: 500 })).id;
    await addMember(db, { householdId: hid, userId: bob });
    await record(db, { userId: bob, householdId: hid, amount: 42, currency: "AUD", connectionId: CONN_B, who: "bob" });

    const report = await readHouseholdSpending(bob, { db, clock: fixedClock(NOW) });

    assert.ok(report);
    assert.equal(report.currency, "AUD", "the household currency, not the member's NZD account currency");
    assert.equal(memberOf(report, bob)?.spendToDate, 42, "a same-currency amount counts at face value");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC2 — totals only: no merchant, no release entry/id, no member email, no other personal
// content — for any member, read by the owner OR a plain member.
// ===========================================================================

test("the report exposes totals only — no merchant, no release entry/id, no member email", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "ac2-owner");
    const bob = await makeUser(db, "ac2-member");
    const hid = (await createHousehold(db, { ownerId: alice, currency: "AUD", monthlyBudget: 1000 })).id;
    await addMember(db, { householdId: hid, userId: bob });

    const releases = [
      await record(db, { userId: alice, householdId: hid, amount: 60, currency: "AUD", connectionId: CONN_A, who: "alice" }),
      await record(db, { userId: bob, householdId: hid, amount: 25, currency: "AUD", connectionId: CONN_B, who: "bob" }),
    ];

    // Read as the PLAIN member (Bob) and as the OWNER (Alice): neither may see a merchant or a
    // release entry for the other, only totals.
    for (const [who, reader] of [["member", bob], ["owner", alice]] as const) {
      const report = await readHouseholdSpending(reader, { db, clock: fixedClock(NOW) });
      assert.ok(report, `${who} gets a report`);

      const serialized = JSON.stringify(report);
      assert.ok(!serialized.includes(MERCHANT_MARKER), `${who}: no merchant is surfaced anywhere in the report`);
      for (const r of releases) {
        assert.ok(!serialized.includes(r.id), `${who}: no individual release id is surfaced (id ${r.id})`);
      }
      assert.ok(!serialized.includes("@warthog.com.au"), `${who}: no member email is surfaced`);

      // The shape carries no release/merchant collection for the report or any member.
      const rawReport = report as unknown as Record<string, unknown>;
      for (const forbidden of ["releases", "entries", "merchant", "items"]) {
        assert.equal(rawReport[forbidden], undefined, `${who}: the report has no "${forbidden}" field`);
      }
      for (const m of report.members) {
        const rawMember = m as unknown as Record<string, unknown>;
        for (const forbidden of ["releases", "entries", "merchant", "items", "email"]) {
          assert.equal(rawMember[forbidden], undefined, `${who}: a member has no "${forbidden}" field`);
        }
        // Each member carries only a total and a limit — both numbers (or a null limit).
        assert.equal(typeof m.spendToDate, "number", `${who}: a member's spend is a number`);
        assert.ok(m.monthlyLimit === null || typeof m.monthlyLimit === "number");
      }
    }
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC3 — only a member can read, scoped by the GIVEN user id.
// ===========================================================================

test("the report is scoped by the GIVEN user id: a member of another household never sees it", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "ac3-alice");
    const bob = await makeUser(db, "ac3-bob");
    const carol = await makeUser(db, "ac3-carol");

    // Household X (Alice owner, Bob member), with spend.
    const x = (await createHousehold(db, { ownerId: alice, currency: "AUD", monthlyBudget: 1000 })).id;
    await addMember(db, { householdId: x, userId: bob });
    await record(db, { userId: alice, householdId: x, amount: 300, currency: "AUD", connectionId: CONN_A, who: "alice" });
    await record(db, { userId: bob, householdId: x, amount: 50, currency: "AUD", connectionId: CONN_B, who: "bob" });

    // A SEPARATE household Y (Carol owner, alone), with its own budget and spend.
    const y = (await createHousehold(db, { ownerId: carol, currency: "AUD", monthlyBudget: 777 })).id;
    await record(db, { userId: carol, householdId: y, amount: 10, currency: "AUD", connectionId: CONN_C, who: "carol" });

    // Carol reads HER OWN household, never Alice's — even though both exist in the same db.
    const forCarol = await readHouseholdSpending(carol, { db, clock: fixedClock(NOW) });
    assert.ok(forCarol, "Carol, a member of her own household, gets a report");
    assert.equal(forCarol.householdId, y, "resolved from Carol's user id, not any client-supplied id");
    assert.equal(forCarol.monthlyBudget, 777, "Carol's household budget, never Alice's");
    assert.equal(forCarol.budgetSpendToDate, 10, "only Carol's household spend");
    assert.equal(forCarol.members.length, 1, "only Carol is in her household");

    const serialized = JSON.stringify(forCarol);
    assert.ok(!serialized.includes(alice), "Alice's user id never leaks into Carol's report");
    assert.ok(!serialized.includes(bob), "Bob's user id never leaks into Carol's report");
    assert.ok(!serialized.includes(x), "the other household's id never leaks into Carol's report");
  } finally {
    await db.close();
  }
});

test("a person in no household gets null — there is no household to expose", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "ac3b-alice");
    const dave = await makeUser(db, "ac3b-dave");
    // Alice has a household; Dave belongs to none.
    await createHousehold(db, { ownerId: alice, currency: "AUD", monthlyBudget: 500 });

    const forDave = await readHouseholdSpending(dave, { db, clock: fixedClock(NOW) });
    assert.equal(forDave, null, "a non-member of any household gets no report");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC4 — a handler on the validation boundary rejects malformed / oversized / mis-shaped input
// with a 4xx before any query, and takes the user id from the SESSION, never the body. The
// handler is a test fixture (the intended usage), not an implementation file.
// ===========================================================================

function jsonRequest(body: string): Request {
  return new Request("https://warthog.com.au/household/spending", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

function householdSpendingHandler(
  deps: { db: Db; clock: Clock },
  sessionUserId: string,
): (req: Request) => Promise<Response> {
  // The read is driven ENTIRELY by the session user id — no household id or user id is ever
  // taken from the client. The body must still be a well-formed, size-capped JSON object;
  // anything mis-shaped / malformed / oversized is rejected with a 4xx before any query, and
  // any smuggled field is stripped (never used to pick a household).
  const schema = z.object({});
  return async (req: Request): Promise<Response> => {
    try {
      await parseBody(schema, req, { maxBytes: 4 * 1024 });
      const report = await readHouseholdSpending(sessionUserId, deps);
      // A NON-secret summary: whether the session user is in a household and how many members
      // it has — never a merchant or a release entry.
      return new Response(
        JSON.stringify({ inHousehold: report !== null, memberCount: report?.members.length ?? 0 }),
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
  const handler = householdSpendingHandler({ db, clock: fixedClock(NOW) }, "session-user");

  const res = await handler(jsonRequest("{ not valid json"));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "malformed input must never reach the read / a query");
});

test("the handler rejects an oversized body with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = householdSpendingHandler({ db, clock: fixedClock(NOW) }, "session-user");

  // ~10 KiB body, well over the handler's 4 KiB cap: rejected by size before parse.
  const res = await handler(jsonRequest(JSON.stringify({ pad: "a".repeat(10 * 1024) })));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "an oversized body must never reach the read / a query");
});

test("the handler rejects a mis-shaped (non-object) body with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = householdSpendingHandler({ db, clock: fixedClock(NOW) }, "session-user");

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
    const hid = (await createHousehold(db, { ownerId: alice, currency: "AUD", monthlyBudget: 500 })).id;
    await addMember(db, { householdId: hid, userId: bob });

    // Session is Bob; the body smuggles Carol's id and a household id. The handler must ignore
    // the body and resolve BOB's household (2 members), never Carol's (none).
    const asBob = householdSpendingHandler({ db, clock: fixedClock(NOW) }, bob);
    const bobRes = await asBob(jsonRequest(JSON.stringify({ userId: carol, householdId: "deadbeef" })));
    assert.equal(bobRes.status, 200, "a well-formed body is accepted");
    const bobBody = (await bobRes.json()) as { inHousehold: boolean; memberCount: number };
    assert.equal(bobBody.inHousehold, true, "Bob's household (the session user's), not the smuggled Carol");
    assert.equal(bobBody.memberCount, 2, "Alice + Bob — resolved from the session id, not the body");

    // Session is Carol; even smuggling Bob's id, she resolves her OWN (empty) household state.
    const asCarol = householdSpendingHandler({ db, clock: fixedClock(NOW) }, carol);
    const carolRes = await asCarol(jsonRequest(JSON.stringify({ userId: bob })));
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

  // The read may short-circuit on the (empty) recording db; we only care that whatever reached
  // the db was bound. Swallow any resulting rejection.
  await readHouseholdSpending(userProbe, { db, clock: fixedClock(NOW) }).catch(() => undefined);

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
    const hid = (await createHousehold(db, { ownerId: alice, currency: "AUD", monthlyBudget: 500 })).id;
    await addMember(db, { householdId: hid, userId: bob });
    await record(db, { userId: bob, householdId: hid, amount: 20, currency: "AUD", connectionId: CONN_B, who: "bob" });

    // The read is given ONLY its injected seams — no config object, no env — and still
    // assembles the report, proving it reads configuration from injected seams alone.
    const report = await readHouseholdSpending(bob, { db, clock: fixedClock(NOW) });

    assert.ok(report, "the read works purely from its injected seams");
    assert.equal(report.currency, "AUD");
    assert.ok(!JSON.stringify(report).includes(DECOY), "no ambient env value is folded into the report");
  } finally {
    await db.close();
    if (prev === undefined) delete process.env.WARTHOG_DECOY_SECRET;
    else process.env.WARTHOG_DECOY_SECRET = prev;
  }
});

// ---------------------------------------------------------------------------
// Review fix W4.3 — the household month is the reader's own (local) month. At
// 2026-12-01T05:00Z it is still November in Los Angeles.
// ---------------------------------------------------------------------------

test("W4.3: the household totals are read for the month in the given time zone", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "tz-owner");
    const hid = (await createHousehold(db, { ownerId: alice, currency: "AUD", monthlyBudget: 500 })).id;
    await recordRelease(db, {
      userId: alice,
      connectionId: CONN_B,
      householdId: hid,
      amount: 60,
      currency: "AUD",
      merchant: "Local November",
      periodKeys: { day: "2026-11-30", week: "2026-W49", month: "2026-11" },
    });

    const report = await readHouseholdSpending(alice, {
      db,
      clock: fixedClock(new Date("2026-12-01T05:00:00.000Z")),
      timeZone: "America/Los_Angeles",
    });
    assert.equal(report?.budgetSpendToDate, 60, "November's spend still counts this month");
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// Review fix W4.5 — an amount in a currency with no reference rate on file is FLAGGED,
// never counted as 0: the household total and the member's total leave it out and the
// report says which currency could not be converted and how much.
// ---------------------------------------------------------------------------

test("W4.5: an other-currency amount with no rate is flagged, never added as 0", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "w45-owner");
    const bob = await makeUser(db, "w45-member");
    const hid = (await createHousehold(db, { ownerId: alice, currency: "AUD", monthlyBudget: 500 })).id;
    await addMember(db, { householdId: hid, userId: bob });
    await record(db, { userId: alice, householdId: hid, amount: 40, currency: "AUD", connectionId: CONN_A, who: "alice" });
    // No USD→AUD (or JPY→AUD) rate is on file at all.
    await record(db, { userId: bob, householdId: hid, amount: 20, currency: "USD", connectionId: CONN_B, who: "bob" });
    await record(db, { userId: bob, householdId: hid, amount: 5, currency: "USD", connectionId: CONN_A, who: "bob" });
    await record(db, { userId: alice, householdId: hid, amount: 900, currency: "JPY", connectionId: CONN_A, who: "alice" });

    const report = await readHouseholdSpending(bob, { db, clock: fixedClock(NOW) });
    assert.ok(report);
    assert.equal(report.budgetSpendToDate, 40, "only the convertible AUD amount is in the household total");
    assert.deepEqual(
      [...report.unconverted].sort((a, b) => a.currency.localeCompare(b.currency)),
      [
        { currency: "JPY", amount: 900 },
        { currency: "USD", amount: 25 },
      ],
      "the household report names each currency it could not convert, with its amount",
    );
    assert.equal(memberOf(report, bob)?.spendToDate, 0, "bob's converted total holds nothing it could not convert");
    assert.deepEqual(memberOf(report, bob)?.unconverted, [{ currency: "USD", amount: 25 }], "and bob's entry flags it");
    assert.deepEqual(memberOf(report, alice)?.unconverted, [{ currency: "JPY", amount: 900 }]);
  } finally {
    await db.close();
  }
});

test("W4.5: a household whose every amount converts flags nothing", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "w45-clean");
    const hid = (await createHousehold(db, { ownerId: alice, currency: "AUD", monthlyBudget: 500 })).id;
    await upsertRate(db, { rateDate: "2026-11-14", baseCurrency: "USD", quoteCurrency: "AUD", rate: 1.5 });
    await record(db, { userId: alice, householdId: hid, amount: 10, currency: "USD", connectionId: CONN_A, who: "alice" });

    const report = await readHouseholdSpending(alice, { db, clock: fixedClock(NOW) });
    assert.equal(report?.budgetSpendToDate, 15);
    assert.deepEqual(report?.unconverted, []);
    assert.deepEqual(memberOf(report!, alice)?.unconverted, []);
  } finally {
    await db.close();
  }
});
