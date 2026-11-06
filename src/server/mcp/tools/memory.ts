// E13-S05 — the `remember` and `search_memory` core tools (design §6.2 MCP core
// tools; brief "Skills, preferences and shared memory": "agents with permission save
// memories (a short fact or note with the source agent and time); each memory is
// either kept to the agent that saved it or shared with the person's other permitted
// agents, following that agent's sharing setting unless the person changes it per
// memory"; constitution principle 14 "Warthog … SHALL record every … memory write
// itself at the moment it handles it").
//
// `remember` saves ONE memory for the CONNECTION's person, with the calling agent as
// its source and the connection's `sharing` grant as its scope (sharing ⇒ "shared",
// otherwise "kept"). `search_memory` hands the agent back ONLY the memories it may
// read — every SHARED memory of the person PLUS the agent's OWN kept memories, never
// another agent's kept memory and never a person-only kept memory — each content
// DECRYPTED within the owner-filtered set. Both are refused for a connection without
// memory permission.
//
// A SERVER module built purely from its INJECTED seams (the parameterizing `db`, the
// `KeyWrapper` that unwraps the person's DEK, and the `Clock` that stamps a save): it
// reads no `process.env` and holds no secret (INV-103). Each handler VALIDATES its
// input at the boundary (zod → a 4xx `HttpError` BEFORE any db access or crypto work,
// INV-102); the memory store binds `user_id` / `source_agent_id` as parameters and
// stores content DEK-encrypted as a bound value, so a SQL-shaped field is inert data
// that cannot alter a query (`search_memory`'s `query` filters in the app, never SQL).
// The OWNING person and the agent are ALWAYS taken from the session `connection`,
// never from a value in the input, so one agent can never save against — or read —
// another person's or another agent's memories. The memory WRITE itself is recorded
// by the pipeline that routes `remember` (Warthog writes the record, principle 14).

import { z } from "zod";

import { parseParams } from "../../http/validate";
import { getConnectionPermissions, type ConnectionPermissions } from "../../db/agent-permissions";
import { createMemory, memoriesForAgent, type MemoryScope } from "../../db/memories";
import { getUserById } from "../../db/users";
import type { KeyWrapper } from "../../crypto/key-wrapper";
import type { Clock } from "../../seams/clock";
import type { AgentConnection } from "../context";
import type { Db } from "../../db/index";

// Field caps, so a grossly oversized value is refused at the boundary before any db
// access (INV-102). A memory is a SHORT fact or note; `reason` matches the registry's
// envelope cap (design §6.2 "every tool takes an optional reason"); a search `query`
// is short.
const MAX_CONTENT = 4000;
const MAX_QUERY = 500;
const MAX_REASON = 2000;

// remember's input: a REQUIRED non-empty `content` (there is nothing to remember
// without it) plus the universal OPTIONAL `reason`. A z.object, so its `.shape`
// exposes each field.
const rememberSchema = z.object({
  content: z.string().min(1).max(MAX_CONTENT),
  reason: z.string().max(MAX_REASON).optional(),
});

// search_memory's input: an OPTIONAL `query` (a bare search returns everything
// readable) plus the universal OPTIONAL `reason`.
const searchSchema = z.object({
  query: z.string().max(MAX_QUERY).optional(),
  reason: z.string().max(MAX_REASON).optional(),
});

// The injected seams — no process.env (INV-103). `db` is the parameterizing seam the
// permission lookup and the memory store read through; `keyWrapper` unwraps the
// person's DEK so content is encrypted on save / decrypted on read; `clock` stamps a
// saved memory's time.
export interface MemoryToolDeps {
  readonly db: Db;
  readonly keyWrapper: KeyWrapper;
  readonly clock: Clock;
}

// What remember hands back: the saved memory's id and scope, or a plain refusal for a
// connection without memory permission.
export type RememberResult =
  | { status: "saved"; id: string; scope: MemoryScope }
  | { status: "refused"; reason: string };

export interface RememberTool {
  readonly name: string;
  readonly inputSchema: z.ZodType;
  handle(input: unknown, connection: AgentConnection): Promise<RememberResult>;
}

// One readable memory as handed to the agent (content DECRYPTED under the owner's DEK).
export interface SearchedMemory {
  readonly id: string;
  readonly content: string;
  readonly scope: MemoryScope;
  readonly sourceAgentId: string | null;
  readonly createdAt: Date;
}

