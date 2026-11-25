// Turning an agent's or form's fields into a record type's own (`./normalise.ts`).

import { test } from "node:test";
import assert from "node:assert/strict";

import { calendarDate, canonicalDateTime, cycleOf, fieldKey, identityAlternatives, isoDuration, monthYear, normaliseFields, plainAmount, plainNumber, recordDisplayName, storedRecordName, yesNo } from "./normalise";
import { BUILT_IN } from "./catalogue";

const agent = { fromAgent: true };
const person = { fromAgent: false };
const type = (id: string) => BUILT_IN.type(id)!;

test("aliases fold into the type's own fields", () => {
  const { fields, problems } = normaliseFields(
    type("vehicles.insurance"),
    { insurer: "AAMI", policy_number: "MPA-2045", premium: "$1,250.50", frequency: "annually", currency: "aud" },
    true,
    agent,
  );
  assert.deepEqual(fields, { provider: "AAMI", reference: "MPA-2045", amount: "1250.50", cycle: "yearly", currency: "AUD" });
  assert.deepEqual(problems, []);
});

test("an alias never replaces a field the type has under that name", () => {
  const { fields } = normaliseFields(type("utilities.energy"), { service: "electricity", retailer: "AGL" }, true, agent);
  assert.deepEqual(fields, { service: "electricity", provider: "AGL" });
});

test("a due date given as a field becomes the due date when none was given", () => {
  const lifted = normaliseFields(type("vehicles.registration"), { plate: "BX12AB", expiry: "2026-12-14" }, false, agent);
  assert.equal(lifted.dueDate, "2026-12-14");
  assert.deepEqual(lifted.fields, { plate: "BX12AB" });
  const kept = normaliseFields(type("vehicles.registration"), { plate: "BX12AB", expiry: "2026-12-14" }, true, agent);
  assert.equal(kept.dueDate, null);
  assert.equal(kept.fields.expiry, "2026-12-14");
});

