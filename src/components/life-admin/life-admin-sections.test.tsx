// Life admin's tabs (founder, 23 and 24 Nov 2026): "Records", "Add", "Upcoming", "History" and "Tasks", one
// row of tabs under the page heading, no counts in their names, one `?tab=` parameter.
//
//   • Records is what's ongoing in the person's life: accounts, policies, memberships, documents,
//     the things other records belong to, and matters in progress. What's active comes first, by
//     category; what's on hold follows as its own quieter list. Bookings are never Records.
//   • Upcoming is what needs the person or is booked: renewals and expiry dates coming up, and
//     every booking ahead (the old Bookings tab, folded in), including ones further out than 60
//     days and ones without a date yet.
//   • History is everything finished, strictly apart: past bookings, things ended or cancelled,
//     matters resolved. Newest first by month, filtered by Category and Status (each
//     multiple-choice), a page at a time.
//
// The moving checklist is gone.

import * as React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";

import { LifeAdminView, type LifeAdminRecordView, type LifeAdminViewProps } from "./life-admin-view";
import { LifeAdminScreen } from "./life-admin-screen";
import { historyView, sectionOf, upcomingSections } from "./record-groups";
import { BUILT_IN } from "@/domain/life-admin/catalogue";
import { phased } from "./phase-fixture";

const TODAY = "2026-11-23";
const ZONE = "Australia/Sydney";
const noop = () => {};

function rec(id: string, type: string, fields: Record<string, string>, over: Partial<LifeAdminRecordView> = {}): LifeAdminRecordView {
  const dueDate = fields.starts_at ? fields.starts_at.slice(0, 10) : null;
  return phased({ id, kind: "item", type, fields, dueDate, status: "active", reminderOffsets: [14, 1], ...over });
}

const REGO = rec("rego", "vehicles.registration", { provider: "Transport for NSW", plate: "BX12AB" }, { dueDate: "2026-12-14" });
const SUPER = rec("super", "investing.super", { provider: "Hostplus", reference: "1234567" });
const PAUSED = rec("gym", "subscriptions.membership", { provider: "Fitness First" }, { status: "paused" });
const CASE_OPEN = rec("claim", "other.case", { name: "Bond claim", provider: "Fair Trading" }, { state: "open" });
const DINNER = rec("dinner", "outings.restaurant", { provider: "Sixpenny", starts_at: "2026-11-25T19:30+11:00[Australia/Sydney]" }, { state: "confirmed" });
const FAR_FLIGHT = rec("flight", "travel.flight", { provider: "Qantas", reference: "QF25", starts_at: "2027-04-10T09:00+10:00[Australia/Sydney]" }, { parentId: "trip", state: "confirmed" });
// A trip's dates are its bookings' span (the loader's recordPhases): here, the one flight.
const TRIP: LifeAdminRecordView = { ...rec("trip", "travel.trip", { name: "Tokyo" }, { state: "confirmed" }), phase: FAR_FLIGHT.phase };
const NO_DATE = rec("tickets", "outings.event", { name: "Festival tickets", provider: "Ticketek" }, { state: "confirmed" });
const PAST_DINNER = rec("ester", "outings.restaurant", { provider: "Ester", starts_at: "2026-10-02T19:00+10:00[Australia/Sydney]" }, { state: "confirmed" });
const CANCELLED_APPT = rec("dentist", "health.appointment", { provider: "Dr Lee", starts_at: "2026-10-20T09:00+11:00[Australia/Sydney]" }, { state: "cancelled", status: "cancelled" });
const ENDED_SUB = rec("newyorker", "subscriptions.service", { name: "The New Yorker" }, { dueDate: "2025-03-28", status: "cancelled" });
const RECEIPT = rec("boox", "belongings.receipt", { name: "BOOX Note Air", purchased_on: "2026-09-13" }, { kind: "receipt_warranty", status: "completed" });
const CASE_DONE = rec("refund", "other.case", { name: "Partial refund", provider: "BOOX" }, { status: "resolved", state: "resolved" });
const UNDATED_ENDED = rec("paramount", "subscriptions.service", { name: "Paramount+" }, { status: "cancelled" });

