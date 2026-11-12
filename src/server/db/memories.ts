import { assertCollectionCapacity } from "./collection-limits";
import { pageOptions, pageCursor, cursorTimestamp } from "./pagination";
// The shared-memory aggregate's data access (brief "Skills, preferences and shared
// memory"; design §4.1). A memory is a short fact or note an agent (with permission)
// or the person saves, carrying the source agent and the time it was saved. Each
// memory is either KEPT to the agent that saved it or SHARED with the person's other
// permitted agents; the person owns, views, edits, re-scopes and deletes them, and
// may add their own (`memoriesForAgent` hands an agent only the memories it may read).
//
// PERSONAL CONTENT, SO DEK-ENCRYPTED. A memory's `content` is a short fact or note the
// person or their agent authored, NOT filterable metadata (design §4.1 names
// "memories" as an encrypted personal-content column; constitution principle 19
// forbids any operator path to decrypt a person's memory contents). So `content` is
// stored only DEK-ENCRYPTED (`../crypto/envelope`): the id is generated up front so
// the envelope's associated data binds the ciphertext to its exact (table, column,
// row) — the plaintext never lands in a column — and the content is decrypted in the
// app within the already member-filtered set. The `source_agent_id` (an "agent id" is
// §4.1 metadata), the `scope` and the `created_at` timestamp are PLAINTEXT METADATA,
// so the set an agent may read can be filtered without decrypting.
//
// The source agent is treated as an OPAQUE plaintext id — it needs no agents-table row
// (a bare UUID is a valid source), so `source_agent_id` is NOT a foreign key; a
// person-authored memory has no source agent (`sourceAgentId` is null). Time enters
// through the injected Clock (never SQL now()): createMemory stamps createdAt =
// clock.now().
//
// Every statement is parameterized through the `Db` seam (INV-102): the ids and every
// value travel as BOUND values, never concatenated into the SQL text, so a value
// shaped like SQL is stored as data and cannot alter the query. Every read/write is
// member-scoped by the `userId` the caller passes — the session's id, never a client
// value — so one person can never read or change another's memories. The DEK and the
// clock are injected (this module reads no `process.env` and holds no key, INV-103).

import { randomUUID } from "node:crypto";

import { decrypt, encrypt } from "../crypto/envelope";
import type { Clock } from "../seams/clock";
import { withTransaction, type Db, type Row } from "./index";

// The envelope's associated data binds each field's ciphertext to its exact location,
// so a row lifted into another row/column/table fails to decrypt.
const TABLE = "memories";

// A memory is KEPT to the agent that saved it, or SHARED with the person's other
// permitted agents.
export type MemoryScope = "kept" | "shared";

// What createMemory records: the OWNER (the session's id / the agent's person, never a
// client value), the content (stored DEK-encrypted), the source agent (null when the
// PERSON added it) and the scope.
export interface NewMemory {
  readonly userId: string;
  readonly content: string;
  readonly sourceAgentId: string | null;
  readonly scope: MemoryScope;
}

// A memory as handed back to its OWNER / a scoped agent (content DECRYPTED under the
// owner's DEK).
export interface Memory {
  readonly id: string;
  readonly userId: string;
  readonly content: string;
  readonly sourceAgentId: string | null;
  readonly scope: MemoryScope;
  readonly createdAt: Date;
}

// The columns a full read returns, kept in one place; `content` comes back as
// ciphertext and is decrypted separately.
const SELECT_COLUMNS =
  "id, user_id, content, source_agent_id, scope, created_at";

// A stored instant comes back as a Date or an ISO/epoch representation depending on
// the driver; normalise to a Date.
function toDate(value: unknown): Date {
  return new Date(value as string | number | Date);
}

// Decrypt a raw row's content under the owner's DEK and assemble a Memory.
async function decryptRow(dek: Uint8Array, row: Row): Promise<Memory> {
  const id = row.id as string;
  const content = await decrypt(
    dek,
    TABLE,
    "content",
    id,
    row.content as string,
  );
  return {
    id,
    userId: row.user_id as string,
    content,
    sourceAgentId: (row.source_agent_id as string | null) ?? null,
    scope: row.scope as MemoryScope,
    createdAt: toDate(row.created_at),
  };
}

