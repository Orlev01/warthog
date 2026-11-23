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

test("Home shows the soonest five reminders and a way to the rest in Life admin's Upcoming", () => {
  const reminders = Array.from({ length: 7 }, (_, i) => ({ id: `r${i}`, title: `Reminder ${i}`, due: `${i + 1} Dec 2026` }));
  const html = renderToStaticMarkup(<DashboardView {...base} reminders={reminders} />);
  const shown = text(html);
  assert.ok(shown.includes("Reminder 4"));
  assert.ok(!shown.includes("Reminder 5"));
  assert.match(html, /href="\/life-admin\?view=life&amp;tab=upcoming"[^>]*>View all 7 in Upcoming/);
  assert.match(renderToStaticMarkup(<DashboardView {...base} reminders={reminders.slice(0, 2)} />), /href="\/life-admin\?view=life&amp;tab=upcoming"[^>]*>See what&#x27;s coming up/);
});

// Life admin's typed records (docs/adr/life-admin-profile.md): each reminder opens its record
// in Life admin, says what its date means ("Expires"), says plainly when it has passed (words
// and an icon), and Home says how many things agents found are waiting to be checked.
test("each reminder links to its record, reads its date the type's way, and an overdue one says so", () => {
  const html = renderToStaticMarkup(
    <DashboardView
      {...base}
      reminders={[
        { id: "r1", title: "Medibank", due: "2 Nov 2026", dueLabel: "Renews", overdue: true, href: "/life-admin?view=life&tab=things#record-r1" },
        { id: "r2", title: "Transport for NSW", due: "14 Dec 2026", dueLabel: "Expires", href: "/life-admin?view=life&tab=things#record-r2" },
        { id: "r3", title: "Dentist", due: "1 Jan 2027" },
      ]}
    />,
  );
  assert.match(html, /href="\/life-admin\?view=life&amp;tab=things#record-r1"[^>]*>[\s\S]*?Medibank[\s\S]*?Overdue since 2 Nov 2026/);
  assert.match(html, /href="\/life-admin\?view=life&amp;tab=things#record-r2"[^>]*>[\s\S]*?Transport for NSW[\s\S]*?Expires 14 Dec 2026/);
  assert.match(text(html), /Dentist Due 1 Jan 2027/, "a reminder without a type's wording says Due");
  assert.match(html, /text-warning/, "an overdue reminder carries the warning icon as well as its words");
});

test("Home says how many things wait to be checked in Life admin, even with no reminders", () => {
  const html = renderToStaticMarkup(<DashboardView {...base} toCheck={{ count: 3, href: "/life-admin?view=life&tab=things" }} />);
  assert.match(html, /href="\/life-admin\?view=life&amp;tab=things"[^>]*>[\s\S]*?3 things to check/);
  assert.match(text(html), /No reminders coming up/, "the reminders panel still says there are none");
  assert.match(text(renderToStaticMarkup(<DashboardView {...base} toCheck={{ count: 1, href: "/life-admin" }} />)), /1 thing to check/);
  assert.doesNotMatch(text(renderToStaticMarkup(<DashboardView {...base} />)), /to check/, "nothing waiting, no line");
});
