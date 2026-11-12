"use client";

import * as React from "react";
import { WorkspaceHeading } from "@/components/shell/workspace-surfaces";
import { Bot, Lock, Pencil, Plus, Save, Share, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/field";
import { EmptyState } from "@/components/ui/empty";
import { ActiveFilters, FilterLinks, type AppliedFilter } from "@/components/ui/filter-links";
import { ListGroup, LIST_ROW } from "@/components/ui/list-group";
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
// time zone (Today / This week / Earlier). Scope and saved-by filter links, removable
// applied-filter chips and the page links are plain same-page links built with
// `hrefWith`, so every filter survives paging, reloads and Back/Forward. Delete asks for
// confirmation in a disclosure before it submits.

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
  // Controls bound to the server actions the page passes. OPTIONAL: the view renders its
  // controls live regardless (they submit to these when supplied); the page always
  // supplies them, so in the running app every control acts — never a dead button.
  editAction?: MemoryAction;
  rescopeAction?: MemoryAction;
  deleteAction?: MemoryAction;
  addAction?: MemoryAction;
};

// A multi-line / select control styled on the same tokens as the shared Input primitive
// (token colour / border / focus) — no raw colour.
const CONTROL_BASE =
  "w-full rounded-card border border-line bg-surface px-3 py-2 text-sm text-fg placeholder:text-fg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-bg";

// A disclosure summary that reads as a quiet control (Edit, Delete, Add a memory).
const SUMMARY_CLASS =
  "inline-flex min-h-11 w-fit cursor-pointer items-center gap-2 rounded-card text-sm font-medium text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus";
const PAGE_LINK = "inline-flex min-h-11 items-center text-accent underline";

// The editable content field, shared by the add and edit forms (one source of truth).
// Pre-filled from `content` on edit, empty on add.
function ContentField({ content }: { content?: string }) {
  const id = React.useId();
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>What to remember</Label>
      <textarea
        id={id}
        name="content"
        required
        maxLength={20_000}
        rows={3}
        className={`${CONTROL_BASE} min-h-20`}
        placeholder="A short fact or note"
        defaultValue={content ?? ""}
      />
    </div>
  );
}

// One memory, as a divider row: its content, its saved-at time and its "Saved by
// <agent> · shared / · kept" label (a person-added memory labelled as saved by you), with
// live re-scope, edit and delete controls. Each control submits to the server action the
// page passes, carrying this memory's id; Delete first asks for confirmation.
function MemoryRow({
  memory,
  editAction,
  rescopeAction,
  deleteAction,
}: {
  memory: MemoryViewItem;
  editAction?: MemoryAction;
  rescopeAction?: MemoryAction;
  deleteAction?: MemoryAction;
}) {
  const savedBy = memory.sourceAgentName ?? "you";
  const targetScope: MemoryScope =
    memory.scope === "shared" ? "kept" : "shared";
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <p className="min-w-0 whitespace-pre-wrap text-fg [overflow-wrap:anywhere]">
        {memory.content}
      </p>
      {memory.audience && (
        <p className="min-w-0 text-sm text-fg-muted [overflow-wrap:anywhere]">
          Available to:{" "}
          {memory.audience.length ? memory.audience.join(", ") : "no agents"}.{" "}
          <a href="/agents" className="text-accent underline">
            Manage agent access
          </a>
        </p>
      )}

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-fg-muted">
        <span className="inline-flex min-w-0 items-center gap-1.5 [overflow-wrap:anywhere]">
          <Bot aria-hidden={true} className="h-4 w-4 shrink-0" />
          Saved by {savedBy} · default: {memory.scope}
        </span>
        <time className="text-xs">{memory.savedAt}</time>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <form action={rescopeAction}>
          <input type="hidden" name="id" value={memory.id} />
          <input type="hidden" name="scope" value={targetScope} />
          <Button variant="secondary" type="submit">
            {memory.scope === "shared" ? (
              <>
                <Lock aria-hidden={true} className="h-4 w-4 shrink-0" />
                Change to kept
              </>
            ) : (
              <>
                <Share aria-hidden={true} className="h-4 w-4 shrink-0" />
                Change to shared
              </>
            )}
          </Button>
        </form>
      </div>

      <details className="flex flex-col gap-3">
        <summary className={SUMMARY_CLASS}>
          <Pencil aria-hidden={true} className="h-4 w-4 shrink-0" />
          Edit
        </summary>
        <form action={editAction} className="flex flex-col gap-3">
          <input type="hidden" name="id" value={memory.id} />
          <ContentField content={memory.content} />
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="secondary" type="submit">
              <Save aria-hidden={true} className="h-4 w-4 shrink-0" />
              Save
            </Button>
          </div>
        </form>
      </details>

      <details className="flex flex-col gap-3">
        <summary className={SUMMARY_CLASS}>
          <Trash2 aria-hidden={true} className="h-4 w-4 shrink-0" />
          Delete
        </summary>
        <p className="my-2 text-sm text-fg-muted">
          Delete this memory? Your agents will no longer be able to use it. This
          cannot be undone.
        </p>
        <form action={deleteAction}>
          <input type="hidden" name="id" value={memory.id} />
          <Button variant="secondary" type="submit">
            <Trash2 aria-hidden={true} className="h-4 w-4 shrink-0" />
            Delete memory
          </Button>
        </form>
      </details>
    </div>
  );
}

