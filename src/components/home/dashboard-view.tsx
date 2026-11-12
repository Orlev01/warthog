import * as React from "react";
import { AlertTriangle, Ban, CheckCircle, Clock, type LucideIcon } from "lucide-react";

import type { SetupChecklistItem } from "@/domain/home/checklist";
import type { OutcomeGroup } from "@/domain/activity/category";
import { SetupChecklist } from "./setup-checklist";
import { Status, type StatusKey } from "@/components/ui/status";
import {
  InstallPrompt,
  type RegisterPushDeviceAction,
} from "@/components/pwa/install-prompt";

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
  href?: string; // the agent's workspace
  activityHref?: string; // its activity
  lastActive?: string; // "Today, 3:04 pm"
  todayCount?: number; // entries in the last 24 hours
  needsAttention?: number; // blocked, failed or disputed in the last 24 hours
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
  title?: string; // what happened, e.g. "Save a memory"
  summary: string;
  outcome?: string;
  outcomeGroup?: OutcomeGroup;
  agent?: string;
  reported?: boolean; // an agent's own report, never shown as fact
  service?: string;
  at: string;
  when?: string; // "Today, 3:04 pm"
  dateTime?: string;
  href?: string; // the entry on the Activity page
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
  // Blocked, failed or disputed activity in the last 24 hours, linking to it.
  attention?: { count: number; href: string };
};

// How many of each list Home shows before "View all".
const HOME_ACTIVITY_ROWS = 8;
const HOME_REMINDER_ROWS = 5;

const OUTCOME_ICONS: Partial<Record<OutcomeGroup, { Icon: LucideIcon; tone: string }>> = {
  done: { Icon: CheckCircle, tone: "text-success" },
  waiting: { Icon: Clock, tone: "text-fg-muted" },
  blocked: { Icon: Ban, tone: "text-danger" },
  failed: { Icon: AlertTriangle, tone: "text-danger" },
};

