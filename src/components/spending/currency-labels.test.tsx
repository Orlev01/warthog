import * as React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { DashboardView, type DashboardAgent } from "../home/dashboard-view";
import { SpendingView } from "./spending-view";

const agent: DashboardAgent & { currency: string; spendUnavailable?: boolean } = {
  id: "synthetic", name: "Test agent", status: "connected", spendThisPeriod: 60,
  budget: 100, budgetPeriod: "month", currency: "USD",
};

test("Home displays the agent budget currency instead of always Australian dollars", () => {
  const html = renderToStaticMarkup(<DashboardView personName="Test" checklist={[]} pendingApprovals={0}
    activity={[]} reminders={[]} agents={[agent]} />);
  assert.match(html, /USD 60 of USD 100/);
  assert.doesNotMatch(html, /A\$60/);
});

test("Home warns when an earlier release cannot be included in its total", () => {
  const html = renderToStaticMarkup(<DashboardView personName="Test" checklist={[]} pendingApprovals={0}
    activity={[]} reminders={[]} agents={[{ ...agent, spendUnavailable: true }]} />);
  assert.match(html, /Total unavailable.*reference rate/i);
  assert.doesNotMatch(html, /60 of/);
});

test("Spending does not present incomplete converted spending as a complete total", () => {
  const own = { agents: [{ agentId: "synthetic", displayName: "Test agent", approvedTotal: 0,
    budget: { amount: 100, currency: "AUD", period: "month" as const }, releases: [],
    unconverted: [{ currency: "USD", amount: 60 }] }] };
  const html = renderToStaticMarkup(<SpendingView own={own} household={null} accountCurrency="AUD" currencyOptions={["AUD"]} />);
  assert.match(html, /Total unavailable.*reference rate/i);
  assert.match(html, /USD 60\.00/);
  assert.doesNotMatch(html, /AUD 0\.00 of AUD 100\.00/);
});

test("shared budgets explain their common month and flag unresolved historical release dates", () => {
  const household = { householdId: "synthetic", currency: "AUD", monthlyBudget: 100,
    budgetSpendToDate: 0, periodIncomplete: true, members: [] };
  const html = renderToStaticMarkup(<SpendingView own={{ agents: [] }} household={household} accountCurrency="AUD" currencyOptions={["AUD"]} />);
  assert.match(html, /UTC/);
  assert.match(html, /Total unavailable.*release dates/i);
  assert.doesNotMatch(html, /AUD 0\.00 of AUD 100\.00/);
});
