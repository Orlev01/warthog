// Review fix G10 — the Life admin section switcher is a real tab list (now one row of six tabs:
// Records, Add, Upcoming, Bills, History and Tasks, no counts in their names;
// docs/adr/life-admin-profile.md).
//
// The section buttons carried aria-selected on plain role=button elements (which
// assistive technology does not announce), with no tablist/tabpanel relationship, and the
// selected one was told apart only by a 1.05:1 fill change. They are now role=tab inside
// a labelled role=tablist, controlling a role=tabpanel labelled by the selected tab, with
// a roving tabindex (arrow keys move between tabs), and the selected tab also carries a
// visible outline and heavier text.

import * as React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";

import { LifeAdminView, nextTabIndex } from "./life-admin-view";

// Tasks is a tab when the page passes its content (LifeAdminScreen does).
function render(initialTab?: "records" | "add" | "upcoming" | "bills" | "history" | "tasks", records: React.ComponentProps<typeof LifeAdminView>["records"] = []): string {
  return renderToStaticMarkup(<LifeAdminView today="2026-11-12" records={records} initialTab={initialTab} tasks={<p>No tasks yet.</p>} />);
}

function attr(attrs: string, name: string): string | null {
  return new RegExp(`\\b${name}="([^"]*)"`).exec(attrs)?.[1] ?? null;
}

test("the section buttons are tabs in a labelled tablist, exactly one selected, controlling a labelled tabpanel", () => {
  const markup = render("tasks");
  const tablist = /<div\b([^>]*role="tablist"[^>]*)>/.exec(markup);
  assert.ok(tablist, "a tablist is rendered");
  assert.ok(attr(tablist![1]!, "aria-label"), "the tablist is labelled");

  const tabs = [
    ...markup.matchAll(/<button\b([^>]*role="tab"[^>]*)>([\s\S]*?)<\/button>/g),
  ].map((m) => ({
    attrs: m[1]!,
    text: m[2]!
      .replace(/<[^>]*>/g, "")
      .replace(/&amp;/g, "&")
      .trim(),
  }));
  assert.deepEqual(
    tabs.map((t) => t.text),
    ["Records", "Add", "Upcoming", "Bills", "History", "Tasks"],
  );
  const selected = tabs.filter(
    (t) => attr(t.attrs, "aria-selected") === "true",
  );
  assert.equal(selected.length, 1);
  assert.equal(selected[0]!.text, "Tasks");
  assert.equal(
    tabs.filter((t) => attr(t.attrs, "aria-selected") === "false").length,
    5,
  );
  // Roving tabindex: only the selected tab is in the tab order.
  assert.deepEqual(
    tabs.map((t) => attr(t.attrs, "tabindex")),
    ["-1", "-1", "-1", "-1", "-1", "0"],
  );

  const panelId = attr(selected[0]!.attrs, "aria-controls");
  assert.ok(panelId);
  const panel = new RegExp(`<div\\b([^>]*id="${panelId}"[^>]*)>`).exec(markup);
  assert.ok(panel, "aria-controls points at a rendered element");
  assert.equal(attr(panel![1]!, "role"), "tabpanel");
  assert.equal(
    attr(panel![1]!, "aria-labelledby"),
    attr(selected[0]!.attrs, "id"),
  );
});

test("the selected tab is marked by more than colour", () => {
  const markup = render("records");
  const selected = /<button\b([^>]*aria-selected="true"[^>]*)>/.exec(
    markup,
  )![1]!;
  const other = /<button\b([^>]*aria-selected="false"[^>]*)>/.exec(markup)![1]!;
  // The shared .wh-tab style bolds the selected tab (and underlines it) from its
  // aria-selected state, for route and in-page tabs alike (src/app/surfaces.css).
  assert.match(selected, /class="wh-tab"/);
  assert.match(other, /class="wh-tab"/);
  const css = readFileSync(new URL("../../app/surfaces.css", import.meta.url), "utf8");
  assert.match(css, /\.wh-tab\[aria-selected="true"\]\s*\{\s*font-weight:\s*600;/);
});

test("arrow keys, Home and End move between tabs, wrapping at the ends", () => {
  assert.equal(nextTabIndex(0, "ArrowRight", 4), 1);
  assert.equal(nextTabIndex(3, "ArrowRight", 4), 0);
  assert.equal(nextTabIndex(0, "ArrowLeft", 4), 3);
  assert.equal(nextTabIndex(2, "Home", 4), 0);
  assert.equal(nextTabIndex(1, "End", 4), 3);
  assert.equal(nextTabIndex(1, "a", 4), null, "other keys are left alone");
});

test("every panel stays mounted with only the selected panel visible; Records opens by default once something is on file, Add before", () => {
  const onFile: React.ComponentProps<typeof LifeAdminView>["records"] = [
    { id: "00000000-0000-4000-8000-00000000000d", kind: "item", type: "vehicles.vehicle", fields: { name: "Honda CB500X" }, dueDate: null, status: "active", reminderOffsets: [] },
  ];
  for (const [initialTab, records, shownIndex] of [
    [undefined, onFile, 0],
    [undefined, [], 1],
    ["records", [], 0],
    ["add", onFile, 1],
    ["upcoming", [], 2],
    ["bills", [], 3],
    ["history", [], 4],
    ["tasks", [], 5],
  ] as const) {
    const panels = [
      ...render(initialTab, records).matchAll(/<div\b([^>]*role="tabpanel"[^>]*)>/g),
    ].map((match) => match[1]!);
    assert.equal(panels.length, 6);
    assert.deepEqual(panels.map((attrs) => /\bhidden=""/.test(attrs)), [0, 1, 2, 3, 4, 5].map((index) => index !== shownIndex), `${String(initialTab)} with ${records.length} records`);
  }
});
