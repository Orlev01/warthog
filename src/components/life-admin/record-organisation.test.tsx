// Life admin records, organised (the founder's "tidy and organise" pass): each record tab
// groups its records by how soon they fall due — Overdue, Next 30 days, Later, No due date
// — soonest first inside each group, with counts on the groups and on the category tabs.
// Each record row leads with its name, due date and a one-line reminder summary, and its
// controls (reminders, attach, edit, delete) sit behind ONE "Manage" disclosure.
//
// The loader hands the view the person's local date (`today`); the view never reads the
// clock, so these tests pin a fixed date and assert what the markup renders.

import * as React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";

import { LifeAdminView, type LifeAdminRecordView, type LifeAdminViewProps } from "./life-admin-view";
import { addDays, dueGroupOf, groupRecordsByDue, recordTitle, reminderSummary } from "./record-groups";

const TODAY = "2026-11-12";
const noop = () => {};

function record(id: string, name: string, dueDate: string | null, over: Partial<LifeAdminRecordView> = {}): LifeAdminRecordView {
  return { id, kind: "subscription", fields: { name, cost: `cost-${id}` }, dueDate, status: "active", reminderOffsets: [14, 1], ...over };
}

const OVERDUE = record("over", "Lapsed gym pass", "2026-11-01");
const DUE_TODAY = record("today", "Phone plan", TODAY);
const BOUNDARY = record("boundary", "Cloud storage", "2026-12-12"); // today + 30: still "next 30 days"
const LATER = record("later", "Annual magazine", "2026-12-13"); // today + 31
const UNDATED = record("undated", "Library card", null, { reminderOffsets: [] });

