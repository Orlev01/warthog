import * as React from "react";
import { Activity, AlertTriangle, Ban, CheckCircle, Clock, type LucideIcon } from "lucide-react";

import { WorkspacePanel } from "@/components/shell/workspace-surfaces";
import { Badge, CountBadge, type BadgeTone } from "@/components/ui/badge";
import { buttonClasses } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty";
import { LIST_ROW, ListGroup } from "@/components/ui/list-group";
import { ACTIVITY_CATEGORIES, CATEGORY_LABELS, outcomeLabel, type OutcomeGroup } from "@/domain/activity/category";
import { withoutMatchedIntents } from "@/domain/activity/evidence";
import type { AgentWorkspaceData } from "@/server/agents/workspace-data";

// An agent's Activity section (the agent workspace's "Activity" tab, 12 November; contained in
// the UI/UX pass): one agent's record, organised the way the Activity page is. A panel holds
// the exact counts by type over its whole record (each a link into the filtered Activity
// page) and what needs attention; the recent entries follow as one list-group panel per day,
// each entry linking to its permalink on the Activity page, where its full detail, Dispute
// and Undo live. Agent-reported entries are labelled as the agent's claim. Each finished
// change appears once (its intent record is left out when the result is listed), outcomes
// read in the page's words ("Done", "Waiting for you"), and only the member's own changes
// say "Changed by you". The section is read-only: it reads nothing and decides nothing.

const OUTCOME_BADGES: Record<OutcomeGroup, { icon?: LucideIcon; tone: BadgeTone }> = {
  done: { icon: CheckCircle, tone: "success" },
  waiting: { icon: Clock, tone: "warning" },
  blocked: { icon: Ban, tone: "danger" },
  failed: { icon: AlertTriangle, tone: "danger" },
  other: { tone: "neutral" },
};

type Row = AgentWorkspaceData["activity"][number];

function attentionText(summary: NonNullable<AgentWorkspaceData["auditSummary"]>): string {
  return [
    summary.byOutcome.blocked ? `${summary.byOutcome.blocked} blocked` : "",
    summary.byOutcome.failed ? `${summary.byOutcome.failed} failed` : "",
    summary.disputed ? `${summary.disputed} disputed` : "",
  ].filter(Boolean).join(" · ");
}

function EntryRow({ entry, agentId, name }: { entry: Row; agentId: string; name: string }) {
  const outcome = outcomeLabel(entry.outcome);
  const badge = OUTCOME_BADGES[entry.outcomeGroup ?? "other"];
  return (
    <li className={LIST_ROW}>
      <div className="flex min-w-0 items-start justify-between gap-x-3">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <a
            href={`/activity?agent=${agentId}&entry=${entry.seq}#entry-${entry.seq}`}
            className="inline-flex min-h-11 items-center font-medium text-fg underline underline-offset-4 lg:min-h-0"
          >
            {entry.title}
            <span className="sr-only">, {entry.at}</span>
          </a>
          {outcome ? (
            <Badge tone={badge.tone} icon={badge.icon}>
              {outcome}
            </Badge>
          ) : null}
        </div>
        <time dateTime={entry.dateTime} title={entry.at} className="shrink-0 pt-0.5 text-sm tabular-nums text-fg-muted lg:pt-0">
          {entry.time}
        </time>
      </div>
      <p className="text-sm text-fg-muted">
        {entry.categoryLabel}
        {entry.changedBy === "you" ? " · Changed by you" : ""}
      </p>
      {/* The summary only when it says more than the title (content-55). */}
      {entry.summary && entry.summary !== entry.title ? <p className="max-w-[72ch] text-sm text-fg">{entry.summary}</p> : null}
      {entry.reported ? <p className="text-sm text-fg-muted">Reported by {name}. Warthog did not observe this.</p> : null}
    </li>
  );
}

export function AgentAuditLog({ data }: { data: AgentWorkspaceData }) {
  const name = data.agent.displayName;
  const id = encodeURIComponent(data.agent.id);
  const log = `/activity?agent=${id}&via=agents`;
  const summary = data.auditSummary;
  const attention = summary ? attentionText(summary) : "";
  const rows = withoutMatchedIntents(data.activity);
  const days: { key: string; label: string; entries: Row[] }[] = [];
  for (const entry of rows) {
    const last = days.at(-1);
    if (last && last.key === entry.dayKey) last.entries.push(entry);
    else days.push({ key: entry.dayKey, label: entry.dayLabel, entries: [entry] });
  }
  return (
    <>
      <WorkspacePanel
        title={`${name}’s activity`}
        description={`What ${name} did through Warthog, and your changes to its access. Warthog can't see what an agent does outside its own connection.`}
        footer={
          <>
            <a href={log} className="inline-flex min-h-11 items-center font-medium text-fg underline underline-offset-4">
              Open all of {name}’s activity
            </a>
            <a href="/activity?view=agents" className="inline-flex min-h-11 items-center underline underline-offset-4">
              Compare all agents
            </a>
          </>
        }
      >
        {summary ? (
          <div className="flex flex-col gap-3">
            <p className="text-sm">
              <span className="font-semibold tabular-nums">{summary.total}</span> {summary.total === 1 ? "entry" : "entries"} in total
            </p>
            <ul role="list" aria-label="Entries by type" className="flex flex-wrap gap-2">
              {ACTIVITY_CATEGORIES.filter((type) => summary.byCategory[type] > 0).map((type) => (
                <li key={type}>
                  <a href={`${log}&type=${type}`} className={buttonClasses({ variant: "secondary", size: "sm" })}>
                    {CATEGORY_LABELS[type]}
                    <CountBadge count={summary.byCategory[type]} />
                  </a>
                </li>
              ))}
            </ul>
            {attention ? (
              <a href={`${log}&attention=1`} className="inline-flex min-h-11 items-center gap-2 self-start text-sm font-medium text-fg underline underline-offset-4">
                <AlertTriangle aria-hidden={true} className="h-4 w-4 shrink-0 text-warning" />
                Needs attention: {attention}
              </a>
            ) : null}
          </div>
        ) : (
          <EmptyState
            variant="inline"
            icon={Activity}
            heading="No activity recorded for this agent yet."
            description={`When ${name} uses Warthog, what it does appears here.`}
          />
        )}
      </WorkspacePanel>
      {days.map((day) => (
        <ListGroup key={day.key} id={`agent-day-${day.key}`} ordered title={<time dateTime={day.key}>{day.label}</time>} count={day.entries.length}>
          {day.entries.map((entry) => (
            <EntryRow key={entry.seq} entry={entry} agentId={id} name={name} />
          ))}
        </ListGroup>
      ))}
    </>
  );
}
