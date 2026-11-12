// UI/UX pass (content-22, desktop-12) — a life-admin record's stored values read as plain,
// labelled, formatted facts: no storage keys, ISO dates or status codes on screen.

import { test } from "node:test";
import assert from "node:assert/strict";

import { dueLine, fieldLabel, formatCalendarDate, recordFacts, statusLabel } from "./record-format";

test("known field keys get plain labels and unknown keys are tidied, never shown raw", () => {
  assert.equal(fieldLabel("amount"), "Cost");
  assert.equal(fieldLabel("cycle"), "Billing cycle");
  assert.equal(fieldLabel("how_to_cancel"), "How to cancel");
  assert.equal(fieldLabel("return_by"), "Return by");
  assert.equal(fieldLabel("warranty_end"), "Warranty ends");
  assert.equal(fieldLabel("loyaltyNumber"), "Loyalty number");
  assert.equal(fieldLabel("plan-tier"), "Plan tier");
  // A person's own label keeps its wording.
  assert.equal(fieldLabel("Monthly cost"), "Monthly cost");
});

test("calendar dates read as '1 Dec 2026'; anything else is left as written", () => {
  assert.equal(formatCalendarDate("2026-12-01"), "1 Dec 2026");
  assert.equal(formatCalendarDate("2029-11-30T00:00:00.000Z"), "30 Nov 2029");
  assert.equal(formatCalendarDate("2026-02-31"), "2026-02-31", "an impossible date is not reinterpreted");
  assert.equal(formatCalendarDate("next Tuesday"), "next Tuesday");
});

test("a status code reads as a word, and the due line joins it to the formatted date", () => {
  assert.equal(statusLabel("active"), "Active");
  assert.equal(statusLabel("canceled"), "Cancelled");
  assert.equal(statusLabel("awaiting_refund"), "Awaiting refund");
  assert.equal(dueLine("2026-12-01", "active"), "Due 1 Dec 2026 · Active");
  assert.equal(dueLine(null, "paused"), "Paused");
});

test("an amount with its currency and cycle reads as one Cost line; the other fields follow, labelled", () => {
  const facts = recordFacts(
    { name: "Netflix Premium", amount: "25.99", currency: "aud", cycle: "monthly", how_to_cancel: "Account › Membership", renews_on: "2026-12-01" },
    "name",
  );
  assert.deepEqual(
    facts.map((fact) => [fact.label, fact.value]),
    [
      ["Cost", "AUD 25.99 a month"],
      ["How to cancel", "Account › Membership"],
      ["Renews", "1 Dec 2026"],
    ],
  );
});

test("a cost the person wrote with its own symbol, or an unknown cycle, is kept as written", () => {
  assert.deepEqual(
    recordFacts({ Service: "Spotlight", "Monthly cost": "A$18.50" }, "Service").map((f) => [f.label, f.value]),
    [["Monthly cost", "A$18.50"]],
  );
  assert.deepEqual(
    recordFacts({ amount: "120", cycle: "every 6 weeks" }, null).map((f) => [f.label, f.value]),
    [
      ["Cost", "120.00"],
      ["Billing cycle", "Every 6 weeks"],
    ],
  );
});

test("the title field and empty values are left out of the facts", () => {
  assert.deepEqual(recordFacts({ name: "Gym", notes: "", where: "Bondi" }, "name").map((f) => f.key), ["where"]);
});
