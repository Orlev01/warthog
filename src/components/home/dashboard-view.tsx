import * as React from "react";
import { AgentMark, ServiceMark } from "@/components/ui/brand-mark";
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  Ban,
  Bell,
  Bot,
  CheckCircle,
  CheckCircle2,
  Circle,
  ClipboardCheck,
  Clock,
  Inbox,
  ListChecks,
  type LucideIcon,
} from "lucide-react";
import { WorkspaceHeading, WorkspacePanel } from "@/components/shell/workspace-surfaces";

import type { SetupChecklistItem } from "@/domain/home/checklist";
import type { OutcomeGroup } from "@/domain/activity/category";
import { formatMoney } from "@/domain/approvals/request-sentence";
import { NOTHING_WAITING } from "@/domain/approvals/inbox-copy";
import { SetupChecklist } from "./setup-checklist";
import { Status, type DisplayStatus } from "@/components/ui/status";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button-link";
import { EmptyState } from "@/components/ui/empty";
import { Notice } from "@/components/ui/notice";
import { ActionForm, FormSubmit } from "@/components/ui/form-submit";
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
// Onboarding first (UI/UX pass, newcomer-01): until every set-up step is done, the
// set-up panel is the first thing under the greeting, full width. A member with no
// agent yet sees it as "Get started" with one primary action, "Connect your first
// agent"; the panels that can only fill once an agent is connected (Inbox, activity,
// agents, reminders) appear as soon as they have something to show, so a newcomer's
// Home is one clear task rather than a wall of empty panels. The panel goes once every
// step is done.
//
// Beside the checklist sits the install prompt (review fix W4.1; brief "install the app
// and turn on notifications"): the iOS Add-to-Home-Screen sheet or the Android install
// button, and "Turn on notifications", which sets this device up for push through the
// page's register action. It reads the browser only after mount and hides what is
// already done (installed, or notifications decided).
//
// Every data-bearing panel renders a bounded empty state with a next step when it has
// no data (no pending approvals, no recent activity, no reminders) rather than a dead
// control. Every piece of text sits in the heading band or a panel, never on the canvas.
//
// This is purely a renderer: it takes already-computed, already-redacted,
// already-formatted values as props. Dates arrive pre-formatted and amounts as
// plain major-unit numbers (formatted here with the shared en-AU money formatter) —
// the view never reaches for a clock. Colour comes from the design tokens, never raw hex.

