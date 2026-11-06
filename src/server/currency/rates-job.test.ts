// E15-S03 — the exchange-rate fetch JOB (`src/server/currency/rates-job.ts`).
//
// RED-first: the module does not exist yet, so importing `./rates-job` throws and every test
// here fails until the builder writes it. That absence IS the point of test-first; do NOT
// implement anything to make these pass — the builder writes the module afterwards.
//
// WHY this exists (task E15-S03; design §8 step 4 + §12): the daily reference rates that feed
// the policy engine's currency conversion are kept current by a job that fetches the day's
// rates THROUGH THE SOURCE SEAM (`./rate-source`) and upserts them into the rate store
// (`../db/exchange-rates`). The job is idempotent — a second run the same day changes nothing
// (the store's composite key overwrites in place). A fetch failure leaves the previously
// stored rates intact and is REPORTED (the source's rejection propagates), never swallowed
// into a silent success.
//
// These tests pin BEHAVIOUR (what the job DOES: fetch via the seam, upsert one row per quote
// currency, re-run the same day without changing the store, propagate a source failure while
// leaving the store intact, bind every fetched value as a query parameter, read no env),
// never the source text of the module — a later rename that preserves behaviour must not
// redden them.
//
// ---------------------------------------------------------------------------
// THE PINNED CONTRACT (chosen by the tester; the implementation conforms to it).
//
//   interface RatesJobDeps { db: Db; source: RateSource }
//
//   interface RatesJobResult {
//     rateDate: string;       // the day whose rates were stored (from the source's set)
//     pairsUpserted: number;  // how many (base, quote) pairs were written this run
//   }
//
//   runRatesJob(deps: RatesJobDeps): Promise<RatesJobResult>
//     • fetches the day's rates via `deps.source.fetchDailyRates()` and upserts ONE row per
//       quote currency into the rate store — (rateDate, baseCurrency, quote, rate) — binding
//       every value as a parameter;
//     • is IDEMPOTENT: a second run with the same day's rates overwrites in place and leaves
//       the store unchanged (same rows, same values, no duplicates, no throw);
//     • REPORTS a fetch failure by letting the source's rejection propagate (it does NOT
//       catch-and-swallow) — and, because it upserts nothing on a failed fetch, the
//       previously stored rates are left intact.
//
// Acceptance criteria → tests:
//   AC1 "The job fetches the day's rates via the source seam and upserts them into the rate
//        store, and a second run the same day changes nothing (idempotent)." — after one run
//        every fetched pair reads back from the store for its date; a second run leaves the
//        row count and every value unchanged and does not throw.
//   AC3 "A fetch failure leaves the previously stored rates intact and is reported, not
//        swallowed." — with rates already stored, a run whose source REJECTS propagates the
//        rejection AND leaves every stored rate exactly as it was.
//   AC4 [obligation:validate-and-parameterize-input] (INV-102) — a trigger handler on the
//        `../http/validate` boundary rejects malformed / oversized input with a 4xx BEFORE the
//        job runs (the source is never called, no query is issued); and the untrusted input
//        that actually reaches a query — the fetched currency codes — travels as a BOUND value
//        (placeholders, never concatenation), so a SQL-injection probe in a currency code
//        cannot alter a query and the table survives. The handler below is a test fixture (the
//        intended usage), not an implementation file.
//   AC5 [obligation:secrets-from-env] (INV-103) — the job is built purely from its injected
//        seams (db, source), reads no `process.env` and holds no secret, so a decoy secret
//        planted in the environment never lands in a stored rate.
//
// Every db handle is closed in a `finally` so node:test leaves no open handle; each real-db
// test uses its own `freshDb()` (an isolated in-memory PGlite with the real migrations), so
// tests share no state.

import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";

import { runRatesJob } from "./rates-job";
// Documentary type anchors — the exact names/shapes the implementation exports. Erased at
// runtime (and test files are excluded from `tsc`), so a rename cannot break these tests.
import type { RatesJobDeps, RatesJobResult } from "./rates-job";
import { fakeRateSource } from "./rate-source";
import type { DailyRates, RateSource } from "./rate-source";
import { getRate } from "../db/exchange-rates";
import { freshDb } from "../../test/db";
import type { Db, QueryResult } from "../db/index";
import { parseBody, HttpError } from "../http/validate";

