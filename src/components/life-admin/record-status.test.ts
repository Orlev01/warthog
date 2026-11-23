// The Records tab's statuses and filters (docs/adr/life-admin-profile.md, "The Records tab"):
// every record is Active, On hold, Finished or Cancelled, worked out from the phase the one
// lifecycle module gives it; the person filters by category and by status (several of each),
// and the tab lists what's active first, one panel per category, then each other status they
// chose as its own section. These pin the pure functions the view renders from.

import { test } from "node:test";
import assert from "node:assert/strict";

import { BUILT_IN } from "@/domain/life-admin/catalogue";
import {
  DEFAULT_LIST_STATUSES,
  LIST_STATUSES,
  listStatusOf,
  listedRecords,
  mostUrgentFirst,
  recordsHref,
  recordsView,
} from "./record-groups";
import { phased } from "./phase-fixture";
import type { CategoryStateView, LifeAdminRecordView } from "./record-view-types";

// FIXTURE_NOW is 23 Nov 2026, midday in Sydney.
function rec(id: string, type: string, fields: Record<string, string>, over: Partial<LifeAdminRecordView> = {}): LifeAdminRecordView {
  return phased({ id, kind: "item", type, fields, dueDate: null, status: "active", reminderOffsets: [], ...over });
}
function booking(id: string, type: string, starts: string, over: Partial<LifeAdminRecordView> = {}): LifeAdminRecordView {
  return rec(id, type, { provider: id, starts_at: starts }, { dueDate: starts.slice(0, 10), state: "confirmed", ...over });
}

// ─── the status of one record ────────────────────────────────────────────────────────

test("live phases are Active: current, due soon, overdue, date passed, waiting, upcoming, happening now, open, waiting", () => {
  const live = [
    rec("current", "vehicles.insurance", {}, { dueDate: "2027-06-01" }),
    rec("soon", "vehicles.registration", {}, { dueDate: "2026-11-25" }),
    rec("overdue", "health.insurance", {}, { dueDate: "2026-11-02" }),
    rec("passed", "health.insurance", {}, { dueDate: "2026-09-01" }),
    rec("undated", "other.item", {}),
    booking("hold", "outings.restaurant", "2026-11-28T19:30+11:00[Australia/Sydney]", { state: "pending" }),
    booking("flight", "travel.flight", "2026-12-03T09:00+11:00[Australia/Sydney]"),
    rec("stay", "travel.stay", { starts_at: "2026-11-22T15:00+11:00[Australia/Sydney]", ends_at: "2026-11-24T11:00+11:00[Australia/Sydney]" }, { dueDate: "2026-11-22" }),
    rec("fine", "government.fine", {}, { state: "open", dueDate: "2026-12-10" }),
    rec("claim", "insurance.claim", {}, { state: "waiting" }),
  ];
  assert.deepEqual(live.map((record) => [record.phase!.phase, listStatusOf(record)]), [
    ["current", "active"], ["due_soon", "active"], ["overdue", "active"], ["date_passed", "active"], ["current", "active"],
    ["pending", "active"], ["upcoming", "active"], ["in_progress", "active"], ["open", "active"], ["waiting", "active"],
  ]);
});

test("paused is On hold", () => {
  const gym = rec("gym", "subscriptions.membership", {}, { status: "paused", dueDate: "2027-01-01" });
  assert.deepEqual([gym.phase!.phase, listStatusOf(gym)], ["paused", "on_hold"]);
});

test("ended, completed and resolved are Finished: a standing item expired or done, a booking that's over, a case resolved", () => {
  const finished = [
    rec("expired", "id.passport", {}, { status: "expired", dueDate: "2026-03-01" }),
    rec("done", "vehicles.service", {}, { status: "done", dueDate: "2026-10-01" }),
    // A passed return-by date ends a receipt while its status is still active.
    rec("receipt", "belongings.receipt", { item: "Kettle" }, { kind: "receipt_warranty", dueDate: "2026-10-01" }),
    booking("dinner", "outings.restaurant", "2026-10-02T19:00+10:00[Australia/Sydney]"),
    rec("case", "insurance.claim", {}, { state: "resolved", status: "done" }),
  ];
  assert.deepEqual(finished.map((record) => [record.phase!.phase, listStatusOf(record)]), [
    ["ended", "finished"], ["ended", "finished"], ["ended", "finished"], ["completed", "finished"], ["resolved", "finished"],
  ]);
});

