// Life admin records, organised (docs/adr/life-admin-profile.md; founder, 23 Nov 2026): the
// Records tab shows what's ongoing — never a booking (Upcoming's) and never anything finished
// (History's) — what's active first, one panel per category with something active in it, in the
// catalogue's order, with an anchor (a vehicle, home, pet) heading the records that belong to it
// and unlinked records after, most urgent first; never an empty panel. A toolbar filters by
// category and by status (Active and On hold, either or both), says what's shown, what isn't and
// how much is in History, and On hold, when chosen, follows as its own quieter list across
// categories. Each row is compact: its name (linking to the item's page), where it stands in
// words and an icon, one muted line (kind, when, cost, provider) and who is handling it; its
// facts, reminders, who added it and its controls sit behind ONE "Details" disclosure.
// "Upcoming" lists what is happening now, overdue, this week and later, every booking further
// ahead or without a date, and the next steps with a date.
//
// The loader hands the view each record's phase (from the one lifecycle module) and the
// person's local date; the view never reads the clock, so these tests work the phases out at a
// fixed instant and assert what the markup renders.

import * as React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";

import { LifeAdminView, type LifeAdminRecordView, type LifeAdminViewProps } from "./life-admin-view";
import { addDays, organiseByCategory, reminderSummary, upcomingSections } from "./record-groups";
import { BUILT_IN } from "@/domain/life-admin/catalogue";
import { phased } from "./phase-fixture";
import type { CategoryStateView } from "./record-view-types";

const TODAY = "2026-11-23";
const ZONE = "Australia/Sydney";
const noop = () => {};

function rec(id: string, type: string, fields: Record<string, string>, over: Partial<LifeAdminRecordView> = {}): LifeAdminRecordView {
  return phased({ id, kind: "item", type, fields, dueDate: null, status: "active", reminderOffsets: [14, 1], ...over });
}

const BIKE = rec("bike", "vehicles.vehicle", { name: "Honda CB500X", plate: "BX12AB" });
const BIKE_REGO = rec("rego", "vehicles.registration", { provider: "Transport for NSW", plate: "BX12AB" }, {
  parentId: "bike",
  dueDate: "2026-12-14",
  handling: { steward: "Instinct", next: { id: "n1", text: "Book the roadworthy", due: "2026-11-28" } },
});
const LOOSE_INSURANCE = rec("ins", "vehicles.insurance", { provider: "NRMA", reference: "POL-77" }, { dueDate: "2027-06-01" });
const HOME = rec("home", "home.property", { name: "Home", address: "1 Example St" });
const POWER = rec("power", "utilities.energy", { provider: "Red Energy", service: "electricity" }, { parentId: "home" });
const HEALTH = rec("health", "health.insurance", { provider: "Medibank" }, { dueDate: "2026-11-02" }); // overdue
const PASSPORT = rec("passport", "id.passport", { country: "Australia" }, { dueDate: "2027-03-01" }); // beyond 60 days
const CANCELLED = rec("gym", "subscriptions.membership", { provider: "Fitness First" }, { dueDate: "2026-11-30", status: "cancelled" });
const DINNER = rec("dinner", "outings.restaurant", { provider: "Sixpenny", starts_at: "2026-11-25T19:30+11:00[Australia/Sydney]", party_size: "4" }, { dueDate: "2026-11-25" });
const LAST_DINNER = rec("lastdinner", "outings.restaurant", { provider: "Ester", starts_at: "2026-10-02T19:00+10:00[Australia/Sydney]" }, { dueDate: "2026-10-02" });
const LEGACY_SUB = phased({ id: "netflix", kind: "subscription", fields: { name: "Netflix", amount: "25.99", currency: "AUD", cycle: "monthly" }, dueDate: TODAY, status: "active", reminderOffsets: [14, 1] });

const ALL = [HEALTH, BIKE, BIKE_REGO, LOOSE_INSURANCE, HOME, POWER, PASSPORT, CANCELLED, DINNER, LAST_DINNER, LEGACY_SUB];

function render(over: Partial<LifeAdminViewProps> = {}): string {
  return renderToStaticMarkup(
    <LifeAdminView
      today={TODAY}
      zone={ZONE}
      records={ALL}
      addRecordAction={noop}
      editRecordAction={noop}
      attachFileAction={noop}
      deleteRecordAction={noop}
      setCategoryVisibilityAction={noop}
      {...over}
    />,
  );
}