const ALL = [REGO, SUPER, PAUSED, CASE_OPEN, DINNER, TRIP, FAR_FLIGHT, NO_DATE, PAST_DINNER, CANCELLED_APPT, ENDED_SUB, RECEIPT, CASE_DONE, UNDATED_ENDED];

function render(over: Partial<LifeAdminViewProps> = {}): string {
  return renderToStaticMarkup(
    <LifeAdminView
      today={TODAY}
      zone={ZONE}
      records={ALL}
      addRecordAction={noop}
      editRecordAction={noop}
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
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

// One tab panel's markup, by its tab's key.
function panel(markup: string, key: "records" | "add" | "upcoming" | "history" | "tasks"): string {
  const order = ["records", "add", "upcoming", "history", "tasks"];
  const starts = [...markup.matchAll(/<div\b[^>]*role="tabpanel"[^>]*>/g)].map((m) => m.index!);
  const index = order.indexOf(key);
  return markup.slice(starts[index], starts[index + 1] ?? markup.length);
}

const tabNames = (markup: string) =>
  [...markup.matchAll(/<button\b[^>]*role="tab"[^>]*>([\s\S]*?)<\/button>/g)].map((m) => text(m[1]!));

// ─── where each record lives ─────────────────────────────────────────────────────────

test("sectionOf: finished things are History's, live bookings Upcoming's, everything else ongoing is Records'", () => {
  const where = Object.fromEntries(ALL.map((record) => [record.id, sectionOf(record, BUILT_IN)]));
  assert.deepEqual(where, {
    rego: "records",
    super: "records",
    gym: "records",
    claim: "records",
    dinner: "upcoming",
    trip: "upcoming",
    flight: "upcoming",
    tickets: "upcoming",
    ester: "history",
    dentist: "history",
    newyorker: "history",
    boox: "history",
    refund: "history",
    paramount: "history",
  });
});

// ─── the tabs ────────────────────────────────────────────────────────────────────────

test("the page has one row of five tabs, Records, Add, Upcoming, History and Tasks, with no counts; Records opens first", () => {
  const markup = renderToStaticMarkup(
    <LifeAdminScreen
      initialTab="records"
      records={{ today: TODAY, zone: ZONE, records: ALL }}
      tasks={{ tasks: [], agents: [] }}
    />,
  );
  assert.deepEqual(tabNames(markup), ["Records", "Add", "Upcoming", "History", "Tasks"]);
  assert.equal([...markup.matchAll(/role="tablist"/g)].length, 1, "one row of tabs, not tabs inside tabs");
  const selected = /<button\b[^>]*aria-selected="true"[^>]*>([\s\S]*?)<\/button>/.exec(markup);
  assert.equal(text(selected![1]!), "Records");
  assert.doesNotMatch(text(markup), /Moving checklist|Records & reminders|Bookings \(/);
});

test("the page opens the tab it was asked for, and its notice shows inside that tab", () => {
  const markup = renderToStaticMarkup(
    <LifeAdminScreen
      initialTab="history"
      notice={<p>Saved the change.</p>}
      records={{ today: TODAY, zone: ZONE, records: ALL }}
      tasks={{ tasks: [], agents: [] }}
    />,
  );
  const selected = /<button\b[^>]*aria-selected="true"[^>]*>([\s\S]*?)<\/button>/.exec(markup);
  assert.equal(text(selected![1]!), "History");
  assert.match(text(panel(markup, "history")), /Saved the change\./);
  assert.doesNotMatch(text(panel(markup, "records")), /Saved the change\./);
});

// ─── Records ─────────────────────────────────────────────────────────────────────────

test("Records lists what's ongoing: never a booking, never anything finished", () => {
  const records = panel(render(), "records");
  for (const id of ["rego", "super", "claim"]) assert.match(records, new RegExp(`id="record-${id}"`), `${id} is a record`);
  for (const id of ["dinner", "trip", "flight", "tickets", "ester", "dentist", "newyorker", "boox", "refund", "paramount"]) {
    assert.doesNotMatch(records, new RegExp(`id="record-${id}"`), `${id} isn't on Records`);
  }
});

test("Records' Status filter offers Active and On hold, and says what's in History with a link to it", () => {
  const records = panel(render(), "records");
  const values = [...records.matchAll(/name="status"(?: checked="")? value="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(values, ["active", "on_hold"]);
  assert.match(text(records), /Not shown: 1 on hold/);
  assert.match(records, /href="\/life-admin\?tab=history"[^>]*>6 finished or cancelled/);
});

test("On hold, when chosen, is its own quieter list on Records", () => {
  const records = panel(render({ recordFilter: { categories: [], statuses: ["active", "on_hold"] } }), "records");
  assert.match(records, /id="records-on_hold-heading"/);
  assert.match(records, /id="record-gym"/);
  assert.doesNotMatch(records, /id="records-finished-heading"|id="records-cancelled-heading"/);
});

// ─── Upcoming ────────────────────────────────────────────────────────────────────────

test("upcomingSections adds every booking further ahead than 60 days, and bookings with no date yet", () => {
  const sections = upcomingSections(ALL);
  assert.deepEqual(sections.week.map((r) => r.id), ["dinner"]);
  assert.deepEqual(sections.later.map((r) => r.id), ["rego"]);
  assert.deepEqual(sections.ahead.map((r) => r.id).sort(), ["flight", "trip"]);
  assert.deepEqual(sections.undated.map((r) => r.id), ["tickets"]);
  const listed = [...sections.now, ...sections.overdue, ...sections.week, ...sections.later, ...sections.ahead, ...sections.undated].map((r) => r.id);
  for (const id of ["super", "gym", "claim", "ester", "dentist", "newyorker", "boox", "refund", "paramount"]) assert.ok(!listed.includes(id), `${id} isn't upcoming`);
});

test("Upcoming holds the bookings: this week, later, further ahead and date to be confirmed, each saying what it's part of", () => {
  const upcoming = panel(render(), "upcoming");
  const words = text(upcoming);
  for (const heading of ["This week", "Later (next 60 days)", "Further ahead", "Date to be confirmed"]) assert.match(words, new RegExp(heading.replace(/[()]/g, "\\$&")));
  assert.match(words, /Sixpenny/);
  assert.match(words, /Part of Tokyo/);
  assert.match(words, /Festival tickets/);
  assert.match(upcoming, /href="\/life-admin\/items\/flight"/);
  assert.doesNotMatch(words, /Ester|Dr Lee|New Yorker/);
});

// ─── History ─────────────────────────────────────────────────────────────────────────

test("historyView: everything finished, newest first by month, the undated last; counts by category and status", () => {
  const view = historyView(ALL, BUILT_IN, { categories: [], statuses: [] }, ZONE);
  assert.deepEqual(view.months.map((month) => month.label), ["October 2026", "September 2026", "March 2025", "No date"]);
  assert.deepEqual(view.months.map((month) => month.rows.map((row) => row.record.id)), [["dentist", "ester"], ["boox"], ["newyorker"], ["paramount", "refund"]]);
  assert.equal(view.total, 6);
  assert.deepEqual(view.statusOptions.map((option) => [option.status, option.count]), [["finished", 3], ["cancelled", 3]]);
  assert.deepEqual(view.categoryOptions.map((option) => [option.category.id, option.count]), [["health", 1], ["belongings", 1], ["subscriptions", 2], ["outings", 1], ["other", 1]]);
});

test("historyView filters by any of the chosen categories and statuses", () => {
  const cancelledOnly = historyView(ALL, BUILT_IN, { categories: [], statuses: ["cancelled"] }, ZONE);
  assert.deepEqual(cancelledOnly.months.flatMap((month) => month.rows.map((row) => row.record.id)).sort(), ["dentist", "newyorker", "paramount"]);
  const outings = historyView(ALL, BUILT_IN, { categories: ["outings", "other"], statuses: [] }, ZONE);
  assert.deepEqual(outings.months.flatMap((month) => month.rows.map((row) => row.record.id)), ["ester", "refund"]);
  assert.equal(outings.shown, 2);
});

test("historyView pages 30 at a time", () => {
  const many = Array.from({ length: 35 }, (_, index) =>
    rec(`old${index}`, "outings.restaurant", { provider: `Place ${index}`, starts_at: `2026-0${1 + (index % 9)}-1${index % 10}T19:00+10:00[Australia/Sydney]` }, { state: "confirmed" }),
  );
  const first = historyView(many, BUILT_IN, { categories: [], statuses: [] }, ZONE);
  assert.equal(first.pages, 2);
  assert.equal(first.months.flatMap((month) => month.rows).length, 30);
  const second = historyView(many, BUILT_IN, { categories: [], statuses: [], page: 2 }, ZONE);
  assert.equal(second.months.flatMap((month) => month.rows).length, 5);
});

test("History: rows by month with their category, multiple-choice Category and Status filters in a GET form that keeps the tab", () => {
  const history = panel(render(), "history");
  const words = text(history);
  assert.match(words, /October 2026/);
  assert.match(history, /id="record-ester"/);
  assert.match(words, /Going out/);
  assert.match(history, /<form\b[^>]*action="\/life-admin"/);
  assert.match(history, /<input type="hidden" name="tab" value="history"/);
  assert.match(history, /name="history_category" value="outings"/);
  assert.deepEqual([...history.matchAll(/name="history_status"(?: checked="")? value="([^"]+)"/g)].map((m) => m[1]), ["finished", "cancelled"]);
  for (const id of ["rego", "super", "dinner", "flight"]) assert.doesNotMatch(history, new RegExp(`id="record-${id}"`));
});

test("History's chips remove one filter at a time and keep the others", () => {
  const history = panel(render({ historyFilter: { categories: ["outings"], statuses: ["finished"] } }), "history");
  assert.match(history, /href="\/life-admin\?tab=history&amp;history_status=finished"/, "removing the category keeps the status");
  assert.match(history, /href="\/life-admin\?tab=history&amp;history_category=outings"/, "removing the status keeps the category");
});

test("an action on a History row comes back to History with its filters", () => {
  const history = panel(render({ historyFilter: { categories: ["outings"], statuses: [] } }), "history");
  const row = history.slice(history.indexOf('id="record-ester"'));
  assert.match(row, /name="returnTab" value="history"/);
  assert.match(row, /name="returnCategory" value="outings"/);
});

test("with nothing finished yet, History says what will appear there", () => {
  const history = panel(render({ records: [REGO, DINNER] }), "history");
  assert.match(text(history), /Nothing in History yet/);
});

// ─── rows on Upcoming, counts and empty states ───────────────────────────────────────

test("a live booking is managed from Upcoming: its row has its details, Edit and Delete, and its #record- anchor", () => {
  const upcoming = panel(render(), "upcoming");
  const at = upcoming.indexOf('id="record-dinner"');
  assert.ok(at >= 0, "the booking's row carries its anchor on Upcoming");
  const row = upcoming.slice(at, upcoming.indexOf('id="record-', at + 1) >>> 0 || undefined);
  assert.match(text(row), /Details/);
  assert.match(text(row), /Edit/);
  assert.match(text(row), /Delete record/);
  assert.match(text(row), /in 2 days/, "how soon, in words");
  assert.match(row, /name="returnTab" value="upcoming"/, "an action on it comes back to Upcoming");
});

test("a record that lives on Records shows in Upcoming without a second #record- anchor", () => {
  const markup = render();
  assert.equal([...markup.matchAll(/id="record-rego"/g)].length, 1, "one anchor per record on the page");
  assert.match(panel(markup, "records"), /id="record-rego"/);
  assert.match(text(panel(markup, "upcoming")), /Registration · BX12AB/);
});

test("with categories chosen, Records counts only their History, and links to History with them", () => {
  const records = panel(render({ recordFilter: { categories: ["subscriptions"], statuses: ["active"] } }), "records");
  assert.match(records, /href="\/life-admin\?tab=history&amp;history_category=subscriptions"[^>]*>2 finished or cancelled/);
});

test("with only bookings, Records has nothing to filter and says where they are", () => {
  const records = panel(render({ records: [DINNER, PAST_DINNER] }), "records");
  assert.doesNotMatch(records, /Filter records/);
  assert.match(text(records), /Nothing ongoing yet/);
  assert.match(records, /href="\/life-admin\?tab=upcoming"/);
});

test("something finished says nothing about reminders", () => {
  const history = panel(render(), "history");
  const row = history.slice(history.indexOf('id="record-ester"'));
  assert.doesNotMatch(text(row.slice(0, row.indexOf('id="record-', 10) >>> 0 || undefined)), /Remind|Change reminders/);
});
