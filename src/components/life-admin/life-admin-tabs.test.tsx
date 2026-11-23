// Review fix G10 — the Life admin section switcher is a real tab list (now four tabs: Your
// things, Upcoming, Bookings and the Moving checklist, docs/adr/life-admin-profile.md).
//
// The four section buttons carried aria-selected on plain role=button elements (which
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

function render(initialTab?: "things" | "upcoming" | "bookings" | "checklist"): string {
  return renderToStaticMarkup(<LifeAdminView today="2026-11-12" records={[]} checklist={[]} initialTab={initialTab} />);
}

function attr(attrs: string, name: string): string | null {
  return new RegExp(`\\b${name}="([^"]*)"`).exec(attrs)?.[1] ?? null;
}

test("the section buttons are tabs in a labelled tablist, exactly one selected, controlling a labelled tabpanel", () => {
  const markup = render("checklist");
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
    ["Your things (0)", "Upcoming (0)", "Bookings (0)", "Moving checklist (0)"],
  );
  const selected = tabs.filter(
    (t) => attr(t.attrs, "aria-selected") === "true",
  );
  assert.equal(selected.length, 1);
  assert.equal(selected[0]!.text, "Moving checklist (0)");
  assert.equal(
    tabs.filter((t) => attr(t.attrs, "aria-selected") === "false").length,
    3,
  );
  // Roving tabindex: only the selected tab is in the tab order.
  assert.deepEqual(
    tabs.map((t) => attr(t.attrs, "tabindex")),
    ["-1", "-1", "-1", "0"],
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
  const markup = render("things");
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

test("every panel stays mounted with only the selected panel visible; Your things opens by default", () => {
  for (const [initialTab, shownIndex] of [[undefined, 0], ["things", 0], ["upcoming", 1], ["bookings", 2], ["checklist", 3]] as const) {
    const panels = [
      ...render(initialTab).matchAll(/<div\b([^>]*role="tabpanel"[^>]*)>/g),
    ].map((match) => match[1]!);
    assert.equal(panels.length, 4);
    assert.deepEqual(panels.map((attrs) => /\bhidden=""/.test(attrs)), [0, 1, 2, 3].map((index) => index !== shownIndex), String(initialTab));
  }
});
