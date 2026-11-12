"use client";

import * as React from "react";
import { WorkspaceHeading } from "@/components/shell/workspace-surfaces";
import { Bot, ChevronDown, Lock, Pencil, Plus, Share, Trash2 } from "lucide-react";

import { Button, buttonClasses } from "@/components/ui/button";
import { ButtonLink } from "@/components/ui/button-link";
import { Input } from "@/components/ui/input";
import { SelectField, TextareaField } from "@/components/ui/field";
import { ActionForm, FormSubmit, PendingFormFields } from "@/components/ui/form-submit";
import { EmptyState } from "@/components/ui/empty";
import { ActiveFilters, FilterLinks, type AppliedFilter } from "@/components/ui/filter-links";
import { ListGroup, LIST_ROW } from "@/components/ui/list-group";
import { ListToolbar } from "@/components/ui/list-toolbar";
import { PageNotice, type NoticeTone } from "@/components/ui/notice";
import { hrefWith, type QueryState } from "@/lib/href";

// E13-S10 — Memory view component (brief "Skills, preferences and shared memory";
// design §4.1; journey: "MEMORY — the moving memory shows 'Saved by Claude · shared'").
//
// The Memory screen lists every memory the person holds — each a short fact or note
// carrying the SOURCE AGENT that saved it (none when the PERSON added it), the TIME it
// was saved and its SHARING STATE (KEPT to the agent that saved it, or SHARED with the
// person's other permitted agents). The person can SEARCH the memories and, on each,
// EDIT its content, RE-SCOPE it (kept ⇄ shared), DELETE it, and ADD THEIR OWN.
//
// This is the pure, prop-driven VIEW (a Client Component in the app): it renders the
// screen FROM PROPS the Memory page read (E13-S09 `memoriesPageData` / `searchMemories`)
// hands it, with the source agent already resolved to a DISPLAY NAME and the saved time
// pre-formatted to a LABEL by that loader — exactly the precedent the sibling skills /
// agent-list / rules / identity / connectors views set (pre-formatted labels in, no
// clock / DB / session in the view).
//
// Each control is a `<form action={…}>` bound to one of the server actions the page
// passes — the actions are OPTIONAL props so the view stays render-testable without a
// server, and the page (wired by a LATER task, E13-S11) always supplies them so no
// control is dead in the running app. Search is a plain GET form that reloads the page
// with the query, which the loader reads. Colour comes from the design tokens
// (globals.css) — never a raw hex.
//
// Organisation: the list sits under date headings the loader computed in the account
// time zone (Today / This week / Earlier). Sharing and saved-by filter links, removable
// applied-filter chips and the page links are plain same-page links built with
// `hrefWith`, so every filter survives paging, reloads and Back/Forward; every form also
// tells the page which filters to come back to, so an edit or a delete keeps the person's
// place. Delete asks for confirmation in a disclosure before it submits.
//
// Layout (rule 1: no text on the canvas): the heading band, the outcome of the last action,
// a collapsible "Add a memory" panel, one toolbar for search and filters (left out until
// there is something to search), the date groups as list panels, and a bounded page bar.
// Each memory's three controls share one row; an opened Edit or Delete panel spans the row
// underneath them.
//
// Sharing, in the person's words: a "kept" memory is PRIVATE to the agent that saved it
// (or, when the person added it, to no agent); a "shared" one is shared with every agent
// they let read memory. The stored values stay "kept" / "shared".

type MemoryScope = "kept" | "shared";

// The date heading a memory sits under (computed by the loader in the account zone).
export type MemoryDateGroup = "today" | "week" | "earlier";

const DATE_GROUPS: ReadonlyArray<{ key: MemoryDateGroup; title: string }> = [
  { key: "today", title: "Today" },
  { key: "week", title: "This week" },
  { key: "earlier", title: "Earlier" },
];

// One filter link: `value` is the URL value it sets (null = no filter), with an optional
// count of the memories it would show.
export type MemoryFilterOption = {
  readonly value: string | null;
  readonly label: string;
  readonly count?: number;
};

