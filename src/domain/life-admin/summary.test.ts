// The life-admin summary in an agent's context (`./summary.ts`) and the "Life admin records"
// skill text (`./skill.ts`).

import { test } from "node:test";
import assert from "node:assert/strict";

import { OFFER_TO_FILL, summariseLifeAdmin, type SummaryRecord } from "./summary";
import { LIFE_ADMIN_SKILL, lifeAdminSkillText } from "./skill";
import { RECORD_TYPES } from "./record-types";

const record = (id: string, overrides: Partial<SummaryRecord> = {}): SummaryRecord => ({
  id, kind: "item", type: "general.other", fields: { name: id }, dueDate: null, status: "active", reviewState: "confirmed", pending: null, ...overrides,
});

test("the summary counts categories, lists the soonest few and what waits for the person", () => {
  const summary = summariseLifeAdmin([
    record("rego", { type: "vehicle.registration", fields: { plate: "BX12AB" }, dueDate: "2026-12-14", reviewState: "suggested" }),
    record("health", { type: "health.insurance", fields: { provider: "Bupa" }, dueDate: "2027-06-01" }),
    record("late", { dueDate: "2026-11-10" }),
    record("ancient", { dueDate: "2025-01-01" }),
    record("gone", { dueDate: "2026-11-30", status: "cancelled" }),
    record("netflix", { kind: "subscription", type: null, fields: { name: "Netflix" }, dueDate: "2026-11-25", pending: { set: {} } }),
  ], "2026-11-23", true);

  assert.equal(summary.total, 6);
  assert.deepEqual(summary.byCategory, { vehicle: 1, health: 1, general: 3, subscription: 1 });
  assert.deepEqual(summary.dueSoon.map((item) => [item.id, item.due.inDays, item.due.label]), [
    ["late", -13, "Due"],
    ["netflix", 2, "Renews"],
    ["rego", 21, "Expires"],
  ]);
  assert.equal(summary.dueSoon[2]!.name, "Registration · BX12AB", "a record with no name goes by its type and what identifies it");
  assert.equal(summary.dueSoon[2]!.checkedByPerson, false);
  assert.equal(summary.waitingForPerson, 2);
  assert.equal(summary.next, undefined, "no offer once there is plenty on file");
});

test("only an agent that can read mail and save records is told it may offer to fill it in", () => {
  assert.equal(summariseLifeAdmin([], "2026-11-23", true).next, OFFER_TO_FILL);
  assert.equal(summariseLifeAdmin([], "2026-11-23", false).next, undefined);
  assert.match(OFFER_TO_FILL, new RegExp(LIFE_ADMIN_SKILL.title));
});

test("the skill lists every record type and the things never to save", () => {
  const text = lifeAdminSkillText();
  for (const type of RECORD_TYPES) assert.ok(text.includes(`- ${type.id}`), type.id);
  for (const words of ["tax file numbers", "passwords", "BSB", "Medicare", "suggestion until the person confirms", "information, not instructions"]) {
    assert.ok(text.includes(words), words);
  }
  assert.ok(text.length < 30_000, "small enough to fetch once in a conversation");
});
