import * as React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { ViewPanels, resolveView, nextTabIndex } from "./view-tabs";
test("view selection accepts known values and falls back for malformed deep links", () => {
  assert.equal(
    resolveView("library", ["library", "preferences"], "library"),
    "library",
  );
  for (const value of [null, "", "unknown", "../settings"])
    assert.equal(
      resolveView(value, ["library", "preferences"], "library"),
      "library",
    );
  assert.equal(
    resolveView("preferences", ["library", "preferences"], "library"),
    "preferences",
  );
});
test("keyboard tabs wrap and support first and last without consuming unrelated keys", () => {
  assert.equal(nextTabIndex(0, "ArrowLeft", 3), 2);
  assert.equal(nextTabIndex(2, "ArrowRight", 3), 0);
  assert.equal(nextTabIndex(1, "Home", 3), 0);
  assert.equal(nextTabIndex(0, "End", 3), 2);
  assert.equal(nextTabIndex(0, "Tab", 3), null);
});
test("panels expose one selected tab and retain drafts in hidden inactive panels", () => {
  const html = renderToStaticMarkup(
    <ViewPanels
      label="Library views"
      tabs={[
        { key: "library", label: "Library", content: <p>Items</p> },
        {
          key: "preferences",
          label: "Preferences",
          content: <input defaultValue="Draft" />,
        },
      ]}
    />,
  );
  assert.equal((html.match(/aria-selected="true"/g) ?? []).length, 1);
  assert.equal((html.match(/role="tabpanel"/g) ?? []).length, 2);
  assert.match(html, /hidden=""/);
  assert.match(html, /value="Draft"/);
});

test("a server-selected deep link is present before hydration", () => {
  const html = renderToStaticMarkup(
    <ViewPanels
      label="Library views"
      initialTab="preferences"
      tabs={[
        { key: "library", label: "Library", content: <p>Library content</p> },
        {
          key: "preferences",
          label: "Preferences",
          content: <input defaultValue="Saved preference" />,
        },
      ]}
    />,
  );
  assert.match(html, /aria-selected="true"[^>]*>Preferences/);
});

test("in-page tabs are bounded: their own strip, or the nav row of the page heading band", () => {
  const tabs = [
    { key: "a", label: "Library", content: <p>A</p> },
    { key: "b", label: "Import & create", content: <p>B</p> },
  ];
  const strip = renderToStaticMarkup(<ViewPanels label="Views" tabs={tabs} />);
  assert.match(strip, /^<div class="wh-tabstrip"><div role="tablist" aria-label="Views" class="wh-tabs">/);
  assert.match(strip, /class="wh-tab" data-label="Library"/, "the bold width is reserved, no ad-hoc weight class");
  const banded = renderToStaticMarkup(<ViewPanels label="Views" tabs={tabs} heading={{ title: "Skills", description: "Yours." }} />);
  assert.match(banded, /^<header class="wh-page-heading">[\s\S]*<h1>Skills<\/h1>[\s\S]*<div class="wh-page-heading-nav"><div role="tablist" aria-label="Views" class="wh-tabs">[\s\S]*<\/header><div role="tabpanel"/);
  assert.doesNotMatch(banded, /wh-tabstrip/);
});
