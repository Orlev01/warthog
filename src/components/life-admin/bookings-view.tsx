"use client";

import * as React from "react";
import { CalendarCheck, CalendarDays, History, Link2, UserCheck } from "lucide-react";

import { WorkspacePanel } from "@/components/shell/workspace-surfaces";
import { ListGroup, LIST_ROW } from "@/components/ui/list-group";
import { ListToolbar } from "@/components/ui/list-toolbar";
import { ActiveFilters, type AppliedFilter } from "@/components/ui/filter-links";
import { FilterForm, MultiSelectFilter } from "@/components/ui/multi-select-filter";
import { ButtonLink } from "@/components/ui/button-link";
import { EmptyState } from "@/components/ui/empty";
import type { Catalogue } from "@/domain/life-admin/catalogue";
import { hrefWithLists } from "@/lib/href";
import { bookingsView, phaseOfView, type BookingRow } from "./record-groups";
import { recordName, whenLine } from "./record-format";
import { PhaseBadge } from "./phase-badge";
import { NotCheckedTag } from "./record-row";
import { itemHref } from "./upcoming-view";
import type { BookingFilters, LifeAdminRecordView } from "./record-view-types";

// Bookings (docs/adr/life-admin-profile.md): every booking from every category — flights,
// stays, restaurants, appointments, a category of the person's own — in two parts: live
// (waiting to be confirmed, upcoming, happening now; soonest first) and past (completed,
// cancelled, missed, lapsed; newest first, by month, a page at a time). The same multiple-choice
// filters as the Records tab, in a plain GET form, narrow both by category (the one the Records
// tab uses), who it's for and state, so Back/Forward and links keep them. Each row says where it
// stands in words and an icon, its category, the anchor it belongs to (a trip, a vehicle) and who
// is handling it, and links to the item's page with its whole journal.

const BASE = "/life-admin";

// The Bookings tab with these filters, each chosen value repeated; a filter change starts again
// from the first page.
function bookingsHref(filters: BookingFilters, patch: Partial<BookingFilters> = {}): string {
  const next = { ...filters, ...patch };
  return hrefWithLists(BASE, {
    view: "life",
    tab: "bookings",
    category: next.categories,
    for_whom: next.forWhom,
    state: next.states,
    page: next.page && next.page > 1 ? String(next.page) : undefined,
  });
}

const without = (list: readonly string[] | undefined, value: string) => (list ?? []).filter((other) => other !== value);

function BookingItem({ row, catalogue, zone, currentYear }: { row: BookingRow<LifeAdminRecordView>; catalogue: Catalogue; zone: string; currentYear: string }) {
  const { record, type, category, anchor } = row;
  const { name } = recordName(type, record.fields, Boolean(record.type));
  const phase = phaseOfView(record);
  const when = whenLine(type, record, zone, currentYear);
  const anchorName = anchor ? recordName(catalogue.typeOfRecord(anchor.kind, anchor.type ?? null), anchor.fields, Boolean(anchor.type)).name : null;
  const forWhom = record.fields.for_whom?.trim();
  return (
    <li className={LIST_ROW}>
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <PhaseBadge phase={phase.phase} label={phase.label} />
          <a href={itemHref(record.id)} className="inline-flex min-h-11 min-w-0 items-center text-sm font-medium text-fg underline-offset-4 hover:underline [overflow-wrap:anywhere]">
            {name}
          </a>
          {record.reviewState === "suggested" ? <NotCheckedTag /> : null}
        </div>
        <p className="text-sm text-fg-muted [overflow-wrap:anywhere]">
          {[type.label, category?.label, when, forWhom ? `For ${forWhom}` : null].filter(Boolean).join(" · ")}
        </p>
        {anchorName ? (
          <p className="inline-flex min-w-0 items-center gap-1.5 text-sm text-fg-muted [overflow-wrap:anywhere]">
            <Link2 aria-hidden={true} className="h-4 w-4 shrink-0" />
            Part of {anchorName}
          </p>
        ) : null}
        {record.handling?.steward ? (
          <p className="inline-flex min-w-0 items-center gap-1.5 text-sm text-fg-muted [overflow-wrap:anywhere]">
            <UserCheck aria-hidden={true} className="h-4 w-4 shrink-0" />
            Handled by {record.handling.steward}
          </p>
        ) : null}
      </div>
    </li>
  );
}

