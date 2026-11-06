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
import { memoriesPageData, searchMemories, type MemoryPageItem } from "@/server/memory/page-data";
import type { KeyWrapper } from "@/server/crypto/key-wrapper";
import type { Clock } from "@/server/seams/clock";
import type { Session } from "@/server/auth/session";

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
// saved-at label, the saving agent's DISPLAY NAME (null when the PERSON added it) and
// its scope. This IS the shape <MemoryView/> is mounted over — the loader output is
// the view's input.
export interface MemoryViewItem {
  readonly id: string;
  readonly content: string;
  readonly savedAt: string;
  readonly sourceAgentName: string | null;
  readonly scope: MemoryScope;
}

// What `load` returns — the owner's memories shaped for the view, plus the search term
// echoed back so the search box stays prefilled (null when no active search).
export interface MemoryPageData {
  readonly memories: MemoryViewItem[];
  readonly query: string | null;
}

// Every mutation reports its outcome — success, or a refusal naming its reason (the
// row is not this person's). Never a silent success (conventions: a server action
// reports success, the refusal reason, or a 4xx).
export type ActionResult = { readonly ok: true } | { readonly ok: false; readonly reason: string };

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
  load(session: Session, query?: string): Promise<MemoryPageData>;
  addMemory(session: Session, input: AddMemoryInput): Promise<ActionResult>;
  editMemory(session: Session, input: EditMemoryInput): Promise<ActionResult>;
  rescopeMemory(session: Session, input: RescopeMemoryInput): Promise<ActionResult>;
  deleteMemory(session: Session, input: DeleteMemoryInput): Promise<ActionResult>;
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
const contentSchema = z.string().min(1).max(CONTENT_MAX);

const addMemorySchema = z.object({ content: contentSchema, scope: scopeSchema });
const editMemorySchema = z.object({ id: memoryIdSchema, content: contentSchema });
const rescopeMemorySchema = z.object({ id: memoryIdSchema, scope: scopeSchema });
const deleteMemorySchema = z.object({ id: memoryIdSchema });

// A stored instant → an absolute, readable date label (the view renders it verbatim
// and reaches for no clock of its own). Shown in UTC so seeded dates are deterministic.
function formatSavedAt(value: Date | string): string {
  return new Date(value).toLocaleDateString("en-AU", {
    timeZone: "UTC",
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

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
    const result = await db.query("SELECT id FROM memories WHERE id = $1 AND user_id = $2", [id, userId]);
    return result.rows.length > 0;
  }

  // Shape one owner-scoped memory for the view: resolve its source agent id to the
  // owner's agent display name (null when the person added it, or when the id is not
  // one of this person's agents), and format its saved time to a label.
  function toViewItem(m: MemoryPageItem, agentNameById: ReadonlyMap<string, string>): MemoryViewItem {
    return {
      id: m.id,
      content: m.content,
      savedAt: formatSavedAt(m.createdAt),
      sourceAgentName: m.sourceAgentId != null ? (agentNameById.get(m.sourceAgentId) ?? null) : null,
      scope: m.scope,
    };
  }

  // Read ONLY the session person's memories (member-scoped by `session.userId`),
  // decrypted under their own DEK, each source agent resolved to a display name and
  // each saved time formatted — the props <MemoryView/> is mounted over. An optional
  // non-empty `query` filters to the matching memories (within the owner set, matched
  // over the decrypted content in the app) and is echoed back. Another person's
  // memory never appears.
  async function load(session: Session, query?: string): Promise<MemoryPageData> {
    const dek = await dataKeyFor(session.userId);
    const hasQuery = typeof query === "string" && query.trim().length > 0;
    const items = hasQuery
      ? await searchMemories(db, session.userId, dek, query)
      : await memoriesPageData(db, session.userId, dek);

    // Resolve source agent ids to display names from the person's OWN agents only
    // (member-scoped), in one read rather than per memory.
    const agents = await listAgentsForUser(db, session.userId);
    const agentNameById = new Map(agents.map((a) => [a.id, a.displayName]));

    return {
      memories: items.map((m) => toViewItem(m, agentNameById)),
      query: hasQuery ? query : null,
    };
  }

  // Add the session person's OWN memory (no source agent). Validate at the boundary
  // first (a 4xx before any write); the owner is the session's id, so a userId
  // smuggled in the input is ignored. The content is DEK-encrypted by the store before
  // it is bound as a parameter.
  async function addMemory(session: Session, input: AddMemoryInput): Promise<ActionResult> {
    const valid = parseParams(addMemorySchema, input);
    const dek = await dataKeyFor(session.userId);
    await createMemoryRow(
      db,
      { userId: session.userId, content: valid.content, sourceAgentId: null, scope: valid.scope },
      dek,
      clock,
    );
    return { ok: true };
  }

  // Replace an OWNED memory's content in place. Validate at the boundary first (a
  // malformed id or content is a 4xx before any query); a memory that is not this
  // person's is refused and left unchanged.
  async function editMemory(session: Session, input: EditMemoryInput): Promise<ActionResult> {
    const valid = parseParams(editMemorySchema, input);
    if (!(await ownsMemory(session.userId, valid.id))) {
      return { ok: false, reason: "not_found" };
    }
    const dek = await dataKeyFor(session.userId);
    await editMemoryRow(db, session.userId, valid.id, valid.content, dek);
    return { ok: true };
  }

  // Change an OWNED memory's scope (kept ⇄ shared). Validate at the boundary first (a
  // malformed id or unknown scope is a 4xx before any query); a memory that is not
  // this person's is refused and left unchanged.
  async function rescopeMemory(session: Session, input: RescopeMemoryInput): Promise<ActionResult> {
    const valid = parseParams(rescopeMemorySchema, input);
    if (!(await ownsMemory(session.userId, valid.id))) {
      return { ok: false, reason: "not_found" };
    }
    await rescopeMemoryRow(db, session.userId, valid.id, valid.scope);
    return { ok: true };
  }

  // Delete an OWNED memory. Validate the id at the boundary (a 4xx before any query),
  // then delete member-scoped (id AND user_id bound): a memory that is not this
  // person's removes nothing and is a safe no-op refusal.
  async function deleteMemory(session: Session, input: DeleteMemoryInput): Promise<ActionResult> {
    const valid = parseParams(deleteMemorySchema, input);
    const removed = await deleteMemoryRow(db, session.userId, valid.id);
    return removed ? { ok: true } : { ok: false, reason: "not_found" };
  }

  return { load, addMemory, editMemory, rescopeMemory, deleteMemory };
}
