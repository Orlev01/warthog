"use client";

import * as React from "react";
import { ChevronDown, ClipboardCheck, EyeOff, Inbox, MailSearch, Sparkles, Trash2 } from "lucide-react";

import { WorkspacePanel } from "@/components/shell/workspace-surfaces";
import { ListGroup, LIST_ROW } from "@/components/ui/list-group";
import { ActionForm, FormSubmit } from "@/components/ui/form-submit";
import { Badge } from "@/components/ui/badge";
import { CopyButton } from "@/components/ui/copy-button";
import { EmptyState } from "@/components/ui/empty";
import type { Catalogue } from "@/domain/life-admin/catalogue";
import type { CategoryDef, RecordTypeDef } from "@/domain/life-admin/record-types";
import { categoryIcon } from "./category-icons";
import { fillInChoices, fillInPrompt, joinWords, organiseByCategory, type AnchorGroup, type CategorySection } from "./record-groups";
import { foundInSentence, pendingChangeLines, recordName, whenLine } from "./record-format";
import { AddRecordPanel, DisabledControl, parentOptions, summaryClass } from "./record-forms";
import { EditControl, NotCheckedTag, RecordFacts, RecordRow, kindLine, recordProvenance } from "./record-row";
import type {
  AssetOption,
  CategoryStateView,
  LifeAdminAction,
  LifeAdminRecordView,
  RecordActions,
  SuggestedCategoryView,
} from "./record-view-types";

export { fillInPrompt } from "./record-groups";

// "Your things" (docs/adr/life-admin-profile.md): the person's life admin as a typed profile,
// filled in mostly by their own agents from email and checked by the person. Top to bottom:
//
//   1. To check — only when there is something to check: agents' suggestions (Confirm, Not
//      mine, Edit), their proposed changes to confirmed records (Accept change, Keep mine), and
//      categories of the person's own an agent suggested (Keep, Decline), each with the agent's
//      reason. Agents are told a suggestion isn't checked until the person confirms it, and an
//      agent never overwrites a confirmed record: its change waits here.
//   2. One panel per category that shows — it has records, the person chose to show it, or it
//      is one of their own — in the catalogue's order. An anchor (a vehicle, home, trip, pet,
//      or a thing of a category of their own) heads the records that belong to it, whatever
//      their category; a trip shows its dates from its bookings. What is finished is set aside
//      in a collapsed "Finished (n)" per category.
//   3. Fill in the rest — at most six empty built-in categories to show or say "not for me",
//      a prompt to copy into an agent, and the ones already marked "not for me", to undo.
//   4. Add something yourself — pick a kind, then fill in its form.

type Typed = { record: LifeAdminRecordView; type: RecordTypeDef; name: string; titleKey: string | null };

type Context = {
  catalogue: Catalogue;
  assets: readonly AssetOption[];
  zone: string;
  currentYear: string;
  actions: RecordActions;
  names: ReadonlyMap<string, string>;
};

