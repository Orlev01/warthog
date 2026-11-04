// E03-S07 — Currency conversion (`src/domain/currency/convert.ts`).
//
// RED-first: the module does not exist yet, so importing it fails and every test
// below fails. That is intentional — the implementation is written afterwards to
// make these pass. Do NOT add the module to turn these green; the builder does
// that. The tests pin BEHAVIOUR (the amounts and rate date a conversion returns,
// the refuse result a missing/unusable rate returns), never the source text of
// the module, so a later rename that keeps behaviour leaves them untouched.
//
// This is a pure domain module (conventions: `src/domain/**` has no React, no DB,
// no fetch, no process.env, no Date.now — and here, no network). Foreign-currency
// card requests are converted for the rule checks in deterministic code (design
// §8 step 4: "currency converted with the latest daily ECB reference rate
// (Frankfurter, free) — no rate → deny"; brief "Currency": "a card request in
// another currency is converted for the rule checks using the latest daily
// reference exchange rate … the approval shows both amounts and the rate's date,
// and if no rate is available the request is refused with a plain reason"). The
// fetching lives behind the server's exchange-rate seam (design §12); THIS module
// is the pure arithmetic over a rate that is INJECTED (the AC's "injected daily
// rate"), so it never touches the network.
//
// ---------------------------------------------------------------------------
// THE PINNED CONTRACT (chosen by the tester; the implementation conforms to it).
//
// A reference rate is about one currency pair on one calendar day: one unit of
// `from` is worth `rate` units of `to`, as published on `date` (an ISO calendar
// date, YYYY-MM-DD — the shape a daily ECB/Frankfurter rate carries). `convert`
// takes a plain `amount` (a number in the `from` currency, the same loose numeric
// amount the rules/budget modules use) and the injected rate, and returns a
// discriminated result:
//
//   interface Money { amount: number; currency: string; }   // major-unit number + ISO code
//
//   interface ReferenceRate { from: string; to: string; rate: number; date: string; }
//
//   type ConversionResult =
//     | { ok: true; original: Money; converted: Money; rate: number; rateDate: string }
//     | { ok: false; reason: string };
//
//   // convert(amount, rate): convert `amount` (expressed in rate.from) into
//   // rate.to using the injected daily reference rate. On success it carries BOTH
//   // amounts — the original (in rate.from) and the converted (in rate.to) — plus
//   // the rate's date. A MISSING rate (null / undefined) or an UNUSABLE one (a
//   // `rate` that is not a positive, finite number) REFUSES with a plain reason;
//   // it never returns a silent 0 or NaN amount.
//   function convert(amount: number, rate: ReferenceRate | null | undefined): ConversionResult;
//
// Why refuse on a rate that is 0 / NaN / Infinity / negative as well as on
// null/undefined: the AC says a missing rate "never [yields] a silent 0 or NaN".
// A rate of 0 would silently convert to 0; a rate of NaN/Infinity would silently
// convert to NaN/Infinity; a negative rate a silently wrong figure. The only rate
// that yields a meaningful conversion is a positive finite number, so anything
// else is "no usable rate" → refuse. (A 0 *input amount* is different — 0 of a
// currency legitimately converts to 0, so that stays `ok: true`; the guard is on
// the RATE, not the amount.)
//
// Assertions are tolerant where representation could reasonably vary: converted
// amounts are compared with a tiny epsilon (so full precision or cents-rounding
// both pass for the clean products chosen here), and the rate date through a
// helper that accepts the echoed string or a Date for the same day. The refusal
// reason is asserted only to be a non-empty string, never its exact wording.

import { test } from "node:test";
import assert from "node:assert/strict";

import { convert } from "./convert";

// ---------------------------------------------------------------------------
// Tolerant helpers — compare the value, not the representation.
// ---------------------------------------------------------------------------

/** Clean products are exact; the epsilon only guards float noise / cents rounding. */
const approx = (a: number, b: number, eps = 1e-9): boolean =>
  Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= eps;

/** Normalise a rate date (an echoed "YYYY-MM-DD" string, or a Date for that day). */
const asDateStr = (v: unknown): string => {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "string") return v.length >= 10 ? v.slice(0, 10) : v;
  return String(v);
};

type Rate = { from: string; to: string; rate: number; date: string };

/** A valid daily reference rate: 1 USD = 1.5 AUD, published 2026-03-15. */
const makeRate = (over: Partial<Rate> = {}): Rate => ({
  from: "USD",
  to: "AUD",
  rate: 1.5,
  date: "2026-03-15",
  ...over,
});

// ===========================================================================
// AC1 — converts an amount with an injected daily rate and returns BOTH amounts
// and the rate date.
// ===========================================================================