export function BookingsView({
  records,
  catalogue,
  filters = {},
  today,
  zone = "UTC",
}: {
  records: readonly LifeAdminRecordView[];
  catalogue: Catalogue;
  filters?: BookingFilters;
  today: string;
  zone?: string;
}) {
  const view = bookingsView(records, catalogue, filters, zone);
  const currentYear = today.slice(0, 4);
  const current: BookingFilters = { ...filters, page: view.page };
  const removing: BookingFilters = { ...filters, page: undefined };
  const applied: AppliedFilter[] = [];
  for (const id of filters.categories ?? []) {
    applied.push({ label: `Category: ${catalogue.category(id)?.label ?? id}`, removeHref: bookingsHref(removing, { categories: without(filters.categories, id) }) });
  }
  for (const who of filters.forWhom ?? []) {
    applied.push({ label: `For: ${who}`, removeHref: bookingsHref(removing, { forWhom: without(filters.forWhom, who) }) });
  }
  for (const state of filters.states ?? []) {
    const label = view.options.states.find((option) => option.phase === state)?.label ?? state;
    applied.push({ label: `State: ${label}`, removeHref: bookingsHref(removing, { states: without(filters.states, state) }) });
  }
  const clearHref = bookingsHref({});
  const filtered = applied.length > 0;

  if (view.total === 0) {
    return (
      <WorkspacePanel title="Bookings" description="Flights, stays, restaurants, appointments and anything else booked for a time." icon={CalendarDays}>
        <EmptyState
          variant="inline"
          icon={CalendarDays}
          heading="No bookings yet."
          description="Ask your agent to look for booking confirmations in your email, or add one yourself under Records."
          action={<ButtonLink href="/life-admin?view=life&tab=records#new-record" size="sm">Add a booking</ButtonLink>}
        />
      </WorkspacePanel>
    );
  }

  return (
    <>
      <ListToolbar
        label="Filter bookings"
        search={
          <FilterForm action={BASE} label="Filter bookings" hidden={{ view: "life", tab: "bookings" }}>
            <MultiSelectFilter
              label="Category"
              name="category"
              options={view.options.categories.map((category) => ({ value: category.id, label: category.label, count: view.counts.categories[category.id] ?? 0 }))}
              selected={filters.categories ?? []}
              hint="None ticked shows every category."
            />
            {view.options.forWhom.length ? (
              <MultiSelectFilter
                label="For"
                name="for_whom"
                noneLabel="Anyone"
                options={view.options.forWhom.map((who) => ({ value: who, label: who, count: view.counts.forWhom[who] ?? 0 }))}
                selected={view.options.forWhom.filter((who) => (filters.forWhom ?? []).some((chosen) => chosen.toLowerCase() === who.toLowerCase()))}
                hint="None ticked shows everyone's."
              />
            ) : null}
            <MultiSelectFilter
              label="State"
              name="state"
              noneLabel="Any"
              options={view.options.states.map((option) => ({ value: option.phase, label: option.label, count: view.counts.states[option.phase] ?? 0 }))}
              selected={filters.states ?? []}
              hint="None ticked shows every state."
            />
          </FilterForm>
        }
        applied={<ActiveFilters filters={applied} clearHref={clearHref} />}
        status={`${view.live.length} live · ${view.pastTotal} past${filtered ? " (filtered)" : ""}`}
      />
      <WorkspacePanel title="Live bookings" description="Waiting to be confirmed, upcoming and happening now, soonest first." icon={CalendarDays}>
        {view.live.length === 0 ? (
          <EmptyState variant="inline" icon={CalendarCheck} heading={filtered ? "No live bookings match these filters." : "No live bookings."} />
        ) : (
          <ul role="list" className="flex min-w-0 flex-col">
            {view.live.map((row) => (
              <BookingItem key={row.record.id} row={row} catalogue={catalogue} zone={zone} currentYear={currentYear} />
            ))}
          </ul>
        )}
      </WorkspacePanel>
      <WorkspacePanel
        title="Past bookings"
        description="Completed, cancelled, missed and lapsed, newest first. Each keeps its whole history."
        icon={History}
        footer={
          view.pages > 1 ? (
            <nav aria-label="Past bookings pages" className="flex min-w-0 flex-wrap items-center gap-3">
              {view.page > 1 ? (
                <ButtonLink href={bookingsHref(current, { page: view.page - 1 })} size="sm">Newer</ButtonLink>
              ) : null}
              <span className="text-sm text-fg-muted">Page {view.page} of {view.pages}</span>
              {view.page < view.pages ? (
                <ButtonLink href={bookingsHref(current, { page: view.page + 1 })} size="sm">Older</ButtonLink>
              ) : null}
            </nav>
          ) : undefined
        }
      >
        {view.past.length === 0 ? (
          <EmptyState variant="inline" icon={History} heading={filtered ? "No past bookings match these filters." : "No past bookings yet."} />
        ) : (
          view.past.map((month) => (
            <ListGroup key={month.key} id={`bookings-${month.key}`} level={3} title={month.label} count={month.rows.length}>
              {month.rows.map((row) => (
                <BookingItem key={row.record.id} row={row} catalogue={catalogue} zone={zone} currentYear={currentYear} />
              ))}
            </ListGroup>
          ))
        )}
      </WorkspacePanel>
    </>
  );
}