test("cancelled, missed and lapsed are Cancelled, and so is a standing item whose status is cancelled", () => {
  const cancelled = [
    booking("gp", "health.appointment", "2026-10-20T09:00+11:00[Australia/Sydney]", { status: "cancelled", state: "cancelled" }),
    booking("salon", "outings.beauty", "2026-09-10T10:00+10:00[Australia/Sydney]", { status: "done", state: "no_show" }),
    booking("held", "outings.restaurant", "2026-11-20T19:00+11:00[Australia/Sydney]", { state: "pending" }),
    rec("netflix", "subscriptions.service", {}, { status: "cancelled", dueDate: "2026-12-01" }),
    rec("old", "subscriptions.service", {}, { status: "Canceled" }),
  ];
  assert.deepEqual(cancelled.map((record) => [record.phase!.phase, listStatusOf(record)]), [
    ["cancelled", "cancelled"], ["missed", "cancelled"], ["lapsed", "cancelled"], ["ended", "cancelled"], ["ended", "cancelled"],
  ]);
});

test("a record without a phase from the loader reads as current, so Active", () => {
  assert.equal(listStatusOf({ status: "active" }), "active");
  assert.deepEqual(LIST_STATUSES, ["active", "on_hold", "finished", "cancelled"]);
  assert.deepEqual(DEFAULT_LIST_STATUSES, ["active"]);
});

// ─── most urgent first ───────────────────────────────────────────────────────────────

test("within a group: overdue and date passed, happening now, due soon, then by due or start date, then undated by name", () => {
  const list = [
    rec("beta", "health.provider", { name: "Beta clinic" }),
    rec("later", "health.insurance", { provider: "Later" }, { dueDate: "2027-05-01" }),
    rec("soon30", "health.script", { name: "Script" }, { dueDate: "2026-12-23" }),
    booking("appt", "health.appointment", "2026-12-01T09:00+11:00[Australia/Sydney]"),
    rec("alpha", "health.provider", { name: "Alpha clinic" }),
    rec("soon5", "health.ambulance", { provider: "Ambulance" }, { dueDate: "2026-11-28" }),
    rec("now", "health.appointment", { starts_at: "2026-11-23T11:00+11:00[Australia/Sydney]", ends_at: "2026-11-23T13:00+11:00[Australia/Sydney]" }, { dueDate: "2026-11-23", state: "confirmed" }),
    rec("overdue", "health.insurance", { provider: "Overdue" }, { dueDate: "2026-11-02" }),
    rec("passed", "health.insurance", { provider: "Passed" }, { dueDate: "2026-09-01" }),
  ];
  assert.deepEqual(mostUrgentFirst(list, BUILT_IN).map((record) => record.id), ["passed", "overdue", "now", "soon5", "soon30", "appt", "later", "alpha", "beta"]);
});

// ─── the records view: filters, Active by category, then the other statuses ─────────

const BIKE = rec("bike", "vehicles.vehicle", { name: "Honda CB500X" });
const REGO = rec("rego", "vehicles.registration", { plate: "BX12AB" }, { parentId: "bike", dueDate: "2026-11-25" });
const BIKE_INS = rec("bikeins", "vehicles.insurance", { provider: "NRMA" }, { parentId: "bike", dueDate: "2027-06-01" });
const OLD_BIKE_INS = rec("oldins", "vehicles.insurance", { provider: "AAMI" }, { parentId: "bike", status: "expired", dueDate: "2026-06-01" });
const HEALTH = rec("health", "health.insurance", { provider: "Medibank" }, { dueDate: "2027-03-01" });
const NETFLIX = rec("netflix", "subscriptions.service", { provider: "Netflix" }, { dueDate: "2026-12-15" });
const STAN = rec("stan", "subscriptions.service", { provider: "Stan" }, { status: "cancelled", dueDate: "2026-08-01" });
const GYM = rec("gym", "subscriptions.membership", { provider: "Fitness First" }, { status: "paused", dueDate: "2027-01-01" });
const DINNER = booking("dinner", "outings.restaurant", "2026-10-02T19:00+10:00[Australia/Sydney]");
const FLIGHT = booking("flight", "travel.flight", "2026-12-03T09:00+11:00[Australia/Sydney]");
const CLAIM = rec("claim", "insurance.claim", { provider: "Allianz" }, { state: "resolved", status: "done", dueDate: "2026-07-01" });
const ALL = [BIKE, REGO, BIKE_INS, OLD_BIKE_INS, HEALTH, NETFLIX, STAN, GYM, DINNER, FLIGHT, CLAIM];

