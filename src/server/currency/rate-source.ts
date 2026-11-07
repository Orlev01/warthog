// The daily-reference-rate SOURCE seam (task E15-S03; design §8 step 4 + §12).
//
// The rate store is fed by a FREE official daily-reference source (Frankfurter / ECB
// reference rates — "no paid tier, no plan that bills" per constitution rule 11),
// reached behind the `RateSource` interface so tests never touch the network (a dev/test
// FAKE returns fixed rates) and the real source is driven by an INJECTED `fetch`. The
// provider's base URL comes from CONFIGURATION (`config.exchangeRateBaseUrl`, read from
// `EXCHANGE_RATE_BASE_URL`), never a literal in source (AC2; INV-103 / constitution rule
// 21). The source is unauthenticated — the provider is free — so it carries NO secret:
// no Authorization / api-key header, and it reads no `process.env` (it is built purely
// from its injected deps, so no ambient value can ride the request — AC5 / INV-103).
//
// A network error, a non-OK HTTP status, or a malformed / invalid body is REPORTED by a
// rejection, never swallowed into a bogus set (AC3): the policy engine must refuse a
// conversion when no real rate is available rather than convert against a silent empty
// or garbage set.

import { z } from "zod";

// A day's reference rates: the day the set is for (ISO "YYYY-MM-DD"), the base currency
// (the "1 unit of" currency, ISO 4217) and a map of quote code -> rate (units of quote
// per 1 unit of base — direction matters).
export interface DailyRates {
  readonly rateDate: string;
  readonly baseCurrency: string;
  readonly rates: Readonly<Record<string, number>>;
}

// A source of the day's reference rates. `fetchDailyRates` REJECTS (reports, never
// swallows) on a network error, a non-OK HTTP status, or a malformed / invalid body.
export interface RateSource {
  fetchDailyRates(): Promise<DailyRates>;
}

// The dev/test fake: resolves to a fixed set with NO network call, so tests and local
// dev run the rates job without reaching the provider.
export function fakeRateSource(fixed: DailyRates): RateSource {
  return {
    fetchDailyRates() {
      return Promise.resolve(fixed);
    },
  };
}

// What the real source needs: the provider base URL (from config) and the `fetch` to use
// (the SSRF-guarded fetch in production; a recording stand-in in tests). No api key — the
// provider is free and unauthenticated.
export interface FrankfurterRateSourceDeps {
  readonly baseUrl: string;
  readonly fetchImpl: typeof fetch;
}

// The upstream daily-rate payload (what the free official source returns): a base
// currency, the date the set is for, and a map of quote code -> rate. `amount` is present
// upstream (rates are per `amount` units of base, always 1 here) but not needed here, so
// it is ignored. A body missing `base` / `date` / `rates` fails this parse and is
// reported as a failure (AC3), never parsed into a bogus set.
const upstreamPayloadSchema = z.object({
  base: z.string(),
  date: z.string(),
  rates: z.record(z.string(), z.number()),
});

// The real source: fetch the day's rates from the free official provider whose base URL
// is injected (from `config.exchangeRateBaseUrl`), rooted at that base URL so swapping
// the configured value moves the dialed URL with it (no baked-in host). No secret rides
// the request.
export function createFrankfurterRateSource(deps: FrankfurterRateSourceDeps): RateSource {
  // Root the day's-rates endpoint at the configured base URL (trailing slashes trimmed so
  // a base URL with or without one dials the same place).
  const root = deps.baseUrl.replace(/\/+$/, "");
  const url = `${root}/latest`;

  return {
    async fetchDailyRates(): Promise<DailyRates> {
      // A network error here rejects the promise; we do not catch it, so the failure is
      // reported out of `fetchDailyRates` (AC3).
      const response = await deps.fetchImpl(url, { headers: { accept: "application/json" } });
      if (!response.ok) {
        throw new Error(`Exchange-rate source returned HTTP ${response.status}`);
      }

      // A non-JSON body makes `.json()` throw; that rejection propagates (reported).
      const body: unknown = await response.json();

      const parsed = upstreamPayloadSchema.safeParse(body);
      if (!parsed.success) {
        throw new Error("Exchange-rate source returned a malformed daily-rate payload");
      }

      return {
        rateDate: parsed.data.date,
        baseCurrency: parsed.data.base,
        rates: parsed.data.rates,
      };
    },
  };
}
