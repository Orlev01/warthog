import * as React from "react";

import type { SetupChecklistItem } from "@/domain/home/checklist";
import { SetupChecklist } from "./setup-checklist";
import { Status, type StatusKey } from "@/components/ui/status";
import { InstallPrompt, type RegisterPushDeviceAction } from "@/components/pwa/install-prompt";

// DashboardView — the home dashboard (brief "Home dashboard"). It composes, in
// ONE render-testable component, every section the brief describes so the page
// loader (E18-S08) stays thin: a greeting, the data-driven set-up checklist
// (reusing <SetupChecklist>, whose five items/links come from the one domain
// module @/domain/home/checklist — this component hard-codes none), a
// pending-approvals count that links to the inbox, the latest activity across
// all agents, each agent with its status and spend-this-period against its
// budget, and the upcoming reminders.
//
// Beside the checklist sits the install prompt (review fix W4.1; brief "install the app
// and turn on notifications"): the iOS Add-to-Home-Screen sheet or the Android install
// button, and "Turn on notifications", which sets this device up for push through the
// page's register action. It reads the browser only after mount and hides what is
// already done (installed, or notifications decided).
//
// Every data-bearing section renders a PLAIN empty message when it has no data
// (no pending approvals, no recent activity, no agents, no reminders) rather
// than a dead control. The greeting and the checklist always show.
//
// This is purely a renderer: it takes already-computed, already-redacted,
// already-formatted values as props. Dates/amounts arrive pre-formatted (or as
// plain major-unit numbers) — the view never reaches for a clock or a locale.
// Colour comes from the design tokens (globals.css), never raw hex.

// One connected agent on the dashboard: its name, connection status, and the
// spend in its current budget period against its budget. `spendThisPeriod` and
// `budget` are plain amounts in the major unit.
export type DashboardAgent = {
  id: string;
  name: string;
  status: StatusKey;
  spendThisPeriod: number;
  budget: number;
  budgetPeriod: "day" | "week" | "month";
  currency?: string;
  spendUnavailable?: boolean;
};

// One latest-activity line: a plain, already-redacted summary, its outcome in words
// (e.g. "Denied"; absent when the entry has none), the agent it came from (absent for a
// Warthog-sourced entry), and a pre-formatted time label.
export type DashboardActivity = {
  id: string;
  summary: string;
  outcome?: string;
  agent?: string;
  at: string;
};

// One upcoming life-admin reminder: a title and a pre-formatted due label.
export type DashboardReminder = {
  id: string;
  title: string;
  due: string;
};

export type DashboardViewProps = {
  personName: string;
  checklist: ReadonlyArray<SetupChecklistItem>;
  pendingApprovals: number;
  activity: ReadonlyArray<DashboardActivity>;
  agents: ReadonlyArray<DashboardAgent>;
  reminders: ReadonlyArray<DashboardReminder>;
  // Wiring for the install prompt's "Turn on notifications" (the page passes these in
  // the running app): the register-this-device server action and the PUBLIC VAPID key.
  registerPushDevice?: RegisterPushDeviceAction;
  vapidPublicKey?: string;
};

// Plain words for the budget period, so spend reads "A$42 of A$200 this month".
function periodLabel(period: DashboardAgent["budgetPeriod"]): string {
  switch (period) {
    case "day":
      return "today";
    case "week":
      return "this week";
    case "month":
      return "this month";
  }
}

export function DashboardView({
  personName,
  checklist,
  pendingApprovals,
  activity,
  agents,
  reminders,
  registerPushDevice,
  vapidPublicKey,
}: DashboardViewProps) {
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-8 px-4 py-8 sm:px-6">
      <h1 className="text-2xl font-semibold tracking-tight text-fg">Hi, {personName}</h1>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold text-fg">Set up Warthog</h2>
        <SetupChecklist items={checklist} />
        <InstallPrompt registerPushDevice={registerPushDevice} vapidPublicKey={vapidPublicKey} />
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold text-fg">Approvals</h2>
        {pendingApprovals > 0 ? (
          <a
            className="font-medium text-accent hover:text-accent-hover"
            href="/inbox"
          >
            {pendingApprovals} pending approval{pendingApprovals === 1 ? "" : "s"}
          </a>
        ) : (
          <p className="text-sm text-fg-muted">No pending approvals.</p>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold text-fg">Recent activity</h2>
        {activity.length > 0 ? (
          <ul className="flex flex-col gap-2">
            {activity.map((entry) => (
              <li
                key={entry.id}
                className="flex flex-col gap-1 rounded-card border border-line bg-surface p-3"
              >
                <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="text-fg">{entry.summary}</span>
                  {entry.outcome ? (
                    <span className="rounded-card bg-surface-muted px-2 py-0.5 text-xs font-medium text-fg-muted">
                      {entry.outcome}
                    </span>
                  ) : null}
                </span>
                <span className="text-sm text-fg-muted">
                  {entry.agent ? `${entry.agent} · ${entry.at}` : entry.at}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-fg-muted">No recent activity yet.</p>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold text-fg">Your agents</h2>
        {agents.length > 0 ? (
          <ul className="flex flex-col gap-2">
            {agents.map((agent) => (
              <li
                key={agent.id}
                className="flex flex-col gap-2 rounded-card border border-line bg-surface p-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="flex flex-col gap-1">
                  <span className="font-medium text-fg">{agent.name}</span>
                  <Status status={agent.status} />
                </div>
                <span className="text-sm text-fg-muted">
                  {agent.spendUnavailable
                    ? "Total unavailable: a reference rate is missing for earlier spending."
                    : `${agent.currency && agent.currency !== "AUD" ? agent.currency + " " : "A$"}${agent.spendThisPeriod} of ${agent.currency && agent.currency !== "AUD" ? agent.currency + " " : "A$"}${agent.budget} ${periodLabel(agent.budgetPeriod)}`}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-fg-muted">No agents connected yet.</p>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold text-fg">Reminders</h2>
        {reminders.length > 0 ? (
          <ul className="flex flex-col gap-2">
            {reminders.map((reminder) => (
              <li
                key={reminder.id}
                className="flex flex-col gap-1 rounded-card border border-line bg-surface p-3"
              >
                <span className="text-fg">{reminder.title}</span>
                <span className="text-sm text-fg-muted">Due {reminder.due}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-fg-muted">No reminders yet.</p>
        )}
      </section>
    </div>
  );
}