// The validated filters in force (null = not filtering) and the options to offer: every
// scope, and "You" plus the person's own agents for who saved it.
export type MemoryFilterState = {
  readonly scope: MemoryScope | null;
  readonly source: string | null; // "you" | one of the person's agent ids
  readonly scopeOptions: readonly MemoryFilterOption[];
  readonly sourceOptions: readonly MemoryFilterOption[];
};

const PATH = "/memory";

// One of the person's memories, as the Memory page read (E13-S09 MemoryPageItem) hands
// it back AFTER the loader resolves the source agent id to a display name and formats
// the saved time: its id, its decrypted content, the pre-formatted saved-at label, the
// saving agent's display name (null when the PERSON added it) and its scope.
export type MemoryViewItem = {
  id: string;
  content: string;
  savedAt: string;
  sourceAgentName: string | null;
  scope: MemoryScope;
  dateGroup: MemoryDateGroup;
  audience?: readonly string[];
};

// A control bound to a server action the page passes.
type MemoryAction = (formData: FormData) => void | Promise<void>;

export type MemoryViewProps = {
  memories: ReadonlyArray<MemoryViewItem>;
  // The search term echoed back so the search box stays prefilled after a search.
  query?: string | null;
  // The scope / saved-by filters in force and the options the filter links offer.
  filters?: MemoryFilterState;
  nextCursor?: string | null;
  hasPreviousPage?: boolean;
  // The page cursor in force (so a form returns to the same page after it saves).
  cursor?: string | null;
  // The outcome of the last action, in plain words (the page maps `?notice=`).
  notice?: { readonly tone: NoticeTone; readonly text: string } | null;
  // Controls bound to the server actions the page passes. OPTIONAL: the view renders its
  // controls live regardless (they submit to these when supplied); the page always
  // supplies them, so in the running app every control acts — never a dead button.
  editAction?: MemoryAction;
  rescopeAction?: MemoryAction;
  deleteAction?: MemoryAction;
  addAction?: MemoryAction;
};

// The add and edit forms report "what to remember" left blank (or only spaces) before the
// round trip; the server refuses it too (memory/actions.ts trims before it validates).
const BLANK_COPY = "Type what to remember. A memory can't be blank.";
function checkNotBlank(event: React.FormEvent<HTMLTextAreaElement>) {
  const field = event.currentTarget;
  field.setCustomValidity(field.value.trim() === "" ? BLANK_COPY : "");
}

// The editable content field, shared by the add and edit forms (one source of truth).
// Pre-filled from `content` on edit, empty on add.
function ContentField({ content }: { content?: string }) {
  return (
    <TextareaField
      label="What to remember"
      name="content"
      required
      maxLength={20_000}
      rows={3}
      placeholder="A short fact, like a preference, a routine or a date"
      defaultValue={content ?? ""}
      onInput={checkNotBlank}
      onInvalid={checkNotBlank}
    />
  );
}

// The list state a form brings the person back to after it saves (the page validates it).
function ReturnState({ state }: { state: QueryState }) {
  return (
    <>
      {Object.entries(state).map(([name, value]) =>
        value ? <input key={name} type="hidden" name={`return_${name}`} value={value} /> : null,
      )}
    </>
  );
}

// A form needs a function action; in a prop-only render (a preview, a render test) with no
// action supplied, nothing is stored.
const noAction = async (_formData: FormData): Promise<void> => {};

// Who can read a memory, in the person's words (never the stored "kept" / "shared").
export function sharingLabel(memory: Pick<MemoryViewItem, "scope" | "sourceAgentName">): string {
  if (memory.scope === "shared") return "Shared with your agents";
  return memory.sourceAgentName ? `Private to ${memory.sourceAgentName}` : "Private";
}

// Edit and Delete are native disclosures (they work before hydration, and focus returns to
// their summary after a save), laid out so all three controls share one row: where the
// browser supports it, each <details> lets its summary sit in the row and its opened panel
// span the full width under the row. Elsewhere an opened disclosure takes the row's width.
const ROW_DISCLOSURE =
  "min-w-0 open:basis-full supports-[selector(::details-content)]:contents details-content:basis-full details-content:order-last not-open:details-content:hidden";
const DISCLOSURE_PANEL = "flex min-w-0 flex-col gap-3 rounded-card bg-surface-muted p-4";

