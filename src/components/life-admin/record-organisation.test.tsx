// Life admin records, organised (docs/adr/life-admin-profile.md): "Your things" has one panel
// per category that shows — it has records, the person chose Show, or it is one of their own —
// in the catalogue's order, with an anchor (a vehicle, home, trip, pet) heading the records that
// belong to it and unlinked records after, and what is finished set aside in a collapsed
// "Finished (n)". Each row leads with its name, its kind and when it is due or happens in the
// kind's words, where it stands in words and an icon, then labelled facts, who is handling it
// and its next step, a one-line reminder summary and who added it, with "Open" (the item's
// page) and its controls behind ONE "Manage" disclosure. "Upcoming" lists what is happening
// now, overdue, this week and later, and the next steps with a date, each linking to its item.
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
      checklist={[]}
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

// The markup of one tab panel (0 Your things, 1 Upcoming, 2 Bookings, 3 Moving checklist).
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
  assert.deepEqual(reminderSummary("2026-12-01", [14, 1]), { on: true, text: "Reminds you 14 days before and 1 day before" });
  assert.deepEqual(reminderSummary("2026-12-01", [1, 30, 7, 7]), { on: true, text: "Reminds you 30 days before, 7 days before and 1 day before" });
  assert.deepEqual(reminderSummary("2026-12-01", [0]), { on: true, text: "Reminds you on the due date" });
  assert.deepEqual(reminderSummary("2026-12-01", []), { on: false, text: "Reminders off" });
  assert.deepEqual(reminderSummary(null, [14]), { on: false, text: "Reminders start once it has a due date" });
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

test("one panel per shown category, in catalogue order, with the category's label and description", () => {
  const titles = headings(tabPanel(render(), 0), 2);
  const categories = titles.filter((title) => BUILT_IN.categories.some((category) => category.label === title));
  assert.deepEqual(categories, ["Home", "Vehicles", "Health", "ID and residency", "Subscriptions and memberships", "Going out"]);
  assert.match(text(panelOf(render(), "Vehicles")), /Cars, motorcycles, caravans and boats, with their rego, insurance and servicing\./);
});

