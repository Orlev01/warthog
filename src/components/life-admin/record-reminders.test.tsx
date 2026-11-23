// A record's reminders, in plain words (founder, 23 Nov 2026: "what is 'Remind me (days before)'?
// Remind me for what?"). A reminder is always about the record's date, so:
//   • a record with no date says nothing about reminders and offers nothing to set;
//   • one with a date says when Warthog will remind the person, against that date ("Reminds you
//     14 days and 1 day before · Expires 14 Dec 2026"), and "Change reminders" offers a choice of
//     days (30, 14, 7, 1 days before, on the day, plus any other day it already has), ticked as
//     set; unticking them all turns reminders off. No typed list of numbers.

import * as React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";

import { LifeAdminView, type LifeAdminRecordView } from "./life-admin-view";
import { reminderChoices } from "./record-row";
import { reminderSummary } from "./record-groups";
import { phased } from "./phase-fixture";
import { reminderOffsetsFrom } from "@/app/(portal)/(protected)/life-admin/form-inputs";

const noop = () => {};

function rowOf(record: LifeAdminRecordView, withEdit = true): string {
  const markup = renderToStaticMarkup(<LifeAdminView today="2026-11-23" zone="Australia/Sydney" records={[record]} {...(withEdit ? { editRecordAction: noop } : {})} />);
  const start = markup.indexOf(`id="record-${record.id}"`);
  assert.ok(start >= 0, "the record renders on Records");
  // To the end of the Records tab (a record coming up shows on Upcoming too).
  const end = markup.indexOf('role="tabpanel"', start);
  return markup.slice(start, end < 0 ? undefined : end);
}

const text = (markup: string) => markup.replace(/<[^>]*>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();
const boxes = (markup: string) =>
  [...markup.matchAll(/<input\b[^>]*name="reminderOffsets"[^>]*>/g)]
    .filter((m) => m[0].includes('type="checkbox"'))
    .map((m) => [Number(/value="(\d+)"/.exec(m[0])![1]), m[0].includes('checked=""')]);

const REGO = phased({ id: "rego", kind: "item", type: "vehicles.registration", fields: { plate: "BX12AB" }, dueDate: "2026-12-14", status: "active", reminderOffsets: [14, 1] });
const SUPER = phased({ id: "super", kind: "item", type: "investing.super", fields: { provider: "Hostplus" }, dueDate: null, status: "active", reminderOffsets: [14, 1] });

test("reminderSummary says when, against the date; nothing without a date", () => {
  assert.deepEqual(reminderSummary("2026-12-14", [1, 14], "Expires 14 Dec 2026"), { on: true, text: "Reminds you 14 days and 1 day before · Expires 14 Dec 2026" });
  assert.deepEqual(reminderSummary("2026-12-03", [0, 1], "Starts 3 Dec 2026"), { on: true, text: "Reminds you 1 day before and on the day · Starts 3 Dec 2026" });
  assert.deepEqual(reminderSummary("2026-12-14", [], "Expires 14 Dec 2026"), { on: false, text: "No reminders · Expires 14 Dec 2026" });
  assert.equal(reminderSummary(null, [14, 1]), null);
});

test("a record with a date says when Warthog will remind you, and offers a choice of days, ticked as set", () => {
  const row = rowOf(REGO);
  assert.match(text(row), /Reminds you 14 days and 1 day before · Expires 14 Dec 2026/);
  assert.match(text(row), /Change reminders/);
  assert.match(text(row), /Remind me before it expires \(14 Dec 2026\)/);
  assert.deepEqual(boxes(row), [[30, false], [14, true], [7, false], [1, true], [0, false]]);
  assert.match(text(row), /30 days before 14 days before 7 days before 1 day before On the day/);
  assert.match(row, /<input type="hidden" name="setting" value="reminder"/);
  assert.match(text(row), /Save reminders/);
  assert.doesNotMatch(text(row), /days before\)|36500|separated by commas/, "no typed list of numbers");
});

test("a record with no date says nothing about reminders and offers nothing to set", () => {
  const row = rowOf(SUPER);
  assert.doesNotMatch(text(row), /Remind|reminder/i);
  assert.doesNotMatch(row, /name="reminderOffsets"/);
});

test("a day the record already has stays a choice; without the edit action the boxes are disabled with a reason", () => {
  assert.deepEqual(reminderChoices([60, 1]), [60, 30, 14, 7, 1, 0]);
  const custom = phased({ ...REGO, id: "rego2", reminderOffsets: [60] });
  assert.deepEqual(boxes(rowOf(custom)).find(([days]) => days === 60), [60, true]);
  const locked = rowOf(REGO, false);
  assert.match(locked, /<fieldset[^>]*disabled=""/);
  assert.match(text(locked), /Changing reminders isn't available just now\./);
});

test("the form's ticked days become the record's reminders; none ticked turns them off", () => {
  const form = new FormData();
  form.append("reminderOffsets", "14");
  form.append("reminderOffsets", "1");
  assert.deepEqual(reminderOffsetsFrom(form), [14, 1]);
  assert.deepEqual(reminderOffsetsFrom(new FormData()), []);
  const older = new FormData();
  older.append("reminderOffsets", "30, 7");
  assert.deepEqual(reminderOffsetsFrom(older), [30, 7], "a form left open before the boxes still works");
});