// One memory, as a divider row: its content, its saved-at time and its "Saved by
// <agent> · <sharing>" label (a person-added memory labelled as saved by you), with live
// re-scope, edit and delete controls in one row. Each control submits to the server action
// the page passes, carrying this memory's id; Delete first asks for confirmation.
function MemoryRow({
  memory,
  state,
  editAction,
  rescopeAction,
  deleteAction,
}: {
  memory: MemoryViewItem;
  state: QueryState;
  editAction?: MemoryAction;
  rescopeAction?: MemoryAction;
  deleteAction?: MemoryAction;
}) {
  const savedBy = memory.sourceAgentName ?? "you";
  const targetScope: MemoryScope =
    memory.scope === "shared" ? "kept" : "shared";
  // The row's controls are described by the memory itself, so "Edit" or "Delete" in a
  // screen reader's list of controls says which memory it acts on (a11y-12).
  const contentId = React.useId();
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <p id={contentId} className="min-w-0 whitespace-pre-wrap text-fg [overflow-wrap:anywhere]">
        {memory.content}
      </p>
      <div className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-fg-muted">
          <span className="inline-flex min-w-0 items-center gap-1.5 [overflow-wrap:anywhere]">
            <Bot aria-hidden={true} className="h-4 w-4 shrink-0" />
            Saved by {savedBy} · {sharingLabel(memory)}
          </span>
          <time className="text-xs">{memory.savedAt}</time>
        </div>
        {memory.audience && (
          <p className="min-w-0 text-sm text-fg-muted [overflow-wrap:anywhere]">
            Agents that can read it:{" "}
            {memory.audience.length ? memory.audience.join(", ") : "none"}.{" "}
            <a href="/agents" className="font-medium text-fg underline underline-offset-4">
              Manage agent access
            </a>
          </p>
        )}
      </div>

      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <ActionForm action={rescopeAction ?? noAction}>
          <input type="hidden" name="id" value={memory.id} />
          <input type="hidden" name="scope" value={targetScope} />
          <ReturnState state={state} />
          <FormSubmit variant="secondary" size="sm" pendingLabel="Saving…" aria-describedby={contentId}>
            {memory.scope === "shared" ? (
              <>
                <Lock aria-hidden={true} className="h-4 w-4 shrink-0" />
                Make private
              </>
            ) : (
              <>
                <Share aria-hidden={true} className="h-4 w-4 shrink-0" />
                Share with my agents
              </>
            )}
          </FormSubmit>
        </ActionForm>

        <details className={ROW_DISCLOSURE}>
          <summary aria-describedby={contentId} className={`${buttonClasses({ variant: "secondary", size: "sm" })} list-none [&::-webkit-details-marker]:hidden`}>
            <Pencil aria-hidden={true} className="h-4 w-4 shrink-0" />
            Edit
          </summary>
          <ActionForm action={editAction ?? noAction} className={DISCLOSURE_PANEL}>
            <input type="hidden" name="id" value={memory.id} />
            <ReturnState state={state} />
            <PendingFormFields>
              <ContentField content={memory.content} />
            </PendingFormFields>
            <div className="flex flex-wrap items-center gap-2">
              <FormSubmit pendingLabel="Saving…">Save changes</FormSubmit>
            </div>
          </ActionForm>
        </details>

        <details className={ROW_DISCLOSURE}>
          <summary aria-describedby={contentId} className={`${buttonClasses({ variant: "danger", size: "sm" })} list-none [&::-webkit-details-marker]:hidden`}>
            <Trash2 aria-hidden={true} className="h-4 w-4 shrink-0" />
            Delete
          </summary>
          <div className={DISCLOSURE_PANEL}>
            <p className="text-sm text-fg">
              Delete this memory? Your agents will no longer be able to use it. This
              cannot be undone.
            </p>
            <ActionForm action={deleteAction ?? noAction}>
              <input type="hidden" name="id" value={memory.id} />
              <ReturnState state={state} />
              <FormSubmit variant="danger-solid" pendingLabel="Deleting…">
                <Trash2 aria-hidden={true} className="h-4 w-4 shrink-0" />
                Delete memory
              </FormSubmit>
            </ActionForm>
          </div>
        </details>
      </div>
    </div>
  );
}

