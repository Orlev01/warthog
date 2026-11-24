"use client";

import * as React from "react";
import { AlertTriangle, CalendarCheck, CalendarClock, ListTodo } from "lucide-react";

import { WorkspacePanel } from "@/components/shell/workspace-surfaces";
import { ListGroup, LIST_ROW } from "@/components/ui/list-group";
import { EmptyState } from "@/components/ui/empty";
import { ButtonLink } from "@/components/ui/button-link";
import type { Catalogue } from "@/domain/life-admin/catalogue";
import { shortDate } from "@/domain/life-admin/journal";
import { phaseOfView, sectionOf, upcomingSections } from "./record-groups";
import { daysText, formatCalendarDate, recordName, whenText } from "./record-format";
import { RecordReturnProvider } from "./record-forms";
import { RecordRow, itemHref } from "./record-row";
import type { AssetOption, LifeAdminRecordView, NextStepView, RecordActions } from "./record-view-types";

// Upcoming (docs/adr/life-admin-profile.md; founder, 23 Nov 2026): what needs the person or is
// booked, across every category, built-in or their own — happening now, overdue (recently), this
// week, later (to 60 days) — then every other booking ahead (the old Bookings tab, folded in):
// further ahead, and those with no date yet; and the next steps anyone recorded with a due date.
// A renewal or expiry is here while it's coming up and stays on Records too; a booking lives
// here until it's over, then moves to History. Where each record stands comes from the one
// lifecycle module, via the loader. Each is the same row as on Records — how soon, what it
// belongs to, who is handling it, and its details, reminders, Edit and Delete one click away — so
// a booking is managed here; an action on it comes back here. A record that lives on Records
// keeps its `#record-<id>` anchor there.

export { itemHref };

export function UpcomingView({
  records,
  catalogue,
  nextSteps,
  today,
  zone = "UTC",
  actions = {},
}: {
  records: readonly LifeAdminRecordView[];
  catalogue: Catalogue;
  nextSteps: readonly NextStepView[];
  today: string;
  zone?: string;
  actions?: RecordActions;
}) {
  const sections = upcomingSections(records);
  const groups = [
    { key: "now", title: "Happening now", rows: sections.now },
    { key: "overdue", title: "Overdue", rows: sections.overdue },
    { key: "week", title: "This week", rows: sections.week },
    { key: "later", title: "Later (next 60 days)", rows: sections.later },
    { key: "ahead", title: "Further ahead", rows: sections.ahead },
    { key: "undated", title: "Date to be confirmed", rows: sections.undated },
  ].filter((group) => group.rows.length > 0);
  const byId = new Map(records.map((record) => [record.id, record] as const));
  const nameOf = (record: LifeAdminRecordView) => recordName(catalogue.typeOfRecord(record.kind, record.type ?? null), record.fields, Boolean(record.type)).name;
  const partOf = (record: LifeAdminRecordView) => {
    const parent = record.parentId && record.parentId !== record.id ? byId.get(record.parentId) : undefined;
    return parent ? nameOf(parent) : null;
  };
  const assets: AssetOption[] = records
    .map((record) => ({ record, type: catalogue.typeOfRecord(record.kind, record.type ?? null) }))
    .filter(({ type }) => type.anchor)
    .map(({ record, type }) => ({ id: record.id, name: nameOf(record), typeId: type.id, typeLabel: type.label }));
  const currentYear = today.slice(0, 4);
  // How soon, in words ("in 12 days", "3 days ago"); nothing while it's happening.
  const soon = (record: LifeAdminRecordView) => {
    const phase = phaseOfView(record);
    return phase.inDays !== undefined && phase.phase !== "in_progress" ? daysText(phase.inDays) : null;
  };
  return (
    <RecordReturnProvider value={{ tab: "upcoming", filter: { categories: [], statuses: [] } }}>
      <WorkspacePanel title="Coming up" description="Renewals, expiry dates and anything else due in the next 60 days, and every booking ahead: flights, stays, restaurants and appointments." icon={CalendarClock}>
        {groups.length === 0 ? (
          <EmptyState
            variant="inline"
            icon={CalendarCheck}
            heading="Nothing coming up."
            description="Bookings, and renewals and expiry dates in the next 60 days, show here. Past ones move to History."
            action={<ButtonLink href="/life-admin?tab=add#new-record" size="sm">Add a booking</ButtonLink>}
          />
        ) : (
          groups.map((group) => (
            <ListGroup key={group.key} id={`upcoming-${group.key}`} level={3} title={group.title} count={group.rows.length}>
              {group.rows.map((record) => (
                <RecordRow
                  key={record.id}
                  record={record}
                  type={catalogue.typeOfRecord(record.kind, record.type ?? null)}
                  catalogue={catalogue}
                  partOf={partOf(record)}
                  note={soon(record)}
                  anchor={sectionOf(record, catalogue) === "upcoming"}
                  assets={assets}
                  zone={zone}
                  currentYear={currentYear}
                  actions={actions}
                />
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
    </RecordReturnProvider>
  );
}