test("convert returns both amounts and the rate date for a valid rate", () => {
  const r = convert(50, makeRate());
  assert.equal(r.ok, true, "a valid injected rate produces a successful conversion");
  if (!r.ok) return; // narrow to the success variant (unreachable after the assert above)

  // The ORIGINAL amount, in the rate's source currency.
  assert.equal(r.original.amount, 50, "the original amount is echoed back");
  assert.equal(r.original.currency, "USD", "the original is labelled with the rate's `from` currency");

  // The CONVERTED amount, in the rate's target currency.
  assert.ok(approx(r.converted.amount, 75), "50 USD at 1.5 converts to 75 AUD");
  assert.equal(r.converted.currency, "AUD", "the converted amount is labelled with the rate's `to` currency");

  // The rate's date, so the approval can show it.
  assert.equal(asDateStr(r.rateDate), "2026-03-15", "the result carries the rate's date");
});

test("convert multiplies the amount by the rate for a different pair", () => {
  // 100 GBP at 0.5 → 50 EUR, published a different day.
  const r = convert(100, makeRate({ from: "GBP", to: "EUR", rate: 0.5, date: "2026-06-01" }));
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.original.amount, 100, "the original amount is unchanged");
  assert.equal(r.original.currency, "GBP", "original currency follows the rate's `from`");
  assert.ok(approx(r.converted.amount, 50), "100 GBP at 0.5 converts to 50 EUR");
  assert.equal(r.converted.currency, "EUR", "converted currency follows the rate's `to`");
  assert.equal(asDateStr(r.rateDate), "2026-06-01", "the result carries this rate's own date");
});

test("convert produces a finite converted amount, never NaN, for a valid rate", () => {
  const r = convert(200, makeRate({ rate: 1.25 }));
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(Number.isFinite(r.converted.amount), true, "the converted amount is a finite number");
  assert.ok(approx(r.converted.amount, 250), "200 at 1.25 converts to 250");
});

test("convert of a zero amount with a valid rate is a legitimate 0, not a refusal", () => {
  // The guard is on the RATE, not the amount: 0 of a currency is genuinely 0 of
  // another, so this stays a successful conversion — the forbidden "silent 0" is
  // the one a MISSING rate would produce (see the refuse tests below).
  const r = convert(0, makeRate());
  assert.equal(r.ok, true, "a zero input amount still converts (the rate is valid)");
  if (!r.ok) return;
  assert.ok(approx(r.converted.amount, 0), "0 USD converts to 0 AUD");
  assert.equal(r.converted.currency, "AUD", "the target currency is still reported");
});

test("convert is deterministic and does not mutate the injected rate", () => {
  const rate = makeRate();
  const snapshot = { ...rate };
  const a = convert(50, rate);
  const b = convert(50, rate);
  assert.deepEqual(rate, snapshot, "the injected rate object is left untouched");
  assert.deepEqual(a, b, "the same inputs give the same result");
});

// ===========================================================================
// AC2 — a missing rate yields a refuse result, never a silent 0 or NaN.
// ===========================================================================

test("convert refuses when the rate is null, rather than converting", () => {
  const r = convert(50, null);
  // The whole guarantee: a missing rate NEVER comes back as a successful
  // conversion (which is the only way a silent 0 or NaN could reach the caller).
  assert.equal(r.ok, false, "a null rate refuses");
  if (r.ok) return; // narrow to the refuse variant
  assert.equal(typeof r.reason, "string", "the refusal carries a reason");
  assert.ok(r.reason.trim().length > 0, "the reason is a non-empty, plain string");
});

test("convert refuses when the rate is undefined", () => {
  const r = convert(50, undefined);
  assert.equal(r.ok, false, "an undefined rate refuses");
  if (r.ok) return;
  assert.ok(r.reason.trim().length > 0, "the refusal carries a plain reason");
});

test("convert refuses a zero rate rather than converting to a silent 0", () => {
  // The AC names this exactly: no "silent 0". A rate of 0 would convert every
  // amount to 0, so it is treated as no usable rate.
  const r = convert(50, makeRate({ rate: 0 }));
  assert.equal(r.ok, false, "a zero rate refuses instead of yielding a silent 0");
  if (r.ok) return;
  assert.ok(r.reason.trim().length > 0, "the refusal carries a plain reason");
});

test("convert refuses a NaN rate rather than converting to a silent NaN", () => {
  // The AC names this exactly: no "silent … NaN".
  const r = convert(50, makeRate({ rate: Number.NaN }));
  assert.equal(r.ok, false, "a NaN rate refuses instead of yielding a silent NaN");
  if (r.ok) return;
  assert.ok(r.reason.trim().length > 0, "the refusal carries a plain reason");
});

test("convert refuses a non-finite (Infinity) rate", () => {
  const r = convert(50, makeRate({ rate: Number.POSITIVE_INFINITY }));
  assert.equal(r.ok, false, "an infinite rate is not a usable rate");
  if (r.ok) return;
  assert.ok(r.reason.trim().length > 0, "the refusal carries a plain reason");
});

test("convert refuses a negative rate", () => {
  const r = convert(50, makeRate({ rate: -1.5 }));
  assert.equal(r.ok, false, "a negative rate is not a usable rate");
  if (r.ok) return;
  assert.ok(r.reason.trim().length > 0, "the refusal carries a plain reason");
});
