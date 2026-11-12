// Home's activity and agents sections, organised (12 November): recent activity is a short
// list with a way into the full log and its grouped views; an agent's own report is labelled
// as such on Home too (it was shown as fact); each agent links to its workspace and its
// activity with the last day's counts; what needs attention is surfaced, not buried.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { DashboardView, type DashboardViewProps } from "./dashboard-view";

const base: DashboardViewProps = {
  personName: "Sam",
  checklist: [],
  pendingApprovals: 0,
  activity: [],
  agents: [],
  reminders: [],
};
const text = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();

test("recent activity names what happened, links each entry and offers the full and grouped log", () => {
  const html = renderToStaticMarkup(
    <DashboardView
      {...base}
      activity={[
        { id: "1", title: "Send", summary: "Stated reason: tell Sam", outcome: "Denied", outcomeGroup: "blocked", agent: "Claude", service: "Gmail", at: "12 Nov 2026, 2:00 pm (Australia/Sydney)", when: "Today, 2:00 pm", href: "/activity?entry=7#entry-7" },
        { id: "2", title: "Agent report", summary: "Booked the car service", agent: "Helper", reported: true, at: "x", when: "Today, 1:00 pm", href: "/activity?entry=6#entry-6" },
      ]}
    />,
  );
  const shown = text(html);
  assert.match(html, /href="\/activity\?entry=7#entry-7"[^>]*>Send/);
  assert.ok(shown.includes("Stated reason: tell Sam"));
  assert.ok(shown.includes("Claude · Gmail"));
  assert.ok(shown.includes("Reported by Helper"), "an agent's report is labelled on Home");
  assert.match(html, /href="\/activity"[^>]*>View all activity/);
  assert.match(html, /href="\/activity\?view=agents"[^>]*>By agent/);
});

test("what needs attention in the last day is surfaced with a link", () => {
  const html = renderToStaticMarkup(<DashboardView {...base} attention={{ count: 3, href: "/activity?attention=1" }} activity={[{ id: "1", summary: "x", at: "y" }]} />);
  assert.match(html, /href="\/activity\?attention=1"[^>]*>.*3 entries need attention from the last 24 hours/);
  assert.doesNotMatch(renderToStaticMarkup(<DashboardView {...base} />), /need attention/);
});

test("each agent links to its workspace and its activity, with the last day's counts", () => {
  const html = renderToStaticMarkup(
    <DashboardView
      {...base}
      agents={[{ id: "a1", name: "Claude", status: "connected", spendThisPeriod: 0, budget: 0, budgetPeriod: "month", href: "/agents/a1", activityHref: "/activity?agent=a1&via=agents", todayCount: 14, needsAttention: 2, lastActive: "Today, 3:04 pm" }]}
    />,
  );
  const shown = text(html);
  assert.match(html, /href="\/agents\/a1"[^>]*>Claude/);
  assert.match(html, /href="\/activity\?agent=a1&amp;via=agents"/);
  assert.ok(shown.includes("14 entries in the last 24 hours"));
  assert.ok(shown.includes("2 need attention"));
  assert.ok(shown.includes("last active Today, 3:04 pm"));
});

test("Home shows the soonest five reminders and a way to the rest", () => {
  const reminders = Array.from({ length: 7 }, (_, i) => ({ id: `r${i}`, title: `Reminder ${i}`, due: `${i + 1} Dec 2026` }));
  const shown = text(renderToStaticMarkup(<DashboardView {...base} reminders={reminders} />));
  assert.ok(shown.includes("Reminder 4"));
  assert.ok(!shown.includes("Reminder 5"));
  assert.ok(shown.includes("View all 7 in Life admin"));
});