// The scope and saved-by filter rows, each a labelled set of same-page links.
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
    <div className="flex min-w-0 flex-wrap items-center gap-x-3">
      <span className="text-sm text-fg-muted">{name}</span>
      <FilterLinks
        label={label}
        items={options.map((option) => ({
          label: option.label,
          href: hrefWith(PATH, state, { [param]: option.value ?? undefined }),
          active: option.value === current,
          ...(option.count !== undefined ? { count: option.count } : {}),
        }))}
      />
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
      label: `Scope: ${labelOf(filters.scopeOptions, filters.scope)}`,
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

export function MemoryView({
  memories,
  query,
  filters,
  nextCursor,
  hasPreviousPage,
  editAction,
  rescopeAction,
  deleteAction,
  addAction,
}: MemoryViewProps) {
  const scopeId = React.useId();
  // The list state every same-page link keeps (never a page cursor or a one-off notice).
  const state: QueryState = {
    q: query ?? undefined,
    scope: filters?.scope ?? undefined,
    source: filters?.source ?? undefined,
  };
  const applied = appliedFilters(state, query, filters);
  const groups = DATE_GROUPS.map((group) => ({
    ...group,
    items: memories.filter((memory) => memory.dateGroup === group.key),
  })).filter((group) => group.items.length > 0);

  return (
    <section className="flex flex-col gap-8">
      <WorkspaceHeading eyebrow="Account resources" title="Memory" description="What your agents remember about you, and who each memory is shared with." />

      {/* ----- Add your own memory (offered even with no memories) ----- */}
      <details className="flex flex-col gap-3 wh-card rounded-card border border-line bg-surface p-4">
        <summary className={SUMMARY_CLASS}>
          <Plus aria-hidden={true} className="h-4 w-4 shrink-0" />
          Add a memory
        </summary>
        <form action={addAction} className="flex flex-col gap-3">
          <ContentField />
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={scopeId}>Who can see it</Label>
            <select
              id={scopeId}
              name="scope"
              className={`${CONTROL_BASE} min-h-11`}
              defaultValue="shared"
            >
              <option value="shared">Shared with your other agents</option>
              <option value="kept">Kept to this memory only</option>
            </select>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="primary" type="submit">
              <Plus aria-hidden={true} className="h-4 w-4 shrink-0" />
              Add memory
            </Button>
          </div>
        </form>
      </details>

      <div className="flex flex-col gap-2">
        {/* ----- Search over the memories (a GET the loader reads; keeps the filters) ----- */}
        <form
          method="get"
          className="flex flex-col gap-2 sm:flex-row sm:items-end"
        >
          {filters?.scope ? <input type="hidden" name="scope" value={filters.scope} /> : null}
          {filters?.source ? <input type="hidden" name="source" value={filters.source} /> : null}
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <Label htmlFor="memory-search">Search</Label>
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

        {filters ? (
          <>
            <FilterRow
              label="Filter by scope"
              name="Scope"
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
          </>
        ) : null}
        <ActiveFilters filters={applied} clearHref={PATH} />
      </div>

      {/* ----- The memories, under date headings ----- */}
      {memories.length === 0 ? (
        applied.length > 0 ? (
          <EmptyState
            heading="No memories match"
            description="Nothing on this page matches the search and filters you chose."
            action={
              <a href={PATH} className={PAGE_LINK}>
                Clear filters
              </a>
            }
          />
        ) : (
          <EmptyState
            heading="No memories yet"
            description="Memories your agents save about you will appear here, each labelled by who saved it."
          />
        )
      ) : (
        <div className="flex flex-col gap-6">
          {groups.map((group) => (
            <ListGroup
              key={group.key}
              id={`memories-${group.key}`}
              title={group.title}
              count={group.items.length}
            >
              {group.items.map((memory) => (
                <li key={memory.id} className={LIST_ROW}>
                  <MemoryRow
                    memory={memory}
                    editAction={editAction}
                    rescopeAction={rescopeAction}
                    deleteAction={deleteAction}
                  />
                </li>
              ))}
            </ListGroup>
          ))}
        </div>
      )}
      {(nextCursor || hasPreviousPage) && (
        <nav
          aria-label="Memory pages"
          className="flex flex-wrap items-center gap-4 text-sm"
        >
          {hasPreviousPage && (
            <a className={PAGE_LINK} href={hrefWith(PATH, state)}>
              First page
            </a>
          )}
          {nextCursor && (
            <a className={PAGE_LINK} href={hrefWith(PATH, state, { cursor: nextCursor })}>
              {query ? "Search older memories" : "Older memories"}
            </a>
          )}
          {query && nextCursor && (
            <span className="text-fg-muted">
              Search continues on the next page, even if this page has no
              matches.
            </span>
          )}
        </nav>
      )}
    </section>
  );
}

export default MemoryView;
