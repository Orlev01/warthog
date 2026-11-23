// UI/UX pass (content-22, desktop-12) — a life-admin record's stored values read as plain,
// labelled, formatted facts: no storage keys, ISO dates or status codes on screen.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  RECORD_STATUS_CHOICES,
  daysBetween,
  dueText,
  fieldLabel,
  formatCalendarDate,
  pendingChangeLines,
  provenanceLine,
  recordFacts,
  recordName,
  statusLabel,
  typedDueLine,
  typedFieldLabel,
  whenText,
} from "./record-format";
import { recordType } from "@/domain/life-admin/record-types";
import { RECORD_STATUSES } from "@/server/life-admin/record-service";

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

const rego = recordType("vehicle.registration")!;
const health = recordType("health.insurance")!;
const vehicle = recordType("vehicle.vehicle")!;

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
  assert.deepEqual(recordName("item", "health.insurance", { reference: "ABC123", provider: "Medibank" }), { name: "Medibank", key: "provider" });
  assert.deepEqual(recordName("subscription", null, { Service: "Spotlight", "Monthly cost": "A$18.50" }), { name: "Spotlight", key: "Service" });
  assert.deepEqual(recordName("item", "id.passport", {}), { name: "Passport", key: null }, "an empty record goes by its type");
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