// What search_memory hands back: the readable memories, or a plain refusal for a
// connection without memory permission.
export type SearchMemoryResult =
  | { status: "ok"; memories: ReadonlyArray<SearchedMemory> }
  | { status: "refused"; reason: string };

export interface SearchMemoryTool {
  readonly name: string;
  readonly inputSchema: z.ZodType;
  handle(input: unknown, connection: AgentConnection): Promise<SearchMemoryResult>;
}

// The plain refusal a connection without memory permission gets.
const NO_PERMISSION_REASON = "This agent does not have permission to use memories.";

// Resolve the person's unwrapped 256-bit DEK: read their wrapped DEK member-scoped by
// `userId` (the session's, never a client value) and unwrap it through the KeyWrapper
// seam. Throws when the person has no row — never fails silently.
async function dataKeyFor(db: Db, keyWrapper: KeyWrapper, userId: string): Promise<Uint8Array> {
  const user = await getUserById(db, userId);
  if (!user) {
    throw new Error("memory tool: no data key for this user");
  }
  return keyWrapper.unwrap(user.wrappedDek);
}

// The connection's memory permission (its person's `memoryRead` grant for this
// connection), or null when it has none — keyed by `connection.connectionId`
// member-scoped by `connection.userId`, exactly the grant the person set.
async function memoryPermission(
  db: Db,
  connection: AgentConnection,
): Promise<ConnectionPermissions | null> {
  const permissions = await getConnectionPermissions(db, connection.userId, connection.connectionId);
  if (!permissions || !permissions.memoryRead) return null;
  return permissions;
}

export function createRememberTool(deps: MemoryToolDeps): RememberTool {
  const { db, keyWrapper, clock } = deps;

  return {
    name: "remember",
    inputSchema: rememberSchema,

    async handle(input: unknown, connection: AgentConnection): Promise<RememberResult> {
      // VALIDATE at the boundary: a bad / oversized / mis-shaped input throws a 4xx
      // `HttpError` BEFORE any db access or crypto work (INV-102).
      const parsed = parseParams(rememberSchema, input);

      // Refuse a connection without memory permission — nothing is saved.
      const permissions = await memoryPermission(db, connection);
      if (!permissions) {
        return { status: "refused", reason: NO_PERMISSION_REASON };
      }

      // Save for the CONNECTION's person, sourced to the CONNECTION's agent (never a
      // value in the input), with the connection's sharing grant as the scope. Content
      // is stored DEK-encrypted through the parameterized store; time is the clock's.
      const scope: MemoryScope = permissions.sharing ? "shared" : "kept";
      const dek = await dataKeyFor(db, keyWrapper, connection.userId);
      const saved = await createMemory(
        db,
        { userId: connection.userId, content: parsed.content, sourceAgentId: connection.agentId, scope },
        dek,
        clock,
      );

      return { status: "saved", id: saved.id, scope: saved.scope };
    },
  };
}

export function createSearchMemoryTool(deps: MemoryToolDeps): SearchMemoryTool {
  const { db, keyWrapper } = deps;

  return {
    name: "search_memory",
    inputSchema: searchSchema,

    async handle(input: unknown, connection: AgentConnection): Promise<SearchMemoryResult> {
      // VALIDATE at the boundary (INV-102) BEFORE any db access or crypto work.
      const parsed = parseParams(searchSchema, input);

      // Refuse a connection without memory permission — no memories are read.
      const permissions = await memoryPermission(db, connection);
      if (!permissions) {
        return { status: "refused", reason: NO_PERMISSION_REASON };
      }

      // Read ONLY what this agent may read — shared memories plus its own kept ones —
      // member-scoped by the CONNECTION's person and filtered by the CONNECTION's agent
      // (both taken from the session, never the input), decrypted under the owner's DEK.
      const dek = await dataKeyFor(db, keyWrapper, connection.userId);
      const readable = await memoriesForAgent(db, connection.userId, connection.agentId, dek);

      // The optional `query` filters IN THE APP over the owner-scoped set (a
      // case-insensitive substring over the decrypted content) — it is never SQL, so a
      // SQL-shaped query is inert.
      const needle = parsed.query?.toLowerCase();
      const matched =
        needle === undefined || needle === ""
          ? readable
          : readable.filter((m) => m.content.toLowerCase().includes(needle));

      const memories: SearchedMemory[] = matched.map((m) => ({
        id: m.id,
        content: m.content,
        scope: m.scope,
        sourceAgentId: m.sourceAgentId,
        createdAt: m.createdAt,
      }));

      return { status: "ok", memories };
    },
  };
}
