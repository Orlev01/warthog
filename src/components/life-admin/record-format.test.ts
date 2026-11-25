// UI/UX pass (content-22, desktop-12) — a life-admin record's stored values read as plain,
// labelled, formatted facts: no storage keys, ISO dates or status codes on screen.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  BOOKING_STATUS_CHOICES,
  CASE_STATUS_CHOICES,
  RECORD_STATUS_CHOICES,
  costText,
  daysBetween,
  daysText,
  dueText,
  fieldLabel,
  formatBoolean,
  formatCalendarDate,
  formatDateTime,
  formatDuration,
  formatFieldValue,
  formatMonthYear,
  formatSpan,
  pendingChangeLines,
  pendingChangeView,
  provenanceLine,
  recordFacts,
  recordName,
  rowSummary,
  statusChoices,
  statusLabel,
  typedDueLine,
  typedFacts,
  typedFieldLabel,
  whenLine,
  whenText,
} from "./record-format";
import { BUILT_IN, buildCatalogue } from "@/domain/life-admin/catalogue";
import { RECORD_STATUSES, statusFor } from "@/domain/life-admin/lifecycle";

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

test("a status code reads as a word; the forms offer exactly the record service's statuses", () => {
  assert.equal(statusLabel("active"), "Active");
  assert.equal(statusLabel("canceled"), "Cancelled");
  assert.equal(statusLabel("expired"), "Expired");
  assert.equal(statusLabel("awaiting_refund"), "Awaiting refund");
  assert.deepEqual(RECORD_STATUS_CHOICES.map((choice) => choice.value), [...RECORD_STATUSES]);
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

// ─── typed records (docs/adr/life-admin-profile.md) ─────────────────────────────────────

const recordType = (id: string) => BUILT_IN.type(id);
const rego = recordType("vehicles.registration")!;
const health = recordType("health.insurance")!;
const vehicle = recordType("vehicles.vehicle")!;

test("a typed record's facts and due line use its type's own wording", () => {
  assert.equal(typedFieldLabel(health, "provider"), "Fund");
  assert.equal(typedFieldLabel(health, "reference"), "Membership number");
  assert.equal(typedFieldLabel(health, "colour_of_card"), "Colour of card", "an agent's own key is tidied");
  assert.deepEqual(
    recordFacts({ provider: "Medibank", amount: "180.20", currency: "AUD", cycle: "monthly", reference: "ABC123" }, "provider", (key) => typedFieldLabel(health, key))
      .map((fact) => [fact.label, fact.value]),
    [["Premium", "AUD 180.20 a month"], ["Membership number", "ABC123"]],
  );
  assert.equal(dueText(rego, "2026-12-14"), "Expires 14 Dec 2026");
  assert.equal(dueText(vehicle, "2026-12-14"), "Due 14 Dec 2026", "a type with no due date of its own says Due");
  assert.equal(typedDueLine(rego, "2026-12-14", "active"), "Registration · Expires 14 Dec 2026 · Active");
  assert.equal(typedDueLine(vehicle, null, "active"), "Vehicle · Active");
});

test("a record's name is the one Home and reminders use, and says which field it came from", () => {
  assert.deepEqual(recordName(health, { reference: "ABC123", provider: "Medibank" }), { name: "Medibank", key: "provider" });
  assert.deepEqual(recordName(BUILT_IN.typeOfRecord("subscription", null), { Service: "Spotlight", "Monthly cost": "A$18.50" }, false), { name: "Spotlight", key: "Service" });
  assert.deepEqual(recordName(recordType("id.passport")!, {}), { name: "Passport", key: null }, "an empty record goes by its type");
  assert.deepEqual(recordName(rego, { plate: "BX12AB", provider: "Transport for NSW" }), { name: "Registration · BX12AB", key: null }, "a kind identified by its plate names it");
});

test("how far away a date is, in words", () => {
  assert.equal(daysBetween("2026-11-23", "2026-12-14"), 21);
  assert.equal(whenText("2026-11-23", "2026-12-14"), "in 21 days");
  assert.equal(whenText("2026-11-23", "2026-11-23"), "today");
  assert.equal(whenText("2026-11-23", "2026-11-24"), "tomorrow");
  assert.equal(whenText("2026-11-23", "2026-11-20"), "3 days ago");
  assert.equal(whenText("2026-12-31", "2027-01-01"), "tomorrow", "across a year end");
});

test("provenance: the person's own record, and an agent's in each of its forms", () => {
  const chatgpt = { kind: "agent" as const, agentId: "a1", name: "ChatGPT" };
  const claude = { kind: "agent" as const, agentId: "a2", name: "Claude" };
  const email = { service: "google-gmail", sender: "service.nsw.gov.au", date: "2026-10-02" };
  assert.equal(provenanceLine({ addedBy: { kind: "person" }, reviewState: "confirmed" }), "Added by you.");
  assert.equal(
    provenanceLine({ addedBy: chatgpt, reviewState: "suggested", foundIn: { ...email, seenByWarthog: true } }),
    "Found by ChatGPT in an email from service.nsw.gov.au (2 Oct 2026). ChatGPT read it through Warthog.",
  );
  assert.equal(
    provenanceLine({ addedBy: chatgpt, reviewState: "suggested", foundIn: { service: "google-gmail", sender: "service.nsw.gov.au", seenByWarthog: false } }),
    "ChatGPT says it found this in an email from service.nsw.gov.au.",
    "the agent's own claim, not Warthog's evidence",
  );
  assert.equal(provenanceLine({ addedBy: chatgpt, reviewState: "suggested" }), "Added by ChatGPT.");
  assert.equal(provenanceLine({ addedBy: chatgpt, reviewState: "confirmed", changedBy: { kind: "person" } }), "Added by ChatGPT. Checked by you.");
  assert.equal(
    provenanceLine({ addedBy: chatgpt, reviewState: "suggested", changedBy: claude }),
    "Added by ChatGPT. Last changed by Claude.",
    "another agent rewrote it since",
  );
  assert.equal(provenanceLine({ addedBy: chatgpt, reviewState: "suggested", changedBy: chatgpt }), "Added by ChatGPT.", "the same agent is not named twice");
  assert.equal(
    provenanceLine({ addedBy: { kind: "agent", name: "an agent that is no longer connected" }, reviewState: "suggested", foundIn: { service: "google-gmail", seenByWarthog: false } }),
    "An agent that is no longer connected says it found this in an email.",
  );
  assert.equal(
    provenanceLine({ addedBy: chatgpt, reviewState: "suggested", foundIn: { service: "google-drive", sender: "x", seenByWarthog: true } }),
    "Found by ChatGPT in a file. ChatGPT read it through Warthog.",
  );
});

test("an agent's pending change reads as labelled old → new lines, due date and status last", () => {
  const lines = pendingChangeLines(
    health,
    { fields: { provider: "Medibank", notes: "Old note" }, dueDate: "2026-10-01", status: "active" },
    { set: { hospital_cover: "gold", provider: "Bupa" }, remove: ["notes"], dueDate: "2027-10-01", status: "cancelled" },
  );
  assert.deepEqual(lines.map((line) => [line.label, line.from, line.to]), [
    ["Hospital cover", null, "gold"],
    ["Fund", "Medibank", "Bupa"],
    ["Notes", "Old note", null],
    ["Renews or extras reset", "1 Oct 2026", "1 Oct 2027"],
    ["Status", "Active", "Cancelled"],
  ]);
  assert.deepEqual(pendingChangeLines(health, { fields: {}, dueDate: null, status: "active" }, { set: {}, remove: [] }), []);
});

test("a change that gives a record another kind says so first, and drops the old schema's type and source lines", () => {
  const legacy = { kind: "renewal_appointment" as const, type: null, fields: { what: "Honda CB500X", type: "vehicle", source: "gmail", plate: "BX12AB" }, dueDate: null, status: "active" };
  const lines = pendingChangeView(BUILT_IN, legacy, { type: "vehicles.vehicle", set: { name: "Honda CB500X", make: "Honda" }, remove: ["what", "type", "source"] });
  assert.deepEqual(lines.map((line) => [line.label, line.from, line.to]), [
    ["Kind", "Renewal or appointment", "Vehicle (Vehicles)"],
    ["Nickname or make and model", null, "Honda CB500X"],
    ["Make", null, "Honda"],
    ["What", "Honda CB500X", null],
  ], "what it gains labelled through the new kind; the removed type and source fields aren't news");
  const same = pendingChangeView(BUILT_IN, { ...legacy, kind: "item" as const, type: "vehicles.vehicle" }, { type: "vehicles.vehicle", set: {}, remove: ["source"] });
  assert.deepEqual(same.map((line) => [line.label, line.to]), [["Source", null]], "the same kind isn't a change of kind, and its removals all show");
  const unknown = pendingChangeView(BUILT_IN, legacy, { type: "nope.gone", set: {}, remove: ["type"] });
  assert.deepEqual(unknown.map((line) => line.label), ["Type"], "a kind the catalogue doesn't have is ignored");
  assert.deepEqual(pendingChangeView(BUILT_IN, legacy, { set: {}, remove: [] }), []);
});

test("a row's one muted line: kind, when, cost and cycle, provider, each only once", () => {
  const rego = BUILT_IN.type("vehicles.registration")!;
  const regoFields = { plate: "BX12AB", provider: "Transport for NSW", amount: "412.50", currency: "aud", cycle: "yearly" };
  const regoName = recordName(rego, regoFields);
  assert.equal(
    rowSummary(rego, { fields: regoFields, dueDate: "2026-12-14" }, { name: regoName.name, titleKey: regoName.key }),
    "Expires 14 Dec 2026 · AUD 412.50 a year · Transport for NSW",
    "a name that starts with its kind doesn't repeat it",
  );
  const health = BUILT_IN.type("health.insurance")!;
  const healthName = recordName(health, { provider: "Medibank" });
  assert.equal(rowSummary(health, { fields: { provider: "Medibank" }, dueDate: "2027-03-01" }, { name: healthName.name, titleKey: healthName.key }), "Health insurance · Renews or extras reset 1 Mar 2027", "the provider it's named for isn't repeated");
  assert.equal(
    rowSummary(health, { fields: { provider: "Medibank" }, dueDate: null }, { name: healthName.name, titleKey: healthName.key, category: "Health" }),
    "Health · Health insurance",
    "a list across categories leads with the category",
  );
  const flight = BUILT_IN.type("travel.flight")!;
  assert.equal(
    rowSummary(flight, { fields: { provider: "Qantas", reference: "QF25", starts_at: "2026-12-03T09:00+11:00[Australia/Sydney]" }, dueDate: "2026-12-03" }, { name: "Flight · QF25", titleKey: null, zone: "Australia/Sydney", currentYear: "2026" }),
    "Starts Thu 3 Dec, 9:00 am AEDT · Qantas",
  );
  const bike = BUILT_IN.type("vehicles.vehicle")!;
  assert.equal(rowSummary(bike, { fields: { name: "Honda CB500X" }, dueDate: null }, { name: "Honda CB500X", titleKey: "name", lead: true }), "", "an anchor's own row under its name has nothing more to say");
});

test("a cost reads once with its currency and cycle; one written with its own currency reads as written", () => {
  assert.equal(costText({ amount: "25.99", currency: "AUD", cycle: "monthly" }), "AUD 25.99 a month");
  assert.equal(costText({ price: "1,250" }), "1,250.00", "thousands grouped");
  assert.equal(costText({ amount: "A$18.50", cycle: "weekly" }), "A$18.50 a week");
  assert.equal(costText({ amount: " " }), null);
  assert.equal(costText({ provider: "Netflix" }), null);
});

// ─── field kinds (catalogue v2) ─────────────────────────────────────────────────────────

test("a date-time reads in the zone it happens in, with the year only when it isn't this year", () => {
  assert.equal(formatDateTime("2026-12-03T19:30+11:00[Australia/Sydney]", "UTC", "2026"), "Thu 3 Dec, 7:30 pm AEDT");
  assert.equal(formatDateTime("2026-12-03T19:30+11:00[Australia/Sydney]", "Asia/Tokyo"), "Thu 3 Dec, 7:30 pm AEDT", "its own zone wins over the fallback");
  assert.equal(formatDateTime("2027-01-03T00:30+09:00[Asia/Tokyo]", "Australia/Sydney", "2026"), "Sun 3 Jan 2027, 12:30 am GMT+9", "a 00:30 Tokyo flight stays on its own date");
  assert.equal(formatDateTime("2026-12-03", "Australia/Sydney"), "3 Dec 2026", "a date alone reads as a date");
  assert.equal(formatDateTime("sometime next week"), "sometime next week", "anything else is left as written");
});

test("month and year, yes/no, durations and numbers with their unit read as words", () => {
  assert.equal(formatMonthYear("2027-03"), "Mar 2027");
  assert.equal(formatMonthYear("2027-13"), "2027-13");
  assert.equal(formatBoolean("yes"), "Yes");
  assert.equal(formatBoolean("no"), "No");
  assert.equal(formatDuration("PT45M"), "45 minutes");
  assert.equal(formatDuration("P12M"), "12 months");
  assert.equal(formatDuration("PT1H30M"), "1 hour 30 minutes");
  assert.equal(formatDuration("P1DT2H"), "1 day 2 hours");
  assert.equal(formatDuration("a while"), "a while");
  const party = { key: "party_size", label: "How many", kind: "number" as const, unit: "people" };
  assert.equal(formatFieldValue(party, "party_size", "6"), "6 people");
  assert.equal(formatFieldValue(party, "party_size", "about six"), "about six");
});

test("a booking's facts and its line under the name read the kind's way, in its own zone", () => {
  const restaurant = recordType("outings.restaurant")!;
  const fields = { provider: "Sixpenny", starts_at: "2026-12-03T19:30+11:00[Australia/Sydney]", party_size: "4", card_held: "yes" };
  assert.deepEqual(
    typedFacts(restaurant, fields, "provider", "UTC", "2026").map((fact) => [fact.label, fact.value]),
    [["Starts", "Thu 3 Dec, 7:30 pm AEDT"], ["How many", "4 people"], ["Card held", "Yes"]],
  );
  assert.equal(whenLine(restaurant, { fields, dueDate: "2026-12-03" }, "UTC", "2026"), "Starts Thu 3 Dec, 7:30 pm AEDT");
  const trip = recordType("travel.trip")!;
  assert.equal(
    whenLine(trip, { fields: {}, dueDate: null, phase: { starts: "2026-12-02T22:00:00.000Z", ends: "2026-12-10T01:00:00.000Z" } }, "Australia/Sydney"),
    "3 – 10 Dec 2026",
    "a trip's span from its bookings",
  );
  assert.equal(formatSpan("2026-11-28T01:00:00.000Z", "2026-12-03T01:00:00.000Z", "Australia/Sydney"), "28 Nov – 3 Dec 2026");
});

test("each lifecycle offers its own statuses, every one a word the record service knows", () => {
  assert.deepEqual(statusChoices("standing"), RECORD_STATUS_CHOICES);
  assert.deepEqual(BOOKING_STATUS_CHOICES.map((choice) => choice.value), ["confirmed", "pending", "cancelled", "no_show"]);
  assert.deepEqual(CASE_STATUS_CHOICES.map((choice) => choice.value), ["open", "waiting", "resolved"]);
  for (const choice of BOOKING_STATUS_CHOICES) assert.ok(statusFor({ lifecycle: "booking" }, choice.value), choice.value);
  for (const choice of CASE_STATUS_CHOICES) assert.ok(statusFor({ lifecycle: "case" }, choice.value), choice.value);
  assert.equal(statusLabel("no_show"), "Didn't go");
  assert.equal(statusLabel("pending"), "Waiting to be confirmed");
});

test("a kind of the person's own category labels its fields its own way", () => {
  const catalogue = buildCatalogue([{
    slug: "x_7kq2mz",
    state: "active",
    definition: {
      label: "Boat",
      description: "The boat and its mooring.",
      lifeArea: "getting_around",
      icon: "sailboat",
      kinds: [{ key: "mooring", label: "Mooring", lifecycle: "standing", use: "A mooring licence.", fields: [{ key: "berth", label: "Berth", kind: "text" }], due: { means: "renews", label: "Licence renews" } }],
    },
  }]);
  const mooring = catalogue.type("x_7kq2mz.mooring")!;
  assert.equal(typedFieldLabel(mooring, "berth"), "Berth");
  assert.equal(dueText(mooring, "2027-02-01"), "Licence renews 1 Feb 2027");
});

test("days from today in words", () => {
  assert.equal(daysText(0), "today");
  assert.equal(daysText(9), "in 9 days");
  assert.equal(daysText(-1), "yesterday");
});

test("a suggested change hides lines that read the same before and after", () => {
  const legacy = { kind: "renewal_appointment" as const, type: null, fields: { name: "Hans Zimmer Live", starts_at: "2026-12-29T19:30[Australia/Sydney]" }, dueDate: "2026-12-29", status: "active" };
  const lines = pendingChangeView(BUILT_IN, legacy, { type: "outings.event", set: { name: "Hans Zimmer Live", provider: "Ticketek", starts_at: "2026-12-29T19:30+11:00[Australia/Sydney]" }, remove: [], status: "active" }, "Australia/Sydney");
  assert.equal(lines[0]!.key, "kind");
  assert.ok(lines.some((line) => line.to === "Ticketek"));
  assert.ok(lines.every((line) => line.from === null || line.to === null || line.from !== line.to), JSON.stringify(lines));
  assert.ok(!lines.some((line) => /^Start/.test(line.label)), "the same start, spelled with its offset, isn't a change");
});

test("a suggested change that links a record to a thing says so", () => {
  const rego = { kind: "renewal_appointment" as const, type: "vehicles.registration", fields: { name: "Motorcycle registration" }, dueDate: "2026-11-24", status: "active", parentId: null };
  const names = new Map([["bike-1", "Mondial HPS 300"]]);
  const linked = pendingChangeView(BUILT_IN, rego, { set: {}, remove: [], parentId: "bike-1" }, "Australia/Sydney", names);
  assert.deepEqual(linked, [{ key: "parent", label: "Belongs to", from: "not linked", to: "Mondial HPS 300" }]);
  const unlinked = pendingChangeView(BUILT_IN, { ...rego, parentId: "bike-1" }, { set: {}, remove: [], parentId: null }, "Australia/Sydney", names);
  assert.deepEqual(unlinked, [{ key: "parent", label: "Belongs to", from: "Mondial HPS 300", to: "not linked" }]);
});

test("an older record given the kind it already reads as doesn't list its stray type and source as removed", () => {
  const chess = { kind: "subscription" as const, type: null, fields: { name: "Chess", type: "subscriptions.service", source: "Gmail" }, dueDate: null, status: "active" };
  const lines = pendingChangeView(BUILT_IN, chess, { type: "subscriptions.service", set: { notes: "Renews in Feb" }, remove: ["type", "source"] }, "Australia/Sydney");
  assert.deepEqual(lines.map((line) => line.key), ["notes"]);
});