test("by default only what's active shows, one section per category in catalogue order, anchors heading their records", () => {
  const view = recordsView(ALL, BUILT_IN, { categories: [], statuses: ["active"] });
  assert.deepEqual(view.active.map((section) => section.category.id), ["vehicles", "travel", "health", "subscriptions"]);
  const vehicles = view.active[0]!;
  assert.deepEqual(vehicles.anchors.map((group) => [group.anchor.id, group.children.map((child) => child.id)]), [["bike", ["rego", "bikeins"]]], "the expired insurance isn't active");
  assert.deepEqual(vehicles.finished, [], "no Finished group inside a category");
  assert.deepEqual(view.others, [], "no other status was chosen");
  assert.equal(view.shown, 6);
});

test("the options: categories with any record, in catalogue order, and all four statuses, each counted against the other filter", () => {
  const view = recordsView(ALL, BUILT_IN, { categories: [], statuses: ["active"] });
  assert.deepEqual(view.categoryOptions.map((option) => [option.category.id, option.count]), [
    ["vehicles", 3], ["travel", 1], ["health", 1], ["insurance", 0], ["subscriptions", 1], ["outings", 0],
  ], "a category whose records are all finished is still offered, with what's active in it");
  assert.deepEqual(view.statusOptions.map((option) => [option.status, option.label, option.count]), [
    ["active", "Active", 6], ["on_hold", "On hold", 1], ["finished", "Finished", 3], ["cancelled", "Cancelled", 1],
  ]);
  const vehicles = recordsView(ALL, BUILT_IN, { categories: ["vehicles"], statuses: ["active", "finished"] });
  assert.deepEqual(vehicles.statusOptions.map((option) => option.count), [3, 0, 1, 0], "status counts follow the category filter");
  assert.deepEqual(vehicles.categoryOptions.find((option) => option.category.id === "outings")!.count, 1, "category counts follow the status filter");
});

test("a category chosen with no records at all is still offered, so it can be unticked", () => {
  const view = recordsView(ALL, BUILT_IN, { categories: ["pets"], statuses: ["active"] });
  assert.ok(view.categoryOptions.some((option) => option.category.id === "pets" && option.count === 0));
  assert.equal(view.shown, 0);
});

test("chosen categories and statuses: Active by category first, then each other status as its own section, newest first", () => {
  const view = recordsView(ALL, BUILT_IN, { categories: ["vehicles", "subscriptions", "outings", "insurance"], statuses: ["cancelled", "active", "finished", "on_hold"] });
  assert.deepEqual(view.active.map((section) => section.category.id), ["vehicles", "subscriptions"]);
  assert.deepEqual(view.others.map((section) => [section.status, section.label, section.rows.map((row) => row.record.id)]), [
    ["on_hold", "On hold", ["gym"]],
    ["finished", "Finished", ["dinner", "claim", "oldins"]],
    ["cancelled", "Cancelled", ["stan"]],
  ]);
  const old = view.others[1]!.rows.find((row) => row.record.id === "oldins")!;
  assert.deepEqual([old.category?.label, old.anchor?.id], ["Vehicles", "bike"], "each row knows its category and the anchor it belongs to");
  assert.equal(view.shown, 9);
});