// --- fixtures ---------------------------------------------------------------------

// A db seam stand-in that records every call instead of running it, so a test can prove WHAT
// reached the query layer and HOW (bound value vs. spliced text). Returns no rows and
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

// A source that counts how many times it is asked to fetch — so a test can prove the trigger
// handler does NOT run the job when it rejects the request up front.
function spySource(fixed: DailyRates): { source: RateSource; count(): number } {
  let n = 0;
  return {
    source: { fetchDailyRates: async () => { n += 1; return fixed; } },
    count: () => n,
  };
}

// A source whose fetch REJECTS — the upstream-failure case for AC3.
function failingSource(message: string): RateSource {
  return { fetchDailyRates: () => Promise.reject(new Error(message)) };
}

// Whether a relation of this exact name exists on this handle (a non-throwing probe scoped to
// the one table under test — behaviour, not source text).
async function tableExists(db: Db, name: string): Promise<boolean> {
  const result = await db.query("SELECT to_regclass($1) AS t", [name]);
  return result.rows[0]?.t != null;
}

// The total number of rows in the rate store — proves a second run added no duplicates.
async function totalRows(db: Db): Promise<number> {
  const result = await db.query("SELECT count(*)::int AS n FROM exchange_rates");
  return result.rows[0]!.n as number;
}

// The trigger handler is a test fixture that EXERCISES the modules (parseBody → the job) — it
// is NOT an implementation file. The rates refresh carries no required input, so the body is
// accepted but ignored; the boundary still rejects a malformed or oversized request with a 4xx
// before the job ever runs.
function ratesJobTriggerHandler(deps: RatesJobDeps): (req: Request) => Promise<Response> {
  const schema = z.object({});
  return async (req: Request): Promise<Response> => {
    try {
      await parseBody(schema, req, { maxBytes: 4 * 1024 });
      const result = await runRatesJob(deps);
      return new Response(JSON.stringify({ ok: true, ...result }), { status: 200 });
    } catch (err) {
      if (err instanceof HttpError) {
        return new Response(JSON.stringify({ error: "invalid input" }), { status: err.status });
      }
      // A non-HttpError escaping the boundary is an uncontrolled 500; surface it so a test sees
      // the raw-500 failure rather than a masked success.
      return new Response("internal error", { status: 500 });
    }
  };
}

