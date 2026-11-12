import { auditedOwnerChange } from "@/server/activity/owner-change";
import { countMemoryFacets, pageMemories, type MemoryListFilters } from "../../../../server/db/memories";
import { withTransaction } from "../../../../server/db/index";
import { createRedactingRecorder } from "../../../../server/mcp/recorder";
import { formatAccountTime } from "@/server/display-time";
import { timeZoneFor } from "@/server/spending/time-zone";
// E13-S11 — Memory page loader + actions (the injectable, unit-testable seam the
// thin `page.tsx` composes — the convention's `createXActions(deps)` factory, as
// `skills/actions.ts`, `vault/actions.ts`, `connectors/actions.ts` and
// `agents/actions.ts` do). A Next entry file may export only its framework fields,
// so the memory-triad logic lives here and the entry stays thin (OBS-025).
//
// The memory triad is the "Skills, preferences and shared memory" surface (brief
// §"Skills, preferences and shared memory"; design §4.1). `load` reads the SESSION
// person's memories server-side — each content DECRYPTED under their own DEK, each
// source agent resolved to a DISPLAY NAME and each saved time formatted to a LABEL —
// and shapes them into the props the already-render-tested <MemoryView/> (E13-S10)
// is mounted over. The actions add the person's OWN memory and edit / re-scope /
// delete any of the person's memories.
//
// Security (each a reviewer veto; CLAUDE.md + the safety invariants):
//   • Every read/write is member-scoped by `session.userId` — the session's verified
//     id, NEVER a userId smuggled in the input. `load` reads only the session person;
//     every mutation is scoped `WHERE … AND user_id = $N` (or refused up front when
//     the row is not theirs), so another person's memory is never read, changed or
//     removed by id (a safe refusal, never a silent write, never a raw 500).
//   • Input is validated at the boundary (INV-102): a malformed / oversized / unknown
//     shape is refused with a 4xx `HttpError` BEFORE any query, so nothing is written.
//     A malformed memory id is rejected at the boundary (OBS-049) before it can reach
//     `WHERE id = $1` as a cast. Every value reaches storage bound as a query
//     parameter (and the content is additionally DEK-encrypted first), so a value
//     shaped like SQL is stored as data and cannot alter a query.
//   • This module reads no `process.env` and holds no secret (INV-103): the db, the
//     KeyWrapper and the Clock are INJECTED seams, so no ambient env value can surface
//     in the loaded screen or a stored row.

import { z } from "zod";

import { parseParams } from "@/server/http/validate";
import type { Db } from "@/server/db/index";
import { getUserById } from "@/server/db/users";
import { listAgentsForUser } from "@/server/db/agents";
import {
  createMemory as createMemoryRow,
  editMemory as editMemoryRow,
  rescopeMemory as rescopeMemoryRow,
  deleteMemory as deleteMemoryRow,
  type MemoryScope,
} from "@/server/db/memories";
import { type MemoryPageItem } from "@/server/memory/page-data";
import type { KeyWrapper } from "@/server/crypto/key-wrapper";
import type { Clock } from "@/server/seams/clock";
import type { Session } from "@/server/auth/session";
import type {
  MemoryDateGroup,
  MemoryFilterOption,
  MemoryFilterState,
} from "@/components/memory/memory-view";

// The injected seams — no process.env, no secret (INV-103). `db` is the
// parameterizing database seam; `keyWrapper` unwraps the session person's own DEK
// (from users.wrapped_dek) so a memory's content can be decrypted and encrypted; the
// `clock` stamps a newly added memory's saved time (never SQL now()).
export interface MemoryActionsDeps {
  readonly db: Db;
  readonly keyWrapper: KeyWrapper;
  readonly clock: Clock;
}

// One memory shaped for the view: its id, its decrypted content, a PRE-FORMATTED
// saved-at label, the saving agent's DISPLAY NAME (null when the PERSON added it), its
// scope and the date heading it sits under (computed in the account time zone). This IS
// the shape <MemoryView/> is mounted over — the loader output is the view's input.
export interface MemoryViewItem {
  readonly id: string;
  readonly content: string;
  readonly savedAt: string;
  readonly sourceAgentName: string | null;
  readonly scope: MemoryScope;
  readonly dateGroup: MemoryDateGroup;
}

// What `load` returns — the owner's memories shaped for the view, the search term echoed
// back so the search box stays prefilled (null when no active search), and the validated
// filters with the options (and counts) the filter links offer.
export interface MemoryPageData {
  readonly memories: MemoryViewItem[];
  readonly query: string | null;
  readonly nextCursor?: string | null;
  readonly filters: MemoryFilterState;
}

