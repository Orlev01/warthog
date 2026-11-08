// Review fix G10 — the Life admin section switcher is a real tab list.
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

import { LifeAdminView, nextTabIndex } from "./life-admin-view";

function render(initialTab?: "subscriptions" | "receipts" | "renewals" | "checklist"): string {
  return renderToStaticMarkup(
    <LifeAdminView subscriptions={[]} receipts={[]} renewals={[]} checklist={[]} initialTab={initialTab} />,
  );
}

function attr(attrs: string, name: string): string | null {
  return new RegExp(`\\b${name}="([^"]*)"`).exec(attrs)?.[1] ?? null;
}

test("the section buttons are tabs in a labelled tablist, exactly one selected, controlling a labelled tabpanel", () => {
  const markup = render("receipts");
  const tablist = /<div\b([^>]*role="tablist"[^>]*)>/.exec(markup);
  assert.ok(tablist, "a tablist is rendered");
  assert.ok(attr(tablist![1]!, "aria-label"), "the tablist is labelled");

  const tabs = [...markup.matchAll(/<button\b([^>]*role="tab"[^>]*)>([\s\S]*?)<\/button>/g)].map((m) => ({
    attrs: m[1]!,
    text: m[2]!.replace(/<[^>]*>/g, "").replace(/&amp;/g, "&").trim(),
  }));
  assert.deepEqual(
    tabs.map((t) => t.text),
    ["Subscriptions", "Receipts & warranties", "Renewals & appointments", "Moving checklist"],
  );
  const selected = tabs.filter((t) => attr(t.attrs, "aria-selected") === "true");
  assert.equal(selected.length, 1);
  assert.equal(selected[0]!.text, "Receipts & warranties");
  assert.equal(tabs.filter((t) => attr(t.attrs, "aria-selected") === "false").length, 3);
  // Roving tabindex: only the selected tab is in the tab order.
  assert.deepEqual(tabs.map((t) => attr(t.attrs, "tabindex")), ["-1", "0", "-1", "-1"]);

  const panelId = attr(selected[0]!.attrs, "aria-controls");
  assert.ok(panelId);
  const panel = new RegExp(`<div\\b([^>]*id="${panelId}"[^>]*)>`).exec(markup);
  assert.ok(panel, "aria-controls points at a rendered element");
  assert.equal(attr(panel![1]!, "role"), "tabpanel");
  assert.equal(attr(panel![1]!, "aria-labelledby"), attr(selected[0]!.attrs, "id"));
});

test("the selected tab is marked by more than colour", () => {
  const markup = render("subscriptions");
  const selected = /<button\b([^>]*aria-selected="true"[^>]*)>/.exec(markup)![1]!;
  const other = /<button\b([^>]*aria-selected="false"[^>]*)>/.exec(markup)![1]!;
  assert.match(selected, /\bfont-semibold\b/);
  assert.ok(!/\bfont-semibold\b/.test(other));
});

test("arrow keys, Home and End move between tabs, wrapping at the ends", () => {
  assert.equal(nextTabIndex(0, "ArrowRight", 4), 1);
  assert.equal(nextTabIndex(3, "ArrowRight", 4), 0);
  assert.equal(nextTabIndex(0, "ArrowLeft", 4), 3);
  assert.equal(nextTabIndex(2, "Home", 4), 0);
  assert.equal(nextTabIndex(1, "End", 4), 3);
  assert.equal(nextTabIndex(1, "a", 4), null, "other keys are left alone");
});
