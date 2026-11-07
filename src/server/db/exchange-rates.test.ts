// E15-S02 — Daily exchange-rate store
// (`src/server/db/exchange-rates.ts`, `db/migrations/0038_exchange_rates.sql`).
//
// RED-first: neither the data-access module nor the migration exists yet, so importing
// `./exchange-rates` throws and `freshDb()` has no `exchange_rates` table — every test
// here fails until the builder adds them. That absence IS the point of test-first; do
// NOT implement anything to make these pass — the builder writes the module and the
// migration afterwards.
//
// These tests pin BEHAVIOUR (what the functions DO: a day's rate upserts keyed by
// (date, base, quote); getRate returns the LATEST rate ON OR BEFORE a requested date for
// a pair together with the date it applies to; a second upsert of the same key overwrites
// in place rather than duplicating; a pair with no rate on or before the date reports
// ABSENCE so the caller can refuse rather than guess; a handler rejects malformed/oversized
// input with a 4xx before any query; every value is BOUND as a parameter; the repo reads no
// secret from the environment), never the source text of the module or the SQL file — a
// later rename that preserves behaviour must not redden them.
//
// WHY this exists (task E15-S02; brief "Currency": "a card request in another currency is
// converted for the rule checks using the latest daily reference exchange rate from a free
// official source, the approval shows both amounts and the rate's date, and if no rate is
// available the request is refused with a plain reason"; design §8 step 4: "currency
// converted with the latest daily ECB reference rate … — no rate → deny"). So the rates
// are stored BY DATE per currency pair and read as "latest on or before", and the applicable
// date travels back for the approval to show. Daily reference rates are GLOBAL reference
// data (not member-scoped personal content) — a short numeric scalar per (date, pair) — so,
// like the account currency and unlike vault fields, cards or released values, they are NOT
// DEK-encrypted and this module holds no key and reads no `process.env`.
//
// ---------------------------------------------------------------------------
// THE PINNED CONTRACT (chosen by the tester; the implementation conforms to it).
//
//   interface UpsertRateInput {
//     rateDate: string;       // the day the rate is for, ISO "YYYY-MM-DD"
//     baseCurrency: string;   // ISO 4217 code (the "1 unit of" currency)
//     quoteCurrency: string;  // ISO 4217 code (units of quote per 1 unit of base)
//     rate: number;           // the reference rate; units of quote per 1 base
//   }
//
//   interface GetRateQuery {
//     on: string;             // the requested date, ISO "YYYY-MM-DD"
//     baseCurrency: string;
//     quoteCurrency: string;
//   }
//
//   type RateLookup =
//     | { found: true; rate: number; rateDate: string }  // the LATEST rate on or before `on`,
//                                                          //   with the date it applies to ("YYYY-MM-DD")
//     | { found: false };                                 // no stored rate on or before `on` — caller refuses
//
//   upsertRate(db, input: UpsertRateInput): Promise<void>
//     • INSERTs the day's rate for (rateDate, baseCurrency, quoteCurrency), or UPDATEs the
//       one already stored for that exact key — so a second upsert of the same key overwrites
//       in place and never duplicates. Every value is BOUND, never concatenated.
//   getRate(db, query: GetRateQuery): Promise<RateLookup>
//     • returns the LATEST rate whose date is on or before `query.on` for that exact pair
//       (direction matters: USD→AUD is not AUD→USD), carrying the date it applies to. When no
//       rate is stored on or before `on` for the pair, returns { found: false } — it never
//       guesses or returns a rate from after the date or from a different pair.
//
// Acceptance criteria → tests:
//   AC1 "Upserting a day's rate for a pair stores it keyed by (date, base, quote), and getRate
//        returns the latest rate on or before a requested date for that pair with the date it
//        applies to." — an upsert round-trips; across several dates, getRate picks the latest
//        date ≤ the requested one (inclusive of an exact match) and reports THAT date; the rate
//        comes back as a number with its stored precision; a different pair is never returned.
//   AC2 "A second upsert of the same (date, base, quote) overwrites rather than duplicating,
//        and a pair with no stored rate reports absence." — re-upserting one key updates the
//        value and leaves exactly one row for it; a pair with no rows, and a date before every
//        stored rate, each return { found: false }.
//   AC3 [obligation:validate-and-parameterize-input] (INV-102) — a handler on the
//        `../http/validate` boundary rejects malformed / oversized / missing / mis-typed /
//        mis-shaped input with a 4xx before any query runs; a SQL-injection probe routed
//        through the repo travels as a BOUND value (placeholders, never concatenation) and an
//        injection-shaped field is rejected by handler validation and never reaches a query —
//        the table survives either way. The handler below is a test fixture (the intended
//        usage), not an implementation file.
//   AC4 [obligation:secrets-from-env] (INV-103) — the repo takes its db as a dependency, reads
//        no `process.env` and holds no secret, so a decoy secret planted in the environment
//        never lands in a stored or returned rate.
//   Migration: the `exchange_rates` relation exists after the project migrations and a second
//        run of every migration changes nothing.
//
// Every db handle is closed in a `finally` so node:test leaves no open handle; each real-db
// test uses its own `freshDb()` (an isolated in-memory PGlite with the real migrations), so
// tests share no state.

