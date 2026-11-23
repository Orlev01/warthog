// UI/UX pass (containment-02/18/19, desktop-07, interaction-19, newcomer-23) — the Life admin
// page is one heading band holding the title, its purpose and the Records & reminders | Tasks
// views; both views stay mounted, so switching between them no longer reloads the page and
// throws away a half-typed task; the outcome notice sits under the band, inside the view it
// came from, never above the tabs.

import * as React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";

import { LifeAdminScreen, type LifeAdminScreenProps } from "./life-admin-screen";

const noop = async () => {};

function render(over: Partial<LifeAdminScreenProps> = {}): string {
  return renderToStaticMarkup(
    <LifeAdminScreen
      initialView="life"
      records={{ today: "2026-11-12", records: [], checklist: [], addRecordAction: noop }}
      tasks={{ tasks: [], agents: [{ id: "agent-1", name: "Zephyr Assistant" }], createTaskAction: noop }}
      {...over}
    />,
  );
}

function tabpanels(markup: string): { attrs: string; body: string }[] {
  const starts = [...markup.matchAll(/<div\b([^>]*role="tabpanel"[^>]*)>/g)];
  return starts.map((match, index) => ({
    attrs: match[1]!,
    body: markup.slice(match.index!, starts[index + 1]?.index ?? markup.length),
  }));
}

test("one heading band holds the page title, its purpose and the two views as tabs", () => {
  const markup = render();
  const h1s = [...markup.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/g)];
  assert.equal(h1s.length, 1);
  assert.equal(h1s[0]![1], "Life admin");
  const band = /<header class="wh-page-heading">([\s\S]*?)<\/header>/.exec(markup)?.[1] ?? "";
  assert.match(band, /<h1>Life admin<\/h1>/, "the title is inside the band");
  assert.match(band, /class="wh-page-description"/, "the band says what the page is for");
  assert.match(band, /role="tablist" aria-label="Life admin views"/, "the view tabs are the band's nav row");
  const tabs = [...band.matchAll(/role="tab"[^>]*>([^<]*)<\/button>/g)].map((m) => m[1]!.replace(/&amp;/g, "&"));
  assert.deepEqual(tabs, ["Records & reminders", "Tasks"]);
});

test("both views stay mounted, so a half-typed task survives switching to Records and back", () => {
  for (const initialView of ["life", "tasks"] as const) {
    const panels = tabpanels(render({ initialView }));
    // The two outer views (the records view nests its own Your things | checklist panels).
    const records = panels.find((panel) => /role="tablist" aria-label="Life admin sections"/.test(panel.body));
    const tasks = panels.find((panel) => /placeholder="Describe the task"/.test(panel.body));
    assert.ok(records && tasks, `both views are rendered when ${initialView} is shown first`);
    assert.equal(/\bhidden=""/.test(tasks!.attrs), initialView !== "tasks", "only the chosen view is visible");
  }
});

test("the outcome notice is the first thing under the band, in the view the action came from", () => {
  const notice = <div data-testid="outcome">Task created.</div>;
  const markup = render({ initialView: "tasks", notice });
  assert.equal(markup.match(/data-testid="outcome"/g)?.length, 1, "shown once");
  assert.ok(markup.indexOf("</header>") < markup.indexOf('data-testid="outcome"'), "below the heading band");
  assert.ok(markup.indexOf('data-testid="outcome"') < markup.indexOf("Create a task"), "above the view's first panel");
});
