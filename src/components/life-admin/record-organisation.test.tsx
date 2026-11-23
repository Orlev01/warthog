// Life admin records, organised as "Your things" (docs/adr/life-admin-profile.md): a Coming up
// list of what is overdue or due in the next 60 days, soonest first, each line linking to its
// record; then one panel per category that has records, in the catalogue's order, with a
// vehicle, home or pet heading the records that belong to it and unlinked records after.
// Each row leads with its name, its type, due date in the type's words and status, a one-line
// reminder summary and who added it, with its controls behind ONE "Manage" disclosure.
//
// The loader hands the view the person's local date (`today`); the view never reads the
// clock, so these tests pin a fixed date and assert what the markup renders.

import * as React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";

import { LifeAdminView, type LifeAdminRecordView, type LifeAdminViewProps } from "./life-admin-view";
import { addDays, comingUp, isLive, organiseByCategory, reminderSummary } from "./record-groups";

const TODAY = "2026-11-23";
const noop = () => {};

function rec(id: string, type: string, fields: Record<string, string>, over: Partial<LifeAdminRecordView> = {}): LifeAdminRecordView {
  return { id, kind: "item", type, fields, dueDate: null, status: "active", reminderOffsets: [14, 1], ...over };
}

const BIKE = rec("bike", "vehicle.vehicle", { name: "Honda CB500X", plate: "BX12AB" });
const BIKE_REGO = rec("rego", "vehicle.registration", { provider: "Transport for NSW", plate: "BX12AB" }, { parentId: "bike", dueDate: "2026-12-14" });
const LOOSE_INSURANCE = rec("ins", "vehicle.insurance", { provider: "NRMA", reference: "POL-77" }, { dueDate: "2027-06-01" });
const HOME = rec("home", "home.property", { name: "Home", address: "1 Example St" });
const POWER = rec("power", "utility.energy", { provider: "Red Energy", service: "electricity" }, { parentId: "home" });
const HEALTH = rec("health", "health.insurance", { provider: "Medibank" }, { dueDate: "2026-11-02" }); // overdue
const PASSPORT = rec("passport", "id.passport", { country: "Australia" }, { dueDate: "2027-03-01" }); // beyond 60 days
const CANCELLED = rec("gym", "subscription.membership", { provider: "Fitness First" }, { dueDate: "2026-11-30", status: "cancelled" });
const OLD_RECEIPT = rec("kettle", "purchase.receipt", { item: "Kettle" }, { kind: "receipt_warranty", dueDate: "2026-10-01" }); // return window passed
const LEGACY_SUB: LifeAdminRecordView = { id: "netflix", kind: "subscription", fields: { name: "Netflix", amount: "25.99", currency: "AUD", cycle: "monthly" }, dueDate: TODAY, status: "active", reminderOffsets: [14, 1] };

const ALL = [HEALTH, BIKE, BIKE_REGO, LOOSE_INSURANCE, HOME, POWER, PASSPORT, CANCELLED, OLD_RECEIPT, LEGACY_SUB];

function render(over: Partial<LifeAdminViewProps> = {}): string {
  return renderToStaticMarkup(
    <LifeAdminView
      today={TODAY}
      records={ALL}
      checklist={[]}
      addRecordAction={noop}
      editRecordAction={noop}
      attachFileAction={noop}
      deleteRecordAction={noop}
      {...over}
    />,
  );
}