// The raw `?scope=` / `?source=` values from the URL. Untrusted: `load` keeps a scope only
// when it is a known scope, and a source only when it is "you" or one of the session
// person's OWN agents; anything else is ignored.
export interface MemoryFilterInput {
  readonly scope?: string;
  readonly source?: string;
}

// Every mutation reports its outcome — success, or a refusal naming its reason (the
// row is not this person's). Never a silent success (conventions: a server action
// reports success, the refusal reason, or a 4xx).
export type ActionResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

// Add the PERSON's OWN memory (no source agent): its content and scope.
export interface AddMemoryInput {
  readonly content: string;
  readonly scope: MemoryScope;
}

// Edit replaces an owned memory's content in place.
export interface EditMemoryInput {
  readonly id: string;
  readonly content: string;
}

// Re-scope flips an owned memory's scope (kept ⇄ shared).
export interface RescopeMemoryInput {
  readonly id: string;
  readonly scope: MemoryScope;
}

// Delete takes only the id of the owned memory to remove.
export interface DeleteMemoryInput {
  readonly id: string;
}

export interface MemoryActions {
  load(
    session: Session,
    query?: string,
    cursor?: string,
    filters?: MemoryFilterInput,
  ): Promise<MemoryPageData>;
  addMemory(session: Session, input: AddMemoryInput): Promise<ActionResult>;
  editMemory(session: Session, input: EditMemoryInput): Promise<ActionResult>;
  rescopeMemory(
    session: Session,
    input: RescopeMemoryInput,
  ): Promise<ActionResult>;
  deleteMemory(
    session: Session,
    input: DeleteMemoryInput,
  ): Promise<ActionResult>;
}

// ---- boundary validation shapes (INV-102) -----------------------------------------
//
// A memory id is a uuid (memories.id — randomUUID()), shape-guarded so a non-uuid (a
// bare integer, a negative, a decimal, "", whitespace, a SQL-shaped id) never reaches
// `WHERE id = $1` as a cast (OBS-049). The scope is the store's enum; a value outside
// it is refused. Content is a short fact or note — bounded free text; a grossly
// oversized one is rejected before any write. A missing or non-string field fails the
// boundary.
const CONTENT_MAX = 20_000;

const memoryIdSchema = z.uuid();
const scopeSchema = z.enum(["kept", "shared"]);
// Trimmed before it is checked, so content of only spaces is refused like empty content
// and never saved as a blank memory an agent would read (interaction-02).
const contentSchema = z.string().trim().min(1).max(CONTENT_MAX);

const addMemorySchema = z.object({
  content: contentSchema,
  scope: scopeSchema,
});
const editMemorySchema = z.object({
  id: memoryIdSchema,
  content: contentSchema,
});
const rescopeMemorySchema = z.object({
  id: memoryIdSchema,
  scope: scopeSchema,
});
const deleteMemorySchema = z.object({ id: memoryIdSchema });

// The date heading a memory sits under: its calendar day in the account time zone
// compared with today's there — "today", the six days before ("week", shown as "This
// week") or "earlier". A saved time ahead of now (clock skew) counts as today.
export function memoryDateGroup(savedAt: Date, now: Date, timeZone: string): MemoryDateGroup {
  const days = localDayNumber(now, timeZone) - localDayNumber(savedAt, timeZone);
  if (days <= 0) return "today";
  if (days < 7) return "week";
  return "earlier";
}

// Whole days since the epoch for the calendar date `instant` falls on in `timeZone`.
function localDayNumber(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const part = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return Date.UTC(part("year"), part("month") - 1, part("day")) / 86_400_000;
}

// The sharing filter in the person's words: a "kept" memory is private to the agent that
// saved it (or to no agent, when the person added it).
const SCOPE_LABELS: Record<MemoryScope, string> = { shared: "Shared", kept: "Private" };