// Create a memory for `input.userId`, storing its content DEK-encrypted plus the
// plaintext source agent / scope / created time (createdAt = clock.now()). The id is
// generated up front so the envelope binds to the row; the returned Memory is
// assembled from the inputs (no dependency on a RETURNING read). Member-scoped: the
// user id is bound. Works for an AGENT save (sourceAgentId set) and the PERSON's own
// (sourceAgentId null).
export async function createMemory(
  db: Db,
  input: NewMemory,
  dek: Uint8Array,
  clock: Clock,
): Promise<Memory> {
  if (!db.inTransaction)
    return withTransaction(db, (tx) => createMemory(tx, input, dek, clock));
  const id = randomUUID();
  const createdAt = clock.now();
  const content = await encrypt(dek, TABLE, "content", id, input.content);
  await assertCollectionCapacity(db, input.userId, "memories", content.length);

  await db.query(
    `INSERT INTO memories (id, user_id, content, source_agent_id, scope, created_at)
     VALUES ($1, $2, $3, $4, $5, $6::timestamptz)`,
    [
      id,
      input.userId,
      content,
      input.sourceAgentId,
      input.scope,
      createdAt.toISOString(),
    ],
  );

  return {
    id,
    userId: input.userId,
    content: input.content,
    sourceAgentId: input.sourceAgentId,
    scope: input.scope,
    createdAt,
  };
}

// Replace an OWNED memory's content in place (same id), re-encrypting it; the source,
// scope and created time are PRESERVED (not touched by the UPDATE, read back here).
// Member-scoped (id AND user_id bound). THROWS when there is no such memory for this
// user, so a cross-user edit cannot silently no-op.
export async function editMemory(
  db: Db,
  userId: string,
  id: string,
  content: string,
  dek: Uint8Array,
): Promise<Memory> {
  if (!db.inTransaction)
    return withTransaction(db, (tx) =>
      editMemory(tx, userId, id, content, dek),
    );
  const ciphertext = await encrypt(dek, TABLE, "content", id, content);
  await assertCollectionCapacity(db, userId, "memories", ciphertext.length, id);

  const result = await db.query(
    `UPDATE memories SET content = $1
     WHERE id = $2 AND user_id = $3
     RETURNING source_agent_id, scope, created_at`,
    [ciphertext, id, userId],
  );
  const row = result.rows[0];
  if (!row) throw new Error("editMemory: no such memory for this user");

  return {
    id,
    userId,
    content,
    sourceAgentId: (row.source_agent_id as string | null) ?? null,
    scope: row.scope as MemoryScope,
    createdAt: toDate(row.created_at),
  };
}

// Change an OWNED memory's scope in place (the per-memory override); content, source
// and created time untouched. Member-scoped (id AND user_id bound). THROWS when there
// is no such memory for this user, so a cross-user re-scope cannot silently no-op.
export async function rescopeMemory(
  db: Db,
  userId: string,
  id: string,
  scope: MemoryScope,
): Promise<void> {
  if (!db.inTransaction)
    return withTransaction(db, (tx) => rescopeMemory(tx, userId, id, scope));
  const result = await db.query(
    `UPDATE memories SET scope = $1 WHERE id = $2 AND user_id = $3 RETURNING id`,
    [scope, id, userId],
  );
  if (result.rows.length === 0)
    throw new Error("rescopeMemory: no such memory for this user");
  await db.query(
    "DELETE FROM agent_memory_access WHERE user_id = $1 AND memory_id = $2",
    [userId, id],
  );
}

// Delete an OWNED memory; true when a row was removed, false when there was none for
// this user (so another person's delete is a no-op). Member-scoped (id AND user_id
// bound).
export async function deleteMemory(
  db: Db,
  userId: string,
  id: string,
): Promise<boolean> {
  const result = await db.query(
    `DELETE FROM memories WHERE id = $1 AND user_id = $2 RETURNING id`,
    [id, userId],
  );
  return result.rows.length > 0;
}

// List ALL of `userId`'s memories — any scope, any source — each content DECRYPTED
// under the owner's `dek`, carrying its source, scope and created time. Member-scoped
// (user_id bound); never another person's. An empty array when the person has none. A
// wrong DEK fails the GCM tag and rejects.
export async function listMemoriesForUser(
  db: Db,
  userId: string,
  dek: Uint8Array,
): Promise<Memory[]> {
  const result = await db.query(
    `SELECT ${SELECT_COLUMNS} FROM memories WHERE user_id = $1 ORDER BY created_at`,
    [userId],
  );

  const memories: Memory[] = [];
  for (const row of result.rows) {
    memories.push(await decryptRow(dek, row));
  }
  return memories;
}

// The memories an agent MAY read: every SHARED memory (whatever its source) PLUS the
// agent's OWN kept memories (source_agent_id = agentId). NEVER another agent's kept
// memory, and never a person-only kept memory — a kept row with a null or different
// source never matches the agent. Member-scoped by userId: an agent never reads
// another person's memories. Decrypted under the owner's `dek`.
export async function memoriesForAgent(
  db: Db,
  userId: string,
  agentId: string,
  dek: Uint8Array,
): Promise<Memory[]> {
  const result = await db.query(
    `SELECT ${SELECT_COLUMNS} FROM memories
     WHERE user_id = $1 AND COALESCE((SELECT allowed FROM agent_memory_access a WHERE a.user_id = memories.user_id AND a.memory_id = memories.id AND a.agent_id::text = $2), (scope = 'shared' OR source_agent_id = $2))
     ORDER BY created_at`,
    [userId, agentId],
  );

  const memories: Memory[] = [];
  for (const row of result.rows) {
    memories.push(await decryptRow(dek, row));
  }
  return memories;
}