const SECTION_LINK = "inline-flex min-h-11 items-center text-sm font-medium text-fg underline underline-offset-4 hover:text-fg-muted";

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
  attention,
}: DashboardViewProps) {
  return (
    <div className="wh-page flex flex-col gap-8">
      <h1 className="text-2xl font-semibold tracking-tight text-fg">
        Hi, {personName}
      </h1>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold text-fg">Set up Warthog</h2>
        <SetupChecklist items={checklist} />
        <InstallPrompt
          registerPushDevice={registerPushDevice}
          vapidPublicKey={vapidPublicKey}
        />
      </section>

      <div className="grid min-w-0 gap-8 xl:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-8">
          <section className="flex flex-col gap-3">
            <h2 className="text-lg font-semibold text-fg">Approvals</h2>
            {pendingApprovals > 0 ? (
              <a
                className="inline-flex min-h-11 items-center self-start font-medium text-fg underline underline-offset-4 hover:text-fg-muted"
                href="/inbox"
              >
                {pendingApprovals} pending approval
                {pendingApprovals === 1 ? "" : "s"}
              </a>
            ) : (
              <p className="text-sm text-fg-muted">No pending approvals.</p>
            )}
          </section>

          <section className="flex flex-col gap-3" aria-labelledby="home-activity-heading">
            <div className="flex flex-wrap items-center justify-between gap-x-4">
              <h2 id="home-activity-heading" className="text-lg font-semibold text-fg">Recent activity</h2>
              {activity.length > 0 ? (
                <span className="flex flex-wrap gap-x-4">
                  <a className={SECTION_LINK} href="/activity?view=agents">By agent</a>
                  <a className={SECTION_LINK} href="/activity">View all activity</a>
                </span>
              ) : null}
            </div>
            {attention ? (
              <a href={attention.href} className="inline-flex min-h-11 items-center gap-2 self-start rounded-card border border-line bg-surface px-3 text-sm font-medium text-fg underline underline-offset-4">
                <AlertTriangle aria-hidden={true} className="h-4 w-4 shrink-0 text-warning" />
                {attention.count} {attention.count === 1 ? "entry needs" : "entries need"} attention from the last 24 hours
              </a>
            ) : null}
            {activity.length > 0 ? (
              <ul role="list" className="flex flex-col">
                {activity.slice(0, HOME_ACTIVITY_ROWS).map((entry) => {
                  const icon = entry.outcomeGroup ? OUTCOME_ICONS[entry.outcomeGroup] : undefined;
                  const headline = entry.title ?? entry.summary;
                  return (
                    <li key={entry.id} className="flex min-w-0 flex-col gap-1 border-b border-line py-3 last:border-0 [overflow-wrap:anywhere]">
                      <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                        {entry.href ? (
                          <a href={entry.href} className="font-medium text-fg underline-offset-4 hover:underline">
                            {headline}<span className="sr-only">, {entry.at}</span>
                          </a>
                        ) : (
                          <span className="font-medium text-fg">{headline}</span>
                        )}
                        {entry.outcome ? (
                          <span className="inline-flex items-center gap-1 rounded-card bg-surface-muted px-2 py-0.5 text-xs font-medium text-fg">
                            {icon ? <icon.Icon aria-hidden={true} className={`h-3.5 w-3.5 shrink-0 ${icon.tone}`} /> : null}
                            {entry.outcome}
                          </span>
                        ) : null}
                      </span>
                      {entry.title && entry.summary !== entry.title ? <span className="text-sm text-fg">{entry.summary}</span> : null}
                      <span className="text-sm text-fg-muted">
                        {[
                          entry.reported ? `Reported by ${entry.agent ?? "an agent"}` : entry.agent,
                          entry.service,
                        ].filter(Boolean).join(" · ")}
                        {entry.reported || entry.agent || entry.service ? " · " : ""}
                        <time dateTime={entry.dateTime}>{entry.when ?? entry.at}</time>
                      </span>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="text-sm text-fg-muted">No recent activity yet.</p>
            )}
          </section>
        </div>
        <div className="flex min-w-0 flex-col gap-8 border-line xl:border-s xl:ps-8">
          <section className="flex flex-col gap-3">
            <h2 className="text-lg font-semibold text-fg">Your agents</h2>
            {agents.length > 0 ? (
              <ul role="list" className="flex flex-col">
                {agents.map((agent) => (
                  <li
                    key={agent.id}
                    className="flex min-w-0 flex-col gap-1 border-b border-line py-3 last:border-0"
                  >
                    <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1">
                      {agent.href ? (
                        <a href={agent.href} className="line-clamp-2 font-medium text-fg underline-offset-4 [overflow-wrap:anywhere] hover:underline">
                          {agent.name}
                        </a>
                      ) : (
                        <span className="line-clamp-2 font-medium text-fg [overflow-wrap:anywhere]">{agent.name}</span>
                      )}
                      <Status status={agent.status} />
                    </div>
                    {agent.activityHref ? (
                      <span className="text-sm text-fg-muted">
                        <a href={agent.activityHref} className="underline underline-offset-2 hover:text-fg">
                          {agent.todayCount ?? 0} {(agent.todayCount ?? 0) === 1 ? "entry" : "entries"} in the last 24 hours<span className="sr-only"> for {agent.name}</span>
                        </a>
                        {agent.needsAttention ? <> · <AlertTriangle aria-hidden={true} className="inline h-3.5 w-3.5 text-warning" /> {agent.needsAttention} need{agent.needsAttention === 1 ? "s" : ""} attention</> : null}
                        {agent.lastActive ? <> · last active {agent.lastActive}</> : null}
                      </span>
                    ) : null}
                    <span className="min-w-0 text-sm text-fg-muted">
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
              <ul role="list" className="flex flex-col">
                {reminders.slice(0, HOME_REMINDER_ROWS).map((reminder) => (
                  <li
                    key={reminder.id}
                    className="flex flex-col gap-1 border-b border-line py-4 last:border-0"
                  >
                    <span className="text-fg [overflow-wrap:anywhere]">
                      {reminder.title}
                    </span>
                    <span className="text-sm text-fg-muted">
                      Due {reminder.due}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-fg-muted">No reminders yet.</p>
            )}
            {reminders.length > 0 ? (
              <a className={SECTION_LINK} href="/life-admin">
                {reminders.length > HOME_REMINDER_ROWS ? `View all ${reminders.length} in Life admin` : "Open Life admin"}
              </a>
            ) : null}
          </section>
        </div>
      </div>
    </div>
  );
}