export function createMemoryActions(deps: MemoryActionsDeps): MemoryActions {
  const { db, keyWrapper, clock } = deps;

  // Resolve the session person's unwrapped 256-bit DEK: read their wrapped DEK (bound
  // by userId) and unwrap it through the injected KeyWrapper. Throws when the person
  // has no row (never fails silently) — the page-data idiom shared with the siblings.
  async function dataKeyFor(userId: string): Promise<Uint8Array> {
    const user = await getUserById(db, userId);
    if (!user) {
      throw new Error("createMemoryActions: no data key for this user");
    }
    return keyWrapper.unwrap(user.wrappedDek);
  }

  // Whether this person owns the memory with this id (member-scoped: id AND user_id
  // bound). Used to refuse a cross-user edit / re-scope up front rather than letting
  // the store throw — so the refusal is a reported { ok: false }, never a raw 500.
  async function ownsMemory(userId: string, id: string): Promise<boolean> {
    const result = await db.query(
      "SELECT id FROM memories WHERE id = $1 AND user_id = $2",
      [id, userId],
    );
    return result.rows.length > 0;
  }

  // Shape one owner-scoped memory for the view: resolve its source agent id to the
  // owner's agent display name (null when the person added it, or when the id is not
  // one of this person's agents), and format its saved time to a label.
  function toViewItem(
    m: MemoryPageItem,
    agentNameById: ReadonlyMap<string, string>,
    timeZone: string,
    now: Date,
  ): MemoryViewItem {
    return {
      id: m.id,
      content: m.content,
      savedAt: formatAccountTime(m.createdAt, timeZone, { dateOnly: true }),
      sourceAgentName:
        m.sourceAgentId != null
          ? (agentNameById.get(m.sourceAgentId) ?? null)
          : null,
      scope: m.scope,
      dateGroup: memoryDateGroup(m.createdAt, now, timeZone),
    };
  }

  // Read ONLY the session person's memories (member-scoped by `session.userId`),
  // decrypted under their own DEK, each source agent resolved to a display name and
  // each saved time formatted — the props <MemoryView/> is mounted over. An optional
  // non-empty `query` filters to the matching memories (within the owner set, matched
  // over the decrypted content in the app) and is echoed back. Another person's
  // memory never appears.
  async function load(
    session: Session,
    query?: string,
    cursor?: string,
    filterInput?: MemoryFilterInput,
  ): Promise<MemoryPageData> {
    const dek = await dataKeyFor(session.userId);
    const timeZone = await timeZoneFor(db, session.userId, dek);
    const hasQuery = typeof query === "string" && query.trim().length > 0;

    // Resolve source agent ids to display names from the person's OWN agents only
    // (member-scoped), in one read rather than per memory. The same list validates the
    // saved-by filter: an id that is not one of this person's agents is ignored.
    const agents = await listAgentsForUser(db, session.userId);
    const agentNameById = new Map(agents.map((a) => [a.id, a.displayName]));
    const scope: MemoryScope | null =
      filterInput?.scope === "kept" || filterInput?.scope === "shared" ? filterInput.scope : null;
    const source: string | null =
      filterInput?.source === "you" || (filterInput?.source !== undefined && agentNameById.has(filterInput.source))
        ? filterInput.source
        : null;
    const filters: MemoryListFilters = {
      ...(scope ? { scope } : {}),
      ...(source === "you"
        ? { source: { kind: "person" as const } }
        : source
          ? { source: { kind: "agent" as const, agentId: source } }
          : {}),
    };

    const page = await pageMemories(db, session.userId, dek, {
      cursor,
      limit: hasQuery ? 200 : 50,
      ...filters,
    });
    const items = hasQuery
      ? page.items.filter((m) =>
          m.content.toLowerCase().includes(query!.toLowerCase()),
        )
      : page.items;

    const active = (
      await db.query(
        "SELECT a.id, a.display_name FROM agents a JOIN agent_permissions p ON p.user_id = a.user_id AND p.connection_id = a.connection_id WHERE a.user_id = $1 AND a.status = 'connected' AND p.memory_read = true",
        [session.userId],
      )
    ).rows;
    const overrides = (
      await db.query(
        "SELECT memory_id, agent_id, allowed FROM agent_memory_access WHERE user_id = $1 AND memory_id = ANY($2::uuid[])",
        [session.userId, items.map((m) => m.id)],
      )
    ).rows;
    const now = clock.now();
    return {
      memories: items.map((m) => ({
        ...toViewItem(m, agentNameById, timeZone, now),
        audience: active
          .filter((a) => {
            const override = overrides.find(
              (o) => o.memory_id === m.id && o.agent_id === a.id,
            );
            return override
              ? override.allowed
              : m.scope === "shared" || m.sourceAgentId === a.id;
          })
          .map((a) => String(a.display_name)),
      })),
      query: hasQuery ? query : null,
      nextCursor: page.nextCursor,
      filters: await filterState(session.userId, scope, source, filters, agents, hasQuery),
    };
  }

  // The filter links' options: every scope, then "You" and each of the person's OWN
  // agents that saved something under the chosen scope (or is the chosen source). Counts
  // come from metadata only and are left off while a search narrows the list, since the
  // search runs over decrypted content and the counts could not match it.
  async function filterState(
    userId: string,
    scope: MemoryScope | null,
    source: string | null,
    filters: MemoryListFilters,
    agents: ReadonlyArray<{ id: string; displayName: string }>,
    hasQuery: boolean,
  ): Promise<MemoryFilterState> {
    const facets = await countMemoryFacets(db, userId, filters);
    const counted = (count: number) => (hasQuery ? {} : { count });
    const scopeTotal = facets.scope.kept + facets.scope.shared;
    const sourceTotal =
      facets.source.person + [...facets.source.agents.values()].reduce((sum, n) => sum + n, 0);
    const scopeOptions: MemoryFilterOption[] = [
      { value: null, label: "All", ...counted(scopeTotal) },
      ...(["shared", "kept"] as const).map((key) => ({
        value: key,
        label: SCOPE_LABELS[key],
        ...counted(facets.scope[key]),
      })),
    ];
    const sourceOptions: MemoryFilterOption[] = [
      { value: null, label: "Anyone", ...counted(sourceTotal) },
      { value: "you", label: "You", ...counted(facets.source.person) },
      ...[...agents]
        .filter((a) => (facets.source.agents.get(a.id) ?? 0) > 0 || a.id === source)
        .sort((a, b) => a.displayName.localeCompare(b.displayName))
        .map((a) => ({ value: a.id, label: a.displayName, ...counted(facets.source.agents.get(a.id) ?? 0) })),
    ];
    return { scope, source, scopeOptions, sourceOptions };
  }

  // Add the session person's OWN memory (no source agent). Validate at the boundary
  // first (a 4xx before any write); the owner is the session's id, so a userId
  // smuggled in the input is ignored. The content is DEK-encrypted by the store before
  // it is bound as a parameter.
  async function addMemory(
    session: Session,
    input: AddMemoryInput,
  ): Promise<ActionResult> {
    const valid = parseParams(addMemorySchema, input);
    const dek = await dataKeyFor(session.userId);
    await auditedOwnerChange(deps, session.userId, async (tx, record) => {
    const memory = await createMemoryRow(
      tx,
      {
        userId: session.userId,
        content: valid.content,
        sourceAgentId: null,
        scope: valid.scope,
      },
      dek,
      clock,
    );
    await record("memory_created", { memoryId: memory.id, scope: valid.scope });
    });
    return { ok: true };
  }

  // Replace an OWNED memory's content in place. Validate at the boundary first (a
  // malformed id or content is a 4xx before any query); a memory that is not this
  // person's is refused and left unchanged.
  async function editMemory(
    session: Session,
    input: EditMemoryInput,
  ): Promise<ActionResult> {
    const valid = parseParams(editMemorySchema, input);
    if (!(await ownsMemory(session.userId, valid.id))) {
      return { ok: false, reason: "not_found" };
    }
    const dek = await dataKeyFor(session.userId);
    await auditedOwnerChange(deps, session.userId, async (tx, record) => {
      await editMemoryRow(tx, session.userId, valid.id, valid.content, dek);
      await record("memory_updated", { memoryId: valid.id, contentChanged: true });
    });
    return { ok: true };
  }

  // Change an OWNED memory's scope (kept ⇄ shared). Validate at the boundary first (a
  // malformed id or unknown scope is a 4xx before any query); a memory that is not
  // this person's is refused and left unchanged.
  async function rescopeMemory(
    session: Session,
    input: RescopeMemoryInput,
  ): Promise<ActionResult> {
    const valid = parseParams(rescopeMemorySchema, input);
    if (!(await ownsMemory(session.userId, valid.id))) {
      return { ok: false, reason: "not_found" };
    }
    const dek = await dataKeyFor(session.userId);
    await withTransaction(db, async (tx) => {
      await rescopeMemoryRow(tx, session.userId, valid.id, valid.scope);
      await createRedactingRecorder({
        db: tx,
        clock,
        dekFor: async () => dek,
      }).record({
        userId: session.userId,
        kind: "memory_scope_change",
        source: "warthog",
        outcome: "saved",
        payload: {
          memoryId: valid.id,
          scope: valid.scope,
          replacedAgentOverrides: true,
        },
      });
    });
    return { ok: true };
  }

  // Delete an OWNED memory. Validate the id at the boundary (a 4xx before any query),
  // then delete member-scoped (id AND user_id bound): a memory that is not this
  // person's removes nothing and is a safe no-op refusal.
  async function deleteMemory(
    session: Session,
    input: DeleteMemoryInput,
  ): Promise<ActionResult> {
    const valid = parseParams(deleteMemorySchema, input);
    const removed = await auditedOwnerChange(deps, session.userId, async (tx, record) => {
      const deleted = await deleteMemoryRow(tx, session.userId, valid.id);
      if (deleted) await record("memory_deleted", { memoryId: valid.id });
      return deleted;
    });
    return removed ? { ok: true } : { ok: false, reason: "not_found" };
  }

  return { load, addMemory, editMemory, rescopeMemory, deleteMemory };
}
