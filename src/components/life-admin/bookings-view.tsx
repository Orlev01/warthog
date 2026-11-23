"use client";

import * as React from "react";
import { CalendarCheck, CalendarDays, History, Link2, UserCheck } from "lucide-react";

import { WorkspacePanel } from "@/components/shell/workspace-surfaces";
import { ListGroup, LIST_ROW } from "@/components/ui/list-group";
import { ListToolbar } from "@/components/ui/list-toolbar";
import { ActiveFilters, type AppliedFilter } from "@/components/ui/filter-links";
import { SelectField } from "@/components/ui/field";
import { Button } from "@/components/ui/button";
import { ButtonLink } from "@/components/ui/button-link";
import { EmptyState } from "@/components/ui/empty";
import type { Catalogue } from "@/domain/life-admin/catalogue";
import { hrefWith } from "@/lib/href";
import { bookingsView, phaseOfView, type BookingRow } from "./record-groups";
import { recordName, whenLine } from "./record-format";
import { PhaseBadge } from "./phase-badge";
import { NotCheckedTag } from "./record-row";
import { itemHref } from "./upcoming-view";
import type { BookingFilters, LifeAdminRecordView } from "./record-view-types";

// Bookings (docs/adr/life-admin-profile.md): every booking from every category — flights,
// stays, restaurants, appointments, a category of the person's own — in two parts: live
// (waiting to be confirmed, upcoming, happening now; soonest first) and past (completed,
// cancelled, missed, lapsed; newest first, by month, a page at a time). Plain GET filters
// narrow both by category, who it's for and state, so Back/Forward and links keep them. Each row
// says where it stands in words and an icon, its category, the anchor it belongs to (a trip, a
// vehicle) and who is handling it, and links to the item's page with its whole journal.

const BASE = "/life-admin";

function filterState(filters: BookingFilters): Record<string, string | undefined> {
  return {
    view: "life",
    tab: "bookings",
    category: filters.category,
    for_whom: filters.forWhom,
    state: filters.state,
    ...(filters.page && filters.page > 1 ? { page: String(filters.page) } : {}),
  };
}

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
  const state = filterState({ ...filters, page: view.page });
  const ids = React.useId();
  const applied: AppliedFilter[] = [];
  const categoryLabel = filters.category ? catalogue.category(filters.category)?.label ?? filters.category : null;
  if (categoryLabel) applied.push({ label: `Category: ${categoryLabel}`, removeHref: hrefWith(BASE, state, { category: undefined }, ["page"]) });
  if (filters.forWhom) applied.push({ label: `For: ${filters.forWhom}`, removeHref: hrefWith(BASE, state, { for_whom: undefined }, ["page"]) });
  if (filters.state) {
    const label = view.options.states.find((option) => option.phase === filters.state)?.label ?? filters.state;
    applied.push({ label: `State: ${label}`, removeHref: hrefWith(BASE, state, { state: undefined }, ["page"]) });
  }
  const clearHref = hrefWith(BASE, { view: "life", tab: "bookings" });
  const filtered = applied.length > 0;

  if (view.total === 0) {
    return (
      <WorkspacePanel title="Bookings" description="Flights, stays, restaurants, appointments and anything else booked for a time." icon={CalendarDays}>
        <EmptyState
          variant="inline"
          icon={CalendarDays}
          heading="No bookings yet."
          description="Ask your agent to look for booking confirmations in your email, or add one yourself under Your things."
          action={<ButtonLink href="/life-admin?view=life&tab=things#new-record" size="sm">Add a booking</ButtonLink>}
        />
      </WorkspacePanel>
    );
  }

  return (
    <>
      <ListToolbar
        label="Filter bookings"
        search={
          <form method="get" action={BASE} className="flex min-w-0 flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end">
            <input type="hidden" name="view" value="life" />
            <input type="hidden" name="tab" value="bookings" />
            <SelectField label="Category" id={`${ids}-category`} name="category" defaultValue={filters.category ?? ""} width="text">
              <option value="">Any category</option>
              {view.options.categories.map((category) => (
                <option key={category.id} value={category.id}>{category.label}</option>
              ))}
            </SelectField>
            {view.options.forWhom.length ? (
              <SelectField label="For" id={`${ids}-for`} name="for_whom" defaultValue={filters.forWhom ?? ""} width="text">
                <option value="">Anyone</option>
                {view.options.forWhom.map((who) => (
                  <option key={who} value={who}>{who}</option>
                ))}
              </SelectField>
            ) : null}
            <SelectField label="State" id={`${ids}-state`} name="state" defaultValue={filters.state ?? ""} width="text">
              <option value="">Any state</option>
              {view.options.states.map((option) => (
                <option key={option.phase} value={option.phase}>{option.label}</option>
              ))}
            </SelectField>
            <Button type="submit" variant="secondary">Apply filters</Button>
          </form>
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
                <ButtonLink href={hrefWith(BASE, state, { page: view.page - 1 > 1 ? String(view.page - 1) : undefined })} size="sm">Newer</ButtonLink>
              ) : null}
              <span className="text-sm text-fg-muted">Page {view.page} of {view.pages}</span>
              {view.page < view.pages ? (
                <ButtonLink href={hrefWith(BASE, state, { page: String(view.page + 1) })} size="sm">Older</ButtonLink>
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
