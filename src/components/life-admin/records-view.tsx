"use client";

import * as React from "react";
import { ChevronDown, ClipboardCheck, EyeOff, FolderOpen, MailSearch, Plus, SearchX, Sparkles, Trash2 } from "lucide-react";

import { WorkspacePanel } from "@/components/shell/workspace-surfaces";
import { ListGroup, LIST_ROW } from "@/components/ui/list-group";
import { ListToolbar } from "@/components/ui/list-toolbar";
import { ActiveFilters, type AppliedFilter } from "@/components/ui/filter-links";
import { FilterForm, MultiSelectFilter } from "@/components/ui/multi-select-filter";
import { ActionForm, FormSubmit } from "@/components/ui/form-submit";
import { Badge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button-link";
import { CopyButton } from "@/components/ui/copy-button";
import { EmptyState } from "@/components/ui/empty";
import { ViewTabLink } from "@/components/ui/view-tabs";
import { ProfileBuildBlock } from "@/components/home/profile-build-block";
import type { ProfileBuildView } from "@/domain/home/profile-build";
import type { Catalogue } from "@/domain/life-admin/catalogue";
import type { CategoryDef, RecordTypeDef } from "@/domain/life-admin/record-types";
import { categoryIcon } from "./category-icons";
import { ADD_TAB_HREF } from "./tab-address";
import {
  DEFAULT_LIST_STATUSES,
  LIST_STATUS_LABELS,
  RECORDS_TAB_STATUSES,
  fillInChoices,
  fillInPrompt,
  joinWords,
  listedRecords,
  historyHref,
  recordsHref,
  recordsView,
  sectionOf,
  type AnchorGroup,
  type CategorySection,
  type RecordsView as RecordsViewModel,
  type StatusSection,
} from "./record-groups";
import { foundInSentence, pendingChangeView, recordName, whenLine } from "./record-format";
import { AddRecordPanel, DisabledControl, RecordReturnProvider, ReturnFields, parentOptions, summaryClass } from "./record-forms";
import { EditControl, RecordFacts, RecordRow, itemHref, kindLine, recordProvenance } from "./record-row";
import type {
  AssetOption,
  CategoryStateView,
  LifeAdminAction,
  LifeAdminRecordView,
  RecordActions,
  RecordFilter,
  RecordListStatus,
  SuggestedCategoryView,
} from "./record-view-types";

export { fillInPrompt } from "./record-groups";

// The Records tab (docs/adr/life-admin-profile.md; founder, 23 Nov 2026): what's ongoing in the
// person's life — accounts, policies, memberships, documents, the things other records belong to
// and matters in progress — as a typed profile, filled in mostly by their own agents from email
// and checked by the person. Bookings are Upcoming's, and anything finished is History's
// (`sectionOf`). Top to bottom:
//
//   1. To check — only when there is something to check, whatever the filters and whichever tab
//      the record will live on: agents' suggestions (Confirm, Not mine, Edit; Confirm all), their
//      proposed changes to confirmed records (Accept change, Keep mine; Accept all), a change of
//      kind first, and categories of the person's own an agent suggested (Keep, Decline), each
//      with the agent's reason.
//   2. The filters: Category and Status (Active, On hold), each multiple-choice
//      (`?category=…&status=…`), in a plain GET form, with the applied ones as removable chips and
//      one line saying what's shown and what isn't (each part not shown a link that adds it, and
//      how many finished things are in History).
//   3. What's active, first and always when Active is chosen: one panel per category with
//      something active, in catalogue order. An anchor (a vehicle, home, pet, or a thing of a
//      category of their own) heads the records that belong to it, whatever their category;
//      within a group the most urgent comes first. Rows are compact; their details are one click
//      away. No category panel is ever empty.
//   4. On hold, when chosen, as its own quieter list across categories.
//   5. "Add a record", to the Add tab; with nothing on file, an empty state saying so instead.
//
// The Add tab (`AddView`; founder, 24 Nov 2026) keeps what's still to fill in apart from what's on
// file:
//   1. Fill in the rest — at most six empty built-in categories to look for or say "not for me",
//      a prompt to copy into an agent, and the ones already marked "not for me", to undo.
//   2. Add something yourself — pick a kind, then fill in its form.

type Typed = { record: LifeAdminRecordView; type: RecordTypeDef; name: string; titleKey: string | null };

type Context = {
  catalogue: Catalogue;
  assets: readonly AssetOption[];
  zone: string;
  currentYear: string;
  actions: RecordActions;
  names: ReadonlyMap<string, string>;
  // The records the current filters show, so a link to one stays on the page.
  visible: ReadonlySet<string>;
};

const DEFAULT_FILTER: RecordFilter = { categories: [], statuses: DEFAULT_LIST_STATUSES };

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

// A small form whose one button posts these hidden values to `action`, and returns to the
// filters the page is showing.
function PostButton({
  action,
  values,
  variant,
  pendingLabel,
  children,
}: {
  action: LifeAdminAction;
  values: Readonly<Record<string, string>>;
  variant: "primary" | "secondary" | "ghost" | "danger-solid";
  pendingLabel: string;
  children: React.ReactNode;
}) {
  return (
    <ActionForm action={action}>
      {Object.entries(values).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <ReturnFields />
      <FormSubmit variant={variant} size="sm" pendingLabel={pendingLabel}>
        {children}
      </FormSubmit>
    </ActionForm>
  );
}

// ─── 1. To check ─────────────────────────────────────────────────────────────────────

function SuggestionItem({ item, ctx }: { item: Typed; ctx: Context }) {
  const { record, type, name, titleKey } = item;
  const { actions } = ctx;
  return (
    <li id={`check-${record.id}`} className={LIST_ROW}>
      <div className="flex min-w-0 flex-col gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <p className="min-w-0 font-medium text-fg [overflow-wrap:anywhere]">
            {name.startsWith(type.label) ? name : <><span className="text-fg-muted">{type.label}:</span> {name}</>}
          </p>
          <p className="text-sm text-fg-muted [overflow-wrap:anywhere]">{kindLine(type, record, ctx.zone, ctx.currentYear)}</p>
        </div>
        <RecordFacts record={record} type={type} titleKey={titleKey} limit={4} zone={ctx.zone} currentYear={ctx.currentYear} />
        <p className="text-sm text-fg-muted [overflow-wrap:anywhere]">{recordProvenance(record)}</p>
        <div className="flex min-w-0 flex-wrap items-start gap-2">
          {actions.confirmRecordAction ? (
            <PostButton action={actions.confirmRecordAction} values={{ recordId: record.id }} variant="primary" pendingLabel="Confirming…">
              Confirm<span className="sr-only"> {name}</span>
            </PostButton>
          ) : (
            <DisabledControl label="Confirm" reason="Confirming isn't available just now." />
          )}
          {actions.dismissRecordAction ? (
            <PostButton action={actions.dismissRecordAction} values={{ recordId: record.id }} variant="secondary" pendingLabel="Removing…">
              Not mine<span className="sr-only">: {name}</span>
            </PostButton>
          ) : null}
          <EditControl
            record={record}
            type={type}
            name={name}
            parents={parentOptions(type, ctx.assets, ctx.catalogue, record.id)}
            zone={ctx.zone}
            editRecordAction={actions.editRecordAction}
            submitLabel="Save and confirm"
          />
        </div>
      </div>
    </li>
  );
}

function PendingItem({ item, ctx }: { item: Typed; ctx: Context }) {
  const { record, type, name } = item;
  const { actions } = ctx;
  const pending = record.pending!;
  const lines = pendingChangeView(ctx.catalogue, record, pending, ctx.zone, ctx.names);
  // The record's own row when the filters show it, else its page.
  const href = ctx.visible.has(record.id) ? `#record-${record.id}` : itemHref(record.id);
  return (
    <li id={`change-${record.id}`} className={LIST_ROW}>
      <div className="flex min-w-0 flex-col gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <p className="min-w-0 font-medium text-fg [overflow-wrap:anywhere]">{pending.byName} suggests a change</p>
          <p className="text-sm text-fg-muted [overflow-wrap:anywhere]">
            {name.startsWith(type.label) ? null : `${type.label} · `}<a href={href} className="font-medium text-fg underline underline-offset-4">{name}</a>
          </p>
        </div>
        {lines.length ? (
          <ul role="list" aria-label="Suggested changes" className="flex min-w-0 flex-col gap-1 text-sm">
            {lines.map((line) => (
              <li key={line.key} className="min-w-0 [overflow-wrap:anywhere]">
                <span className="text-fg-muted">{line.label}:</span>{" "}
                <span className={line.from === null ? "text-fg-muted" : "text-fg"}>{line.from ?? "not set"}</span>{" "}
                <span aria-hidden={true}>→</span>
                <span className="sr-only">changes to</span>{" "}
                <span className={line.to === null ? "text-fg-muted" : "font-medium text-fg"}>{line.to ?? "removed"}</span>
              </li>
            ))}
          </ul>
        ) : null}
        {pending.foundIn ? <p className="text-sm text-fg-muted [overflow-wrap:anywhere]">{foundInSentence(pending.byName, pending.foundIn)}</p> : null}
        <div className="flex min-w-0 flex-wrap items-start gap-2">
          {actions.acceptPendingAction ? (
            <PostButton action={actions.acceptPendingAction} values={{ recordId: record.id }} variant="primary" pendingLabel="Accepting…">
              Accept change<span className="sr-only"> to {name}</span>
            </PostButton>
          ) : (
            <DisabledControl label="Accept change" reason="Accepting changes isn't available just now." />
          )}
          {actions.declinePendingAction ? (
            <PostButton action={actions.declinePendingAction} values={{ recordId: record.id }} variant="secondary" pendingLabel="Keeping yours…">
              Keep mine<span className="sr-only">: {name}</span>
            </PostButton>
          ) : null}
        </div>
      </div>
    </li>
  );
}

/** What declining a suggested category does, in words, for its confirmation. */
export function declineConsequence(category: Pick<SuggestedCategoryView, "label" | "suggestedRecords" | "confirmedRecords">): string {
  const parts: string[] = [];
  if (category.suggestedRecords > 0) parts.push(`its ${plural(category.suggestedRecords, "suggested record")} will be removed`);
  if (category.confirmedRecords > 0) parts.push(`the ${plural(category.confirmedRecords, "record")} you confirmed will move to Something else, with their details kept`);
  const what = parts.length ? `${joinWords(parts)[0]!.toUpperCase()}${joinWords(parts).slice(1)}.` : "It has no records yet.";
  return `Decline “${category.label}”? ${what} Agents won't suggest it again.`;
}

function SuggestedCategoryItem({ category, actions }: { category: SuggestedCategoryView; actions: RecordActions }) {
  return (
    <li id={`suggested-category-${category.slug}`} className={LIST_ROW}>
      <div className="flex min-w-0 flex-col gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <p className="min-w-0 font-medium text-fg [overflow-wrap:anywhere]">{category.label}</p>
            <Badge tone="info" icon={Sparkles}>Suggested category</Badge>
          </div>
          {category.description ? <p className="text-sm text-fg-muted [overflow-wrap:anywhere]">{category.description}</p> : null}
        </div>
        <p className="text-sm text-fg [overflow-wrap:anywhere]">
          {category.why ? `Suggested by ${category.suggestedBy}: ${category.why}` : `Suggested by ${category.suggestedBy}.`}
        </p>
        <dl className="grid min-w-0 max-w-xl grid-cols-1 gap-x-4 gap-y-1 text-sm sm:grid-cols-[minmax(7rem,11rem)_minmax(0,1fr)]">
          <dt className="text-fg-muted">Adds</dt>
          <dd className="mb-2 min-w-0 text-fg [overflow-wrap:anywhere] sm:mb-0">{joinWords(category.kinds) || "No kinds"}</dd>
          <dt className="text-fg-muted">Holds</dt>
          <dd className="min-w-0 text-fg">
            {plural(category.records, "record")}
            {category.suggestedRecords > 0 && category.suggestedRecords < category.records ? `, ${category.suggestedRecords} not checked yet` : category.suggestedRecords > 0 ? ", not checked yet" : ""}
          </dd>
        </dl>
        <div className="flex min-w-0 flex-wrap items-start gap-2">
          {actions.keepCategoryAction ? (
            <PostButton action={actions.keepCategoryAction} values={{ slug: category.slug }} variant="primary" pendingLabel="Keeping…">
              Keep<span className="sr-only"> {category.label}</span>
            </PostButton>
          ) : (
            <DisabledControl label="Keep" reason="Keeping categories isn't available just now." />
          )}
          {actions.declineCategoryAction ? (
            <details className="min-w-0 open:basis-full">
              <summary className={summaryClass("secondary", "sm")}>
                Decline<span className="sr-only"> {category.label}</span>
                <ChevronDown aria-hidden={true} className="h-4 w-4 shrink-0 text-fg-muted" />
              </summary>
              <div className="mt-3 flex flex-col gap-3 rounded-card bg-surface-muted p-4">
                <p className="text-sm text-fg">{declineConsequence(category)}</p>
                <div>
                  <PostButton action={actions.declineCategoryAction} values={{ slug: category.slug }} variant="danger-solid" pendingLabel="Declining…">
                    <Trash2 aria-hidden={true} className="h-4 w-4 shrink-0" />
                    Decline category<span className="sr-only"> {category.label}</span>
                  </PostButton>
                </div>
              </div>
            </details>
          ) : null}
        </div>
      </div>
    </li>
  );
}

// "Confirm all n" / "Accept all n changes": one form posting every id it covers.
function AllForm({ action, ids, pendingLabel, children }: { action: LifeAdminAction; ids: readonly string[]; pendingLabel: string; children: React.ReactNode }) {
  return (
    <ActionForm action={action}>
      {ids.map((id) => (
        <input key={id} type="hidden" name="recordId" value={id} />
      ))}
      <ReturnFields />
      <FormSubmit variant="secondary" pendingLabel={pendingLabel}>
        {children}
      </FormSubmit>
    </ActionForm>
  );
}

// A profile build (docs/adr/profile-build.md) can leave dozens of suggestions: across categories
// they're grouped, each with its count and "Confirm all in <category>", the first one open (all of
// them while there are only a few).
const GROUPS_OPEN_UP_TO = 8;

function byCategory(items: readonly Typed[], ctx: Context): { id: string; label: string; items: Typed[] }[] {
  const groups = new Map<string, { id: string; label: string; items: Typed[] }>();
  for (const item of items) {
    const id = item.type.category;
    const group = groups.get(id) ?? { id, label: ctx.catalogue.category(id)?.label ?? "Other", items: [] };
    group.items.push(item);
    groups.set(id, group);
  }
  return [...groups.values()];
}

function CategorySuggestions({ group, open, ctx }: { group: { id: string; label: string; items: Typed[] }; open: boolean; ctx: Context }) {
  const { actions } = ctx;
  return (
    <li className="min-w-0 list-none">
      <details open={open} className="group/category min-w-0">
        <summary className={summaryClass("ghost", "sm")}>
          {group.label} · {group.items.length}
          <ChevronDown aria-hidden={true} className="h-4 w-4 shrink-0 text-fg-muted transition-transform group-open/category:rotate-180" />
        </summary>
        {group.items.length >= 2 && actions.confirmAllAction ? (
          <div className="mt-2 flex">
            <AllForm action={actions.confirmAllAction} ids={group.items.map((item) => item.record.id)} pendingLabel="Confirming…">
              Confirm all {group.items.length} in {group.label}
            </AllForm>
          </div>
        ) : null}
        <ul role="list" className="flex min-w-0 flex-col">
          {group.items.map((item) => (
            <SuggestionItem key={item.record.id} item={item} ctx={ctx} />
          ))}
        </ul>
      </details>
    </li>
  );
}

function ToCheckPanel({
  suggestions,
  changes,
  categories,
  ctx,
}: {
  suggestions: readonly Typed[];
  changes: readonly Typed[];
  categories: readonly SuggestedCategoryView[];
  ctx: Context;
}) {
  const { actions } = ctx;
  const confirmAll =
    suggestions.length >= 2 && actions.confirmAllAction ? (
      <AllForm action={actions.confirmAllAction} ids={suggestions.map((item) => item.record.id)} pendingLabel="Confirming…">
        Confirm all {suggestions.length}
      </AllForm>
    ) : null;
  const acceptAll =
    changes.length >= 2 && actions.acceptAllPendingAction ? (
      <AllForm action={actions.acceptAllPendingAction} ids={changes.map((item) => item.record.id)} pendingLabel="Accepting…">
        Accept all {changes.length} changes
      </AllForm>
    ) : null;
  return (
    <WorkspacePanel
      title="To check"
      description="Your agents found these. Agents are told they aren't checked yet until you confirm them, and an agent never changes what you've confirmed without asking you here."
      icon={ClipboardCheck}
      footer={confirmAll || acceptAll ? <>{confirmAll}{acceptAll}</> : undefined}
    >
      {categories.length ? (
        <ListGroup id="to-check-categories" level={3} title="Suggested categories" count={categories.length}>
          {categories.map((category) => (
            <SuggestedCategoryItem key={category.slug} category={category} actions={actions} />
          ))}
        </ListGroup>
      ) : null}
      {suggestions.length ? (
        <ListGroup id="to-check-suggestions" level={3} title="Found by your agents" count={suggestions.length}>
          {byCategory(suggestions, ctx).length > 1
            ? byCategory(suggestions, ctx).map((group, index) => (
                <CategorySuggestions key={group.id} group={group} open={index === 0 || suggestions.length <= GROUPS_OPEN_UP_TO} ctx={ctx} />
              ))
            : suggestions.map((item) => <SuggestionItem key={item.record.id} item={item} ctx={ctx} />)}
        </ListGroup>
      ) : null}
      {changes.length ? (
        <ListGroup id="to-check-changes" level={3} title="Suggested changes" count={changes.length}>
          {changes.map((item) => (
            <PendingItem key={item.record.id} item={item} ctx={ctx} />
          ))}
        </ListGroup>
      ) : null}
    </WorkspacePanel>
  );
}

// ─── 2. The filters ──────────────────────────────────────────────────────────────────

const STATUS_WORDS: Readonly<Record<RecordListStatus, string>> = { active: "active", on_hold: "on hold", finished: "finished", cancelled: "cancelled" };

function isDefault(filter: RecordFilter): boolean {
  return filter.categories.length === 0 && filter.statuses.length === DEFAULT_LIST_STATUSES.length && filter.statuses.every((status) => DEFAULT_LIST_STATUSES.includes(status));
}

// "14 active · Not shown: 2 on hold · 18 finished or cancelled, in History", each part not shown
// a link that shows it (History's in the same categories).
function StatusLine({ view, filter, inHistory }: { view: RecordsViewModel<LifeAdminRecordView>; filter: RecordFilter; inHistory: number }) {
  const count = (status: RecordListStatus) => view.statusOptions.find((option) => option.status === status)?.count ?? 0;
  const shown = RECORDS_TAB_STATUSES.filter((status) => filter.statuses.includes(status)).map((status) => `${count(status)} ${STATUS_WORDS[status]}`);
  const hidden = RECORDS_TAB_STATUSES.filter((status) => !filter.statuses.includes(status) && count(status) > 0);
  return (
    <>
      {shown.join(", ")}
      {hidden.length ? (
        <>
          {" · Not shown: "}
          {hidden.map((status, index) => (
            <React.Fragment key={status}>
              {index > 0 ? ", " : null}
              <a
                href={recordsHref({ ...filter, statuses: [...filter.statuses, status] })}
                className="inline-flex min-h-11 items-center font-medium text-fg underline underline-offset-4 lg:pointer-fine:min-h-0"
              >
                {count(status)} {STATUS_WORDS[status]}
                <span className="sr-only">: show them</span>
              </a>
            </React.Fragment>
          ))}
        </>
      ) : null}
      {inHistory > 0 ? (
        <>
          {" · "}
          <a
            href={historyHref({ categories: filter.categories, statuses: [] })}
            className="inline-flex min-h-11 items-center font-medium text-fg underline underline-offset-4 lg:pointer-fine:min-h-0"
          >
            {inHistory} finished or cancelled
          </a>
          {", in History"}
        </>
      ) : null}
    </>
  );
}

// "You pay about AUD 284.79 and USD 16.00 a month for 9 recurring records." What's active and
// repeating in the chosen categories, worked out by Warthog (costs.ts); "about" because weekly,
// quarterly and yearly amounts are spread over months. Nothing when no active record has a price.
function CostLine({ monthly }: { monthly: RecordsViewModel<LifeAdminRecordView>["monthly"] }) {
  if (monthly.length === 0) return null;
  // The currency most of them are in leads.
  const amounts = [...monthly].sort((a, b) => b.records - a.records || b.amount - a.amount).map((cost) => `${cost.currency} ${cost.amount.toFixed(2)}`);
  const amountWords = amounts.length === 1 ? amounts[0] : `${amounts.slice(0, -1).join(", ")} and ${amounts.at(-1)}`;
  const records = monthly.reduce((sum, cost) => sum + cost.records, 0);
  return (
    <p className="wh-toolbar-status text-fg">
      You pay about {amountWords} a month for {plural(records, "recurring record")}.
    </p>
  );
}

function RecordsToolbar({ view, filter, inHistory }: { view: RecordsViewModel<LifeAdminRecordView>; filter: RecordFilter; inHistory: number }) {
  const applied: AppliedFilter[] = [];
  for (const id of filter.categories) {
    const label = view.categoryOptions.find((option) => option.category.id === id)?.category.label ?? id;
    applied.push({ label: `Category: ${label}`, removeHref: recordsHref({ ...filter, categories: filter.categories.filter((other) => other !== id) }) });
  }
  if (!(filter.statuses.length === 1 && filter.statuses[0] === "active")) {
    for (const status of filter.statuses) {
      applied.push({ label: `Status: ${LIST_STATUS_LABELS[status]}`, removeHref: recordsHref({ ...filter, statuses: filter.statuses.filter((other) => other !== status) }) });
    }
  }
  return (
    <ListToolbar
      label="Filter records"
      search={
        <FilterForm action="/life-admin" label="Filter records by category and status" hidden={{}}>
          <MultiSelectFilter
            label="Category"
            name="category"
            options={view.categoryOptions.map(({ category, count }) => ({ value: category.id, label: category.label, count }))}
            selected={filter.categories}
            hint="None ticked shows every category."
            countLabel={(count) => plural(count, "record")}
          />
          <MultiSelectFilter
            label="Status"
            name="status"
            options={view.statusOptions.map(({ status, label, count }) => ({ value: status, label, count }))}
            selected={filter.statuses}
            defaults={DEFAULT_LIST_STATUSES}
            hint="What's active always comes first. With none ticked, Active shows."
            countLabel={(count) => plural(count, "record")}
          />
        </FilterForm>
      }
      applied={<ActiveFilters filters={applied} clearHref={recordsHref(DEFAULT_FILTER)} />}
      status={<StatusLine view={view} filter={filter} inHistory={inHistory} />}
    >
      <CostLine monthly={view.monthly} />
    </ListToolbar>
  );
}

// ─── 3. Active, one panel per category ───────────────────────────────────────────────

function anchorSummary(group: AnchorGroup<LifeAdminRecordView>, ctx: Context): string {
  const { anchor, type, children } = group;
  const span = whenLine(type, anchor, ctx.zone, ctx.currentYear);
  const next = children.find((child) => child.phase?.comingUp || child.dueDate);
  const nextText = next
    ? (() => {
        const childType = ctx.catalogue.typeOfRecord(next.kind, next.type ?? null);
        const when = whenLine(childType, next, ctx.zone, ctx.currentYear);
        return `Next: ${recordName(childType, next.fields, Boolean(next.type)).name}${when ? `, ${when.charAt(0).toLowerCase()}${when.slice(1)}` : ""}`;
      })()
    : null;
  return [type.label, type.anchor && anchor.phase?.starts ? span : null, nextText].filter(Boolean).join(" · ");
}

function Row({ record, ctx, lead, partOf, category }: { record: LifeAdminRecordView; ctx: Context; lead?: string; partOf?: string | null; category?: string }) {
  return (
    <RecordRow
      record={record}
      type={ctx.catalogue.typeOfRecord(record.kind, record.type ?? null)}
      catalogue={ctx.catalogue}
      lead={lead}
      partOf={partOf}
      category={category}
      assets={ctx.assets}
      zone={ctx.zone}
      currentYear={ctx.currentYear}
      actions={ctx.actions}
    />
  );
}

// What a record belongs to when that thing isn't heading it here (a trip, say, which lives on
// Upcoming), so the row still says it.
function partOfElsewhere(record: LifeAdminRecordView, ctx: Context): string | null {
  return record.parentId && record.parentId !== record.id ? ctx.names.get(record.parentId) ?? null : null;
}

function CategoryPanel({ section, suggested, ctx }: { section: CategorySection<LifeAdminRecordView>; suggested: boolean; ctx: Context }) {
  const { category, anchors, loose } = section;
  const anchorNoun = anchors[0]?.type.label.toLowerCase();
  return (
    <WorkspacePanel
      title={
        suggested ? (
          <span className="inline-flex flex-wrap items-center gap-2">
            {category.label}
            <Badge tone="info" icon={Sparkles}>Suggested</Badge>
          </span>
        ) : (
          category.label
        )
      }
      icon={categoryIcon(category.icon)}
    >
      {anchors.map((group) => {
        const { anchor, type, children } = group;
        const { name } = recordName(type, anchor.fields, Boolean(anchor.type));
        return (
          <ListGroup key={anchor.id} id={`asset-${anchor.id}`} level={3} title={name} summary={anchorSummary(group, ctx)}>
            <Row record={anchor} ctx={ctx} lead={`${type.label} details`} />
            {children.map((child) => (
              <Row key={child.id} record={child} ctx={ctx} />
            ))}
          </ListGroup>
        );
      })}
      {loose.length === 0 ? null : anchors.length ? (
        <ListGroup id={`category-${category.id}-unlinked`} level={3} title={`Not linked to a ${anchorNoun}`} count={loose.length}>
          {loose.map((record) => (
            <Row key={record.id} record={record} ctx={ctx} partOf={partOfElsewhere(record, ctx)} />
          ))}
        </ListGroup>
      ) : (
        <ul role="list" className="flex min-w-0 flex-col">
          {loose.map((record) => (
            <Row key={record.id} record={record} ctx={ctx} partOf={partOfElsewhere(record, ctx)} />
          ))}
        </ul>
      )}
    </WorkspacePanel>
  );
}

// ─── 4. Each other status, across categories ─────────────────────────────────────────

const SECTION_SUMMARY: Readonly<Record<RecordListStatus, string>> = {
  active: "",
  on_hold: "Paused for now, newest first.",
  finished: "Ended, completed or resolved, newest first. Each keeps its whole history.",
  cancelled: "Cancelled, missed or lapsed, newest first.",
};

function StatusList({ section, ctx }: { section: StatusSection<LifeAdminRecordView>; ctx: Context }) {
  return (
    <ListGroup
      id={`records-${section.status}`}
      level={2}
      title={<span className="text-fg-muted">{section.label}</span>}
      count={section.rows.length}
      summary={SECTION_SUMMARY[section.status]}
    >
      {section.rows.map((row) => (
        <Row
          key={row.record.id}
          record={row.record}
          ctx={ctx}
          category={row.category?.label}
          partOf={row.anchor ? ctx.names.get(row.anchor.id) ?? null : null}
        />
      ))}
    </ListGroup>
  );
}

// ─── the Add tab: Fill in the rest ───────────────────────────────────────────────────

function FillInPanel({
  available,
  notForMe,
  hasRecords,
  action,
}: {
  available: readonly CategoryDef[];
  notForMe: readonly { category: CategoryDef; records: number }[];
  hasRecords: boolean;
  action?: LifeAdminAction;
}) {
  const prompt = available.length ? fillInPrompt(available) : null;
  return (
    <WorkspacePanel
      title={hasRecords ? "Fill in the rest" : "Fill in your life admin"}
      description="Your agent can find these in your email, calendar and files. What it saves waits under To check until you confirm it. Say a category is not for you, and it won't be suggested again."
      icon={MailSearch}
      footer="Warthog doesn't read your things itself. Your agent does, through Warthog, and only what you allow it to."
    >
      <div className="flex min-w-0 flex-col gap-4">
        {available.length ? (
          <ul role="list" aria-label="Categories you could fill in" className="flex min-w-0 flex-col">
            {available.map((category) => {
              const Icon = categoryIcon(category.icon);
              return (
                <li key={category.id} className={`${LIST_ROW} sm:flex-row sm:items-start sm:justify-between sm:gap-4`}>
                  <div className="flex min-w-0 items-start gap-2">
                    <Icon aria-hidden={true} className="mt-0.5 h-4 w-4 shrink-0 text-fg-muted" />
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-fg">{category.label}</p>
                      <p className="text-sm text-fg-muted">{category.description}</p>
                    </div>
                  </div>
                  {action ? (
                    <div className="flex shrink-0 flex-wrap items-start gap-2">
                      <PostButton action={action} values={{ category: category.id, setting: "not_for_me" }} variant="ghost" pendingLabel="Hiding…">
                        <EyeOff aria-hidden={true} className="h-4 w-4 shrink-0 text-fg-muted" />
                        Not for me<span className="sr-only">: {category.label}</span>
                      </PostButton>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        ) : null}
        {prompt ? (
          <div className="flex min-w-0 flex-col gap-3 rounded-card bg-surface-muted p-4 sm:flex-row sm:items-start">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-fg">Ask your agent</p>
              <p className="mt-1 text-sm text-fg [overflow-wrap:anywhere]">{prompt}</p>
            </div>
            <CopyButton value={prompt} label="prompt for your agent" />
          </div>
        ) : null}
        {notForMe.length ? (
          <details className="group/hidden min-w-0">
            <summary className={summaryClass("ghost", "sm")}>
              <EyeOff aria-hidden={true} className="h-4 w-4 shrink-0 text-fg-muted" />
              Not for me ({notForMe.length})
              <ChevronDown aria-hidden={true} className="h-4 w-4 shrink-0 text-fg-muted transition-transform group-open/hidden:rotate-180" />
            </summary>
            <ul role="list" aria-label="Categories you said are not for you" className="mt-2 flex min-w-0 flex-col rounded-card bg-surface-muted px-4">
              {notForMe.map(({ category, records }) => (
                <li key={category.id} className={`${LIST_ROW} sm:flex-row sm:items-center sm:justify-between sm:gap-4`}>
                  <p className="min-w-0 text-sm text-fg">
                    {category.label}
                    {records > 0 ? <span className="text-fg-muted"> · {plural(records, "record")} kept, hidden on every tab</span> : null}
                  </p>
                  {action ? (
                    <PostButton action={action} values={{ category: category.id, setting: "clear" }} variant="secondary" pendingLabel="Restoring…">
                      Undo<span className="sr-only">: show {category.label} again</span>
                    </PostButton>
                  ) : null}
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </div>
    </WorkspacePanel>
  );
}

// ─── nothing matches ─────────────────────────────────────────────────────────────────

function NoMatches({ filter, view }: { filter: RecordFilter; view: RecordsViewModel<LifeAdminRecordView> }) {
  // With the default filters, nothing is active: offer what there is instead of a "Clear" that
  // would change nothing.
  // With the default filters and something ongoing, nothing active means it's all on hold.
  if (isDefault(filter)) {
    return (
      <EmptyState
        icon={SearchX}
        heading="Nothing is active right now."
        description="What you keep here is on hold. What's finished is in History."
        action={<ButtonLink href={recordsHref({ categories: [], statuses: ["active", "on_hold"] })} size="sm">Show what's on hold</ButtonLink>}
      />
    );
  }
  return (
    <EmptyState
      icon={SearchX}
      heading="No records match these filters."
      description="Choose other categories or statuses, or clear the filters to see what's active."
      action={<ButtonLink href={recordsHref(DEFAULT_FILTER)} size="sm">Clear filters</ButtonLink>}
    />
  );
}

// Nothing ongoing yet, though there are bookings or finished things: say where they are.
function NothingOngoing({ upcoming, history }: { upcoming: boolean; history: boolean }) {
  return (
    <EmptyState
      icon={SearchX}
      heading="Nothing ongoing yet."
      description={`Your accounts, policies, memberships and things show here.${upcoming ? " Your bookings are under Upcoming." : ""}${history ? " What's finished is in History." : ""}`}
      action={
        upcoming ? (
          <ButtonLink href="/life-admin?tab=upcoming" size="sm">Go to Upcoming</ButtonLink>
        ) : (
          <ButtonLink href="/life-admin?tab=history" size="sm">Go to History</ButtonLink>
        )
      }
    />
  );
}

// Nothing on file: no record shown on any tab (none yet, or all in categories the person said are
// not for them) and nothing to check. Records then says so, and Life admin opens on Add.
export function nothingOnFile(
  records: readonly LifeAdminRecordView[],
  listed: readonly LifeAdminRecordView[],
  suggestedCategories: readonly SuggestedCategoryView[],
): boolean {
  return listed.length === 0 && suggestedCategories.length === 0 && !records.some((record) => record.reviewState === "suggested" || record.pending);
}

// Records with nothing on file. When what they keep is all in categories they said are not for
// them, say so rather than "nothing yet".
function NothingOnFile({ hidden }: { hidden: boolean }) {
  return (
    <EmptyState
      icon={FolderOpen}
      heading={hidden ? "Nothing to show." : "Nothing on file yet."}
      description={
        hidden
          ? "What you keep is in categories you said are not for you. You can show them again from Not for me, on Add."
          : "Your accounts, policies, memberships and things show here once you add them, or your agent finds them and you confirm."
      }
      action={<AddLink />}
    />
  );
}

// To the Add tab (in place, so half-typed work in other tabs survives): what's still to fill in,
// and adding a record.
function AddLink() {
  return (
    <ViewTabLink tab="add" href={ADD_TAB_HREF} size="sm">
      <Plus aria-hidden={true} className="h-4 w-4 shrink-0" />
      Add a record
    </ViewTabLink>
  );
}

// The things other records belong to (a vehicle, home, pet, or a thing of a category of their own),
// as the "belongs to" choices in the record forms.
export function assetsOf(records: readonly LifeAdminRecordView[], catalogue: Catalogue): AssetOption[] {
  return records.flatMap((record) => {
    const type = catalogue.typeOfRecord(record.kind, record.type ?? null);
    if (!type.anchor) return [];
    const { name } = recordName(type, record.fields, Boolean(record.type));
    return [{ id: record.id, name, typeId: type.id, typeLabel: type.label }];
  });
}

// ─── the Add tab ─────────────────────────────────────────────────────────────────────

export function AddView({
  records,
  catalogue,
  categories,
  zone = "UTC",
  addType,
  assets,
  profileBuild,
  actions,
}: {
  records: readonly LifeAdminRecordView[];
  catalogue: Catalogue;
  categories: readonly CategoryStateView[];
  zone?: string;
  addType?: string | null;
  // The "belongs to" choices, when the caller already worked them out.
  assets?: readonly AssetOption[];
  // Who can build the person's whole profile (docs/adr/profile-build.md): its permanent place.
  profileBuild?: ProfileBuildView;
  actions: RecordActions;
}) {
  const { available, notForMe } = fillInChoices(catalogue, categories);
  return (
    <RecordReturnProvider value={{ tab: "add", filter: { categories: [], statuses: [] } }}>
      {profileBuild ? (
        <WorkspacePanel
          title="Build your whole profile"
          description="Your agent goes through what it can read and fills in every category, and suggests your details for About you, for you to check. Run it again any time: it fills the gaps."
          icon={MailSearch}
        >
          <ProfileBuildBlock view={profileBuild} quiet />
        </WorkspacePanel>
      ) : null}
      {available.length || notForMe.length ? (
        <FillInPanel available={available} notForMe={notForMe} hasRecords={records.length > 0} action={actions.setCategoryVisibilityAction} />
      ) : null}
      <AddRecordPanel catalogue={catalogue} addType={addType} assets={assets ?? assetsOf(records, catalogue)} zone={zone} addRecordAction={actions.addRecordAction} />
    </RecordReturnProvider>
  );
}

// ─── the Records tab ─────────────────────────────────────────────────────────────────

export function RecordsView({
  records,
  catalogue,
  categories,
  suggestedCategories = [],
  today,
  zone = "UTC",
  filter = DEFAULT_FILTER,
  assets: given,
  actions,
}: {
  records: readonly LifeAdminRecordView[];
  catalogue: Catalogue;
  categories: readonly CategoryStateView[];
  suggestedCategories?: readonly SuggestedCategoryView[];
  today: string;
  zone?: string;
  // The "belongs to" choices, when the caller already worked them out.
  assets?: readonly AssetOption[];
  // The filters the page validated; Active in every category when absent.
  filter?: RecordFilter;
  actions: RecordActions;
}) {
  const all: Typed[] = records.map((record) => {
    const type = catalogue.typeOfRecord(record.kind, record.type ?? null);
    const { name, key } = recordName(type, record.fields, Boolean(record.type));
    return { record, type, name, titleKey: key };
  });
  const names = new Map(all.map((item) => [item.record.id, item.name] as const));
  const assets = given ?? all.filter((item) => item.type.anchor).map((item) => ({ id: item.record.id, name: item.name, typeId: item.type.id, typeLabel: item.type.label }));
  const listed = listedRecords(records, catalogue, categories);
  const ongoing = listed.filter((record) => sectionOf(record, catalogue) === "records");
  const chosen = new Set(filter.categories);
  const inHistory = listed.filter(
    (record) => sectionOf(record, catalogue) === "history" && (chosen.size === 0 || chosen.has(catalogue.typeOfRecord(record.kind, record.type ?? null).category)),
  ).length;
  const upcomingOnly = listed.some((record) => sectionOf(record, catalogue) === "upcoming");
  const view = recordsView(ongoing, catalogue, filter);
  const visible = new Set([
    ...view.active.flatMap((section) => [...section.anchors.flatMap((group) => [group.anchor, ...group.children]), ...section.loose]).map((record) => record.id),
    ...view.others.flatMap((section) => section.rows.map((row) => row.record.id)),
  ]);
  const ctx: Context = { catalogue, assets, zone, currentYear: today.slice(0, 4), actions, names, visible };
  const suggestions = all.filter((item) => item.record.reviewState === "suggested");
  const changes = all.filter((item) => item.record.pending && item.record.reviewState !== "suggested");
  const toCheck = suggestions.length > 0 || changes.length > 0 || suggestedCategories.length > 0;
  return (
    <RecordReturnProvider value={{ tab: "records", filter }}>
      {toCheck ? <ToCheckPanel suggestions={suggestions} changes={changes} categories={suggestedCategories} ctx={ctx} /> : null}
      {!listed.length && !toCheck ? <NothingOnFile hidden={records.length > 0} /> : null}
      {ongoing.length ? <RecordsToolbar view={view} filter={filter} inHistory={inHistory} /> : null}
      {listed.length && !ongoing.length ? <NothingOngoing upcoming={upcomingOnly} history={inHistory > 0} /> : null}
      {view.active.map((section) => (
        <CategoryPanel key={section.category.id} section={section} suggested={catalogue.customStates[section.category.id] === "suggested"} ctx={ctx} />
      ))}
      {view.others.map((section) => (
        <StatusList key={section.status} section={section} ctx={ctx} />
      ))}
      {ongoing.length && view.shown === 0 ? <NoMatches filter={filter} view={view} /> : null}
      {listed.length || toCheck ? (
        <div className="flex">
          <AddLink />
        </div>
      ) : null}
    </RecordReturnProvider>
  );
}

