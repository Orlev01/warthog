// What recurring records cost a month (./costs.ts): the figure agents get from list_records and
// the Records tab shows, worked out once by Warthog.

import { test } from "node:test";
import assert from "node:assert/strict";

import { monthlyCost } from "./costs";

test("recurring amounts become a monthly figure per currency; one-offs and records without an amount don't count", () => {
  const totals = monthlyCost([
    { fields: { amount: "148.25", currency: "AUD", cycle: "monthly" } },
    { fields: { amount: 21, currency: "AUD", cycle: "weekly" } },
    { fields: { amount: "42.99", currency: "AUD", cycle: "yearly" } },
    { fields: { amount: "16", currency: "USD", cycle: "monthly" } },
    { fields: { amount: "1578.70", currency: "AUD", cycle: "one_off" } },
    { fields: { amount: "12", currency: "AUD" } },
    { fields: { provider: "Hostplus" } },
    { fields: { amount: "not a number", currency: "AUD", cycle: "monthly" } },
  ]);
  assert.deepEqual(totals, [
    { currency: "AUD", amount: 242.83, records: 3 },
    { currency: "USD", amount: 16, records: 1 },
  ]);
});

test("a record with no currency counts as AUD, and an unknown cycle doesn't count", () => {
  assert.deepEqual(monthlyCost([{ fields: { amount: "30", cycle: "quarterly" } }, { fields: { amount: "5", cycle: "every so often" } }]), [
    { currency: "AUD", amount: 10, records: 1 },
  ]);
  assert.deepEqual(monthlyCost([]), []);
});
