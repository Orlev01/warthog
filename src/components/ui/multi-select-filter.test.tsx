// A multiple-choice list filter (`./multi-select-filter`): a native disclosure whose summary says
// what's chosen ("Category: All", "Category: Vehicles", "Category: Vehicles +2") over a fieldset
// of named checkboxes, inside a plain GET form with an Apply button, so it works without
// JavaScript and the choice lives in the address (repeated parameters). With JavaScript, ticking
// a box applies it at once.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { FilterForm, MultiSelectFilter, multiSelectSummary } from "./multi-select-filter";

const OPTIONS = [
  { value: "vehicles", label: "Vehicles", count: 3 },
  { value: "health", label: "Health", count: 1 },
  { value: "subscriptions", label: "Subscriptions and memberships", count: 0 },
];

const text = (markup: string) => markup.replace(/<[^>]*>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

test("the summary says what's chosen: all, one, or the first and how many more, in the options' order", () => {
  assert.equal(multiSelectSummary("Category", OPTIONS, []), "Category: All");
  assert.equal(multiSelectSummary("Category", OPTIONS, ["health"]), "Category: Health");
  assert.equal(multiSelectSummary("Category", OPTIONS, ["subscriptions", "health", "vehicles"]), "Category: Vehicles +2");
  assert.equal(multiSelectSummary("Status", OPTIONS, [], "Any"), "Status: Any");
  assert.equal(multiSelectSummary("Category", OPTIONS, ["gone"]), "Category: All", "a value with no option reads as nothing chosen");
});

test("a disclosure over a labelled fieldset of named checkboxes, the chosen ones ticked, each with its count", () => {
  const html = renderToStaticMarkup(
    <MultiSelectFilter label="Category" name="category" options={OPTIONS} selected={["vehicles", "health"]} hint="None ticked shows every category." countLabel={(n) => `${n} records`} />,
  );
  assert.match(html, /^<details\b/);
  const summary = /<summary\b[^>]*>([\s\S]*?)<\/summary>/.exec(html)!;
  assert.equal(text(summary[1]!), "Category: Vehicles +1");
  assert.match(summary[0], /wh-button/, "the summary looks like a button and is a 44px target");
  assert.match(summary[0], /min-h-11/);
  const fieldset = /<fieldset\b([^>]*)>([\s\S]*?)<\/fieldset>/.exec(html)!;
  assert.match(fieldset[2]!, /^<legend\b[^>]*>Category<\/legend>/, "the fieldset is named by its legend");
  const hintId = /aria-describedby="([^"]+)"/.exec(fieldset[1]!)![1]!;
  assert.match(fieldset[2]!, new RegExp(`<p id="${hintId}"[^>]*>None ticked shows every category\\.</p>`), "the hint is tied to the fieldset");
  const boxes = [...fieldset[2]!.matchAll(/<label\b([^>]*)>([\s\S]*?)<\/label>/g)].map((m) => ({
    label: m[1]!,
    input: /<input\b[^>]*>/.exec(m[2]!)![0],
    text: text(m[2]!),
  }));
  assert.deepEqual(boxes.map((box) => box.text), ["Vehicles 3 3 records", "Health 1 1 records", "Subscriptions and memberships 0 0 records"]);
  assert.deepEqual(boxes.map((box) => /type="checkbox"/.test(box.input) && /name="category"/.test(box.input)), [true, true, true]);
  assert.deepEqual(boxes.map((box) => /value="([^"]+)"/.exec(box.input)![1]), ["vehicles", "health", "subscriptions"]);
  assert.deepEqual(boxes.map((box) => /\bchecked=""/.test(box.input)), [true, true, false]);
  assert.ok(boxes.every((box) => /min-h-11/.test(box.label)), "every choice is a 44px target");
});

test("a filter form is a plain GET form to the page, keeping its other state and offering Apply without JavaScript", () => {
  const html = renderToStaticMarkup(
    <FilterForm action="/life-admin" label="Filter records" hidden={{ view: "life", tab: "records" }}>
      <MultiSelectFilter label="Status" name="status" options={[{ value: "active", label: "Active" }]} selected={["active"]} defaults={["active"]} />
    </FilterForm>,
  );
  const form = /<form\b([^>]*)>([\s\S]*?)<\/form>/.exec(html)!;
  assert.match(form[1]!, /action="\/life-admin"/);
  assert.match(form[1]!, /aria-label="Filter records"/);
  assert.doesNotMatch(form[1]!, /method="post"/i, "a GET form");
  assert.match(form[2]!, /<input type="hidden" name="view" value="life"\/><input type="hidden" name="tab" value="records"\/>/);
  assert.match(form[2]!, /<button\b[^>]*type="submit"[^>]*>Apply<\/button>/, "Apply submits the choice when there's no JavaScript");
});

test("the filter uses tokens, never raw hex", () => {
  const html = renderToStaticMarkup(<MultiSelectFilter label="Category" name="category" options={OPTIONS} selected={[]} />);
  assert.doesNotMatch(html, /#[0-9a-fA-F]{3,8}\b/);
});
