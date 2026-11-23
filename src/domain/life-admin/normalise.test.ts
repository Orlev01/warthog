// Turning an agent's or form's fields into a record type's own (`./normalise.ts`).

import { test } from "node:test";
import assert from "node:assert/strict";

import { calendarDate, cycleOf, fieldKey, identityParts, normaliseFields, plainAmount, recordDisplayName } from "./normalise";
import { recordType } from "./record-types";

const agent = { fromAgent: true };
const person = { fromAgent: false };
const type = (id: string) => recordType(id)!;

test("aliases fold into the type's own fields", () => {
  const { fields, problems } = normaliseFields(
    type("vehicle.insurance"),
    { insurer: "AAMI", policy_number: "MPA-2045", premium: "$1,250.50", frequency: "annually", currency: "aud" },
    true,
    agent,
  );
  assert.deepEqual(fields, { provider: "AAMI", reference: "MPA-2045", amount: "1250.50", cycle: "yearly", currency: "AUD" });
  assert.deepEqual(problems, []);
});

test("an alias never replaces a field the type has under that name", () => {
  const { fields } = normaliseFields(type("utility.energy"), { service: "electricity", retailer: "AGL" }, true, agent);
  assert.deepEqual(fields, { service: "electricity", provider: "AGL" });
});

test("a due date given as a field becomes the due date when none was given", () => {
  const lifted = normaliseFields(type("vehicle.registration"), { plate: "BX12AB", expiry: "2026-12-14" }, false, agent);
  assert.equal(lifted.dueDate, "2026-12-14");
  assert.deepEqual(lifted.fields, { plate: "BX12AB" });
  const kept = normaliseFields(type("vehicle.registration"), { plate: "BX12AB", expiry: "2026-12-14" }, true, agent);
  assert.equal(kept.dueDate, null);
  assert.equal(kept.fields.expiry, "2026-12-14");
});

test("bad values are left out with a plain note", () => {
  const { fields, problems } = normaliseFields(
    type("purchase.receipt"),
    { item: "TV", purchased_on: "last Tuesday", amount: "about fifty", currency: "dollars", nested: { a: 1 } },
    true,
    agent,
  );
  assert.deepEqual(fields, { item: "TV" });
  assert.equal(problems.length, 4);
  assert.ok(problems.every((problem) => problem.startsWith("Left out")));
});

test("from an agent, links become site names and card numbers are masked", () => {
  const { fields, problems } = normaliseFields(
    type("subscription.service"),
    { name: "Netflix", how_to_cancel: "Go to https://netflix.com/cancelplan", paid_with: "4242 4242 4242 4242", website: "https://www.netflix.com/au/" },
    true,
    agent,
  );
  assert.equal(fields.how_to_cancel, "Go to netflix.com");
  assert.equal(fields.paid_with, "••••4242");
  assert.equal(fields.website, "netflix.com");
  assert.ok(problems.some((problem) => problem.startsWith("Links")));
  assert.ok(problems.some((problem) => problem.startsWith("Card numbers")));
});

test("from the person, text is kept as typed", () => {
  const { fields } = normaliseFields(type("subscription.service"), { how_to_cancel: "https://netflix.com/cancelplan" }, true, person);
  assert.equal(fields.how_to_cancel, "https://netflix.com/cancelplan");
});

test("last4 fields keep only the last four characters", () => {
  const { fields, problems } = normaliseFields(type("money.bank_account"), { provider: "CBA", last4: "06 2000 1234 5678" }, true, agent);
  assert.equal(fields.last4, "5678");
  assert.equal(problems.length, 1);
});

test("unknown fields are kept as extras, within limits", () => {
  const raw = Object.fromEntries(Array.from({ length: 25 }, (_, index) => [`extra_${index}`, "x"]));
  const { fields, problems } = normaliseFields(type("general.other"), { ...raw, name: "Thing" }, true, agent);
  assert.equal(fields.name, "Thing");
  assert.equal(Object.keys(fields).length, 21);
  assert.equal(problems.length, 5);
});

test("helpers", () => {
  assert.equal(fieldKey("Policy Number"), "policy_number");
  assert.equal(fieldKey("renewsOn"), "renews_on");
  assert.equal(calendarDate("2026-02-29"), null);
  assert.equal(calendarDate("2026-12-14T00:00:00Z"), "2026-12-14");
  assert.equal(plainAmount("AUD 25.99"), "25.99");
  assert.equal(plainAmount("A$18.50"), "18.50");
  assert.equal(plainAmount("abc123"), null);
  assert.equal(cycleOf("Annual"), "yearly");
  assert.equal(cycleOf("sometimes"), null);
});

test("display names and identity", () => {
  const rego = type("vehicle.registration");
  assert.equal(recordDisplayName(rego, {}), "Registration");
  assert.equal(recordDisplayName(type("subscription.service"), { provider: "Netflix" }), "Netflix");
  assert.deepEqual(identityParts(rego, { plate: "BX 12-AB" }, null), ["bx12ab"]);
  assert.equal(identityParts(rego, {}, null), null);
  assert.deepEqual(identityParts(type("vehicle.service"), {}, "parent-id"), ["parentid"]);
  assert.deepEqual(identityParts(type("id.medicare"), {}, null), []);
  assert.equal(identityParts(type("general.reminder"), { name: "x" }, null), null);
  assert.deepEqual(identityParts(type("subscription.service"), { name: "Netflix" }, null), ["netflix"]);
  assert.equal(identityParts(type("subscription.service"), {}, null), null);
});