function jsonRequest(body: string): Request {
  return new Request("https://warthog.com.au/api/currency/rates", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

// ===========================================================================
// AC1 — the job fetches the day's rates via the seam and upserts them; a second run the same
// day changes nothing (idempotent).
// ===========================================================================

test("the job fetches the day's rates via the source seam and upserts them into the store", async () => {
  const db = await freshDb();
  try {
    const fixed: DailyRates = {
      rateDate: "2026-11-06",
      baseCurrency: "EUR",
      rates: { AUD: 1.6543, USD: 1.0812, GBP: 0.8721 },
    };
    const result: RatesJobResult = await runRatesJob({ db, source: fakeRateSource(fixed) });

    assert.equal(result.rateDate, "2026-11-06", "the result reports the day whose rates were stored");
    assert.equal(result.pairsUpserted, 3, "one pair per quote currency was written");

    // Every fetched pair reads back from the store for its date.
    for (const [quote, rate] of Object.entries(fixed.rates)) {
      const lookup = await getRate(db, { on: "2026-11-06", baseCurrency: "EUR", quoteCurrency: quote });
      assert.equal(lookup.found, true, `EUR->${quote} was stored by the job`);
      if (lookup.found) {
        assert.equal(lookup.rate, rate, `EUR->${quote} reads back at its fetched value`);
        assert.equal(lookup.rateDate, "2026-11-06", `EUR->${quote} is stored for the fetched date`);
      }
    }
  } finally {
    await db.close();
  }
});

test("a second run the same day changes nothing (idempotent: no duplicate rows, no value drift, no throw)", async () => {
  const db = await freshDb();
  try {
    const fixed: DailyRates = { rateDate: "2026-11-06", baseCurrency: "EUR", rates: { AUD: 1.6543, USD: 1.0812 } };
    const source = fakeRateSource(fixed);

    await runRatesJob({ db, source });
    const rowsAfterFirst = await totalRows(db);
    assert.equal(rowsAfterFirst, 2, "the first run wrote one row per quote currency");

    // A second run with the same day's rates must not throw and must not change the store.
    await runRatesJob({ db, source });

    assert.equal(await totalRows(db), rowsAfterFirst, "the second run added no duplicate rows");
    const aud = await getRate(db, { on: "2026-11-06", baseCurrency: "EUR", quoteCurrency: "AUD" });
    const usd = await getRate(db, { on: "2026-11-06", baseCurrency: "EUR", quoteCurrency: "USD" });
    assert.equal(aud.found && aud.rate, 1.6543, "AUD is unchanged after the second run");
    assert.equal(usd.found && usd.rate, 1.0812, "USD is unchanged after the second run");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC3 — a fetch failure leaves the previously stored rates intact and is reported, not
// swallowed.
// ===========================================================================

test("a fetch failure propagates (is reported) and leaves the previously stored rates intact", async () => {
  const db = await freshDb();
  try {
    // Seed the store via a first, SUCCESSFUL run.
    const good: DailyRates = { rateDate: "2026-11-06", baseCurrency: "EUR", rates: { AUD: 1.6543, USD: 1.0812 } };
    await runRatesJob({ db, source: fakeRateSource(good) });
    const rowsBefore = await totalRows(db);

    // A later run whose source REJECTS must surface the failure, not swallow it.
    await assert.rejects(
      () => runRatesJob({ db, source: failingSource("upstream unreachable") }),
      "a fetch failure must be reported by a rejection, never swallowed into a silent success",
    );

    // The previously stored rates are untouched: the failed run wrote nothing.
    assert.equal(await totalRows(db), rowsBefore, "a failed fetch leaves the row count unchanged");
    const aud = await getRate(db, { on: "2026-11-06", baseCurrency: "EUR", quoteCurrency: "AUD" });
    assert.equal(aud.found, true, "the previously stored rate survives the failed run");
    if (aud.found) {
      assert.equal(aud.rate, 1.6543, "and is left at exactly its prior value");
    }
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC4 (validate half) — a trigger handler rejects malformed / oversized input with a 4xx
// BEFORE the job runs, and accepts a well-formed trigger.
// ===========================================================================

test("the trigger handler rejects malformed JSON with a 4xx and never runs the job", async () => {
  const db = recordingDb();
  const spy = spySource({ rateDate: "2026-11-06", baseCurrency: "EUR", rates: { AUD: 1.65 } });
  const handler = ratesJobTriggerHandler({ db, source: spy.source });

  const res = await handler(jsonRequest("{ not valid json"));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(spy.count(), 0, "malformed input must be rejected before the job fetches anything");
  assert.equal(db.calls.length, 0, "and before any query is issued");
});

test("the trigger handler rejects an oversized body with a 4xx and never runs the job", async () => {
  const db = recordingDb();
  const spy = spySource({ rateDate: "2026-11-06", baseCurrency: "EUR", rates: { AUD: 1.65 } });
  const handler = ratesJobTriggerHandler({ db, source: spy.source });

  // ~10 KiB body, well over the handler's 4 KiB cap: rejected by size before the job runs.
  const res = await handler(jsonRequest(JSON.stringify({ junk: "x".repeat(10 * 1024) })));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(spy.count(), 0, "an oversized body must be rejected before the job fetches anything");
  assert.equal(db.calls.length, 0, "and before any query is issued");
});

test("the trigger handler accepts a well-formed trigger and stores the day's rates", async () => {
  const db = await freshDb();
  try {
    const fixed: DailyRates = { rateDate: "2026-11-06", baseCurrency: "EUR", rates: { AUD: 1.6543 } };
    const handler = ratesJobTriggerHandler({ db, source: fakeRateSource(fixed) });

    const res = await handler(jsonRequest("{}"));
    assert.ok(res.status >= 200 && res.status < 300, `expected a 2xx, got ${res.status}`);

    const lookup = await getRate(db, { on: "2026-11-06", baseCurrency: "EUR", quoteCurrency: "AUD" });
    assert.equal(lookup.found, true, "a well-formed trigger runs the job and stores the rates");
    if (lookup.found) {
      assert.equal(lookup.rate, 1.6543, "the stored rate matches what the source returned");
    }
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC4 (parameterize half) — every fetched value reaches the query layer as a BOUND value, and
// a SQL-injection probe in a fetched currency code cannot alter a query; the table survives.
// ===========================================================================

test("the job binds every fetched currency, date and rate as a parameter, never woven into the SQL text", async () => {
  const db = recordingDb();
  const fixed: DailyRates = { rateDate: "2026-11-06", baseCurrency: "EUR", rates: { AUD: 1.6543, USD: 1.0812 } };

  await runRatesJob({ db, source: fakeRateSource(fixed) });

  assert.ok(db.calls.length >= 2, "one upsert per quote currency reached the query layer");
  const bound = db.calls.flatMap((c) => c.values);
  assert.ok(bound.includes("2026-11-06"), "the date travels as a bound value");
  assert.ok(bound.includes("EUR"), "the base currency travels as a bound value");
  assert.ok(bound.includes("AUD"), "a quote currency travels as a bound value");
  assert.ok(bound.includes("USD"), "every quote currency travels as a bound value");
  assert.ok(bound.includes(1.6543), "a rate travels as a bound value");
  for (const call of db.calls) {
    assert.ok(!call.text.includes("'EUR'"), "the base currency is bound, never concatenated into the SQL");
    assert.ok(!call.text.includes("1.6543"), "the rate is bound, never concatenated into the SQL");
  }
});

test("a SQL-injection probe in a fetched currency code is bound, never run (recording db)", async () => {
  const db = recordingDb();
  const probe = "AUD'); DROP TABLE exchange_rates; --";
  const fixed: DailyRates = { rateDate: "2026-11-06", baseCurrency: "EUR", rates: { [probe]: 1.5, USD: 1.0812 } };

  await runRatesJob({ db, source: fakeRateSource(fixed) });

  // The probe may be dropped by validation or bound by the repo — either way no injected
  // statement is ever woven into the SQL text that reaches the query layer.
  for (const call of db.calls) {
    assert.ok(!call.text.includes(probe), "the currency code is bound, never concatenated into the SQL");
    assert.ok(!call.text.includes("DROP TABLE"), "no injected statement appears in the SQL text");
  }
});

test("a SQL-injection probe in a fetched currency code cannot drop the table (real db)", async () => {
  const db = await freshDb();
  try {
    const probe = "AUD'); DROP TABLE exchange_rates; --";
    const fixed: DailyRates = { rateDate: "2026-11-06", baseCurrency: "EUR", rates: { [probe]: 1.5 } };

    try {
      await runRatesJob({ db, source: fakeRateSource(fixed) });
    } catch {
      // Tolerate a constraint / shape error — the point is that no injected statement ran.
    }

    assert.equal(
      await tableExists(db, "exchange_rates"),
      true,
      "the exchange_rates table must still exist (the probe was bound, never executed as SQL)",
    );
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC5 [obligation:secrets-from-env] — the job reads no process.env: a decoy secret in the
// environment never lands in a stored rate.
// ===========================================================================

test("the job reads no process.env: a decoy secret in the environment never lands in a stored rate", async () => {
  const DECOY = "sk_live_DECOY_must_never_appear_in_warthog";
  const prev = process.env.WARTHOG_DECOY_SECRET;
  process.env.WARTHOG_DECOY_SECRET = DECOY;
  const db = await freshDb();
  try {
    const fixed: DailyRates = { rateDate: "2026-11-06", baseCurrency: "EUR", rates: { AUD: 1.6543 } };
    await runRatesJob({ db, source: fakeRateSource(fixed) });

    // Scan every cell of the one table under test for the decoy (scoped narrowly — the job is
    // built purely from its injected seams, so no ambient env value should reach a column).
    const all = await db.query("SELECT * FROM exchange_rates");
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

// Keep the documentary types referenced so a drift in their names is noticed at authoring time
// (the imports are erased at runtime; this never executes).
export type __RatesJobDepsAnchor = RatesJobDeps;
export type __RatesJobResultAnchor = RatesJobResult;