import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";

import { upsertRate, getRate } from "./exchange-rates";
// Documentary type anchors — the exact names/shapes the implementation exports. Erased at
// runtime (and test files are excluded from `tsc`), so a rename cannot break these tests; the
// runtime assertions below are what actually gate behaviour.
import type { UpsertRateInput, GetRateQuery, RateLookup } from "./exchange-rates";
import { freshDb } from "../../test/db";
import { loadMigrations, runMigrations, type Db, type QueryResult } from "./index";
import { parseBody, HttpError } from "../http/validate";

// --- fixtures ---------------------------------------------------------------------

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
// relation name when it exists and NULL when it does not — a non-throwing probe scoped to the
// one table under test (behaviour, not source text).
async function tableExists(db: Db, name: string): Promise<boolean> {
  const result = await db.query("SELECT to_regclass($1) AS t", [name]);
  return result.rows[0]?.t != null;
}

// How many rows exist for one exact (date, base, quote) key — proves an upsert overwrote in
// place rather than inserting a duplicate.
async function rowCountForKey(
  db: Db,
  rateDate: string,
  base: string,
  quote: string,
): Promise<number> {
  const result = await db.query(
    "SELECT count(*)::int AS n FROM exchange_rates " +
      "WHERE rate_date = $1 AND base_currency = $2 AND quote_currency = $3",
    [rateDate, base, quote],
  );
  return result.rows[0]!.n as number;
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

// ===========================================================================
// AC1 — an upsert round-trips; getRate reads the latest rate on or before a date for a pair
// with the date it applies to; the rate's precision survives; other pairs never leak in.
// ===========================================================================

test("a day's rate upserts and reads back for its pair and date", async () => {
  const db = await freshDb();
  try {
    const input: UpsertRateInput = {
      rateDate: "2026-11-05",
      baseCurrency: "USD",
      quoteCurrency: "AUD",
      rate: 1.5321,
    };
    await upsertRate(db, input);

    const lookup: RateLookup = await getRate(db, {
      on: "2026-11-05",
      baseCurrency: "USD",
      quoteCurrency: "AUD",
    });
    assert.equal(lookup.found, true, "a stored rate is found for its own date");
    if (lookup.found) {
      assert.equal(typeof lookup.rate, "number", "the rate comes back as a number, not a numeric string");
      assert.equal(lookup.rate, 1.5321, "the stored rate reads back exactly");
      assert.equal(lookup.rateDate, "2026-11-05", "the applicable date is the stored one (YYYY-MM-DD)");
    }
  } finally {
    await db.close();
  }
});

test("getRate returns the LATEST rate on or before the requested date, with that rate's date", async () => {
  const db = await freshDb();
  try {
    // Three daily rates for USD→AUD, out of order on insert to prove ordering is by date.
    await upsertRate(db, { rateDate: "2026-11-05", baseCurrency: "USD", quoteCurrency: "AUD", rate: 1.6 });
    await upsertRate(db, { rateDate: "2026-11-01", baseCurrency: "USD", quoteCurrency: "AUD", rate: 1.5 });
    await upsertRate(db, { rateDate: "2026-11-03", baseCurrency: "USD", quoteCurrency: "AUD", rate: 1.55 });

    // A date strictly between two stored dates: the latest ON OR BEFORE it is 2026-11-03.
    const between = await getRate(db, { on: "2026-11-04", baseCurrency: "USD", quoteCurrency: "AUD" });
    assert.equal(between.found, true, "a rate exists on or before 2026-11-04");
    if (between.found) {
      assert.equal(between.rate, 1.55, "the latest rate on or before 2026-11-04 is the 2026-11-03 one");
      assert.equal(between.rateDate, "2026-11-03", "and its applicable date is reported, not the requested date");
    }

    // A date AFTER every stored rate: the latest overall (2026-11-05) applies.
    const after = await getRate(db, { on: "2026-12-25", baseCurrency: "USD", quoteCurrency: "AUD" });
    assert.equal(after.found, true, "a date after all rates still has a latest rate");
    if (after.found) {
      assert.equal(after.rate, 1.6, "the most recent stored rate applies for a later date");
      assert.equal(after.rateDate, "2026-11-05", "its date is the most recent stored date");
    }

    // The earliest stored date, queried exactly: inclusive lower bound.
    const earliest = await getRate(db, { on: "2026-11-01", baseCurrency: "USD", quoteCurrency: "AUD" });
    assert.equal(earliest.found, true, "the earliest stored date is on-or-before itself");
    if (earliest.found) {
      assert.equal(earliest.rate, 1.5, "the earliest rate applies on its own date");
      assert.equal(earliest.rateDate, "2026-11-01", "with its own date");
    }
  } finally {
    await db.close();
  }
});

test("getRate is INCLUSIVE of an exact-date match (on == rateDate returns that day's rate)", async () => {
  const db = await freshDb();
  try {
    await upsertRate(db, { rateDate: "2026-11-02", baseCurrency: "EUR", quoteCurrency: "AUD", rate: 1.62 });
    await upsertRate(db, { rateDate: "2026-11-04", baseCurrency: "EUR", quoteCurrency: "AUD", rate: 1.68 });

    const exact = await getRate(db, { on: "2026-11-04", baseCurrency: "EUR", quoteCurrency: "AUD" });
    assert.equal(exact.found, true, "an exact date match is found (on-or-before includes equal)");
    if (exact.found) {
      assert.equal(exact.rate, 1.68, "the exact day's rate wins, not the day before");
      assert.equal(exact.rateDate, "2026-11-04", "the matched date is the exact requested date");
    }
  } finally {
    await db.close();
  }
});

test("getRate is pair-directional: a rate for one pair never answers for another", async () => {
  const db = await freshDb();
  try {
    await upsertRate(db, { rateDate: "2026-11-03", baseCurrency: "USD", quoteCurrency: "AUD", rate: 1.55 });

    // A different quote currency for the same base is a different pair.
    const otherQuote = await getRate(db, { on: "2026-11-10", baseCurrency: "USD", quoteCurrency: "NZD" });
    assert.equal(otherQuote.found, false, "USD→NZD has no stored rate, even though USD→AUD does");

    // The reversed direction (AUD→USD) is a different pair and is not derived from USD→AUD.
    const reversed = await getRate(db, { on: "2026-11-10", baseCurrency: "AUD", quoteCurrency: "USD" });
    assert.equal(reversed.found, false, "the reverse direction is not inferred from the stored direction");

    // The actual stored pair still answers, unaffected by the misses above.
    const stored = await getRate(db, { on: "2026-11-10", baseCurrency: "USD", quoteCurrency: "AUD" });
    assert.equal(stored.found, true, "the stored pair still resolves");
    if (stored.found) {
      assert.equal(stored.rate, 1.55, "and returns its own rate");
    }
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC2 — a second upsert of the same key overwrites in place (no duplicate); absence is
// reported for a pair with no rate and for a date before every stored rate.
// ===========================================================================

test("re-upserting the same (date, base, quote) overwrites the rate and leaves exactly one row", async () => {
  const db = await freshDb();
  try {
    await upsertRate(db, { rateDate: "2026-11-03", baseCurrency: "USD", quoteCurrency: "AUD", rate: 1.55 });
    await upsertRate(db, { rateDate: "2026-11-03", baseCurrency: "USD", quoteCurrency: "AUD", rate: 1.58 });

    const lookup = await getRate(db, { on: "2026-11-03", baseCurrency: "USD", quoteCurrency: "AUD" });
    assert.equal(lookup.found, true, "the pair still resolves after the overwrite");
    if (lookup.found) {
      assert.equal(lookup.rate, 1.58, "the second upsert's value wins (overwrite, not a new row)");
    }

    assert.equal(
      await rowCountForKey(db, "2026-11-03", "USD", "AUD"),
      1,
      "there is exactly one row for the (date, base, quote) key — the upsert did not duplicate",
    );
  } finally {
    await db.close();
  }
});

test("overwriting one day's rate does not disturb another day's rate for the same pair", async () => {
  const db = await freshDb();
  try {
    await upsertRate(db, { rateDate: "2026-11-01", baseCurrency: "USD", quoteCurrency: "AUD", rate: 1.5 });
    await upsertRate(db, { rateDate: "2026-11-02", baseCurrency: "USD", quoteCurrency: "AUD", rate: 1.52 });

    // Re-upsert only 2026-11-02; 2026-11-01 must survive untouched.
    await upsertRate(db, { rateDate: "2026-11-02", baseCurrency: "USD", quoteCurrency: "AUD", rate: 1.99 });

    const first = await getRate(db, { on: "2026-11-01", baseCurrency: "USD", quoteCurrency: "AUD" });
    assert.equal(first.found, true, "the untouched day still resolves");
    if (first.found) {
      assert.equal(first.rate, 1.5, "the other day's rate is unchanged by the overwrite");
    }
    assert.equal(await rowCountForKey(db, "2026-11-01", "USD", "AUD"), 1, "one row for the untouched day");
    assert.equal(await rowCountForKey(db, "2026-11-02", "USD", "AUD"), 1, "one row for the overwritten day");
  } finally {
    await db.close();
  }
});

test("a pair with no stored rate reports absence (never a guessed rate)", async () => {
  const db = await freshDb();
  try {
    const lookup = await getRate(db, { on: "2026-11-10", baseCurrency: "GBP", quoteCurrency: "AUD" });
    assert.deepEqual(lookup, { found: false }, "an unknown pair reports absence so the caller can refuse");
  } finally {
    await db.close();
  }
});

test("a date before every stored rate for the pair reports absence (no rate on or before it)", async () => {
  const db = await freshDb();
  try {
    await upsertRate(db, { rateDate: "2026-11-05", baseCurrency: "USD", quoteCurrency: "AUD", rate: 1.6 });

    const lookup = await getRate(db, { on: "2026-11-01", baseCurrency: "USD", quoteCurrency: "AUD" });
    assert.deepEqual(
      lookup,
      { found: false },
      "no rate exists on or before 2026-11-01, so absence is reported — a later rate is NOT returned",
    );
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC3 (parameterize half) — every field reaches the query layer as a BOUND value, and a
// SQL-injection probe routed through the repo cannot alter a query; the table survives.
// ===========================================================================

test("upsertRate binds every field as a parameter, never woven into the SQL text", async () => {
  const db = recordingDb();
  await upsertRate(db, {
    rateDate: "2026-11-03",
    baseCurrency: "USD",
    quoteCurrency: "AUD",
    rate: 1.55,
  });

  assert.ok(db.calls.length >= 1, "a statement was issued");
  const bound = db.calls.flatMap((c) => c.values);
  assert.ok(bound.includes("2026-11-03"), "the date travels as a bound value");
  assert.ok(bound.includes("USD"), "the base currency travels as a bound value");
  assert.ok(bound.includes("AUD"), "the quote currency travels as a bound value");
  assert.ok(bound.includes(1.55), "the rate travels as a bound value");
  for (const call of db.calls) {
    assert.ok(!call.text.includes("'USD'"), "the currency is bound, never concatenated into the SQL");
    assert.ok(!call.text.includes("1.55"), "the rate is bound, never concatenated into the SQL");
  }
});

test("getRate binds the date and the currency pair as parameters, never woven into the SQL text", async () => {
  const db = recordingDb();
  const lookup = await getRate(db, { on: "2026-11-04", baseCurrency: "USD", quoteCurrency: "AUD" });

  // The recording db returns no rows, so a read reports absence carrying no leaked SQL — but
  // whatever statement it issued must have BOUND the date and the pair.
  assert.deepEqual(lookup, { found: false }, "no rows → absence is reported");
  assert.ok(db.calls.length >= 1, "a statement was issued");
  const bound = db.calls.flatMap((c) => c.values);
  assert.ok(bound.includes("2026-11-04"), "the requested date is bound");
  assert.ok(bound.includes("USD"), "the base currency is bound");
  assert.ok(bound.includes("AUD"), "the quote currency is bound");
});

test("a SQL-injection probe in a currency field is bound, never run: upsertRate cannot drop the table", async () => {
  const recorder = recordingDb();
  const probe = "USD'); DROP TABLE exchange_rates; --";
  await upsertRate(recorder, {
    rateDate: "2026-11-03",
    baseCurrency: probe,
    quoteCurrency: "AUD",
    rate: 1.55,
  });
  assertBoundNotSpliced(recorder, probe);

  // And against a REAL database: the probe is bound, so even if it reaches the repo it cannot
  // execute the injected statement — the table must still be there afterwards. (A schema CHECK
  // may reject it as a constraint violation; either way the DROP never runs.)
  const db = await freshDb();
  try {
    try {
      await upsertRate(db, { rateDate: "2026-11-03", baseCurrency: probe, quoteCurrency: "AUD", rate: 1.55 });
    } catch {
      /* tolerate a constraint/shape error — the point is that no injected statement ran */
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
// AC3 (validate half) — a handler on the `../http/validate` boundary rejects malformed /
// oversized / missing / mis-typed / mis-shaped input with a 4xx BEFORE any query runs, and
// accepts a well-formed body and stores it. This handler is a test fixture that EXERCISES
// the modules (parseBody → the parameterized repo) — it is NOT an implementation file.
// ===========================================================================

function upsertRateHandler(db: Db): (req: Request) => Promise<Response> {
  // The body carries the full daily-rate record. Currency codes are validated to the ISO
  // 4217 shape (three uppercase letters), the date to YYYY-MM-DD, and the rate to a positive
  // number — so a mis-shaped or injection-shaped value is rejected HERE and never reaches a
  // query; a well-formed value is then BOUND by the repo.
  const schema = z.object({
    rateDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    baseCurrency: z.string().regex(/^[A-Z]{3}$/),
    quoteCurrency: z.string().regex(/^[A-Z]{3}$/),
    rate: z.number().positive(),
  });
  return async (req: Request): Promise<Response> => {
    try {
      const body = await parseBody(schema, req, { maxBytes: 4 * 1024 });
      await upsertRate(db, {
        rateDate: body.rateDate,
        baseCurrency: body.baseCurrency,
        quoteCurrency: body.quoteCurrency,
        rate: body.rate,
      });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
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
  return new Request("https://warthog.com.au/api/exchange-rates", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

const WELL_FORMED_BODY = JSON.stringify({
  rateDate: "2026-11-03",
  baseCurrency: "USD",
  quoteCurrency: "AUD",
  rate: 1.55,
});

test("the handler rejects malformed JSON with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = upsertRateHandler(db);

  const res = await handler(jsonRequest("{ not valid json"));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "malformed input must never reach a query");
});

test("the handler rejects an oversized body with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = upsertRateHandler(db);

  // ~10 KiB body, well over the handler's 4 KiB cap: rejected by size before parse.
  const res = await handler(
    jsonRequest(JSON.stringify({ rateDate: "2026-11-03", baseCurrency: "USD", quoteCurrency: "AUD", rate: 1.55, junk: "x".repeat(10 * 1024) })),
  );

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "an oversized body must never reach a query");
});

test("the handler rejects a body missing a required field with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = upsertRateHandler(db);

  // No `rate` field at all — a schema violation, rejected before any query.
  const res = await handler(jsonRequest(JSON.stringify({ rateDate: "2026-11-03", baseCurrency: "USD", quoteCurrency: "AUD" })));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "a schema violation must never reach a query");
});

test("the handler rejects a mis-typed rate (string, not number) with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = upsertRateHandler(db);

  // rate must be a number — a string is a schema violation, rejected before any query.
  const res = await handler(jsonRequest(JSON.stringify({ rateDate: "2026-11-03", baseCurrency: "USD", quoteCurrency: "AUD", rate: "1.55" })));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "a mis-typed field must never reach a query");
});

test("the handler rejects a non-positive rate with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = upsertRateHandler(db);

  for (const bad of [0, -1.5]) {
    const res = await handler(jsonRequest(JSON.stringify({ rateDate: "2026-11-03", baseCurrency: "USD", quoteCurrency: "AUD", rate: bad })));
    assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx for rate ${bad}, got ${res.status}`);
  }
  assert.equal(db.calls.length, 0, "a non-positive rate must never reach a query");
});

test("the handler rejects a mis-shaped date with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = upsertRateHandler(db);

  // "05/11/2026" is not the ISO YYYY-MM-DD shape — rejected before any query.
  const res = await handler(jsonRequest(JSON.stringify({ rateDate: "05/11/2026", baseCurrency: "USD", quoteCurrency: "AUD", rate: 1.55 })));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "a mis-shaped date must never reach a query");
});

test("the handler rejects a mis-shaped / injection-shaped currency with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = upsertRateHandler(db);

  const probe = "USD'); DROP TABLE exchange_rates; --";
  const res = await handler(jsonRequest(JSON.stringify({ rateDate: "2026-11-03", baseCurrency: probe, quoteCurrency: "AUD", rate: 1.55 })));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx for the probe, got ${res.status}`);
  assert.equal(db.calls.length, 0, "an injection-shaped currency is rejected by validation and never reaches a query");
});

test("the handler accepts a well-formed body and persists the daily rate", async () => {
  const db = await freshDb();
  try {
    const handler = upsertRateHandler(db);

    const res = await handler(jsonRequest(WELL_FORMED_BODY));
    assert.ok(res.status >= 200 && res.status < 300, `expected a 2xx, got ${res.status}`);

    const lookup = await getRate(db, { on: "2026-11-03", baseCurrency: "USD", quoteCurrency: "AUD" });
    assert.equal(lookup.found, true, "the submitted rate is stored");
    if (lookup.found) {
      assert.equal(lookup.rate, 1.55, "and reads back as submitted");
      assert.equal(lookup.rateDate, "2026-11-03", "for its submitted date");
    }
  } finally {
    await db.close();
  }
});

test("the handler cannot be SQL-injected via a currency field: the exchange_rates table survives", async () => {
  const db = await freshDb();
  try {
    const handler = upsertRateHandler(db);
    const probe = "USD'); DROP TABLE exchange_rates; --";

    const res = await handler(jsonRequest(JSON.stringify({ rateDate: "2026-11-03", baseCurrency: probe, quoteCurrency: "AUD", rate: 1.55 })));

    // The injection-shaped value fails the ISO-shape validation, so it is rejected (never run).
    assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx for the probe, got ${res.status}`);
    assert.equal(await tableExists(db, "exchange_rates"), true, "the exchange_rates table must still exist");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC4 — the repo reads no process.env: a decoy secret in the environment never lands in a
// stored or returned rate.
// ===========================================================================

test("the repo reads no process.env: a decoy secret in the environment never lands in a rate", async () => {
  const DECOY = "sk_live_DECOY_must_never_appear_in_warthog";
  const prev = process.env.WARTHOG_DECOY_SECRET;
  process.env.WARTHOG_DECOY_SECRET = DECOY;
  const db = await freshDb();
  try {
    await upsertRate(db, { rateDate: "2026-11-03", baseCurrency: "USD", quoteCurrency: "AUD", rate: 1.55 });

    const lookup = await getRate(db, { on: "2026-11-03", baseCurrency: "USD", quoteCurrency: "AUD" });
    assert.equal(lookup.found, true, "the write and read run purely from the injected db + inputs — no app env needed");
    assert.ok(
      !JSON.stringify(lookup).includes(DECOY),
      "no ambient env value is folded into the returned rate",
    );

    // Scan every cell of the one table under test for the decoy (scoped narrowly — the same
    // value could legitimately live elsewhere if it were a real datum, which it is not).
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

// ===========================================================================
// Migration — the table applies and a second run of every migration changes nothing.
// ===========================================================================

test("the exchange_rates migration applies and re-running every migration changes nothing", async () => {
  const db = await freshDb();
  try {
    assert.equal(
      await tableExists(db, "exchange_rates"),
      true,
      "the exchange_rates table must exist after the project migrations",
    );

    const migrations = await loadMigrations();
    assert.ok(
      migrations.some((m) => m.name === "0038_exchange_rates"),
      "db/migrations/0038_exchange_rates.sql must be part of the project migrations",
    );

    // A second run over the same database applies nothing new and does not throw —
    // re-executing 0038's CREATE would throw "already exists", so an empty result AND no throw
    // together prove the migration's second run changes nothing.
    const again = await runMigrations(db, migrations);
    assert.deepEqual(again, [], "a second migration run must change nothing");
  } finally {
    await db.close();
  }
});

// Keep the documentary input/query types referenced so a drift in their names is noticed at
// authoring time (the imports are erased at runtime; this never executes).
export type __UpsertRateInputAnchor = UpsertRateInput;
export type __GetRateQueryAnchor = GetRateQuery;
