// An item's journal (`./journal.ts`, `./journal-text.ts`): open steps, decisions in force, change
// entries in words, the hand-over line, and what journal text may say.

import { test } from "node:test";
import assert from "node:assert/strict";

import { changeText, currentDecisions, handoverLine, openNextSteps, type JournalEntryView } from "./journal";
import { cleanJournalText, findForbiddenText } from "./journal-text";

const instinct = { kind: "agent" as const, name: "Instinct" };
const entry = (id: string, kind: JournalEntryView["kind"], at: string, extra: Partial<JournalEntryView> = {}): JournalEntryView =>
  ({ id, kind, at, by: instinct, reported: kind !== "change", ...extra });

test("open next steps and the decisions still in force", () => {
  const entries = [
    entry("d1", "decision", "2026-11-18T01:00:00Z", { text: "Chose Bikesure." }),
    entry("d2", "decision", "2026-11-18T02:00:00Z", { text: "Chose Swann instead.", refId: "d1" }),
    entry("n1", "next", "2026-11-18T03:00:00Z", { text: "Roadworthy at Ryde", due: "2026-11-28" }),
    entry("n2", "next", "2026-11-18T04:00:00Z", { text: "Pay the premium" }),
    entry("x1", "next_done", "2026-11-20T00:00:00Z", { refId: "n2" }),
  ];
  assert.deepEqual(currentDecisions(entries).map((e) => e.id), ["d2"]);
  assert.deepEqual(openNextSteps(entries).map((e) => e.id), ["n1"]);
});

test("Warthog's change entries read as plain sentences", () => {
  assert.equal(changeText({ event: "updated", fields: [{ key: "amount", label: "Premium", from: "1100", to: "1250" }] }, instinct), "Instinct changed premium 1100 → 1250");
  assert.equal(changeText({ event: "steward", from: "Instinct", to: "Muse" }, { kind: "agent", name: "Muse" }), "Muse took over from Instinct");
  assert.equal(changeText({ event: "confirmed" }, { kind: "person" }), "The person confirmed this");
});

test("the hand-over line is deterministic and in I-PASS order", () => {
  const line = handoverLine({
    name: "Motorcycle insurance",
    state: "renews 1 Dec, in 9 days",
    decision: entry("d2", "decision", "2026-11-18T01:00:00Z", { text: "Swann, agreed value $9,000, $212/yr cheaper than Bikesure" }),
    next: entry("n1", "next", "2026-11-18T02:00:00Z", { text: "Get the roadworthy at Ryde Motorcycles", due: "2026-11-28" }),
    steward: "Instinct",
    lastTouched: { at: "2026-11-18T02:00:00Z", by: "Instinct" },
    now: new Date("2026-11-22T02:00:00Z"),
    zone: "Australia/Sydney",
  });
  assert.equal(line, "Motorcycle insurance · renews 1 Dec, in 9 days · decided: Swann, agreed value $9,000, $212/yr cheaper than Bikesure (Instinct, 18 Nov) · next: Get the roadworthy at Ryde Motorcycles, due 28 Nov · handled by Instinct · last touched 4 days ago by Instinct");
});

test("journal text: refusals and cleaning", () => {
  assert.equal(findForbiddenText("My TFN is 123 456 782"), "tax_file_number");
  assert.equal(findForbiddenText("Pay via BPAY biller 12345 ref 998877"), "payment_details");
  assert.equal(findForbiddenText("Passport PA1234567 renewed"), "government_id");
  assert.equal(findForbiddenText("Chose Swann: $212 a year cheaper"), null);
  assert.deepEqual(cleanJournalText("See https://evil.example/pay?x=1 ​ now"), { text: "See evil.example now", cut: false });
  const long = cleanJournalText("word ".repeat(100))!;
  assert.ok(long.cut && Array.from(long.text).length <= 281);
  assert.equal(cleanJournalText("   "), null);
});
