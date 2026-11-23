"use client";

import * as React from "react";
import { AlertTriangle, CalendarCheck, CalendarClock, ListTodo } from "lucide-react";

import { WorkspacePanel } from "@/components/shell/workspace-surfaces";
import { ListGroup, LIST_ROW } from "@/components/ui/list-group";
import { EmptyState } from "@/components/ui/empty";
import type { Catalogue } from "@/domain/life-admin/catalogue";
import { shortDate } from "@/domain/life-admin/journal";
import { phaseOfView, upcomingSections } from "./record-groups";
import { daysText, formatCalendarDate, recordName, whenLine, whenText } from "./record-format";
import { PhaseBadge, phaseIcon } from "./phase-badge";
import { NotCheckedTag, handlingText } from "./record-row";
import type { LifeAdminRecordView, NextStepView } from "./record-view-types";

// Upcoming (docs/adr/life-admin-profile.md): what needs the person soon, across every
// category, built-in or their own — happening now, overdue (recently), this week, later (to
// 60 days) — and the next steps anyone recorded with a due date. Where each record stands comes
// from the one lifecycle module, via the loader; every line links to the item's own page.

export const itemHref = (id: string) => `/life-admin/items/${encodeURIComponent(id)}`;

function UpcomingRow({ record, catalogue, today, zone }: { record: LifeAdminRecordView; catalogue: Catalogue; today: string; zone: string }) {
  const type = catalogue.typeOfRecord(record.kind, record.type ?? null);
  const { name } = recordName(type, record.fields, Boolean(record.type));
  const phase = phaseOfView(record);
  const Icon = phaseIcon(phase.phase);
  const when = whenLine(type, record, zone, today.slice(0, 4));
  const relative = phase.inDays !== undefined && phase.phase !== "in_progress" ? daysText(phase.inDays) : null;
  const handling = handlingText(record.handling, zone);
  return (
    <li className={`${LIST_ROW} flex-row items-start gap-3`}>
      <Icon aria-hidden={true} className={`mt-3 h-4 w-4 shrink-0 ${phase.phase === "overdue" ? "text-warning" : "text-fg-muted"}`} />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <a href={itemHref(record.id)} className="inline-flex min-h-11 min-w-0 items-center text-sm font-medium text-fg underline-offset-4 hover:underline [overflow-wrap:anywhere]">
            {name}
          </a>
          <PhaseBadge phase={phase.phase} label={phase.label} />
          {record.reviewState === "suggested" ? <NotCheckedTag /> : null}
        </div>
        <p className="text-sm text-fg-muted [overflow-wrap:anywhere]">
          {[type.label, when, relative].filter(Boolean).join(" · ")}
        </p>
        {handling ? <p className="text-sm text-fg-muted [overflow-wrap:anywhere]">{handling}</p> : null}
      </div>
    </li>
  );
}

export function UpcomingView({
  records,
  catalogue,
  nextSteps,
  today,
  zone = "UTC",
}: {
  records: readonly LifeAdminRecordView[];
  catalogue: Catalogue;
  nextSteps: readonly NextStepView[];
  today: string;
  zone?: string;
}) {
  const sections = upcomingSections(records);
  const groups = [
    { key: "now", title: "Happening now", rows: sections.now },
    { key: "overdue", title: "Overdue", rows: sections.overdue },
    { key: "week", title: "This week", rows: sections.week },
    { key: "later", title: "Later (next 60 days)", rows: sections.later },
  ].filter((group) => group.rows.length > 0);
  return (
    <>
      <WorkspacePanel title="Coming up" description="What's happening now, overdue, and due or booked in the next 60 days, across all your things." icon={CalendarClock}>
        {groups.length === 0 ? (
          <EmptyState variant="inline" icon={CalendarCheck} heading="Nothing due in the next 60 days." description="Renewals, expiry dates and bookings show here as they come up." />
        ) : (
          groups.map((group) => (
            <ListGroup key={group.key} id={`upcoming-${group.key}`} level={3} title={group.title} count={group.rows.length}>
              {group.rows.map((record) => (
                <UpcomingRow key={record.id} record={record} catalogue={catalogue} today={today} zone={zone} />
              ))}
            </ListGroup>
          ))
        )}
      </WorkspacePanel>
      <WorkspacePanel title="Next steps due" description="Next steps you or your agents recorded on an item, with a date, soonest first." icon={ListTodo}>
        {nextSteps.length === 0 ? (
          <EmptyState variant="inline" icon={ListTodo} heading="No next steps with a date." description="When you or an agent adds a next step with a due date to an item, it shows here." />
        ) : (
          <ul role="list" className="flex min-w-0 flex-col">
            {nextSteps.map((step) => {
              const overdue = step.due < today;
              return (
                <li key={step.id} className={`${LIST_ROW} flex-row items-start gap-3`}>
                  {overdue ? (
                    <AlertTriangle aria-hidden={true} className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
                  ) : (
                    <ListTodo aria-hidden={true} className="mt-0.5 h-4 w-4 shrink-0 text-fg-muted" />
                  )}
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <p className="text-sm text-fg [overflow-wrap:anywhere]">{step.text}</p>
                    <p className="text-sm text-fg-muted [overflow-wrap:anywhere]">
                      {overdue ? `Overdue since ${formatCalendarDate(step.due)}` : `Due ${shortDate(step.due, zone)}, ${whenText(today, step.due)}`}
                      {" · "}
                      <a href={itemHref(step.recordId)} className="font-medium text-fg underline underline-offset-4">
                        {step.recordName}
                      </a>
                    </p>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </WorkspacePanel>
    </>
  );
}
