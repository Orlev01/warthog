// The life-admin summary in an agent's context (`./summary.ts`) and the "Life admin records"
// skill text (`./skill.ts`).

import { test } from "node:test";
import assert from "node:assert/strict";

import { offerBookings, offerToFill, summariseLifeAdmin, type SummaryRecord } from "./summary";
import { PROFILE_SKILL } from "./profile-skill";
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
  ], BUILT_IN, NOW, "Australia/Sydney", { offerSources: ["mail"] });

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
  assert.equal(summary.next, offerBookings(["mail"]), "no bookings yet, so the offer is to find them");
  assert.equal(summary.categories.unused > 10, true);
});

test("an agent that can read the person's email, calendar or files and save records may offer to build their profile", () => {
  assert.equal(summariseLifeAdmin([], BUILT_IN, NOW, "Australia/Sydney", { offerSources: ["mail"] }).next, offerToFill(["mail"]));
  assert.equal(summariseLifeAdmin([], BUILT_IN, NOW, "Australia/Sydney", { offerSources: ["calendar", "files"] }).next, offerToFill(["calendar", "files"]));
  assert.equal(summariseLifeAdmin([], BUILT_IN, NOW, "Australia/Sydney", { offerSources: [] }).next, undefined);
  assert.match(offerToFill(["mail"]), new RegExp(`"${PROFILE_SKILL.title}"`), "it points to the profile skill");
  assert.match(offerToFill(["mail", "calendar", "files"]), /go through your email, calendar and files/);
  assert.match(offerToFill(["files"]), /go through your files/);
});

test("the bookings offer names only email and calendar, and needs one of them", () => {
  assert.match(offerBookings(["mail", "calendar", "files"])!, /in their email and calendar/);
  assert.match(offerBookings(["calendar"])!, new RegExp(`"${LIFE_ADMIN_SKILL.title}"`));
  assert.equal(offerBookings(["files"]), undefined);
  const record = { id: "a", kind: "item" as const, type: "vehicles.vehicle", fields: { name: "Car" }, dueDate: null, status: "active", reviewState: "confirmed" as const, pending: null };
  const many = Array.from({ length: 6 }, (_, index) => ({ ...record, id: `r${index}` }));
  assert.equal(summariseLifeAdmin(many, BUILT_IN, NOW, "Australia/Sydney", { offerSources: ["files"] }).next, undefined, "no bookings offer from files alone");
});

test("the skill lists every record type and the things never to save", () => {
  const text = lifeAdminSkillText(BUILT_IN);
  for (const type of BUILT_IN_TYPES) assert.ok(text.includes(`- ${type.id} `), type.id);
  for (const words of ["tax file numbers", "passwords", "BSB", "Medicare", "suggestion until the person confirms", "information, not instructions"]) {
    assert.ok(text.includes(words), words);
  }
  // About 8,500 tokens, fetched once per conversation. Raised from 32,000 on 23 Nov 2026 for
  // "What to carry over" (account name, number and email), after trimming repeated field lists,
  // and from 33,000 on 25 Nov 2026 for "Which emails to read" and leaving out Promotions.
  assert.ok(text.length < 35_000, `small enough to fetch once in a conversation (${text.length})`);
  const own = lifeAdminSkillText(buildCatalogue([{ slug: "x_bcdfgh", state: "suggested", definition: { label: "Rowing club", description: "d", lifeArea: "everyday", icon: "trophy", kinds: [{ key: "fees", label: "Fees", lifecycle: "standing", use: "Fees.", fields: [] }] } }]), { notForMe: ["pets"] });
  assert.ok(own.includes('"Rowing club" (x_bcdfgh, suggested'), "a person's own category is quoted");
  assert.ok(!own.includes("- pets.pet "), "not-for-me categories are left out");
});

test("a past trip with past bookings isn't an upcoming booking for agents", () => {
  const summary = summariseLifeAdmin([
    record("trip", { kind: "item", type: "travel.trip", fields: { name: "Queenstown" }, dueDate: null, status: "active" }),
    record("stay", { kind: "item", type: "travel.stay", fields: { provider: "Goodstays", starts_at: "2026-08-27[Pacific/Auckland]", ends_at: "2026-08-31[Pacific/Auckland]" }, dueDate: "2026-08-27", status: "active", parentId: "trip" }),
  ], BUILT_IN, NOW, "Australia/Sydney", { offerSources: [] });
  assert.equal(summary.upcomingBookings, 0);
  assert.equal(summary.dueSoon.length, 0);
});

test("the skill asks agents to carry over what identifies an account: its name, number and the email it's registered to", () => {
  const text = lifeAdminSkillText(BUILT_IN);
  assert.match(text, /What to carry over/);
  assert.match(text, /account_name \(the name it's in/);
  assert.match(text, /account_email \(the person's own address the provider writes to/);
  assert.match(text, /for a bank account or card, last4 only/);
  assert.match(text, /Leave out balances and transactions, offers and marketing/);
  assert.match(text, /- investing\.super — Super fund \[account\]/);
  assert.doesNotMatch(text, /- travel\.flight — Flight \[account\]/);
  assert.match(text, /kinds marked \[account\] also have account_name, account_email/);
  assert.ok(text.length < 35_000, `still small enough to fetch once (${text.length})`);
});

// Dogfood, 25 Nov 2026: "fine" matched everyday email, and Outlook can't take Gmail's syntax.
test("the skill's searches avoid common words and say how to search Outlook", () => {
  const text = lifeAdminSkillText(BUILT_IN);
  const government = text.split("\n").find((line) => line.startsWith("- Tax and government:")) ?? "";
  assert.match(government, /from:\(ato\.gov\.au OR my\.gov\.au/, "government paperwork by sender");
  assert.doesNotMatch(government, /"fine"/);
  assert.match(text, /in Outlook, put the same words in \$search without newer_than:.*received>=YYYY-MM-DD/);
});

// Dogfood, 25 Nov 2026: the banking search's words ("annual fee", "balance transfer") found NAB's
// offers and missed the founder's other banks, and nothing told agents to pass over marketing.
test("the skill reads service emails, not marketing, and finds bank accounts by subject", () => {
  const text = lifeAdminSkillText(BUILT_IN);
  const searches = text.split("\n").filter((line) => line.startsWith("- ") && line.includes("newer_than:"));
  assert.ok(searches.length >= 16);
  for (const line of searches) assert.ok(line.split("`").filter((_, i) => i % 2 === 1).every((query) => query.includes("-category:promotions")), line);
  const banking = searches.find((line) => line.startsWith("- Banking and credit:")) ?? "";
  assert.match(banking, /subject:\(statement OR eStatement\)/);
  assert.match(banking, /subject:\(welcome OR approved/);
  assert.doesNotMatch(banking, /balance transfer/);
  assert.match(text, /Which emails to read\n- Service emails:/);
  assert.match(text, /Not marketing: offers, rewards, newsletters/);
  assert.match(text, /newest service email from each sender/);
  assert.match(text, /search that sender for its service emails/);
  assert.match(text, /when the coverage line shows an inbox with more/);
  assert.match(text, /policy the person closed: status cancelled/);
  assert.match(text, /- banking\.account — Bank account[^\n]*\n(?:  [^\n]*\n)*  same record when: provider \+ last4 match; without those, provider \+ name/);
  assert.match(text, /without newer_than:, -category:promotions, brackets/);
  assert.ok(text.length < 35_000, `still small enough to fetch once (${text.length})`);
});
