// UI/UX pass (containment-02/18/19, desktop-07, interaction-19, newcomer-23; founder, 23 Nov
// 2026) — the Life admin page is one heading band holding the title, its purpose and one row of
// tabs, Records | Upcoming | History | Tasks; every tab stays mounted, so switching between them
// never reloads the page and throws away a half-typed task; the outcome notice sits under the
// band, inside the tab it came from, never above the tabs.

import * as React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";

import { LifeAdminScreen, type LifeAdminScreenProps } from "./life-admin-screen";

const noop = async () => {};

function render(over: Partial<LifeAdminScreenProps> = {}): string {
  return renderToStaticMarkup(
    <LifeAdminScreen
      initialTab="records"
      records={{ today: "2026-11-12", records: [], addRecordAction: noop }}
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

test("one heading band holds the page title, its purpose and the four tabs", () => {
  const markup = render();
  const h1s = [...markup.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/g)];
  assert.equal(h1s.length, 1);
  assert.equal(h1s[0]![1], "Life admin");
  const band = /<header class="wh-page-heading">([\s\S]*?)<\/header>/.exec(markup)?.[1] ?? "";
  assert.match(band, /<h1>Life admin<\/h1>/, "the title is inside the band");
  assert.match(band, /class="wh-page-description"/, "the band says what the page is for");
  assert.match(band, /role="tablist" aria-label="Life admin"/, "the tabs are the band's nav row");
  const tabs = [...band.matchAll(/role="tab"[^>]*>([^<]*)<\/button>/g)].map((m) => m[1]!.replace(/&amp;/g, "&"));
  assert.deepEqual(tabs, ["Records", "Upcoming", "History", "Tasks"]);
  assert.equal([...markup.matchAll(/role="tablist"/g)].length, 1, "one row of tabs, none nested");
});

test("every tab stays mounted, so a half-typed task survives switching to Records and back", () => {
  const order = ["records", "upcoming", "history", "tasks"] as const;
  for (const initialTab of order) {
    const panels = tabpanels(render({ initialTab }));
    assert.equal(panels.length, 4, "a panel per tab");
    const records = panels.find((panel) => /What are you adding\?/.test(panel.body));
    const tasks = panels.find((panel) => /placeholder="Describe the task"/.test(panel.body));
    assert.ok(records && tasks, `Records and Tasks are both rendered when ${initialTab} is shown first`);
    assert.deepEqual(panels.map((panel) => /\bhidden=""/.test(panel.attrs)), order.map((key) => key !== initialTab), "only the chosen tab is visible");
  }
});

test("the outcome notice is the first thing under the band, in the tab the action came from", () => {
  const notice = <div data-testid="outcome">Task created.</div>;
  const markup = render({ initialTab: "tasks", notice });
  assert.equal(markup.match(/data-testid="outcome"/g)?.length, 1, "shown once");
  assert.ok(markup.indexOf("</header>") < markup.indexOf('data-testid="outcome"'), "below the heading band");
  const tasks = tabpanels(markup)[3]!.body;
  assert.match(tasks, /data-testid="outcome"/, "inside the Tasks tab");
  assert.ok(tasks.indexOf('data-testid="outcome"') < tasks.indexOf("Create a task"), "above the tab's first panel");
});