// One connected agent on the dashboard: its name, connection status, and the
// spend in its current budget period against its card budget. `spendThisPeriod` and
// `budget` are plain amounts in the major unit; `budget` is null (or absent) when the
// agent has no card budget.
export type DashboardAgent = {
  id: string;
  platform?: string; // identifies the agent's brand mark
  name: string;
  href?: string; // the agent's workspace
  activityHref?: string; // its activity
  attentionHref?: string; // its activity that needs attention
  lastActive?: string; // "Today, 3:04 pm"
  todayCount?: number; // entries in the last 24 hours
  needsAttention?: number; // blocked, failed or disputed in the last 24 hours
  status: DisplayStatus;
  spendThisPeriod: number;
  budget?: number | null;
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

// One upcoming life-admin reminder: a title and a pre-formatted due date, what the date
// means for its type ("Expires"; "Due" when absent), whether it has passed, and its row in
// Life admin.
export type DashboardReminder = {
  id: string;
  title: string;
  due: string;
  dueLabel?: string;
  overdue?: boolean;
  href?: string;
};

// After an account recovery (sign-in audit, founder decision 13 November 2026): when it
// happened, pre-formatted, and the agents it kept, each linking to its settings.
export type DashboardRecoveryReview = {
  // The recovery's activity entry hash: Dismiss posts it so only the notice shown is hidden.
  id: string;
  recoveredAt: string;
  agents: ReadonlyArray<{ id: string; name: string; href: string }>;
};

export type DashboardViewProps = {
  personName: string;
  checklist: ReadonlyArray<SetupChecklistItem>;
  pendingApprovals: number;
  activity: ReadonlyArray<DashboardActivity>;
  agents: ReadonlyArray<DashboardAgent>;
  reminders: ReadonlyArray<DashboardReminder>;
  // Agents' suggestions and proposed changes waiting for the person in Life admin.
  toCheck?: { count: number; href: string };
  // Wiring for the install prompt's "Turn on notifications" (the page passes these in
  // the running app): the register-this-device server action and the PUBLIC VAPID key.
  registerPushDevice?: RegisterPushDeviceAction;
  vapidPublicKey?: string;
  // Blocked, failed or disputed activity in the last 24 hours, linking to it.
  attention?: { count: number; href: string };
  // The agents a recent account recovery kept, for the person to review, and the page's
  // server action that hides the notice on this browser.
  recoveryReview?: DashboardRecoveryReview;
  dismissRecoveryReview?: (formData: FormData) => void | Promise<void>;
};

// How many of each list Home shows before "View all".
const HOME_ACTIVITY_ROWS = 8;
const HOME_REMINDER_ROWS = 5;

// What Warthog is, in one sentence (the Help page's own words), for a member who hasn't
// connected an agent yet; once they have, the heading says what Home shows.
const PRODUCT_LINE = "Warthog is the one place you own that every AI agent connects through.";
const HOME_LINE = "What needs your decision, what your agents have done and what's coming up.";

const OUTCOME_BADGES: Partial<Record<OutcomeGroup, { Icon: LucideIcon; tone: BadgeTone }>> = {
  done: { Icon: CheckCircle, tone: "success" },
  waiting: { Icon: Clock, tone: "warning" },
  blocked: { Icon: Ban, tone: "danger" },
  failed: { Icon: AlertTriangle, tone: "danger" },
};

// A standalone text link in a dense row: a full 44px target on phones and touch screens
// that keeps its 20px line in the layout (the negative margin absorbs the extra height),
// back to its text size with a mouse on a desktop.
const ROW_LINK =
  "-my-3 inline-flex min-h-11 items-center underline-offset-4 lg:pointer-fine:my-0 lg:pointer-fine:min-h-0";
// A panel-header action link (By agent, View all activity, Open Life admin).
const ACTION_LINK = "inline-flex min-h-11 items-center gap-2 underline underline-offset-4 lg:pointer-fine:min-h-9";

// Plain words for the budget period, so spend reads "$42.00 of $200.00 this month".
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

// An agent's card spend against its card budget, or that it has none (the same words as
// the Agents list), formatted with the shared en-AU money formatter.
function SpendLine({ agent }: { agent: DashboardAgent }) {
  if (agent.spendUnavailable) {
    return <>Total unavailable: a reference rate is missing for earlier spending.</>;
  }
  if (agent.budget === null || agent.budget === undefined) {
    const href = agent.href ? `${agent.href}?section=spending` : undefined;
    return (
      <>
        No card budget
        {href ? (
          <>
            {" · "}
            <a href={href} className={`${ROW_LINK} underline`}>
              Set a budget<span className="sr-only"> for {agent.name}</span>
            </a>
          </>
        ) : null}
      </>
    );
  }
  const currency = agent.currency ?? "AUD";
  return (
    <>
      {formatMoney(agent.spendThisPeriod, currency)} of {formatMoney(agent.budget, currency)} {periodLabel(agent.budgetPeriod)}
    </>
  );
}

// The set-up checklist panel. Until an agent is connected it is "Get started", leading
// with the one action that makes Warthog work; after that it is "Finish setting up".
function SetupPanel({
  checklist,
  completed,
  hasAgents,
  registerPushDevice,
  vapidPublicKey,
}: {
  checklist: ReadonlyArray<SetupChecklistItem>;
  completed: number;
  hasAgents: boolean;
  registerPushDevice?: RegisterPushDeviceAction;
  vapidPublicKey?: string;
}) {
  return (
    <WorkspacePanel
      title={hasAgents ? "Finish setting up" : "Get started"}
      description={`${completed} of ${checklist.length} steps done`}
      icon={ListChecks}
    >
      {/* The install prompt's own sections sit as muted insets inside this panel (canvas →
          panel → inset), and its wrapper drops out of the layout while it has nothing to say. */}
      <div className="flex min-w-0 flex-col gap-4 [&>[data-install-prompt]:empty]:hidden [&_[data-install-prompt]_section]:rounded-[var(--wh-radius-inset)] [&_[data-install-prompt]_section]:border-transparent [&_[data-install-prompt]_section]:bg-surface-muted">
        {hasAgents ? null : (
          <div className="flex min-w-0 flex-col items-start gap-3">
            <p className="max-w-prose text-sm leading-relaxed text-fg">
              No agents connected yet. Start with the agent you already use, such as Claude or
              ChatGPT: it gets its own connection, and you choose what it can reach.
            </p>
            <ButtonLink href="/agents/connect" variant="primary">
              Connect your first agent
              <ArrowRight aria-hidden={true} className="h-4 w-4 shrink-0" />
            </ButtonLink>
          </div>
        )}
        <SetupChecklist items={checklist} />
        <InstallPrompt registerPushDevice={registerPushDevice} vapidPublicKey={vapidPublicKey} />
      </div>
    </WorkspacePanel>
  );
}

function InboxPanel({ pendingApprovals }: { pendingApprovals: number }) {
  return (
    <WorkspacePanel title="Inbox" description="Requests waiting for your decision" icon={Inbox}>
      {pendingApprovals > 0 ? (
        <a className="wh-approval-summary underline-offset-4 hover:underline" href="/inbox">
          <span>
            {pendingApprovals} {pendingApprovals === 1 ? "request is" : "requests are"} waiting for your approval
          </span>
          <ArrowRight aria-hidden={true} className="h-4 w-4 shrink-0" />
        </a>
      ) : (
        <EmptyState
          variant="inline"
          icon={CheckCircle2}
          heading={NOTHING_WAITING.heading}
          description={NOTHING_WAITING.description}
        />
      )}
    </WorkspacePanel>
  );
}

function ActivityPanel({
  activity,
  attention,
}: {
  activity: ReadonlyArray<DashboardActivity>;
  attention?: DashboardViewProps["attention"];
}) {
  return (
    <WorkspacePanel
      title="Recent activity"
      description="Recorded across all your agents"
      icon={Activity}
      action={
        activity.length > 0 ? (
          <span className="flex flex-wrap gap-x-4">
            <a href="/activity?view=agents" className={ACTION_LINK}>By agent</a>
            <a href="/activity" className={ACTION_LINK}>View all activity <ArrowRight aria-hidden={true} className="h-4 w-4 shrink-0" /></a>
          </span>
        ) : undefined
      }
    >
      {/* What needs a look, as one muted inset link row above the timeline: a sentence that
          wraps cleanly in a half-width panel, unlike a pill. */}
      {attention ? (
        <a
          href={attention.href}
          className="mb-4 flex min-h-11 items-center gap-2 rounded-[var(--wh-radius-inset)] bg-surface-muted px-3 py-2 text-sm font-medium text-fg underline decoration-line-strong underline-offset-4 hover:decoration-current"
        >
          <AlertTriangle aria-hidden={true} className="h-4 w-4 shrink-0 text-warning" />
          {attention.count} {attention.count === 1 ? "entry needs" : "entries need"} attention from the last 24 hours
        </a>
      ) : null}
      {activity.length > 0 ? (
        <ul className="wh-timeline">
          {activity.slice(0, HOME_ACTIVITY_ROWS).map((entry) => {
            const badge = entry.outcomeGroup ? OUTCOME_BADGES[entry.outcomeGroup] : undefined;
            const headline = entry.title ?? entry.summary;
            return (
              <li key={entry.id}>
                <p className="flex items-center gap-2 text-sm font-medium text-fg">
                  {entry.serviceId ? <ServiceMark id={entry.serviceId} name={entry.service ?? entry.serviceId} size="xs" /> : null}
                  {entry.href ? (
                    <a href={entry.href} className={`${ROW_LINK} hover:underline`}>
                      {headline}<span className="sr-only">, {entry.at}</span>
                    </a>
                  ) : headline}
                </p>
                {entry.title && entry.summary !== entry.title ? (
                  <p className="mt-1 text-sm leading-relaxed text-fg">{entry.summary}</p>
                ) : null}
                <div className="wh-timeline-meta">
                  {entry.outcome ? (
                    <Badge tone={badge?.tone ?? "neutral"} icon={badge?.Icon}>{entry.outcome}</Badge>
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
      ) : (
        <EmptyState
          variant="inline"
          icon={Activity}
          heading="No activity yet"
          description="Everything your agents do through Warthog is recorded here, newest first."
        />
      )}
    </WorkspacePanel>
  );
}

function AgentsPanel({ agents }: { agents: ReadonlyArray<DashboardAgent> }) {
  return (
    <WorkspacePanel
      title="Your agents"
      description="Each agent has its own connection and controls"
      icon={Bot}
      action={<a href="/agents" className={ACTION_LINK}>All agents</a>}
    >
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
              <p className="text-sm leading-relaxed text-fg-muted">
                <a href={agent.activityHref} className={`${ROW_LINK} underline hover:text-fg`}>
                  {agent.todayCount ?? 0} {(agent.todayCount ?? 0) === 1 ? "entry" : "entries"} in the last 24 hours<span className="sr-only"> for {agent.name}</span>
                </a>
                {agent.needsAttention ? (
                  <>
                    {" · "}
                    {/* The warning icon stays with its words when the line wraps. */}
                    <span className="whitespace-nowrap">
                      <AlertTriangle aria-hidden={true} className="inline h-4 w-4 align-[-3px] text-warning" />{" "}
                      {agent.attentionHref ? (
                        <a href={agent.attentionHref} className={`${ROW_LINK} underline hover:text-fg`}>
                          {agent.needsAttention} need{agent.needsAttention === 1 ? "s" : ""} attention<span className="sr-only"> for {agent.name}</span>
                        </a>
                      ) : (
                        <>{agent.needsAttention} need{agent.needsAttention === 1 ? "s" : ""} attention</>
                      )}
                    </span>
                  </>
                ) : null}
                {agent.lastActive ? <> · last active {agent.lastActive}</> : null}
              </p>
            ) : null}
            <p className="min-w-0 text-xs leading-relaxed text-fg-muted">
              <SpendLine agent={agent} />
            </p>
          </li>
        ))}
      </ul>
    </WorkspacePanel>
  );
}

// What a reminder's date says: "Overdue since 2 Nov 2026", or "Expires 14 Dec 2026" in its
// type's words.
function reminderDue(reminder: DashboardReminder): string {
  return reminder.overdue ? `Overdue since ${reminder.due}` : `${reminder.dueLabel ?? "Due"} ${reminder.due}`;
}

function RemindersPanel({
  reminders,
  toCheck,
}: {
  reminders: ReadonlyArray<DashboardReminder>;
  toCheck?: { count: number; href: string };
}) {
  const checkLine = toCheck ? (
    <a href={toCheck.href} className={`${ACTION_LINK} text-sm font-medium text-fg`}>
      <ClipboardCheck aria-hidden={true} className="h-4 w-4 shrink-0 text-fg-muted" />
      {toCheck.count === 1 ? "1 thing to check" : `${toCheck.count} things to check`}
      <span className="sr-only"> in Life admin</span>
    </a>
  ) : null;
  return (
    <WorkspacePanel
      title="Reminders"
      description="Coming up in your life admin"
      icon={Bell}
      action={reminders.length > 0 ? (
        <a href="/life-admin?view=life&tab=upcoming" className={ACTION_LINK}>
          {reminders.length > HOME_REMINDER_ROWS ? `View all ${reminders.length} in Upcoming` : "See what's coming up"}
        </a>
      ) : undefined}
    >
      {checkLine ? <div className="mb-3 border-b border-line pb-3">{checkLine}</div> : null}
      {reminders.length > 0 ? (
        <ul className="flex flex-col divide-y divide-line">
          {reminders.slice(0, HOME_REMINDER_ROWS).map((reminder) => {
            const Icon = reminder.overdue ? AlertTriangle : Circle;
            const body = (
              <>
                <Icon aria-hidden={true} className={`mt-0.5 h-4 w-4 shrink-0 ${reminder.overdue ? "text-warning" : "text-fg-muted"}`} />
                <span className="flex min-w-0 flex-col">
                  <span className="text-sm text-fg [overflow-wrap:anywhere]">{reminder.title}</span>
                  {reminder.due ? <span className="mt-1 text-xs text-fg-muted">{reminderDue(reminder)}</span> : null}
                </span>
              </>
            );
            return (
              <li key={reminder.id} className="py-3 first:pt-0 last:pb-0">
                {reminder.href ? (
                  <a href={reminder.href} className="flex min-h-11 min-w-0 items-start gap-3 rounded-field hover:bg-surface-muted">
                    {body}
                  </a>
                ) : (
                  <div className="flex min-w-0 items-start gap-3">{body}</div>
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        <EmptyState
          variant="inline"
          icon={Bell}
          heading="No reminders coming up"
          description="Renewals, expiry dates and bills with a due date in Life admin show here."
          action={<ButtonLink href="/life-admin" size="sm">Open Life admin</ButtonLink>}
        />
      )}
    </WorkspacePanel>
  );
}

// The review notice after an account recovery. Recovery removed the lost sign-in methods
// but kept every agent and its key, so this names each one as still connected (never as
// removed) and links to its settings, where its key is replaced or revoked, and to Agents,
// where any agent is disconnected. A contained, page-level notice; "Dismiss" hides it on
// this browser, and it goes by itself two weeks after the recovery.
function RecoveryReviewNotice({
  review,
  dismiss,
}: {
  review: DashboardRecoveryReview;
  dismiss?: (formData: FormData) => void | Promise<void>;
}) {
  return (
    <Notice tone="warning" announce={false} className="wh-page-notice">
      <div className="flex min-w-0 flex-col gap-3">
        <p className="font-medium text-fg">Your account was recovered on {review.recoveredAt}.</p>
        <p className="text-fg-muted">
          Your old passkeys and authenticator app were removed and every other device was signed out. These agents
          are still connected and can still use your account. Check you recognise each one. You can replace an
          agent&apos;s key in its settings, or disconnect it from Agents.
        </p>
        <ul role="list" aria-label="Agents to review" className="-my-1 flex min-w-0 flex-col">
          {review.agents.map((agent) => (
            <li key={agent.id} className="min-w-0">
              <a
                href={agent.href}
                className="inline-flex min-h-11 min-w-0 items-center gap-2 font-medium text-fg underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus [overflow-wrap:anywhere]"
              >
                {agent.name} settings
                <ArrowRight aria-hidden={true} className="h-4 w-4 shrink-0" />
              </a>
            </li>
          ))}
        </ul>
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t border-line pt-2">
          <a
            href="/agents"
            className="inline-flex min-h-11 min-w-0 items-center gap-2 font-medium text-fg underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
          >
            Disconnect an agent from Agents
            <ArrowRight aria-hidden={true} className="h-4 w-4 shrink-0" />
          </a>
          {dismiss ? (
            <ActionForm action={dismiss}>
              <input type="hidden" name="review" value={review.id} />
              <FormSubmit variant="secondary" size="sm" pendingLabel="Dismissing…">
                Dismiss
              </FormSubmit>
            </ActionForm>
          ) : null}
        </div>
      </div>
    </Notice>
  );
}

export function DashboardView({
  personName,
  checklist,
  pendingApprovals,
  activity,
  agents,
  reminders,
  toCheck,
  registerPushDevice,
  vapidPublicKey,
  attention,
  recoveryReview,
  dismissRecoveryReview,
}: DashboardViewProps) {
  const completed = checklist.filter((item) => item.done).length;
  const setupOpen = checklist.length > 0 && completed < checklist.length;
  const hasAgents = agents.length > 0;
  const inbox = <InboxPanel key="inbox" pendingApprovals={pendingApprovals} />;
  const recent = <ActivityPanel key="activity" activity={activity} attention={attention} />;
  const upcoming = <RemindersPanel key="reminders" reminders={reminders} toCheck={toCheck} />;
  // Before the first agent, only the panels with something in them appear (in one grid);
  // after it, the full two-column dashboard.
  const newcomerPanels = [
    pendingApprovals > 0 ? inbox : null,
    activity.length > 0 || attention ? recent : null,
    reminders.length > 0 || toCheck ? upcoming : null,
  ].filter((panel) => panel !== null);
  return (
    <div className="wh-page">
      <WorkspaceHeading title={<>Hi, {personName}</>} description={hasAgents ? HOME_LINE : PRODUCT_LINE} />
      {recoveryReview ? <RecoveryReviewNotice review={recoveryReview} dismiss={dismissRecoveryReview} /> : null}
      {setupOpen ? (
        <SetupPanel
          checklist={checklist}
          completed={completed}
          hasAgents={hasAgents}
          registerPushDevice={registerPushDevice}
          vapidPublicKey={vapidPublicKey}
        />
      ) : null}
      {hasAgents ? (
        <div className="wh-dashboard-grid">
          <div className="wh-dashboard-column">
            {inbox}
            {recent}
          </div>
          <div className="wh-dashboard-column">
            <AgentsPanel agents={agents} />
            {upcoming}
          </div>
        </div>
      ) : newcomerPanels.length > 0 ? (
        <div className="wh-dashboard-grid">{newcomerPanels}</div>
      ) : null}
    </div>
  );
}