function render(over: Partial<LifeAdminViewProps> = {}): string {
  return renderToStaticMarkup(
    <LifeAdminView
      today={TODAY}
      subscriptions={[LATER, BOUNDARY, UNDATED, OVERDUE, DUE_TODAY]}
      receipts={[]}
      renewals={[]}
      checklist={[]}
      initialTab="subscriptions"
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

// ─── the pure grouping helpers ───────────────────────────────────────────────────────

test("addDays crosses month and year ends on calendar dates", () => {
  assert.equal(addDays("2026-11-12", 30), "2026-12-12");
  assert.equal(addDays("2026-12-15", 30), "2027-01-14");
  assert.equal(addDays("2028-02-28", 1), "2028-02-29", "leap day");
});

test("dueGroupOf: past is overdue, today through today+30 is next 30 days, after that later, no date undated", () => {
  assert.equal(dueGroupOf("2026-11-11", TODAY), "overdue");
  assert.equal(dueGroupOf(TODAY, TODAY), "soon", "due today is not overdue");
  assert.equal(dueGroupOf("2026-12-12", TODAY), "soon");
  assert.equal(dueGroupOf("2026-12-13", TODAY), "later");
  assert.equal(dueGroupOf(null, TODAY), "undated");
});

test("groupRecordsByDue keeps the fixed group order, omits empty groups and sorts soonest first", () => {
  const groups = groupRecordsByDue([LATER, BOUNDARY, UNDATED, OVERDUE, DUE_TODAY], TODAY);
  assert.deepEqual(
    groups.map((g) => [g.title, g.records.map((r) => r.id)]),
    [
      ["Overdue", ["over"]],
      ["Next 30 days", ["today", "boundary"]],
      ["Later", ["later"]],
      ["No due date", ["undated"]],
    ],
  );
  assert.deepEqual(groupRecordsByDue([UNDATED], TODAY).map((g) => g.key), ["undated"]);
  assert.deepEqual(groupRecordsByDue([], TODAY), []);
  const tie = [record("b", "B", "2026-12-01"), record("a", "A", "2026-12-01")];
  assert.deepEqual(groupRecordsByDue(tie, TODAY)[0]!.records.map((r) => r.id), ["b", "a"], "ties keep the loader's order");
});

test("reminderSummary states the reminder setting in one plain line", () => {
  assert.deepEqual(reminderSummary("2026-12-01", [14, 1]), { on: true, text: "Reminds you 14 days before and 1 day before" });
  assert.deepEqual(reminderSummary("2026-12-01", [1, 30, 7, 7]), {
    on: true,
    text: "Reminds you 30 days before, 7 days before and 1 day before",
  });
  assert.deepEqual(reminderSummary("2026-12-01", [0]), { on: true, text: "Reminds you on the due date" });
  assert.deepEqual(reminderSummary("2026-12-01", []), { on: false, text: "Reminders off" });
  assert.deepEqual(reminderSummary(null, [14]), { on: false, text: "Reminders start once it has a due date" });
});

test("recordTitle prefers a name or title field, else the first filled-in field", () => {
  assert.deepEqual(recordTitle({ cost: "9", name: "Netflix" }), { title: "Netflix", key: "name" });
  assert.deepEqual(recordTitle({ Title: "Passport" }), { title: "Passport", key: "Title" });
  assert.deepEqual(recordTitle({ Service: "", Store: "Good Guys" }), { title: "Good Guys", key: "Store" });
  assert.deepEqual(recordTitle({}), { title: "", key: null });
});

// ─── the grouped view ────────────────────────────────────────────────────────────────

test("a record tab groups its records by due date with a count on each group, soonest first", () => {
  const markup = render();
  assert.deepEqual(headings(markup, 3), ["Overdue", "Next 30 days", "Later", "No due date"]);
  assert.match(text(markup), /Overdue 1 .*Next 30 days 2 .*Later 1 .*No due date 1/);
  const order = ["over", "today", "boundary", "later", "undated"].map((id) => markup.indexOf(`id="record-${id}"`));
  assert.deepEqual([...order].sort((a, b) => a - b), order, "rows render in due order");
  assert.ok(order.every((index) => index >= 0));
});

test("only groups with records render", () => {
  const markup = render({ subscriptions: [UNDATED, DUE_TODAY] });
  assert.deepEqual(headings(markup, 3), ["Next 30 days", "No due date"]);
});

test("an empty tab keeps its empty state and its Add control", () => {
  const markup = render({ subscriptions: [] });
  assert.deepEqual(headings(markup, 3), []);
  assert.match(text(markup), /Nothing here yet/);
  assert.match(text(markup), /Add a subscription/);
});

test("the category tabs carry their counts", () => {
  const markup = render({
    receipts: [{ ...record("r1", "Kettle", null), kind: "receipt_warranty" }],
    checklist: [
      { id: "c1", label: "Tell the bank", done: false, linkedTaskId: null },
      { id: "c2", label: "Redirect mail", done: true, linkedTaskId: null },
    ],
  });
  const tabs = [...markup.matchAll(/<button\b[^>]*role="tab"[^>]*>([\s\S]*?)<\/button>/g)].map((m) => text(m[1]!));
  assert.deepEqual(tabs, ["Subscriptions (5)", "Receipts & warranties (1)", "Renewals & appointments (0)", "Moving checklist (2)"]);
});

test("the view has exactly one h1, 'Life admin', in the house style", () => {
  const h1s = [...render().matchAll(/<h1\b([^>]*)>([\s\S]*?)<\/h1>/g)];
  assert.equal(h1s.length, 1);
  assert.equal(text(h1s[0]![2]!), "Life admin");
  assert.match(h1s[0]![1]!, /text-2xl font-semibold tracking-tight text-fg/);
});

test("each row leads with its name, due date and a reminder summary; its controls sit behind one Manage disclosure", () => {
  const markup = render({ subscriptions: [DUE_TODAY, UNDATED] });
  for (const [id, name, summary] of [
    ["today", "Phone plan", "Reminds you 14 days before and 1 day before"],
    ["undated", "Library card", "Reminders off"],
  ] as const) {
    const row = rowOf(markup, id);
    const manage = [...row.matchAll(/<summary\b[^>]*>([\s\S]*?)<\/summary>/g)].filter((m) => /^Manage\b/.test(text(m[1]!)));
    assert.equal(manage.length, 1, `record ${id} has exactly one Manage disclosure`);
    assert.match(text(manage[0]![1]!), new RegExp(`^Manage ${name}$`), "the disclosure is named for its record");
    const at = row.indexOf(manage[0]![0]);
    const before = row.slice(0, at);
    const inside = row.slice(at);
    assert.match(text(before), new RegExp(name), "the name is visible without opening Manage");
    assert.match(text(before), new RegExp(summary), "the reminder setting is summarised without opening Manage");
    assert.match(text(before), new RegExp(`cost-${id}`), "the other fields stay visible");
    assert.doesNotMatch(before, /<form\b/, "no form sits outside the Manage disclosure");
    // Every per-record control is inside the disclosure: reminders, edit, delete.
    assert.match(inside, /name="setting" value="reminder"/);
    assert.match(inside, /name="reminderOffsets"/);
    assert.match(inside, /name="recordFormVersion" value="2"/, "the Edit form");
    assert.match(text(inside), /Delete this record and all its attached files\? This cannot be undone\./, "the delete confirmation step is kept");
    assert.match(text(inside), /Delete record and files/);
  }
  assert.match(text(rowOf(markup, "today")), new RegExp(`Due ${TODAY} · active`));
});

test("a receipt's attach control and its downloads keep their places: attach inside Manage, downloads visible", () => {
  const receipt: LifeAdminRecordView = {
    ...record("rec", "Vacuum", "2026-12-20"),
    kind: "receipt_warranty",
    files: [{ id: "f1", size: 1048576 }],
  };
  const markup = render({ subscriptions: [], receipts: [receipt], initialTab: "receipts" });
  const row = rowOf(markup, "rec");
  const at = row.search(/<summary\b[^>]*>(?:(?!<\/summary>)[\s\S])*Manage/);
  assert.ok(at > 0);
  assert.match(row.slice(0, at), /href="\/api\/receipts\/f1"/, "the download link is visible without opening Manage");
  assert.match(row.slice(at), /type="file"/, "the attach control is inside Manage");
  assert.match(row, /name="returnTab" value="receipts"/);
});

test("record anchors keep working: the row is focusable and clears the sticky header", () => {
  const row = /<li\b([^>]*)id="record-today"([^>]*)>/.exec(render())!;
  assert.ok(row, "the row carries its #record- anchor");
  assert.match(row[0]!, /tabindex="-1"/);
  assert.match(row[0]!, /scroll-mt-32/);
});

test("the organised view uses tokens, never raw hex", () => {
  assert.doesNotMatch(render(), /#[0-9a-fA-F]{3,8}\b/);
});
