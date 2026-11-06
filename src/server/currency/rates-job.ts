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
// The job is built purely from its injected seams (db, source): it reads no
// `process.env` and holds no secret (AC5 / INV-103). Every fetched value reaches the
// query layer as a BOUND parameter through `upsertRate` (never concatenated into the SQL
// text), so a value shaped like SQL is stored as data and cannot alter the query (AC4 /
// INV-102).

import type { Db } from "../db/index";
import { withTransaction } from "../db/index";
import { upsertRate } from "../db/exchange-rates";
import type { RateSource } from "./rate-source";

// What the job runs against: the database seam and the rate source seam.
export interface RatesJobDeps {
  readonly db: Db;
  readonly source: RateSource;
}

// What the job reports: the day whose rates were stored and how many (base, quote) pairs
// were written this run.
export interface RatesJobResult {
  readonly rateDate: string;
  readonly pairsUpserted: number;
}

// Fetch the day's rates via the seam and upsert one row per quote currency into the rate
// store. The fetch is awaited FIRST: if it rejects, the rejection propagates and no write
// is attempted, so the previously stored rates are left intact (AC3). The upserts run in
// one transaction so a mid-run failure rolls the whole refresh back rather than leaving
// the store half-updated (constitution: roll back on failure). A re-run the same day
// overwrites in place and changes nothing (AC1).
export async function runRatesJob(deps: RatesJobDeps): Promise<RatesJobResult> {
  const daily = await deps.source.fetchDailyRates();
  const quotes = Object.entries(daily.rates);

  await withTransaction(deps.db, async (tx) => {
    for (const [quoteCurrency, rate] of quotes) {
      await upsertRate(tx, {
        rateDate: daily.rateDate,
        baseCurrency: daily.baseCurrency,
        quoteCurrency,
        rate,
      });
    }
  });

  return { rateDate: daily.rateDate, pairsUpserted: quotes.length };
}
