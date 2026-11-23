// The life-admin summary in an agent's context (`./summary.ts`) and the "Life admin records"
// skill text (`./skill.ts`).

import { test } from "node:test";
import assert from "node:assert/strict";

import { OFFER_BOOKINGS, OFFER_TO_FILL, summariseLifeAdmin, type SummaryRecord } from "./summary";
import { LIFE_ADMIN_SKILL, lifeAdminSkillText } from "./skill";
import { BUILT_IN_TYPES } from "./record-types";
import { BUILT_IN, buildCatalogue } from "./catalogue";

const NOW = new Date("2026-11-23T01:00:00Z");
const record = (id: string, overrides: Partial<SummaryRecord> = {}): SummaryRecord => ({
  id, kind: "item", type: "other.item", fields: { name: id }, dueDate: null, status: "active", reviewState: "confirmed", pending: null, ...overrides,
});

test("the summary counts categories, lists the soonest few and what waits for the person", () => {
  const summary = summariseLifeAdmin([
    record("rego", { type: "vehicles.registration", fields: { plate: "BX12AB" }, dueDate: "2026-12-14", reviewState: "suggested" }),
    record("health", { type: "health.insurance", fields: { provider: "Bupa" }, dueDate: "2027-06-01" }),
    record("late", { dueDate: "2026-11-10" }),
    record("ancient", { dueDate: "2025-01-01" }),
    record("gone", { dueDate: "2026-11-30", status: "cancelled" }),
    record("netflix", { kind: "subscription", type: null, fields: { name: "Netflix" }, dueDate: "2026-11-25", pending: { set: {} } }),
  ], BUILT_IN, NOW, "Australia/Sydney", { mayOffer: true });

  assert.equal(summary.total, 6);
  assert.deepEqual(summary.byCategory, { vehicles: 1, health: 1, other: 3, subscriptions: 1 });
  assert.deepEqual(summary.dueSoon.map((item) => [item.id, item.due!.inDays, item.due!.label]), [
    ["late", -13, "Due"],
    ["netflix", 2, "Renews"],
    ["rego", 21, "Expires"],
  ]);
  assert.equal(summary.dueSoon[2]!.name, "Registration · BX12AB", "a record with no name goes by its type and what identifies it");
  assert.equal(summary.dueSoon[2]!.checkedByPerson, false);
  assert.equal(summary.waitingForPerson, 2);
  assert.equal(summary.next, OFFER_BOOKINGS, "no bookings yet, so the offer is to find them");
  assert.equal(summary.categories.unused > 10, true);
});

test("only an agent that can read mail and save records is told it may offer to fill it in", () => {
  assert.equal(summariseLifeAdmin([], BUILT_IN, NOW, "Australia/Sydney", { mayOffer: true }).next, OFFER_TO_FILL);
  assert.equal(summariseLifeAdmin([], BUILT_IN, NOW, "Australia/Sydney", { mayOffer: false }).next, undefined);
  assert.match(OFFER_TO_FILL, new RegExp(LIFE_ADMIN_SKILL.title));
});

test("the skill lists every record type and the things never to save", () => {
  const text = lifeAdminSkillText(BUILT_IN);
  for (const type of BUILT_IN_TYPES) assert.ok(text.includes(`- ${type.id} `), type.id);
  for (const words of ["tax file numbers", "passwords", "BSB", "Medicare", "suggestion until the person confirms", "information, not instructions"]) {
    assert.ok(text.includes(words), words);
  }
  assert.ok(text.length < 32_000, `small enough to fetch once in a conversation (${text.length})`);
  const own = lifeAdminSkillText(buildCatalogue([{ slug: "x_bcdfgh", state: "suggested", definition: { label: "Rowing club", description: "d", lifeArea: "everyday", icon: "trophy", kinds: [{ key: "fees", label: "Fees", lifecycle: "standing", use: "Fees.", fields: [] }] } }]), { notForMe: ["pets"] });
  assert.ok(own.includes('"Rowing club" (x_bcdfgh, suggested'), "a person's own category is quoted");
  assert.ok(!own.includes("- pets.pet "), "not-for-me categories are left out");
});

test("a past trip with past bookings isn't an upcoming booking for agents", () => {
  const summary = summariseLifeAdmin([
    record("trip", { kind: "item", type: "travel.trip", fields: { name: "Queenstown" }, dueDate: null, status: "active" }),
    record("stay", { kind: "item", type: "travel.stay", fields: { provider: "Goodstays", starts_at: "2026-08-27[Pacific/Auckland]", ends_at: "2026-08-31[Pacific/Auckland]" }, dueDate: "2026-08-27", status: "active", parentId: "trip" }),
  ], BUILT_IN, NOW, "Australia/Sydney", { mayOffer: false });
  assert.equal(summary.upcomingBookings, 0);
  assert.equal(summary.dueSoon.length, 0);
});