test("bad values are left out with a plain note", () => {
  const { fields, problems } = normaliseFields(
    type("belongings.receipt"),
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
    type("subscriptions.service"),
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
  const { fields } = normaliseFields(type("subscriptions.service"), { how_to_cancel: "https://netflix.com/cancelplan" }, true, person);
  assert.equal(fields.how_to_cancel, "https://netflix.com/cancelplan");
});

test("last4 fields keep only the last four characters", () => {
  const { fields, problems } = normaliseFields(type("banking.account"), { provider: "CBA", last4: "06 2000 1234 5678" }, true, agent);
  assert.equal(fields.last4, "5678");
  assert.equal(problems.length, 1);
});

test("unknown fields are kept as extras, within limits", () => {
  const raw = Object.fromEntries(Array.from({ length: 25 }, (_, index) => [`extra_${index}`, "x"]));
  const { fields, problems } = normaliseFields(type("other.item"), { ...raw, name: "Thing" }, true, agent);
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

test("display names and identity alternatives", () => {
  const rego = type("vehicles.registration");
  assert.equal(recordDisplayName(rego, {}), "Registration");
  assert.equal(recordDisplayName(type("subscriptions.service"), { provider: "Netflix" }), "Netflix");
  assert.equal(storedRecordName(rego, { plate: "BX12AB", provider: "Service NSW" }), "Registration · BX12AB", "a rego goes by its plate");
  assert.equal(storedRecordName(type("vehicles.insurance"), { provider: "AAMI" }), "AAMI");
  assert.equal(storedRecordName(type("subscriptions.service"), { amount: "12" }, false), "12", "an older record goes by its first value");
  assert.deepEqual(identityAlternatives(rego, { plate: "BX 12-AB" }, "p1").map((a) => a.values), [["bx12ab"], ["p1"]]);
  assert.deepEqual(identityAlternatives(rego, {}, null), []);
  assert.deepEqual(identityAlternatives(type("id.medicare"), {}, null), [{ keys: [], values: [] }]);
  assert.deepEqual(identityAlternatives(type("other.reminder"), { name: "x" }, null), []);
  const dinner = type("outings.restaurant");
  assert.deepEqual(identityAlternatives(dinner, { provider: "Bistro", starts_at: "2026-12-03T19:30+11:00[Australia/Sydney]" }, null).map((a) => a.values), [["bistro", "20261203"]], "provider + start date when there's no reference");
  assert.equal(identityAlternatives(dinner, { provider: "Bistro", reference: "R1", starts_at: "2026-12-03" }, null).length, 2);
  const account = type("banking.account");
  assert.deepEqual(identityAlternatives(account, { provider: "Westpac", name: "Westpac eSaver" }, null), [{ keys: ["provider", "name"], values: ["westpac", "westpacesaver"] }], "no last 4: the bank and name");
  assert.deepEqual(identityAlternatives(account, { provider: "Westpac", name: "Westpac Choice", last4: "2902" }, null).map((a) => a.keys), [["provider", "last4"]], "the fallback only stands in for a missing last 4");
  assert.deepEqual(identityAlternatives(account, { name: "Some account" }, null), []);
});

test("new field kinds are kept in canonical form", () => {
  assert.deepEqual(canonicalDateTime("2026-12-03T19:30[Australia/Sydney]", "UTC"), { value: "2026-12-03T19:30+11:00[Australia/Sydney]", assumedZone: false });
  assert.deepEqual(canonicalDateTime("2026-12-03 19:30", "Australia/Sydney"), { value: "2026-12-03T19:30+11:00[Australia/Sydney]", assumedZone: true });
  // An instant with an offset but no zone keeps its offset (pages show it in the person's zone).
  assert.deepEqual(canonicalDateTime("2026-12-03T08:30:00Z", "Australia/Sydney"), { value: "2026-12-03T08:30+00:00", assumedZone: false });
  assert.deepEqual(canonicalDateTime("2026-12-03T19:30+11:00", "Australia/Sydney"), { value: "2026-12-03T19:30+11:00[Australia/Sydney]", assumedZone: false });
  assert.deepEqual(canonicalDateTime("2026-12-03", "Australia/Sydney"), { value: "2026-12-03", assumedZone: false });
  assert.equal(canonicalDateTime("2026-12-03T19:30[Mars/Olympus]", "UTC"), null);
  assert.equal(monthYear("03/27"), "2027-03");
  assert.equal(monthYear("March 2027"), "2027-03");
  assert.equal(monthYear("13/27"), null);
  assert.equal(plainNumber("6 people"), "6");
  assert.equal(plainNumber("45,000 km"), "45000");
  assert.equal(yesNo("True"), "yes");
  assert.equal(isoDuration("1h30m"), "PT1H30M");
  assert.equal(isoDuration("12 months"), "P12M");
  assert.equal(isoDuration("PT45M"), "PT45M");
});

test("a booking's fields: aliases, zones, people and details", () => {
  const { fields, problems } = normaliseFields(
    type("outings.restaurant"),
    { restaurant: "Bistro", confirmation_number: "R-77", start: "2026-12-03 19:30", guests: "6 people", card_held: true, for: "Mum" },
    false,
    { fromAgent: true, zone: "Australia/Sydney" },
    [{ label: "Dress code", value: "Smart casual" }],
  );
  assert.deepEqual(fields, { provider: "Bistro", reference: "R-77", starts_at: "2026-12-03T19:30+11:00[Australia/Sydney]", party_size: "6", card_held: "yes", for_whom: "Mum", dress_code: "Smart casual" });
  assert.ok(problems.some((p) => p.includes("Australia/Sydney")), "an assumed zone is noted");
  const refused = normaliseFields(type("outings.restaurant"), { for: "mum@example.com" }, false, { fromAgent: true });
  assert.deepEqual(refused.fields, {});
});

test("a policy, account or member number an agent saves is kept as written, even when it looks like a card", () => {
  const policy = normaliseFields(type("vehicles.insurance"), { provider: "QBE", reference: "3601079013498" }, false, agent);
  assert.equal(policy.fields.reference, "3601079013498");
  assert.deepEqual(policy.problems, []);
  // A card number in free text is still cut to its last four.
  const notes = normaliseFields(type("vehicles.insurance"), { provider: "QBE", notes: "Paid with 4111 1111 1111 1111" }, false, agent);
  assert.equal(notes.fields.notes, "Paid with ••••1111");
  // And on a card record, a full number in its reference is cut too.
  const card = normaliseFields(type("banking.card"), { provider: "NAB", reference: "4111111111111111" }, false, agent);
  assert.equal(card.fields.reference, "••••1111");
});