// The sharing and saved-by filter rows, each a labelled set of same-page links that
// scrolls in one line on phones.
function FilterRow({
  label,
  name,
  param,
  options,
  current,
  state,
}: {
  label: string;
  name: string;
  param: "scope" | "source";
  options: readonly MemoryFilterOption[];
  current: string | null;
  state: QueryState;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
      <span className="shrink-0 text-sm font-medium text-fg-muted sm:w-20">{name}</span>
      <div className="min-w-0 flex-1">
        <FilterLinks
          label={label}
          variant="scroll"
          items={options.map((option) => ({
            label: option.label,
            href: hrefWith(PATH, state, { [param]: option.value ?? undefined }),
            active: option.value === current,
            ...(option.count !== undefined ? { count: option.count } : {}),
          }))}
        />
      </div>
    </div>
  );
}

// The filters in force as removable chips (each link drops only that filter).
function appliedFilters(
  state: QueryState,
  query: string | null | undefined,
  filters: MemoryFilterState | undefined,
): AppliedFilter[] {
  const applied: AppliedFilter[] = [];
  const labelOf = (options: readonly MemoryFilterOption[], value: string) =>
    options.find((option) => option.value === value)?.label ?? value;
  if (filters?.scope) {
    applied.push({
      label: `Sharing: ${labelOf(filters.scopeOptions, filters.scope)}`,
      removeHref: hrefWith(PATH, state, { scope: undefined }),
    });
  }
  if (filters?.source) {
    applied.push({
      label: `Saved by: ${labelOf(filters.sourceOptions, filters.source)}`,
      removeHref: hrefWith(PATH, state, { source: undefined }),
    });
  }
  if (query) {
    applied.push({
      label: `Search: “${query}”`,
      removeHref: hrefWith(PATH, state, { q: undefined }),
    });
  }
  return applied;
}

// "Showing 4 memories.", "2 memories match “seat” on this page."
function listStatus(count: number, query: string | null | undefined, paged: boolean): string {
  const memories = `${count} ${count === 1 ? "memory" : "memories"}`;
  const where = paged ? " on this page" : "";
  if (query) return `${memories} ${count === 1 ? "matches" : "match"} “${query}”${where}.`;
  return `Showing ${memories}${where}.`;
}