// Who saved a memory, as a Memory page filter: the PERSON (no source agent) or one agent.
// The caller validates an agent id against the person's own agents before passing it; it
// is only ever bound as a parameter.
export type MemorySourceFilter =
  | { readonly kind: "person" }
  | { readonly kind: "agent"; readonly agentId: string };

// The Memory page's list filters, applied in SQL so paging stays correct.
export interface MemoryListFilters {
  readonly scope?: MemoryScope;
  readonly source?: MemorySourceFilter;
}

// The bound values for the filter fragments below: scope, source kind, source agent id.
function filterValues(filters: MemoryListFilters): [string | null, string | null, string | null] {
  const source = filters.source;
  return [
    filters.scope ?? null,
    source?.kind ?? null,
    source?.kind === "agent" ? source.agentId : null,
  ];
}

// `scope` / `source` predicates over the numbered parameters a caller supplies. The text
// is fixed; every value is a bound parameter.
const scopePredicate = (p: number) => `($${p}::text IS NULL OR scope = $${p}::text)`;
const sourcePredicate = (kind: number, agent: number) =>
  `($${kind}::text IS NULL OR ($${kind}::text = 'person' AND source_agent_id IS NULL) OR ($${kind}::text = 'agent' AND source_agent_id = $${agent}::text))`;

/** Newest-first bounded page; visibility and the page filters are enforced in SQL before decryption. */
export async function pageMemories(
  db: Db,
  userId: string,
  dek: Uint8Array,
  input: { cursor?: string; limit?: number; agentId?: string } & MemoryListFilters = {},
) {
  const { limit, cursor } = pageOptions(input);
  const result = await db.query(
    `SELECT ${SELECT_COLUMNS}, ${cursorTimestamp("created_at")} FROM memories
 WHERE user_id = $1 AND ($2::text IS NULL OR COALESCE((SELECT allowed FROM agent_memory_access a WHERE a.user_id = memories.user_id AND a.memory_id = memories.id AND a.agent_id::text = $2),scope = 'shared' OR source_agent_id = $2))
 AND ($3::timestamptz IS NULL OR (created_at,id) < ($3::timestamptz,$4::uuid))
 AND ${scopePredicate(6)} AND ${sourcePredicate(7, 8)}
 ORDER BY created_at DESC,id DESC LIMIT $5`,
    [
      userId,
      input.agentId ?? null,
      cursor?.at ?? null,
      cursor?.id ?? null,
      limit + 1,
      ...filterValues(input),
    ],
  );
  const items = await Promise.all(
    result.rows.slice(0, limit).map((row) => decryptRow(dek, row)),
  );
  const last = result.rows[Math.min(result.rows.length, limit) - 1];
  return {
    items,
    nextCursor:
      result.rows.length > limit && last
        ? pageCursor({ id: String(last.id), createdAt: String(last.cursor_at) })
        : null,
  };
}

// How many of the person's memories each Memory page filter option would show. Each facet
// honours the OTHER facet's filter but not its own (so choosing "Kept" still shows how many
// are shared): scope counts within the chosen source, source counts within the chosen
// scope. Metadata only (no content is read or decrypted); member-scoped by `userId`.
export interface MemoryFacetCounts {
  readonly scope: Readonly<Record<MemoryScope, number>>;
  readonly source: {
    readonly person: number;
    readonly agents: ReadonlyMap<string, number>;
  };
}

export async function countMemoryFacets(
  db: Db,
  userId: string,
  filters: MemoryListFilters,
): Promise<MemoryFacetCounts> {
  const [scope, sourceKind, sourceAgent] = filterValues(filters);
  const byScope = await db.query(
    `SELECT scope, count(*)::int AS n FROM memories
 WHERE user_id = $1 AND ${sourcePredicate(2, 3)}
 GROUP BY scope`,
    [userId, sourceKind, sourceAgent],
  );
  const bySource = await db.query(
    `SELECT source_agent_id, count(*)::int AS n FROM memories
 WHERE user_id = $1 AND ${scopePredicate(2)}
 GROUP BY source_agent_id`,
    [userId, scope],
  );
  const scopeCounts: Record<MemoryScope, number> = { kept: 0, shared: 0 };
  for (const row of byScope.rows) scopeCounts[row.scope as MemoryScope] = Number(row.n);
  let person = 0;
  const agents = new Map<string, number>();
  for (const row of bySource.rows) {
    if (row.source_agent_id == null) person = Number(row.n);
    else agents.set(String(row.source_agent_id), Number(row.n));
  }
  return { scope: scopeCounts, source: { person, agents } };
}