// A small form whose one button posts these hidden values to `action`.
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
  const lines = pendingChangeLines(type, record, pending, ctx.zone);
  return (
    <li id={`change-${record.id}`} className={LIST_ROW}>
      <div className="flex min-w-0 flex-col gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <p className="min-w-0 font-medium text-fg [overflow-wrap:anywhere]">{pending.byName} suggests a change</p>
          <p className="text-sm text-fg-muted [overflow-wrap:anywhere]">
            {name.startsWith(type.label) ? null : `${type.label} · `}<a href={`#record-${record.id}`} className="font-medium text-fg underline underline-offset-4">{name}</a>
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

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
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
      <ActionForm action={actions.confirmAllAction}>
        {suggestions.map((item) => (
          <input key={item.record.id} type="hidden" name="recordId" value={item.record.id} />
        ))}
        <FormSubmit variant="secondary" pendingLabel="Confirming…">
          Confirm all {suggestions.length}
        </FormSubmit>
      </ActionForm>
    ) : undefined;
  return (
    <WorkspacePanel
      title="To check"
      description="Your agents found these. Agents are told they aren't checked yet until you confirm them, and an agent never changes what you've confirmed without asking you here."
      icon={ClipboardCheck}
      footer={confirmAll}
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
          {suggestions.map((item) => (
            <SuggestionItem key={item.record.id} item={item} ctx={ctx} />
          ))}
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

// ─── 2. One panel per category ───────────────────────────────────────────────────────

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

function CategoryPanel({
  category,
  section,
  suggested,
  ctx,
}: {
  category: CategoryDef;
  section?: CategorySection<LifeAdminRecordView>;
  suggested: boolean;
  ctx: Context;
}) {
  const row = (record: LifeAdminRecordView, options: { lead?: string; partOf?: string | null } = {}) => (
    <RecordRow
      key={record.id}
      record={record}
      type={ctx.catalogue.typeOfRecord(record.kind, record.type ?? null)}
      catalogue={ctx.catalogue}
      lead={options.lead}
      partOf={options.partOf}
      assets={ctx.assets}
      zone={ctx.zone}
      currentYear={ctx.currentYear}
      actions={ctx.actions}
    />
  );
  const title = suggested ? (
    <span className="inline-flex flex-wrap items-center gap-2">
      {category.label}
      <Badge tone="info" icon={Sparkles}>Suggested</Badge>
    </span>
  ) : (
    category.label
  );
  const anchors = section?.anchors ?? [];
  const loose = section?.loose ?? [];
  const finished = section?.finished ?? [];
  const anchorNoun = anchors[0]?.type.label.toLowerCase();
  const hide =
    category.origin === "builtin" && ctx.actions.setCategoryVisibilityAction ? (
      <PostButton action={ctx.actions.setCategoryVisibilityAction} values={{ category: category.id, setting: "clear" }} variant="secondary" pendingLabel="Hiding…">
        Hide until there&apos;s something here<span className="sr-only">: {category.label}</span>
      </PostButton>
    ) : undefined;
  return (
    <WorkspacePanel title={title} description={category.description} icon={categoryIcon(category.icon)}>
      {!section ? (
        <EmptyState
          variant="inline"
          icon={Inbox}
          heading="Nothing here yet."
          description="Add one yourself below, or ask your agent to look for it in your email."
          action={hide}
        />
      ) : null}
      {anchors.map((group) => {
        const { anchor, type, children } = group;
        const { name } = recordName(type, anchor.fields, Boolean(anchor.type));
        return (
          <ListGroup key={anchor.id} id={`asset-${anchor.id}`} level={3} title={name} summary={anchorSummary(group, ctx)}>
            {row(anchor, { lead: `${type.label} details` })}
            {children.map((child) => row(child))}
          </ListGroup>
        );
      })}
      {loose.length === 0 ? null : anchors.length ? (
        <ListGroup id={`category-${category.id}-unlinked`} level={3} title={`Not linked to a ${anchorNoun}`} count={loose.length}>
          {loose.map((record) => row(record))}
        </ListGroup>
      ) : (
        <ul role="list" className="flex min-w-0 flex-col">
          {loose.map((record) => row(record))}
        </ul>
      )}
      {finished.length ? (
        <ListGroup id={`category-${category.id}-finished`} level={3} title="Finished" count={finished.length} collapsible>
          {finished.map((record) => row(record, { partOf: record.parentId ? ctx.names.get(record.parentId) ?? null : null }))}
        </ListGroup>
      ) : null}
    </WorkspacePanel>
  );
}

// ─── 3. Fill in the rest ─────────────────────────────────────────────────────────────

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
      description="Your agent can find these in your email. What it saves waits under To check until you confirm it. Show a category to keep it here while it's empty, or say it's not for you."
      icon={MailSearch}
      footer="Warthog doesn't read your email itself. Your agent does, through Warthog, and only what you allow it to."
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
                      <PostButton action={action} values={{ category: category.id, setting: "show" }} variant="secondary" pendingLabel="Showing…">
                        Show<span className="sr-only"> {category.label}</span>
                      </PostButton>
                      <PostButton action={action} values={{ category: category.id, setting: "not_for_me" }} variant="ghost" pendingLabel="Hiding…">
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
                    {records > 0 ? <span className="text-fg-muted"> · {plural(records, "record")} kept, hidden here</span> : null}
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

// ─── the "Your things" tab ───────────────────────────────────────────────────────────

export function ThingsView({
  records,
  catalogue,
  categories,
  suggestedCategories = [],
  today,
  zone = "UTC",
  addType,
  actions,
}: {
  records: readonly LifeAdminRecordView[];
  catalogue: Catalogue;
  categories: readonly CategoryStateView[];
  suggestedCategories?: readonly SuggestedCategoryView[];
  today: string;
  zone?: string;
  addType?: string | null;
  actions: RecordActions;
}) {
  const all: Typed[] = records.map((record) => {
    const type = catalogue.typeOfRecord(record.kind, record.type ?? null);
    const { name, key } = recordName(type, record.fields, Boolean(record.type));
    return { record, type, name, titleKey: key };
  });
  const names = new Map(all.map((item) => [item.record.id, item.name] as const));
  const assets: AssetOption[] = all
    .filter((item) => item.type.anchor)
    .map((item) => ({ id: item.record.id, name: item.name, typeId: item.type.id, typeLabel: item.type.label }));
  const ctx: Context = { catalogue, assets, zone, currentYear: today.slice(0, 4), actions, names };
  const suggestions = all.filter((item) => item.record.reviewState === "suggested");
  const changes = all.filter((item) => item.record.pending && item.record.reviewState !== "suggested");
  const shownIds = new Set(categories.filter((state) => state.visibility === "shown").map((state) => state.id));
  const counts = new Map(categories.map((state) => [state.id, state.records] as const));
  const { sections } = organiseByCategory(records, catalogue, shownIds);
  const sectionOf = new Map(sections.map((section) => [section.category.id, section] as const));
  const { available, notForMe } = fillInChoices(catalogue, categories);
  return (
    <>
      {suggestions.length || changes.length || suggestedCategories.length ? (
        <ToCheckPanel suggestions={suggestions} changes={changes} categories={suggestedCategories} ctx={ctx} />
      ) : null}
      {catalogue.categories
        // A category whose records all sit under an anchor elsewhere (an electricity account
        // under its home) has no panel of its own; one shown while empty says so.
        .filter((category) => shownIds.has(category.id) && (sectionOf.has(category.id) || (counts.get(category.id) ?? 0) === 0))
        .map((category) => (
          <CategoryPanel
            key={category.id}
            category={category}
            section={sectionOf.get(category.id)}
            suggested={catalogue.customStates[category.id] === "suggested"}
            ctx={ctx}
          />
        ))}
      {available.length || notForMe.length ? (
        <FillInPanel available={available} notForMe={notForMe} hasRecords={records.length > 0} action={actions.setCategoryVisibilityAction} />
      ) : null}
      <AddRecordPanel catalogue={catalogue} addType={addType} assets={assets} zone={zone} addRecordAction={actions.addRecordAction} />
    </>
  );
}
