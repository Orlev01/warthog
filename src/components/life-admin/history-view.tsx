"use client";

import * as React from "react";
import { History } from "lucide-react";

import { WorkspacePanel } from "@/components/shell/workspace-surfaces";
import { ListGroup } from "@/components/ui/list-group";
import { ListToolbar } from "@/components/ui/list-toolbar";
import { ActiveFilters, type AppliedFilter } from "@/components/ui/filter-links";
import { FilterForm, MultiSelectFilter } from "@/components/ui/multi-select-filter";
import { ButtonLink } from "@/components/ui/button-link";
import { EmptyState } from "@/components/ui/empty";
import type { Catalogue } from "@/domain/life-admin/catalogue";
import { HISTORY_STATUSES, LIST_STATUS_LABELS, historyHref, historyView } from "./record-groups";
import { recordName } from "./record-format";
import { RecordReturnProvider } from "./record-forms";
import { RecordRow } from "./record-row";
import type { AssetOption, HistoryFilter, LifeAdminRecordView, RecordActions } from "./record-view-types";

// History (founder, 23 Nov 2026): everything finished, kept strictly apart from Records and
// Upcoming — past bookings (completed, cancelled, missed, lapsed), things the person ended or
// cancelled, matters resolved — as a log to look back on, for them and their agents. Newest first,
// by the month it happened in (the undated last), 30 to a page. Category and Status filters, each
// multiple-choice, in a plain GET form (`?history_category=…&history_status=…`), so Back/Forward
// and links keep them; the applied ones are removable chips. Each row is the same compact row as
// on Records, with its category, what it belonged to, and its details, edit and delete one click
// away; an action on it comes back here.

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

export function HistoryView({
  records,
  catalogue,
  filter = { categories: [], statuses: [] },
  today,
  zone = "UTC",
  actions,
}: {
  records: readonly LifeAdminRecordView[];
  catalogue: Catalogue;
  filter?: HistoryFilter;
  today: string;
  zone?: string;
  actions: RecordActions;
}) {
  const view = historyView(records, catalogue, filter, zone);
  const currentYear = today.slice(0, 4);
  const assets: AssetOption[] = records
    .map((record) => ({ record, type: catalogue.typeOfRecord(record.kind, record.type ?? null) }))
    .filter(({ type }) => type.anchor)
    .map(({ record, type }) => ({ id: record.id, name: recordName(type, record.fields, Boolean(record.type)).name, typeId: type.id, typeLabel: type.label }));
  const nameOf = (record: LifeAdminRecordView) => recordName(catalogue.typeOfRecord(record.kind, record.type ?? null), record.fields, Boolean(record.type)).name;

  if (view.total === 0) {
    return (
      <WorkspacePanel title="History" description="What's finished, kept apart from what's ongoing." icon={History}>
        <EmptyState
          variant="inline"
          icon={History}
          heading="Nothing in History yet."
          description="Past bookings, things you've ended or cancelled, and matters that are resolved move here, with everything that happened along the way."
        />
      </WorkspacePanel>
    );
  }

  const base: HistoryFilter = { categories: filter.categories, statuses: filter.statuses };
  const applied: AppliedFilter[] = [];
  for (const id of filter.categories) {
    const label = view.categoryOptions.find((option) => option.category.id === id)?.category.label ?? id;
    applied.push({ label: `Category: ${label}`, removeHref: historyHref({ ...base, categories: filter.categories.filter((other) => other !== id) }) });
  }
  for (const status of filter.statuses) {
    applied.push({ label: `Status: ${LIST_STATUS_LABELS[status]}`, removeHref: historyHref({ ...base, statuses: filter.statuses.filter((other) => other !== status) }) });
  }
  const counts = HISTORY_STATUSES.map((status) => view.statusOptions.find((option) => option.status === status)?.count ?? 0);
  const filtered = applied.length > 0;
  const current: HistoryFilter = { ...base, page: view.page };

  return (
    <RecordReturnProvider value={{ tab: "history", filter: current }}>
      <ListToolbar
        label="Filter history"
        search={
          <FilterForm action="/life-admin" label="Filter history by category and status" hidden={{ tab: "history" }}>
            <MultiSelectFilter
              label="Category"
              name="history_category"
              options={view.categoryOptions.map(({ category, count }) => ({ value: category.id, label: category.label, count }))}
              selected={filter.categories}
              hint="None ticked shows every category."
              countLabel={(count) => plural(count, "record")}
            />
            <MultiSelectFilter
              label="Status"
              name="history_status"
              noneLabel="Any"
              options={view.statusOptions.map(({ status, label, count }) => ({ value: status, label, count }))}
              selected={filter.statuses}
              hint="None ticked shows both."
              countLabel={(count) => plural(count, "record")}
            />
          </FilterForm>
        }
        applied={<ActiveFilters filters={applied} clearHref={historyHref({ categories: [], statuses: [] })} />}
        status={`${counts[0]} finished · ${counts[1]} cancelled${filtered ? ` · ${plural(view.shown, "shown", "shown")}` : ""}`}
      />
      <WorkspacePanel
        title="History"
        description="What's finished, newest first: past bookings, things you've ended or cancelled, and matters resolved. Each keeps its whole log."
        icon={History}
        footer={
          view.pages > 1 ? (
            <nav aria-label="History pages" className="flex min-w-0 flex-wrap items-center gap-3">
              {view.page > 1 ? (
                <ButtonLink href={historyHref({ ...base, page: view.page - 1 })} size="sm">Newer</ButtonLink>
              ) : null}
              <span className="text-sm text-fg-muted">Page {view.page} of {view.pages}</span>
              {view.page < view.pages ? (
                <ButtonLink href={historyHref({ ...base, page: view.page + 1 })} size="sm">Older</ButtonLink>
              ) : null}
            </nav>
          ) : undefined
        }
      >
        {view.shown === 0 ? (
          <EmptyState
            variant="inline"
            icon={History}
            heading="Nothing in History matches these filters."
            action={<ButtonLink href={historyHref({ categories: [], statuses: [] })} size="sm">Clear filters</ButtonLink>}
          />
        ) : (
          view.months.map((month) => (
            <ListGroup key={month.key} id={`history-${month.key}`} level={3} title={month.label} count={month.rows.length}>
              {month.rows.map((row) => (
                <RecordRow
                  key={row.record.id}
                  record={row.record}
                  type={row.type}
                  catalogue={catalogue}
                  category={row.category?.label}
                  partOf={row.anchor ? nameOf(row.anchor) : null}
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
    </RecordReturnProvider>
  );
}
