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
