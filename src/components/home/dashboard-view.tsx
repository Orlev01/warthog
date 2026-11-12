import * as React from "react";
import { AgentMark, ServiceMark } from "@/components/ui/brand-mark";
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  Ban,
  Bell,
  Bot,
  CheckCheck,
  CheckCircle,
  CheckCircle2,
  Circle,
  Clock,
  ListChecks,
  type LucideIcon,
} from "lucide-react";
import { WorkspaceHeading, WorkspacePanel } from "@/components/shell/workspace-surfaces";

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
  platform?: string; // identifies the agent's brand mark
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
  serviceId?: string; // the service's catalogue id, for its mark
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
  done: { Icon: CheckCircle, tone: "wh-tone-success" },
  waiting: { Icon: Clock, tone: "wh-tone-warning" },
  blocked: { Icon: Ban, tone: "wh-tone-danger" },
  failed: { Icon: AlertTriangle, tone: "wh-tone-danger" },
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
  attention,
}: DashboardViewProps) {
  const completed = checklist.filter((item) => item.done).length;
  return (
    <div className="wh-page flex flex-col gap-6">
      <WorkspaceHeading
        eyebrow="Your workspace"
        title={<>Hi, {personName}</>}
        description="A place to oversee your agents, review their requests and keep track of what happens next."
      />
      <div className="wh-dashboard-grid">
        <div className="wh-dashboard-column">
          <WorkspacePanel title="Approvals" description="Requests waiting for your decision" icon={CheckCheck}>
            {pendingApprovals > 0 ? (
              <a className="wh-approval-summary" href="/inbox">
                <span>{pendingApprovals} pending approval{pendingApprovals === 1 ? "" : "s"}</span>
                <ArrowRight aria-hidden size={20} />
              </a>
            ) : (
              <div className="wh-panel-empty">
                <CheckCircle2 aria-hidden size={20} />
                <div><p className="font-medium text-fg">No pending approvals.</p><p>Requests that need your decision will appear here.</p></div>
              </div>
            )}
          </WorkspacePanel>
          <WorkspacePanel
            title="Recent activity"
            description="Recorded across your Warthog connections"
            icon={Activity}
            action={
              activity.length > 0 ? (
                <span className="flex flex-wrap gap-x-4">
                  <a href="/activity?view=agents">By agent</a>
                  <a href="/activity">View all activity <ArrowRight aria-hidden size={14} /></a>
                </span>
              ) : undefined
            }
          >
            {attention ? (
              <a href={attention.href} className="mb-4 inline-flex min-h-11 items-center gap-2 rounded-card border border-line bg-surface-muted px-3 text-sm font-medium text-fg underline underline-offset-4">
                <AlertTriangle aria-hidden={true} className="h-4 w-4 shrink-0 text-warning" />
                {attention.count} {attention.count === 1 ? "entry needs" : "entries need"} attention from the last 24 hours
              </a>
            ) : null}
            {activity.length > 0 ? (
              <ul className="wh-timeline">
                {activity.slice(0, HOME_ACTIVITY_ROWS).map((entry) => {
                  const icon = entry.outcomeGroup ? OUTCOME_ICONS[entry.outcomeGroup] : undefined;
                  const headline = entry.title ?? entry.summary;
                  return (
                    <li key={entry.id}>
                      <p className="flex items-center gap-2 text-sm font-medium text-fg">
                        {entry.serviceId ? <ServiceMark id={entry.serviceId} name={entry.service ?? entry.serviceId} size="xs" /> : null}
                        {entry.href ? (
                          <a href={entry.href} className="underline-offset-4 hover:underline">
                            {headline}<span className="sr-only">, {entry.at}</span>
                          </a>
                        ) : headline}
                      </p>
                      {entry.title && entry.summary !== entry.title ? (
                        <p className="mt-1 text-sm leading-relaxed text-fg">{entry.summary}</p>
                      ) : null}
                      <div className="wh-timeline-meta">
                        {entry.outcome ? (
                          <span className={`wh-tone-badge ${icon ? icon.tone : "wh-tone-neutral"}`}>
                            {icon ? <icon.Icon aria-hidden={true} className="h-3.5 w-3.5 shrink-0" /> : null}
                            {entry.outcome}
                          </span>
                        ) : null}
                        <span>
                          {[entry.reported ? `Reported by ${entry.agent ?? "an agent"}` : entry.agent, entry.service].filter(Boolean).join(" · ")}
                          {entry.reported || entry.agent || entry.service ? " · " : ""}
                          <time dateTime={entry.dateTime}>{entry.when ?? entry.at}</time>
                        </span>
                      </div>
                    </li>
                  );
                })}
              </ul>
            ) : <p className="wh-panel-empty">No recent activity yet.</p>}
          </WorkspacePanel>
        </div>
        <div className="wh-dashboard-column">
          <WorkspacePanel title="Your agents" description="Separate connections, individual controls" icon={Bot}>
            {agents.length > 0 ? (
              <ul className="flex flex-col divide-y divide-line">
                {agents.map((agent) => (
                  <li key={agent.id} className="flex min-w-0 flex-col gap-2 py-4 first:pt-0 last:pb-0">
                    <div className="flex min-w-0 items-start gap-3">
                      <AgentMark platform={agent.platform} name={agent.name} size="md" />
                      <div className="flex min-w-0 flex-1 flex-col items-start gap-1">
                        <a href={agent.href ?? `/agents/${encodeURIComponent(agent.id)}`} className="inline-flex min-h-11 items-center font-medium text-fg underline decoration-line-strong underline-offset-4 [overflow-wrap:anywhere]">{agent.name}</a>
                        <Status status={agent.status} />
                      </div>
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
                    <span className="min-w-0 text-xs leading-relaxed text-fg-muted">
                      {agent.spendUnavailable
                        ? "Total unavailable: a reference rate is missing for earlier spending."
                        : `${agent.currency && agent.currency !== "AUD" ? agent.currency + " " : "A$"}${agent.spendThisPeriod} of ${agent.currency && agent.currency !== "AUD" ? agent.currency + " " : "A$"}${agent.budget} ${periodLabel(agent.budgetPeriod)}`}
                    </span>
                  </li>
                ))}
              </ul>
            ) : <p className="wh-panel-empty">No agents connected yet.</p>}
          </WorkspacePanel>
          <WorkspacePanel title="Set up Warthog" description={`${completed} of ${checklist.length} steps complete`} icon={ListChecks}>
            <SetupChecklist items={checklist} />
            <InstallPrompt registerPushDevice={registerPushDevice} vapidPublicKey={vapidPublicKey} />
          </WorkspacePanel>
          <WorkspacePanel
            title="Reminders"
            description="Coming up in your life admin"
            icon={Bell}
            action={reminders.length > 0 ? (
              <a href="/life-admin">
                {reminders.length > HOME_REMINDER_ROWS ? `View all ${reminders.length} in Life admin` : "Open Life admin"}
              </a>
            ) : undefined}
          >
            {reminders.length > 0 ? (
              <ul className="flex flex-col divide-y divide-line">
                {reminders.slice(0, HOME_REMINDER_ROWS).map((reminder) => (
                  <li key={reminder.id} className="flex items-start gap-3 py-3 first:pt-0 last:pb-0">
                    <Circle aria-hidden size={15} className="mt-1 shrink-0 text-fg-muted" />
                    <div className="min-w-0">
                      <p className="text-sm text-fg [overflow-wrap:anywhere]">{reminder.title}</p>
                      <p className="mt-1 text-xs text-fg-muted">Due {reminder.due}</p>
                    </div>
                  </li>
                ))}
              </ul>
            ) : <p className="wh-panel-empty">No reminders yet.</p>}
          </WorkspacePanel>
        </div>
      </div>
    </div>
  );
}