function text(markup: string): string {
  return markup
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function headings(markup: string, level: number): string[] {
  return [...markup.matchAll(new RegExp(`<h${level}\\b[^>]*>([\\s\\S]*?)</h${level}>`, "g"))].map((m) => text(m[1]!));
}

// The markup of one tab panel (0 Records, 1 Upcoming, 2 History).
function tabPanel(markup: string, index: number): string {
  const starts = [...markup.matchAll(/<div\b[^>]*role="tabpanel"[^>]*>/g)].map((m) => m.index!);
  return markup.slice(starts[index], starts[index + 1] ?? markup.length);
}

// The markup of one record row: from its anchor to the next record's (or the end).
function rowOf(markup: string, id: string): string {
  const start = markup.indexOf(`id="record-${id}"`);
  assert.ok(start >= 0, `record ${id} renders with its #record-${id} anchor`);
  const next = markup.indexOf('id="record-', start + 1);
  return markup.slice(start, next < 0 ? undefined : next);
}

// The markup of the panel (a WorkspacePanel <section>) whose h2 starts with `title`, up to the next one.
function panelOf(markup: string, title: string): string {
  const at = markup.search(new RegExp(`<h2\\b[^>]*>(?:<span[^>]*>)?${title}`));
  assert.ok(at >= 0, `a "${title}" panel renders`);
  const start = markup.lastIndexOf("<section", at);
  const next = markup.slice(at).search(/<section aria-labelledby="[^"]*" class="wh-panel[ "]/);
  return markup.slice(start, next < 0 ? undefined : at + next);
}

const shownFor = (records: readonly LifeAdminRecordView[]) =>
  new Set(records.map((record) => BUILT_IN.typeOfRecord(record.kind, record.type ?? null).category));

// ─── the pure helpers ────────────────────────────────────────────────────────────────

test("addDays crosses month and year ends on calendar dates", () => {
  assert.equal(addDays("2026-11-12", 30), "2026-12-12");
  assert.equal(addDays("2026-12-15", 30), "2027-01-14");
  assert.equal(addDays("2028-02-28", 1), "2028-02-29", "leap day");
});

test("reminderSummary states the reminder setting in one plain line", () => {
  assert.deepEqual(reminderSummary("2026-12-01", [14, 1]), { on: true, text: "Reminds you 14 days and 1 day before" });
  assert.deepEqual(reminderSummary("2026-12-01", [1, 30, 7, 7]), { on: true, text: "Reminds you 30 days, 7 days and 1 day before" }, "soonest last, each day once");
  assert.deepEqual(reminderSummary("2026-12-01", [0]), { on: true, text: "Reminds you on the day" });
  assert.deepEqual(reminderSummary("2026-12-01", []), { on: false, text: "No reminders" });
  assert.equal(reminderSummary(null, [14]), null, "nothing to say without a date");
});

test("organiseByCategory: catalogue order, anchors with their records (whatever their category), unlinked after, finished set aside", () => {
  const { sections } = organiseByCategory(ALL, BUILT_IN, shownFor(ALL));
  assert.deepEqual(sections.map((section) => section.category.id), ["home", "vehicles", "health", "id", "subscriptions", "outings"]);
  const vehicles = sections.find((section) => section.category.id === "vehicles")!;
  assert.deepEqual(vehicles.anchors.map((group) => [group.anchor.id, group.children.map((child) => child.id)]), [["bike", ["rego"]]]);
  assert.deepEqual(vehicles.loose.map((record) => record.id), ["ins"]);
  const home = sections.find((section) => section.category.id === "home")!;
  assert.deepEqual(home.anchors.map((group) => group.children.map((child) => child.id)), [["power"]], "the electricity account sits under the home");
  assert.ok(!sections.some((section) => section.category.id === "utilities"), "Utilities has nothing to show on its own");
  const subscriptions = sections.find((section) => section.category.id === "subscriptions")!;
  assert.deepEqual([subscriptions.loose.map((r) => r.id), subscriptions.finished.map((r) => r.id)], [["netflix"], ["gym"]], "a cancelled membership is finished");
  const outings = sections.find((section) => section.category.id === "outings")!;
  assert.deepEqual([outings.loose.map((r) => r.id), outings.finished.map((r) => r.id)], [["dinner"], ["lastdinner"]], "a dinner that's over is finished");
  const orphan = rec("orphan", "vehicles.service", { provider: "Bike Shop" }, { parentId: "gone" });
  assert.deepEqual(organiseByCategory([orphan], BUILT_IN).sections[0]!.loose.map((record) => record.id), ["orphan"], "a link to a record that isn't there reads as unlinked");
});

test("a finished anchor takes its records with it into Finished; a live anchor's finished record goes there too", () => {
  const trip = rec("trip", "travel.trip", { name: "Tokyo" }, { status: "done" });
  const flight = rec("flight", "travel.flight", { provider: "Qantas", starts_at: "2026-09-01T09:00+10:00[Australia/Sydney]" }, { parentId: "trip", dueDate: "2026-09-01" });
  const bike = rec("bike2", "vehicles.vehicle", { name: "Vespa" });
  const oldService = rec("svc", "vehicles.booking", { provider: "Moto", starts_at: "2026-08-01T09:00+10:00[Australia/Sydney]" }, { parentId: "bike2", dueDate: "2026-08-01" });
  const { sections } = organiseByCategory([trip, flight, bike, oldService], BUILT_IN);
  const travel = sections.find((section) => section.category.id === "travel")!;
  assert.deepEqual([travel.anchors.length, travel.finished.map((r) => r.id)], [0, ["trip", "flight"]]);
  const vehicles = sections.find((section) => section.category.id === "vehicles")!;
  assert.deepEqual([vehicles.anchors[0]!.children.length, vehicles.finished.map((r) => r.id)], [0, ["svc"]]);
});

test("a record linked to an anchor in a hidden category stays in its own category", () => {
  const { sections } = organiseByCategory([HOME, POWER], BUILT_IN, new Set(["utilities"]));
  assert.deepEqual(sections.map((section) => [section.category.id, section.loose.map((r) => r.id)]), [["utilities", ["power"]]]);
});

test("upcomingSections: happening now, overdue, this week and later, from each record's phase", () => {
  const stay = rec("stay", "travel.stay", { provider: "Park Hyatt", starts_at: "2026-11-22T15:00+11:00[Australia/Sydney]", ends_at: "2026-11-24T11:00+11:00[Australia/Sydney]" }, { dueDate: "2026-11-22" });
  const sections = upcomingSections([...ALL, stay]);
  assert.deepEqual(sections.now.map((r) => r.id), ["stay"]);
  assert.deepEqual(sections.overdue.map((r) => r.id), ["health"]);
  assert.deepEqual(sections.week.map((r) => r.id), ["netflix", "dinner"]);
  assert.deepEqual(sections.later.map((r) => r.id), ["rego"]);
  const edge = [rec("on60", "other.item", {}, { dueDate: addDays(TODAY, 60) }), rec("on61", "other.item", {}, { dueDate: addDays(TODAY, 61) })];
  assert.deepEqual(upcomingSections(edge).later.map((r) => r.id), ["on60"], "the 60th day is in, the 61st out");
});

// ─── the organised view ──────────────────────────────────────────────────────────────

// The markup of the Records toolbar.
function toolbarOf(markup: string): string {
  const start = markup.indexOf('<section aria-label="Filter records"');
  assert.ok(start >= 0, "the Records toolbar renders");
  return markup.slice(start, markup.indexOf("</section>", start) + 10);
}

test("one panel per category with something active, in catalogue order, with its label", () => {
  const titles = headings(tabPanel(render(), 0), 2);
  const categories = titles.filter((title) => BUILT_IN.categories.some((category) => category.label === title));
  assert.deepEqual(categories, ["Home", "Vehicles", "Health", "ID and residency", "Subscriptions and memberships"], "no Going out: the dinner booked is Upcoming's, the one that's over History's");
  assert.doesNotMatch(text(panelOf(render(), "Vehicles")), /Cars, motorcycles, caravans and boats/, "no boilerplate description: the rows are what matters");
});

test("a category with nothing active never has a panel, even one the person chose to show; Not for me hides one and its records", () => {
  const states: CategoryStateView[] = BUILT_IN.categories.map((category) => ({
    id: category.id,
    visibility: category.id === "pets" ? "shown" : category.id === "outings" ? "not_for_me" : category.id === "health" ? "shown" : "available",
    records: category.id === "health" ? 1 : category.id === "outings" ? 1 : 0,
  }));
  const markup = render({ records: [HEALTH, DINNER], categories: states });
  const panels = headings(tabPanel(markup, 0), 2);
  assert.ok(panels.some((title) => title.startsWith("Health")));
  assert.ok(!panels.some((title) => title.startsWith("Pets")), "an empty category shown by choice has no panel");
  assert.ok(!panels.some((title) => title.startsWith("Going out")), "a category that's not for them has no panel");
  assert.ok(!markup.includes('id="record-dinner"'), "and its records aren't listed");
  assert.doesNotMatch(text(markup), /Nothing here yet|Hide until there's something here/);
  assert.match(text(markup), /Not for me \(1\)/);
});

test("an anchor heads the records that belong to it, most urgent first; unlinked records follow under their own heading", () => {
  const markup = render();
  const vehicles = panelOf(markup, "Vehicles");
  assert.deepEqual(headings(vehicles, 3), ["Honda CB500X", "Not linked to a vehicle"]);
  const bike = vehicles.indexOf('id="record-bike"');
  const rego = vehicles.indexOf('id="record-rego"');
  const unlinked = vehicles.indexOf("Not linked to a vehicle");
  const insurance = vehicles.indexOf('id="record-ins"');
  assert.ok(bike >= 0 && bike < rego && rego < unlinked && unlinked < insurance, "bike, its rego, then the unlinked insurance");
  assert.match(text(vehicles), /Vehicle · Next: Registration · BX12AB, expires 14 Dec 2026/, "the anchor's line names its next record");
  assert.match(text(rowOf(markup, "bike")), /^.*Vehicle details : Honda CB500X Current Details/, "the anchor's own row says what it is");
  assert.ok(panelOf(markup, "Home").includes('id="record-power"'), "the electricity account is listed under the home");
  const lateIns = rec("late", "vehicles.insurance", { provider: "Youi" }, { dueDate: "2026-11-01" });
  const soon = rec("soon", "vehicles.roadside", { provider: "NRMA Roadside" }, { dueDate: "2026-12-01" });
  const order = panelOf(render({ records: [LOOSE_INSURANCE, soon, lateIns] }), "Vehicles");
  assert.ok(order.indexOf('id="record-late"') < order.indexOf('id="record-soon"') && order.indexOf('id="record-soon"') < order.indexOf('id="record-ins"'), "overdue, due soon, then by date");
});

test("by default what isn't active is left out, and one line says so: what's on hold a link that adds it, what's finished a link to History", () => {
  const paused = rec("paused", "subscriptions.membership", { provider: "Anytime Fitness" }, { status: "paused", dueDate: "2027-01-01" });
  const markup = render({ records: [...ALL, paused] });
  const records = tabPanel(markup, 0);
  assert.ok(!records.includes('id="record-paused"'), "what's on hold isn't listed");
  assert.ok(!records.includes('id="record-gym"') && !records.includes('id="record-lastdinner"'), "the cancelled membership and the dinner that's over aren't on Records");
  assert.doesNotMatch(records, /<details\b[^>]*>\s*<summary[^>]*wh-list-group-header/, "no collapsed Finished group in any panel");
  const toolbar = toolbarOf(markup);
  const status = /<p role="status"[^>]*>([\s\S]*?)<\/p>/.exec(toolbar)!;
  assert.match(text(status[1]!), /^8 active · Not shown: 1 on hold : show them · 2 finished or cancelled\s?, in History$/);
  const links = [...status[1]!.matchAll(/<a href="([^"]+)"/g)].map((m) => m[1]!.replace(/&amp;/g, "&"));
  assert.deepEqual(links, ["/life-admin?status=active&status=on_hold", "/life-admin?tab=history"]);
});

test("the toolbar: Category and Status, multiple-choice, in a plain GET form, summarising the choice", () => {
  const toolbar = toolbarOf(render());
  const form = /<form\b([^>]*)>([\s\S]*?)<\/form>/.exec(toolbar)!;
  assert.match(form[1]!, /action="\/life-admin"/);
  assert.doesNotMatch(form[2]!, /type="hidden"/, "Records is the default tab: the form needs no tab of its own");
  const summaries = [...form[2]!.matchAll(/<summary\b[^>]*>([\s\S]*?)<\/summary>/g)].map((m) => text(m[1]!));
  assert.deepEqual(summaries, ["Category: All", "Status: Active"]);
  const boxes = (name: string) => [...form[2]!.matchAll(new RegExp(`<label\\b[^>]*>(<input type="checkbox"[^>]*name="${name}"[^>]*>)([\\s\\S]*?)</label>`, "g"))].map((m) => [text(m[2]!), /\bchecked=""/.test(m[1]!)]);
  assert.deepEqual(boxes("category"), [
    ["Home 1 1 record", false], ["Utilities 1 1 record", false], ["Vehicles 3 3 records", false], ["Health 1 1 record", false],
    ["ID and residency 1 1 record", false], ["Subscriptions and memberships 1 1 record", false],
  ], "every category with a record on Records, in catalogue order, each counting its own records among what's shown");
  assert.deepEqual(boxes("status"), [["Active 8 8 records", true], ["On hold 0 0 records", false]], "Finished and Cancelled are History's");
  assert.match(form[2]!, /type="submit"[^>]*>Apply</, "Apply, for when there's no JavaScript");
  assert.doesNotMatch(toolbar, /Clear all filters/, "nothing applied, nothing to clear");
});

test("two categories: only their panels, chips to remove each, and the summary names the first and how many more", () => {
  const markup = render({ recordFilter: { categories: ["vehicles", "health"], statuses: ["active"] } });
  const panels = headings(tabPanel(markup, 0), 2).filter((title) => BUILT_IN.categories.some((category) => title.startsWith(category.label)));
  assert.deepEqual(panels, ["Vehicles", "Health"]);
  const toolbar = toolbarOf(markup);
  assert.equal(text(/<summary\b[^>]*>([\s\S]*?)<\/summary>/.exec(toolbar)![1]!), "Category: Vehicles +1");
  const chips = [...toolbar.matchAll(/<a href="([^"]+)"[^>]*>(?:(?!<\/a>)[\s\S])*?Remove filter (?:<\/span>)?([^<]+)/g)].map((m) => [text(m[2]!), m[1]!.replace(/&amp;/g, "&")]);
  assert.deepEqual(chips, [
    ["Category: Vehicles", "/life-admin?category=health"],
    ["Category: Health", "/life-admin?category=vehicles"],
  ]);
  assert.match(toolbar, /href="\/life-admin"[^>]*>Clear all filters/);
  assert.match(text(/<p role="status"[^>]*>([\s\S]*?)<\/p>/.exec(toolbar)![1]!), /^4 active$/, "nothing else in these categories");
});

test("Active and On hold: what's active first by category, then On hold as its own quieter list, newest first, each row with its category", () => {
  const paused = rec("paused", "subscriptions.membership", { provider: "Anytime Fitness" }, { status: "paused", dueDate: "2027-01-01" });
  const pausedEarlier = rec("pausedins", "vehicles.insurance", { provider: "Youi" }, { status: "paused", dueDate: "2026-06-01" });
  const markup = render({ records: [...ALL, paused, pausedEarlier], recordFilter: { categories: [], statuses: ["active", "on_hold"] } });
  const panel = tabPanel(markup, 0);
  const onHoldAt = panel.search(/<section aria-labelledby="records-on_hold-heading"/);
  assert.ok(onHoldAt > 0, "an On hold list");
  assert.ok(panel.indexOf(">Subscriptions and memberships") < onHoldAt, "after every Active panel");
  const onHold = panel.slice(onHoldAt, panel.indexOf("</section>", onHoldAt));
  assert.match(onHold, /<h2 id="records-on_hold-heading"><span class="text-fg-muted">On hold<\/span><\/h2>/, "a quieter heading");
  assert.match(text(onHold), /^On hold 2 Paused for now, newest first\./);
  assert.ok(onHold.indexOf('id="record-paused"') < onHold.indexOf('id="record-pausedins"'), "newest first");
  assert.match(text(rowOf(onHold, "paused")), /^.*Anytime Fitness Paused Subscriptions and memberships · Membership/, "the category leads its line");
  assert.ok(!panel.slice(0, onHoldAt).includes('id="record-paused"'), "statuses never mix: the paused membership isn't in the Subscriptions panel");
  const toolbar = toolbarOf(markup);
  assert.match(text(/<p role="status"[^>]*>([\s\S]*?)<\/p>/.exec(toolbar)![1]!), /^8 active, 2 on hold · 2 finished or cancelled\s?, in History$/);
  assert.deepEqual([...toolbar.matchAll(/Remove filter <\/span>([^<]+)/g)].map((m) => m[1]), ["Status: Active", "Status: On hold"]);
});

test("Records never lists what's finished or cancelled, and a chosen status with nothing in it has no list", () => {
  const paused = rec("paused", "subscriptions.membership", { provider: "Anytime Fitness" }, { status: "paused", dueDate: "2027-01-01" });
  const panel = tabPanel(render({ records: [...ALL, paused], recordFilter: { categories: [], statuses: ["on_hold", "active"] } }), 0);
  const lists = [...panel.matchAll(/<section aria-labelledby="records-([a-z_]+)-heading"/g)].map((m) => m[1]);
  assert.deepEqual(lists, ["on_hold"]);
  const nothingOnHold = tabPanel(render({ records: [HEALTH], recordFilter: { categories: [], statuses: ["active", "on_hold"] } }), 0);
  assert.doesNotMatch(nothingOnHold, /records-on_hold-heading/, "a chosen status with nothing in it has no list");
});

test("a filter that matches nothing shows one empty state with Clear filters, and no panels", () => {
  const markup = render({ recordFilter: { categories: ["outings"], statuses: ["on_hold"] } });
  const panel = tabPanel(markup, 0);
  assert.match(text(panel), /No records match these filters\. Choose other categories or statuses, or clear the filters to see what's active\. Clear filters/);
  assert.equal((panel.match(/No records match these filters/g) ?? []).length, 1, "one empty state");
  assert.match(panel, /href="\/life-admin"[^>]*>Clear filters/);
  assert.ok(!headings(panel, 2).some((title) => BUILT_IN.categories.some((category) => title.startsWith(category.label))), "no category panel");
  const paused = rec("paused", "subscriptions.membership", { provider: "Anytime Fitness" }, { status: "paused", dueDate: "2027-01-01" });
  const nothingActive = tabPanel(render({ records: [paused, CANCELLED, LAST_DINNER] }), 0);
  assert.match(text(nothingActive), /Nothing is active right now\. What you keep here is on hold\. What's finished is in History\. Show what's on hold/);
  assert.match(nothingActive, /href="\/life-admin\?status=active&amp;status=on_hold"[^>]*>Show what&#x27;s on hold/);
  const allFinished = tabPanel(render({ records: [CANCELLED, LAST_DINNER] }), 0);
  assert.match(text(allFinished), /Nothing ongoing yet\. Your accounts, policies, memberships and things show here\. What's finished is in History\. Go to History/);
  assert.doesNotMatch(allFinished, /Filter records/, "nothing ongoing: nothing to filter");
  assert.match(allFinished, /href="\/life-admin\?tab=history"[^>]*>Go to History/);
});

// The Add tab (founder, 24 Nov 2026): Records keeps what's on file; what's still to fill in and
// adding a record are on Add.
test("with no records at all, Records says nothing is on file yet and points to Add, which offers how to fill it in", () => {
  const markup = render({ records: [] });
  const records = tabPanel(markup, 0);
  assert.doesNotMatch(records, /aria-label="Filter records"/);
  assert.doesNotMatch(text(records), /No records match|Nothing is active|Fill in your life admin|Add something yourself/);
  assert.match(text(records), /Nothing on file yet\./);
  assert.match(records, /href="\/life-admin\?tab=add"[^>]*>[\s\S]*?Add a record/);
  const add = tabPanel(markup, 1);
  assert.match(text(add), /Fill in your life admin/);
  assert.match(text(add), /Add something yourself/);
});

test("Records holds only what's on file, with a way to Add; Fill in the rest and Add something yourself are on Add", () => {
  const markup = render();
  const records = tabPanel(markup, 0);
  assert.doesNotMatch(text(records), /Fill in the rest|Add something yourself|Not for me \(/);
  assert.match(records, /href="\/life-admin\?tab=add"[^>]*>[\s\S]*?Add a record/);
  const add = tabPanel(markup, 1);
  assert.match(text(add), /Fill in the rest/);
  assert.match(text(add), /Add something yourself/);
  assert.match(add, /<input type="hidden" name="returnTab" value="add"\/>/, "what's done on Add comes back to Add");
});

test("each row is compact: its name linking to its page, where it stands, one muted line and who's handling it; the rest is one click away in Details", () => {
  const markup = render();
  const row = rowOf(markup, "rego");
  const details = [...row.matchAll(/<summary\b[^>]*>([\s\S]*?)<\/summary>/g)].filter((m) => /^Details\b/.test(text(m[1]!)));
  assert.equal(details.length, 1, "exactly one Details disclosure");
  assert.match(text(details[0]![1]!), /^Details Registration · BX12AB$/, "named for its record");
  const before = row.slice(0, row.indexOf(details[0]![0]));
  const inside = row.slice(row.indexOf(details[0]![0]));
  assert.match(before, /<a href="\/life-admin\/items\/rego"[^>]*>Registration · BX12AB<\/a>/, "the name opens the item's page");
  assert.match(text(before), /> Registration · BX12AB Due soon Expires 14 Dec 2026 · Transport for NSW Handled by Instinct · Next: Book the roadworthy, due 28 Nov$/);
  assert.doesNotMatch(before, /<form\b/, "no form sits outside Details");
  assert.match(text(inside), /Registration authority Transport for NSW Number plate BX12AB/, "the facts, with the kind's labels");
  assert.match(text(inside), /Reminds you 14 days and 1 day before · Expires 14 Dec 2026/);
  assert.match(text(inside), /Added by you\./);
  assert.match(inside, /name="setting" value="reminder"/);
  assert.match(inside, /name="recordFormVersion" value="2"/, "the Edit form");
  assert.match(text(inside), /Delete this record and all its attached files\? This can't be undone\./);
});

test("a booking reads its start in its own zone, and a phase is words and an icon, never colour alone", () => {
  const pastLunch = rec("lunch", "outings.restaurant", { provider: "Bennelong", starts_at: "2026-09-12T12:30+10:00[Australia/Sydney]", party_size: "4" }, { dueDate: "2026-09-12" });
  const markup = render({ records: [...ALL, pastLunch] });
  const upcoming = tabPanel(markup, 2);
  assert.match(text(upcoming), /Sixpenny Upcoming Restaurant · Starts Wed 25 Nov, 7:30 pm AEDT · in 2 days/, "one ahead, in Upcoming");
  assert.match(upcoming.slice(upcoming.indexOf('href="/life-admin/items/dinner"')), /^[^]*?class="wh-badge[^"]*"[^>]*><svg[^>]*aria-hidden="true"[\s\S]*?Upcoming/);
  const past = rowOf(tabPanel(markup, 3), "lunch");
  assert.match(text(past), /Bennelong Completed Going out · Restaurant · Starts Sat 12 Sept, 12:30 pm AEST Details/, "one that's over, in History, in the zone of its own date");
  assert.match(text(past), /How many 4 people/);
  assert.match(past, /class="wh-badge[^"]*"[^>]*><svg[^>]*aria-hidden="true"[\s\S]*?Completed/);
});

test("a legacy record reads through its kind's type: a subscription renews, its cost is on its line", () => {
  const row = text(rowOf(render(), "netflix"));
  assert.match(row, /Netflix Due soon Subscription · Renews 23 Nov 2026 · AUD 25\.99 a month Details/);
  assert.match(row, /Cost AUD 25\.99 a month/);
});

test("Upcoming: happening now, overdue, this week and later, each line linking to its item, and next steps due", () => {
  const upcoming = tabPanel(render({
    nextSteps: [{ id: "n1", recordId: "rego", recordName: "Registration · BX12AB", text: "Book the roadworthy", due: "2026-11-28" }],
  }), 2);
  assert.deepEqual(headings(upcoming, 3), ["Overdue", "This week", "Later (next 60 days)"]);
  const lines = [...upcoming.matchAll(/<a href="\/life-admin\/items\/([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)].map((m) => [m[1], text(m[2]!)]);
  assert.deepEqual(lines, [
    ["health", "Medibank"],
    ["netflix", "Netflix"],
    ["dinner", "Sixpenny"],
    ["rego", "Registration · BX12AB"],
    ["rego", "Registration · BX12AB"],
  ]);
  assert.match(text(upcoming), /Medibank Overdue Health insurance · Renews or extras reset 2 Nov 2026 · 21 days ago/);
  assert.match(text(upcoming), /Book the roadworthy Due 28 Nov, in 5 days · Registration · BX12AB/);
  assert.match(upcoming, /wh-tone-warning/, "an overdue line carries the warning badge as well as its words");
});

test("Upcoming says so when nothing is due or booked, with a way to add a booking", () => {
  const upcoming = tabPanel(render({ records: [PASSPORT] }), 2);
  assert.match(text(upcoming), /Nothing coming up\. Bookings, and renewals and expiry dates in the next 60 days, show here\. Past ones move to History\./);
  assert.match(upcoming, /href="\/life-admin\?tab=add#new-record"[^>]*>Add a booking/);
  assert.match(text(upcoming), /No next steps with a date\./);
});

test("a receipt's downloads and its attach control are in its Details", () => {
  const receipt = rec("kettle", "belongings.receipt", { item: "Kettle" }, { kind: "receipt_warranty", dueDate: "2026-12-01", files: [{ id: "f1", size: 1048576 }] });
  const row = rowOf(render({ records: [receipt] }), "kettle");
  const at = row.search(/<summary\b[^>]*>(?:(?!<\/summary>)[\s\S])*Details/);
  assert.ok(at > 0);
  assert.match(row.slice(at), /href="\/api\/receipts\/f1"[^>]*>Download attachment 1 \(1\.0 MB\)/, "the download is one click away");
  assert.match(row.slice(at), /type="file"/, "the attach control too");
});

test("record anchors keep working: the row is focusable, clears the sticky header and is in the visible tab", () => {
  const markup = render();
  const row = /<li\b([^>]*)id="record-rego"([^>]*)>/.exec(markup)!;
  assert.ok(row, "the row carries its #record- anchor");
  assert.match(row[0]!, /tabindex="-1"/);
  assert.match(row[0]!, /scroll-mt-32/);
  const panel = markup.lastIndexOf('role="tabpanel"', markup.indexOf('id="record-rego"'));
  const attrs = markup.slice(markup.lastIndexOf("<div", panel), markup.indexOf(">", panel));
  assert.doesNotMatch(attrs, /hidden=""/, "Records is the tab shown first");
  assert.equal(markup.match(/id="record-rego"/g)?.length, 1, "one anchor per record, even when it is also in Upcoming");
});

test("the organised view uses tokens, never raw hex", () => {
  assert.doesNotMatch(render(), /#[0-9a-fA-F]{3,8}\b/);
});

test("the toolbar says what the active, recurring records cost a month, and says nothing when none has a price", () => {
  const github = phased({ id: "github", kind: "subscription", type: "subscriptions.service", fields: { name: "GitHub Team", amount: "16", currency: "USD", cycle: "monthly" }, dueDate: TODAY, status: "active", reminderOffsets: [] });
  const priced = text(toolbarOf(render({ records: [github, LEGACY_SUB] })));
  assert.match(priced, /You pay about AUD 25\.99 and USD 16\.00 a month for 2 recurring records\./, "the larger figure leads, whichever was saved first");
  const one = text(toolbarOf(render({ records: [LEGACY_SUB] })));
  assert.match(one, /You pay about AUD 25\.99 a month for 1 recurring record\./);
  assert.doesNotMatch(text(toolbarOf(render({ records: [LOOSE_INSURANCE] }))), /You pay/);
});

test("when everything kept is in categories marked not for me, Life admin opens on Add and Records says why it's empty", () => {
  const states: CategoryStateView[] = BUILT_IN.categories.map((category) => ({
    id: category.id,
    visibility: category.id === "health" ? "not_for_me" : "available",
    records: category.id === "health" ? 1 : 0,
  }));
  const markup = render({ records: [HEALTH], categories: states });
  const selected = /<button\b[^>]*aria-selected="true"[^>]*>([\s\S]*?)<\/button>/.exec(markup)!;
  assert.equal(text(selected[1]!), "Add", "nothing is shown on any tab, so Add opens");
  const records = tabPanel(markup, 0);
  assert.match(text(records), /Nothing to show\. What you keep is in categories you said are not for you\./);
  assert.doesNotMatch(text(records), /Nothing on file yet/);
  assert.match(text(tabPanel(markup, 1)), /Not for me \(1\)/);
});
