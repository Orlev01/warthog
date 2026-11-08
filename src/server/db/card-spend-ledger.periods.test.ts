// Review fix W4.3 — budget periods in the person's own time zone
// (`periodKeyFor` in src/server/db/card-spend-ledger.ts).
//
// The ledger's day / week / month bucket keys used to come from UTC calendar arithmetic,
// so for a person in Sydney a daily budget reset at 10 or 11 in the morning and a
// purchase at 8am on 1 December counted toward November (review medium: "Budget periods
// and displayed times use UTC, not the person's time zone"). The brief serves people in
// their own time zone (preferences.time_zone), defaulting to Sydney.
//
// These tests pin what periodKeyFor RETURNS for an instant and an IANA zone: the zone's
// own calendar day, ISO week and month, the Sydney default when no zone is given, and a
// loud refusal of a zone that is not a real IANA name (the caller resolves a saved
// preference to a valid zone first; the key function never guesses).

import { test } from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_TIME_ZONE, periodKeyFor } from "./card-spend-ledger";

const SYDNEY = "Australia/Sydney";

test("the default zone is Sydney", () => {
  assert.equal(DEFAULT_TIME_ZONE, SYDNEY);
});

test("8am on 1 December in Sydney is December, not November (the review's repro)", () => {
  // 2026-11-30T21:00Z is 1 Dec 08:00 AEDT (UTC+11).
  const at = new Date("2026-11-30T21:00:00.000Z");
  assert.equal(periodKeyFor("month", at, SYDNEY), "2026-12");
  assert.equal(periodKeyFor("day", at, SYDNEY), "2026-12-01");
  assert.equal(periodKeyFor("week", at, SYDNEY), "2026-W49");
});

test("with no zone the key is the Sydney one (the product default)", () => {
  const at = new Date("2026-11-30T21:00:00.000Z");
  assert.equal(periodKeyFor("month", at), "2026-12");
  assert.equal(periodKeyFor("day", at), "2026-12-01");
});

test("UTC remains available explicitly", () => {
  const at = new Date("2026-11-30T21:00:00.000Z");
  assert.equal(periodKeyFor("month", at, "UTC"), "2026-11");
  assert.equal(periodKeyFor("day", at, "UTC"), "2026-11-30");
  assert.equal(periodKeyFor("week", at, "UTC"), "2026-W49");
});

test("a zone behind UTC buckets into its own (earlier) day and month", () => {
  // 2026-12-01T05:00Z is 30 Nov 21:00 in Los Angeles (UTC-8).
  const at = new Date("2026-12-01T05:00:00.000Z");
  assert.equal(periodKeyFor("day", at, "America/Los_Angeles"), "2026-11-30");
  assert.equal(periodKeyFor("month", at, "America/Los_Angeles"), "2026-11");
});

test("the week rolls over at local Monday midnight, not UTC's", () => {
  // Sunday 29 Nov 14:00Z is Monday 30 Nov 01:00 in Sydney: a new ISO week there.
  const at = new Date("2026-11-29T14:00:00.000Z");
  assert.equal(periodKeyFor("week", at, "UTC"), "2026-W48");
  assert.equal(periodKeyFor("week", at, SYDNEY), "2026-W49");
});

test("Sydney's daylight-saving change moves midnight with it", () => {
  // Before 4 Oct 2026 Sydney is UTC+10, so local midnight on 4 Oct is 3 Oct 14:00Z.
  assert.equal(periodKeyFor("day", new Date("2026-10-03T13:59:00.000Z"), SYDNEY), "2026-10-03");
  assert.equal(periodKeyFor("day", new Date("2026-10-03T14:00:00.000Z"), SYDNEY), "2026-10-04");
  // After it Sydney is UTC+11, so local midnight on 5 Oct is 4 Oct 13:00Z.
  assert.equal(periodKeyFor("day", new Date("2026-10-04T12:59:00.000Z"), SYDNEY), "2026-10-04");
  assert.equal(periodKeyFor("day", new Date("2026-10-04T13:00:00.000Z"), SYDNEY), "2026-10-05");
});

test("New Year in Sydney starts the new month while the ISO week still belongs to the old year", () => {
  // 31 Dec 14:00Z is 1 Jan 2027 01:00 AEDT, a Friday in ISO week 2026-W53.
  const at = new Date("2026-12-31T14:00:00.000Z");
  assert.equal(periodKeyFor("month", at, SYDNEY), "2027-01");
  assert.equal(periodKeyFor("day", at, SYDNEY), "2027-01-01");
  assert.equal(periodKeyFor("week", at, SYDNEY), "2026-W53");
  assert.equal(periodKeyFor("month", at, "UTC"), "2026-12");
});

test("a zone that is not a real IANA name is refused, never guessed", () => {
  const at = new Date("2026-11-15T12:00:00.000Z");
  assert.throws(() => periodKeyFor("day", at, "Sydney"), RangeError);
  assert.throws(() => periodKeyFor("day", at, ""), RangeError);
});