test("a status with nothing in it has no section, and nothing chosen matching shows nothing", () => {
  const view = recordsView(ALL, BUILT_IN, { categories: ["health"], statuses: ["active", "cancelled"] });
  assert.deepEqual([view.active.length, view.others.length, view.shown], [1, 0, 1]);
  const none = recordsView(ALL, BUILT_IN, { categories: ["outings"], statuses: ["active"] });
  assert.deepEqual([none.active.length, none.others.length, none.shown], [0, 0, 0]);
});

test("a record whose anchor isn't in a chosen category stays in its own category", () => {
  const view = recordsView(ALL, BUILT_IN, { categories: ["vehicles"], statuses: ["active"] });
  assert.equal(view.active[0]!.anchors.length, 1);
  const home = rec("home", "home.property", { name: "Home" });
  const power = rec("power", "utilities.energy", { provider: "Red Energy" }, { parentId: "home" });
  const utilities = recordsView([home, power], BUILT_IN, { categories: ["utilities"], statuses: ["active"] });
  assert.deepEqual(utilities.active.map((section) => [section.category.id, section.loose.map((record) => record.id)]), [["utilities", ["power"]]]);
  const both = recordsView([home, power], BUILT_IN, { categories: [], statuses: ["active"] });
  assert.deepEqual(both.active.map((section) => section.category.id), ["home"], "under its home, Utilities has no panel of its own");
});

test("records of a category the person said is not for them aren't listed", () => {
  const states: CategoryStateView[] = BUILT_IN.categories.map((category) => ({ id: category.id, visibility: category.id === "outings" ? "not_for_me" : "shown", records: 0 }));
  assert.deepEqual(listedRecords(ALL, BUILT_IN, states).map((record) => record.id), ALL.filter((record) => record.id !== "dinner").map((record) => record.id));
});

test("a filter's link repeats each chosen value and leaves the default status out", () => {
  assert.equal(recordsHref({ categories: [], statuses: ["active"] }), "/life-admin?view=life&tab=records");
  assert.equal(
    recordsHref({ categories: ["vehicles", "health"], statuses: ["active", "finished"] }),
    "/life-admin?view=life&tab=records&category=vehicles&category=health&status=active&status=finished",
  );
  assert.equal(recordsHref({ categories: ["vehicles"], statuses: ["finished"] }), "/life-admin?view=life&tab=records&category=vehicles&status=finished");
});

test("the Records tab's monthly figure counts what's active and recurring in the chosen categories", () => {
  const priced = [
    rec("prime", "subscriptions.service", { provider: "Amazon", amount: "12.99", currency: "AUD", cycle: "monthly" }, { dueDate: "2026-12-25" }),
    rec("fund", "health.insurance", { provider: "Medibank", amount: "148.25", currency: "AUD", cycle: "monthly" }, { dueDate: "2027-03-01" }),
    rec("github", "subscriptions.service", { provider: "GitHub", amount: "16", currency: "USD", cycle: "monthly" }, { dueDate: "2026-12-15" }),
    rec("gone", "subscriptions.service", { provider: "Paramount+", amount: "12.99", currency: "AUD", cycle: "monthly" }, { status: "cancelled", dueDate: "2026-10-29" }),
    rec("paused", "subscriptions.membership", { provider: "Gym", amount: "60", currency: "AUD", cycle: "monthly" }, { status: "paused", dueDate: "2027-01-01" }),
  ];
  const everything = recordsView(priced, BUILT_IN, { categories: [], statuses: ["active", "cancelled", "on_hold"] });
  assert.deepEqual(everything.monthly, [{ currency: "AUD", amount: 161.24, records: 2 }, { currency: "USD", amount: 16, records: 1 }], "only active records count, whatever statuses are shown");
  const subscriptions = recordsView(priced, BUILT_IN, { categories: ["subscriptions"], statuses: ["active"] });
  assert.deepEqual(subscriptions.monthly, [{ currency: "AUD", amount: 12.99, records: 1 }, { currency: "USD", amount: 16, records: 1 }], "the category filter narrows it");
  assert.deepEqual(recordsView(priced, BUILT_IN, { categories: ["vehicles"], statuses: ["active"] }).monthly, []);
});
