// The exchange-rate fetch JOB (task E15-S03; design §8 step 4 + §12).
//
// The daily reference rates that feed the policy engine's currency conversion are kept
// current by this job: it fetches the day's rates THROUGH THE SOURCE SEAM
// (`./rate-source`) and upserts one row per quote currency into the rate store
// (`../db/exchange-rates`). It is IDEMPOTENT — a second run with the same day's rates
// overwrites in place via the store's composite key, so no duplicate rows and no value
// drift (AC1). A fetch failure is REPORTED, not swallowed: the fetch happens BEFORE any
// write, so the source's rejection propagates out of the job and the previously stored
// rates are left untouched (AC3).
//
// The free source publishes ONE base (EUR), but conversion looks up a direct (from, to) pair —
// a card request converts FROM its currency INTO the account currency (AUD by default) — so
// the job stores every ordered pair among the day's currencies, each derived from the one
// published base (from->to = base->to / base->from). Currency codes are normalised to upper
// case; an entry that is not a three-letter code with a positive finite rate is dropped, and a
// set whose base is unusable is reported.
//
// The job is built purely from its injected seams (db, source): it reads no
// `process.env` and holds no secret (AC5 / INV-103). Every fetched value reaches the
// query layer as a BOUND parameter through `upsertRate` (never concatenated into the SQL
// text), so a value shaped like SQL is stored as data and cannot alter the query (AC4 /
// INV-102).

import type { Db } from "../db/index";
import { withTransaction } from "../db/index";
import { upsertRate } from "../db/exchange-rates";
import type { DailyRates, RateSource } from "./rate-source";

// What the job runs against: the database seam and the rate source seam.
export interface RatesJobDeps {
  readonly db: Db;
  readonly source: RateSource;
}

// What the job reports: the day whose rates were stored and how many ordered (base, quote)
// pairs were written this run.
export interface RatesJobResult {
  readonly rateDate: string;
  readonly pairsUpserted: number;
}

const CURRENCY_CODE = /^[A-Z]{3}$/;

// The day's set as units of each currency per 1 unit of the base (the base itself is 1),
// keeping only well-formed codes with positive finite rates.
function perBase(daily: DailyRates): Map<string, number> {
  const base = daily.baseCurrency.trim().toUpperCase();
  if (!CURRENCY_CODE.test(base)) {
    throw new Error("Exchange-rate source returned an unusable base currency");
  }
  const units = new Map<string, number>([[base, 1]]);
  for (const [code, rate] of Object.entries(daily.rates)) {
    const quote = code.trim().toUpperCase();
    if (!CURRENCY_CODE.test(quote) || quote === base) continue;
    if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0) continue;
    units.set(quote, rate);
  }
  return units;
}

// Fetch the day's rates via the seam and upsert one row per ordered currency pair into the
// rate store. The fetch is awaited FIRST: if it rejects, the rejection propagates and no write
// is attempted, so the previously stored rates are left intact (AC3). The upserts run in
// one transaction so a mid-run failure rolls the whole refresh back rather than leaving
// the store half-updated (constitution: roll back on failure). A re-run the same day
// overwrites in place and changes nothing (AC1).
export async function runRatesJob(deps: RatesJobDeps): Promise<RatesJobResult> {
  const daily = await deps.source.fetchDailyRates();
  const units = perBase(daily);

  const pairs: Array<{ baseCurrency: string; quoteCurrency: string; rate: number }> = [];
  for (const [from, fromUnits] of units) {
    for (const [to, toUnits] of units) {
      if (from === to) continue;
      // 1 `from` = (toUnits / fromUnits) `to`, both measured against the published base.
      pairs.push({ baseCurrency: from, quoteCurrency: to, rate: toUnits / fromUnits });
    }
  }

  await withTransaction(deps.db, async (tx) => {
    for (const pair of pairs) {
      await upsertRate(tx, { rateDate: daily.rateDate, ...pair });
    }
  });

  return { rateDate: daily.rateDate, pairsUpserted: pairs.length };
}