export function MemoryView({
  memories,
  query,
  filters,
  nextCursor,
  hasPreviousPage,
  cursor,
  notice,
  editAction,
  rescopeAction,
  deleteAction,
  addAction,
}: MemoryViewProps) {
  // The list state every same-page link keeps (never a page cursor or a one-off notice).
  const state: QueryState = {
    q: query ?? undefined,
    scope: filters?.scope ?? undefined,
    source: filters?.source ?? undefined,
  };
  // What a form returns to after it saves: the same filters, and the same page.
  const returnState: QueryState = { ...state, cursor: cursor ?? undefined };
  const applied = appliedFilters(state, query, filters);
  const groups = DATE_GROUPS.map((group) => ({
    ...group,
    items: memories.filter((memory) => memory.dateGroup === group.key),
  })).filter((group) => group.items.length > 0);
  // Nothing saved at all (not just nothing matching): searching and filtering would be dead
  // controls around an empty list, so they wait until there is a memory.
  const firstRun = memories.length === 0 && applied.length === 0 && !hasPreviousPage;
  const paged = Boolean(nextCursor || hasPreviousPage);

  return (
    <>
      <WorkspaceHeading
        title="Memory"
        description="What your agents remember about you. Shared memories can be read by every agent you let read memory; private ones stay with the agent that saved them."
      />
      {notice ? <PageNotice tone={notice.tone}>{notice.text}</PageNotice> : null}

      {/* ----- Add your own memory (offered even with no memories) ----- */}
      <details id="add-memory" className="wh-panel group">
        <summary className="wh-panel-header flex min-h-11 cursor-pointer list-none items-center gap-3 border-b-0! [&::-webkit-details-marker]:hidden">
          <span className="wh-panel-title">
            <span className="flex items-center gap-2 font-semibold text-fg">
              <Plus aria-hidden={true} className="h-4 w-4 shrink-0" />
              Add a memory
            </span>
          </span>
          <ChevronDown aria-hidden={true} className="h-4 w-4 shrink-0 text-fg-muted transition-transform group-open:rotate-180" />
        </summary>
        <div className="wh-panel-body border-t border-line">
          <ActionForm action={addAction ?? noAction} className="flex max-w-prose flex-col gap-4">
            <ReturnState state={returnState} />
            <PendingFormFields>
              <ContentField />
              <SelectField label="Who can read it" name="scope" defaultValue="shared" width="text">
                <option value="shared">Shared with your agents</option>
                <option value="kept">Private: no agent can read it</option>
              </SelectField>
            </PendingFormFields>
            <div className="flex flex-wrap items-center gap-2">
              <FormSubmit pendingLabel="Adding…">
                <Plus aria-hidden={true} className="h-4 w-4 shrink-0" />
                Add memory
              </FormSubmit>
            </div>
          </ActionForm>
        </div>
      </details>

      {firstRun ? null : (
        <ListToolbar
          label="Find memories"
          filters={
            filters ? (
              <div className="flex min-w-0 flex-col gap-3">
                <FilterRow
                  label="Filter by sharing"
                  name="Sharing"
                  param="scope"
                  options={filters.scopeOptions}
                  current={filters.scope}
                  state={state}
                />
                <FilterRow
                  label="Filter by who saved it"
                  name="Saved by"
                  param="source"
                  options={filters.sourceOptions}
                  current={filters.source}
                  state={state}
                />
              </div>
            ) : null
          }
          search={
            /* A GET the loader reads; it keeps the filters. */
            <form method="get" className="flex flex-col gap-2 sm:flex-row sm:items-end">
              {filters?.scope ? <input type="hidden" name="scope" value={filters.scope} /> : null}
              {filters?.source ? <input type="hidden" name="source" value={filters.source} /> : null}
              <div className="flex min-w-0 flex-1 flex-col gap-2">
                <label htmlFor="memory-search" className="text-sm font-medium text-fg">
                  Search
                </label>
                <Input
                  id="memory-search"
                  type="search"
                  name="q"
                  defaultValue={query ?? ""}
                  placeholder="Search your memories"
                />
              </div>
              <Button variant="secondary" type="submit">
                Search
              </Button>
            </form>
          }
          applied={<ActiveFilters filters={applied} clearHref={PATH} />}
          status={memories.length > 0 ? listStatus(memories.length, query, paged) : undefined}
        />
      )}

      {/* ----- The memories, under date headings ----- */}
      {memories.length === 0 ? (
        applied.length > 0 ? (
          <EmptyState
            heading="No memories match"
            description="Nothing on this page matches the search and filters you chose."
            action={
              <ButtonLink href={PATH} variant="secondary">
                Clear filters
              </ButtonLink>
            }
          />
        ) : (
          <EmptyState
            heading="No memories yet"
            description="When an agent saves something about you, it appears here with who saved it and who can read it. You can add your own above."
          />
        )
      ) : (
        groups.map((group) => (
          <ListGroup
            key={group.key}
            id={`memories-${group.key}`}
            title={group.title}
            count={group.items.length}
          >
            {group.items.map((memory) => (
              <li key={memory.id} className={`${LIST_ROW} py-4`}>
                <MemoryRow
                  memory={memory}
                  state={returnState}
                  editAction={editAction}
                  rescopeAction={rescopeAction}
                  deleteAction={deleteAction}
                />
              </li>
            ))}
          </ListGroup>
        ))
      )}
      {paged && (
        <nav aria-label="Memory pages" className="wh-form-actions">
          <div className="wh-form-actions-buttons">
            {hasPreviousPage && (
              <ButtonLink href={hrefWith(PATH, state)} variant="secondary" size="sm">
                First page
              </ButtonLink>
            )}
            {nextCursor && (
              <ButtonLink href={hrefWith(PATH, state, { cursor: nextCursor })} variant="secondary" size="sm">
                {query ? "Search older memories" : "Older memories"}
              </ButtonLink>
            )}
          </div>
          {query && nextCursor && (
            <p>Search continues on the next page, even if this page has no matches.</p>
          )}
        </nav>
      )}
    </>
  );
}

export default MemoryView;
