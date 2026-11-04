// E03-S07 — Currency conversion (design §8 step 4: "currency converted with the
// latest daily ECB reference rate (Frankfurter, free) — no rate → deny"; brief
// "Currency": a foreign-currency card request is converted for the rule checks
// using the latest daily reference rate, the approval shows both amounts and the
// rate's date, and if no rate is available the request is refused).
//
// Pure domain module: no React, no DB, no fetch, no process.env, no Date.now, no
// network. The fetching of daily reference rates lives behind the server's
// exchange-rate seam (design §12); THIS module is only the deterministic
// arithmetic over a rate that is INJECTED by the caller.

/** A money amount: a major-unit number labelled with its ISO currency code. */
export interface Money {
  amount: number;
  currency: string;
}

/**
 * A daily reference rate for one currency pair on one calendar day: one unit of
 * `from` is worth `rate` units of `to`, as published on `date` (ISO YYYY-MM-DD).
 */
export interface ReferenceRate {
  from: string;
  to: string;
  rate: number;
  date: string;
}

/**
 * The result of a conversion: either a successful conversion carrying both
 * amounts and the rate's date, or a refusal with a plain reason.
 */
export type ConversionResult =
  | { ok: true; original: Money; converted: Money; rate: number; rateDate: string }
  | { ok: false; reason: string };

/**
 * Convert `amount` (expressed in `rate.from`) into `rate.to` using the injected
 * daily reference rate. On success it carries BOTH amounts — the original and the
 * converted — plus the rate's date. A missing rate (null/undefined) or an
 * unusable one (a `rate` that is not a positive, finite number) refuses with a
 * plain reason rather than returning a silent 0 or NaN.
 */
export function convert(
  amount: number,
  rate: ReferenceRate | null | undefined,
): ConversionResult {
  if (rate == null) {
    return { ok: false, reason: "No reference rate available to convert this amount." };
  }

  if (!Number.isFinite(rate.rate) || rate.rate <= 0) {
    return { ok: false, reason: "No usable reference rate available to convert this amount." };
  }

  return {
    ok: true,
    original: { amount, currency: rate.from },
    converted: { amount: amount * rate.rate, currency: rate.to },
    rate: rate.rate,
    rateDate: rate.date,
  };
}