function text(markup: string): string {
  return markup
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function headings(markup: string, level: number): string[] {
  return [...markup.matchAll(new RegExp(`<h${level}\\b[^>]*>([\\s\\S]*?)</h${level}>`, "g"))].map((m) => text(m[1]!));
}

// The markup of one record row: from its anchor to the next record's (or the end).
function rowOf(markup: string, id: string): string {
  const start = markup.indexOf(`id="record-${id}"`);
  assert.ok(start >= 0, `record ${id} renders with its #record-${id} anchor`);
  const next = markup.indexOf('id="record-', start + 1);
  return markup.slice(start, next < 0 ? undefined : next);
}

// The markup of the panel (a WorkspacePanel <section>) whose h2 is `title`, up to the next one.
function panelOf(markup: string, title: string): string {
  const at = markup.search(new RegExp(`<h2\\b[^>]*>${title}</h2>`));
  assert.ok(at >= 0, `a "${title}" panel renders`);
  const start = markup.lastIndexOf("<section", at);
  const next = markup.slice(at).search(/<section aria-labelledby="[^"]*" class="wh-panel[ "]/);
  return markup.slice(start, next < 0 ? undefined : at + next);
}

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

test("isLive: cancelled, done, expired and paused records need nothing more", () => {
  for (const status of ["active", "kept", "upcoming", ""]) assert.equal(isLive(status), true, status);
  for (const status of ["cancelled", "Canceled", "done", "expired", "paused", "ended"]) assert.equal(isLive(status), false, status);
});

test("comingUp: live records overdue or due within 60 days, soonest first; a passed return-by and settled records are left out", () => {
  const items = comingUp(ALL, TODAY);
  assert.deepEqual(items.map((item) => [item.record.id, item.overdue]), [
    ["health", true],
    ["netflix", false],
    ["rego", false],
  ]);
  assert.equal(items[2]!.type.id, "vehicle.registration");
  const edge = [rec("on60", "general.other", {}, { dueDate: addDays(TODAY, 60) }), rec("on61", "general.other", {}, { dueDate: addDays(TODAY, 61) })];
  assert.deepEqual(comingUp(edge, TODAY).map((item) => item.record.id), ["on60"], "the 60th day is in, the 61st out");
});

test("organiseByCategory: catalogue order, assets with their records (whatever their category), unlinked after, empty categories listed", () => {
  const { sections, empty } = organiseByCategory(ALL);
  assert.deepEqual(sections.map((section) => section.category.id), ["vehicle", "home", "health", "id", "subscription", "purchase"]);
  const vehicles = sections[0]!;
  assert.deepEqual(vehicles.assets.map((group) => [group.asset.id, group.children.map((child) => child.id)]), [["bike", ["rego"]]]);
  assert.deepEqual(vehicles.loose.map((record) => record.id), ["ins"]);
  const home = sections[1]!;
  assert.deepEqual(home.assets.map((group) => group.children.map((child) => child.id)), [["power"]], "the electricity account sits under the home");
  assert.ok(!sections.some((section) => section.category.id === "utility"), "Utilities has nothing left to show on its own");
  assert.ok(!empty.some((category) => category.id === "utility"), "but it isn't empty either");
  assert.deepEqual(empty.map((category) => category.id), ["insurance", "money", "work", "pet", "general"]);
  const orphan = rec("orphan", "vehicle.service", { provider: "Bike Shop" }, { parentId: "gone" });
  assert.deepEqual(organiseByCategory([orphan]).sections[0]!.loose.map((record) => record.id), ["orphan"], "a link to a record that isn't there reads as unlinked");
});

// ─── the organised view ──────────────────────────────────────────────────────────────

test("Coming up lists each line with its type's due wording, links to its record and says how far away it is", () => {
  const markup = render();
  const panel = panelOf(markup, "Coming up");
  const lines = [...panel.matchAll(/<a href="#record-([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)].map((m) => [m[1], text(m[2]!)]);
  assert.deepEqual(lines, [
    ["health", "Health insurance · Medibank — Overdue since 2 Nov 2026"],
    ["netflix", "Subscription · Netflix — Renews 23 Nov 2026 · today"],
    // A rego goes by its plate, not the registration authority, and its type isn't repeated.
    ["rego", "Registration · BX12AB — Expires 14 Dec 2026 · in 21 days"],
  ]);
  assert.match(panel, /text-warning/, "an overdue line carries the warning icon as well as its words");
});

test("Coming up says so when nothing is due, and is left out when there are no records", () => {
  assert.match(text(panelOf(render({ records: [PASSPORT] }), "Coming up")), /Nothing due in the next 60 days\./);
  assert.ok(!headings(render({ records: [] }), 2).includes("Coming up"));
});

test("one panel per category with records, in catalogue order, with the category's label and description", () => {
  const markup = render();
  const titles = headings(markup, 2);
  const categories = titles.filter((title) => ["Vehicles", "Home", "Utilities", "Health", "ID documents", "Subscriptions", "Receipts & warranties"].includes(title));
  assert.deepEqual(categories, ["Vehicles", "Home", "Health", "ID documents", "Subscriptions", "Receipts & warranties"]);
  assert.match(text(panelOf(markup, "Vehicles")), /Cars, motorcycles, boats and trailers, with their rego, insurance and servicing\./);
  assert.ok(titles.indexOf("Coming up") < titles.indexOf("Vehicles"), "Coming up comes first");
});

test("an asset heads the records that belong to it; unlinked records follow under their own heading", () => {
  const markup = render();
  const vehicles = panelOf(markup, "Vehicles");
  assert.deepEqual(headings(vehicles, 3), ["Honda CB500X", "Not linked to a vehicle"]);
  const bike = vehicles.indexOf('id="record-bike"');
  const rego = vehicles.indexOf('id="record-rego"');
  const unlinked = vehicles.indexOf("Not linked to a vehicle");
  const insurance = vehicles.indexOf('id="record-ins"');
  assert.ok(bike >= 0 && bike < rego && rego < unlinked && unlinked < insurance, "bike, its rego, then the unlinked insurance");
  assert.match(text(rowOf(markup, "bike")), /^.*Vehicle details Vehicle · Active/, "the asset's own row says what it is");
  const home = panelOf(markup, "Home");
  assert.ok(home.includes('id="record-power"'), "the electricity account is listed under the home");
});

test("each row leads with its name, type, due date and status, then labelled facts, reminders and who added it; controls sit behind one Manage", () => {
  const markup = render();
  const row = rowOf(markup, "ins");
  const manage = [...row.matchAll(/<summary\b[^>]*>([\s\S]*?)<\/summary>/g)].filter((m) => /^Manage\b/.test(text(m[1]!)));
  assert.equal(manage.length, 1, "exactly one Manage disclosure");
  assert.match(text(manage[0]![1]!), /^Manage NRMA$/, "named for its record");
  const before = row.slice(0, row.indexOf(manage[0]![0]));
  const inside = row.slice(row.indexOf(manage[0]![0]));
  assert.match(text(before), /NRMA Vehicle insurance · Renews 1 June 2027 · Active/);
  assert.match(text(before), /Policy number POL-77/, "facts use the type's labels");
  assert.match(text(before), /Reminds you 14 days before and 1 day before/);
  assert.match(text(before), /Added by you\./);
  assert.doesNotMatch(before, /<form\b/, "no form sits outside Manage");
  assert.match(inside, /name="setting" value="reminder"/);
  assert.match(inside, /name="recordFormVersion" value="2"/, "the Edit form");
  assert.match(text(inside), /Delete this record and all its attached files\? This can't be undone\./);
  assert.match(inside, /name="returnTab" value="things"/);
});

test("a legacy record reads through its kind's type: a subscription renews, its cost is one line", () => {
  const row = text(rowOf(render(), "netflix"));
  assert.match(row, /Netflix Subscription · Renews 23 Nov 2026 · Active/);
  assert.match(row, /Cost AUD 25\.99 a month/);
});

test("a receipt's attach control and its downloads keep their places: attach inside Manage, downloads visible", () => {
  const receipt = { ...OLD_RECEIPT, files: [{ id: "f1", size: 1048576 }] };
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
  assert.equal(markup.match(/id="record-rego"/g)?.length, 1, "one anchor per record, even when it is also in To check or Coming up");
});

test("the organised view uses tokens, never raw hex", () => {
  assert.doesNotMatch(render(), /#[0-9a-fA-F]{3,8}\b/);
});