test("a category the person chose to show stays while empty, says so, and can be hidden again; Not for me hides one", () => {
  const states: CategoryStateView[] = BUILT_IN.categories.map((category) => ({
    id: category.id,
    visibility: category.id === "pets" ? "shown" : category.id === "legal" ? "not_for_me" : category.id === "health" ? "shown" : "available",
    records: category.id === "health" ? 1 : 0,
  }));
  const markup = render({ records: [HEALTH], categories: states });
  const pets = text(panelOf(markup, "Pets"));
  assert.match(pets, /Nothing here yet\./);
  assert.match(pets, /Hide until there's something here/);
  assert.ok(!headings(tabPanel(markup, 0), 2).includes("Legal and estate"), "a category that's not for them has no panel");
  assert.match(text(markup), /Not for me \(1\)/);
});

test("an anchor heads the records that belong to it; unlinked records follow under their own heading", () => {
  const markup = render();
  const vehicles = panelOf(markup, "Vehicles");
  assert.deepEqual(headings(vehicles, 3), ["Honda CB500X", "Not linked to a vehicle"]);
  const bike = vehicles.indexOf('id="record-bike"');
  const rego = vehicles.indexOf('id="record-rego"');
  const unlinked = vehicles.indexOf("Not linked to a vehicle");
  const insurance = vehicles.indexOf('id="record-ins"');
  assert.ok(bike >= 0 && bike < rego && rego < unlinked && unlinked < insurance, "bike, its rego, then the unlinked insurance");
  assert.match(text(vehicles), /Vehicle · Next: Registration · BX12AB, expires 14 Dec 2026/, "the anchor's line names its next record");
  assert.match(text(rowOf(markup, "bike")), /^.*Vehicle details Vehicle Current/, "the anchor's own row says what it is");
  assert.ok(panelOf(markup, "Home").includes('id="record-power"'), "the electricity account is listed under the home");
});

test("finished records sit in a collapsed Finished (n) group in their panel", () => {
  const outings = panelOf(render(), "Going out");
  const finished = /<details\b(?![^>]*\bopen\b)[^>]*>[\s\S]*?<\/details>/.exec(outings)?.[0] ?? "";
  assert.match(text(finished), /^Finished 1/, "a closed disclosure titled Finished with its count");
  assert.ok(finished.includes('id="record-lastdinner"'), "the dinner that's over is inside it");
  assert.ok(!finished.includes('id="record-dinner"'), "the upcoming one is not");
  assert.match(text(rowOf(render(), "lastdinner")), /Completed/);
});

test("each row: name, kind and when, its phase in words, facts, who's handling it and its next step, reminders, who added it, Open and one Manage", () => {
  const markup = render();
  const row = rowOf(markup, "rego");
  const manage = [...row.matchAll(/<summary\b[^>]*>([\s\S]*?)<\/summary>/g)].filter((m) => /^Manage\b/.test(text(m[1]!)));
  assert.equal(manage.length, 1, "exactly one Manage disclosure");
  assert.match(text(manage[0]![1]!), /^Manage Registration · BX12AB$/, "named for its record");
  const before = row.slice(0, row.indexOf(manage[0]![0]));
  const inside = row.slice(row.indexOf(manage[0]![0]));
  assert.match(text(before), /Registration · BX12AB Registration · Expires 14 Dec 2026 Due soon/);
  assert.match(text(before), /Registration authority Transport for NSW Number plate BX12AB/, "facts use the kind's labels");
  assert.match(text(before), /Handled by Instinct · Next: Book the roadworthy, due 28 Nov/);
  assert.match(text(before), /Reminds you 14 days before and 1 day before/);
  assert.match(text(before), /Added by you\./);
  assert.match(before, /href="\/life-admin\/items\/rego"[^>]*>Open/, "Open goes to the item's page");
  assert.doesNotMatch(before, /<form\b/, "no form sits outside Manage");
  assert.match(inside, /name="setting" value="reminder"/);
  assert.match(inside, /name="recordFormVersion" value="2"/, "the Edit form");
  assert.match(text(inside), /Delete this record and all its attached files\? This can't be undone\./);
});

test("a booking reads its start in its own zone, and a phase is words and an icon, never colour alone", () => {
  const row = rowOf(render(), "dinner");
  assert.match(text(row), /Sixpenny Restaurant · Starts Wed 25 Nov, 7:30 pm AEDT Upcoming/);
  assert.match(text(row), /How many 4 people/);
  assert.match(row, /class="wh-badge[^"]*"[^>]*><svg[^>]*aria-hidden="true"[\s\S]*?Upcoming/);
});

test("a legacy record reads through its kind's type: a subscription renews, its cost is one line", () => {
  const row = text(rowOf(render(), "netflix"));
  assert.match(row, /Netflix Subscription · Renews 23 Nov 2026 Due soon/);
  assert.match(row, /Cost AUD 25\.99 a month/);
});

test("Upcoming: happening now, overdue, this week and later, each line linking to its item, and next steps due", () => {
  const upcoming = tabPanel(render({
    nextSteps: [{ id: "n1", recordId: "rego", recordName: "Registration · BX12AB", text: "Book the roadworthy", due: "2026-11-28" }],
  }), 1);
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
  assert.match(upcoming, /text-warning/, "an overdue line carries the warning icon as well as its words");
});

test("Upcoming says so when nothing is due", () => {
  const upcoming = text(tabPanel(render({ records: [PASSPORT] }), 1));
  assert.match(upcoming, /Nothing due in the next 60 days\./);
  assert.match(upcoming, /No next steps with a date\./);
});

test("a receipt's attach control and its downloads keep their places: attach inside Manage, downloads visible", () => {
  const receipt = rec("kettle", "belongings.receipt", { item: "Kettle" }, { kind: "receipt_warranty", dueDate: "2026-12-01", files: [{ id: "f1", size: 1048576 }] });
  const row = rowOf(render({ records: [receipt] }), "kettle");
  const at = row.search(/<summary\b[^>]*>(?:(?!<\/summary>)[\s\S])*Manage/);
  assert.ok(at > 0);
  assert.match(row.slice(0, at), /href="\/api\/receipts\/f1"/, "the download link is visible without opening Manage");
  assert.match(row.slice(at), /type="file"/, "the attach control is inside Manage");
});

test("record anchors keep working: the row is focusable, clears the sticky header and is in the visible tab", () => {
  const markup = render();
  const row = /<li\b([^>]*)id="record-rego"([^>]*)>/.exec(markup)!;
  assert.ok(row, "the row carries its #record- anchor");
  assert.match(row[0]!, /tabindex="-1"/);
  assert.match(row[0]!, /scroll-mt-32/);
  const panel = markup.lastIndexOf('role="tabpanel"', markup.indexOf('id="record-rego"'));
  const attrs = markup.slice(markup.lastIndexOf("<div", panel), markup.indexOf(">", panel));
  assert.doesNotMatch(attrs, /hidden=""/, "Your things is the tab shown first");
  assert.equal(markup.match(/id="record-rego"/g)?.length, 1, "one anchor per record, even when it is also in Upcoming");
});

test("the organised view uses tokens, never raw hex", () => {
  assert.doesNotMatch(render(), /#[0-9a-fA-F]{3,8}\b/);
});
