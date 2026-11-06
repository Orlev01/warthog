// The daily exchange-rate aggregate's data access (brief "Currency": "a card request
// in another currency is converted for the rule checks using the latest daily reference
// exchange rate from a free official source, the approval shows both amounts and the
// rate's date, and if no rate is available the request is refused with a plain reason";
// design §8 step 4). One daily reference rate per (date, pair) lives in exactly one
// place here (constitution: one-source-of-truth): the policy engine reads the latest
// rate on or before the request's date to convert a foreign-currency card request.
//
// Daily reference rates are GLOBAL reference data (a short numeric scalar per (date,
// pair)), NOT member-scoped personal content — so, like the account currency and unlike
// vault fields, cards or released values, they are PLAINTEXT and NOT DEK-encrypted, and
// this module holds no key and reads no `process.env` (config flows from
// `src/server/config.ts` alone, INV-103).
//
// Every statement is parameterized through the `Db` seam (INV-102): the date, the
// currency pair and the rate travel as BOUND values, never concatenated into the SQL
// text, so a value shaped like SQL is stored as data and cannot alter the query.

import type { Db } from "./index";

// What upsertRate takes: the day the rate is for (ISO "YYYY-MM-DD"), the pair the rate
// quotes (units of quote per 1 unit of base — direction matters) and the reference rate.
export interface UpsertRateInput {
  readonly rateDate: string;
  readonly baseCurrency: string;
  readonly quoteCurrency: string;
  readonly rate: number;
}

// What getRate takes: the requested date (ISO "YYYY-MM-DD") and the pair to look up.
export interface GetRateQuery {
  readonly on: string;
  readonly baseCurrency: string;
  readonly quoteCurrency: string;
}

// The outcome of a lookup: the latest rate on or before the requested date for the pair,
// carrying the date it applies to — or absence, so the caller refuses rather than guesses.
export type RateLookup =
  | { found: true; rate: number; rateDate: string }
  | { found: false };

// Store the day's rate for (rateDate, baseCurrency, quoteCurrency): INSERT the row or
// UPDATE the one already there for that exact key — keyed on the composite primary key,
// so a second upsert of the same key overwrites in place and never duplicates. Every
// value is bound as a parameter.
export async function upsertRate(db: Db, input: UpsertRateInput): Promise<void> {
  await db.query(
    `INSERT INTO exchange_rates (rate_date, base_currency, quote_currency, rate)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (rate_date, base_currency, quote_currency)
     DO UPDATE SET rate = EXCLUDED.rate`,
    [input.rateDate, input.baseCurrency, input.quoteCurrency, input.rate],
  );
}

// Read the LATEST rate whose date is on or before `query.on` for that exact pair
// (direction matters), carrying the date it applies to. Returns { found: false } when no
// rate is stored on or before `on` for the pair — it never returns a rate from after the
// date or from a different pair. The applicable date is read back as ISO "YYYY-MM-DD"
// (via to_char, independent of the session's DateStyle) and the rate as a number.
export async function getRate(db: Db, query: GetRateQuery): Promise<RateLookup> {
  const result = await db.query(
    `SELECT to_char(rate_date, 'YYYY-MM-DD') AS rate_date, rate
       FROM exchange_rates
      WHERE base_currency = $1 AND quote_currency = $2 AND rate_date <= $3
      ORDER BY rate_date DESC
      LIMIT 1`,
    [query.baseCurrency, query.quoteCurrency, query.on],
  );

  const row = result.rows[0];
  if (!row) return { found: false };
  return { found: true, rate: Number(row.rate), rateDate: row.rate_date as string };
}
