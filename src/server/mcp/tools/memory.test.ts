// E13-S05 — the `remember` and `search_memory` core tools
// (`src/server/mcp/tools/memory.ts`, design §6.2 MCP core tools; brief §"Skills,
// preferences and shared memory": "agents with permission save memories (a short fact
// or note with the source agent and time); each memory is either kept to the agent that
// saved it or shared with the person's other permitted agents, following that agent's
// sharing setting unless the person changes it per memory"; constitution principle 14
// "Warthog … SHALL record every … memory write itself at the moment it handles it").
//
// RED-first: `./memory` does not exist yet, so importing `createRememberTool` /
// `createSearchMemoryTool` throws and every test here fails until the builder writes the
// minimum code to pass. That absence IS the point of test-first; do NOT implement
// anything to make these pass — the builder writes `memory.ts` afterwards. (The memory
// STORE these tools read/write — `createMemory` / `memoriesForAgent` / `listMemoriesForUser`
// — the permission store `getConnectionPermissions`/`upsertPermissions`, and the pipeline
// they are routed through all ALREADY exist and are driven here as real, tested seams.)
//
// These tests pin BEHAVIOUR (what each tool DOES: the row it stores, the set it returns,
// who it refuses, and that it runs through the pipeline so a memory write is recorded),
// never the source text of any module — a later rename that preserves behaviour must not
// redden them.
//
// ---------------------------------------------------------------------------
// THE PINNED CONTRACT (chosen by the tester; the implementation conforms to it).
//
//   import { z } from "zod";
//   import type { Db } from "../../db/index";
//   import type { KeyWrapper } from "../../crypto/key-wrapper";
//   import type { Clock } from "../../seams/clock";
//   import type { AgentConnection } from "../context";
//
//   interface MemoryToolDeps {
//     readonly db: Db;               // the parameterizing db seam (permissions + the memory store)
//     readonly keyWrapper: KeyWrapper; // unwraps the person's DEK (encrypt on save / decrypt on read)
//     readonly clock: Clock;         // createMemory stamps createdAt = clock.now()
//   }
//
//   // remember — save ONE memory for the CONNECTION's person, with the agent as its
//   // source and the connection's `sharing` grant as its scope (sharing ⇒ "shared",
//   // otherwise "kept"). Refused when the connection has no memory permission.
//   type RememberResult =
//     | { status: "saved"; id: string; scope: "kept" | "shared" }
//     | { status: "refused"; reason: string };
//   interface RememberTool {
//     readonly name: string;           // "remember"
//     readonly inputSchema: z.ZodType; // a z.object whose .shape has a REQUIRED non-empty
//                                       // string `content` and the universal OPTIONAL `reason`.
//     handle(input: unknown, connection: AgentConnection): Promise<RememberResult>;
//   }
//   function createRememberTool(deps: MemoryToolDeps): RememberTool;
//
//   // search_memory — return ONLY the memories THIS agent may read (every SHARED memory
//   // of the person PLUS the agent's OWN kept memories — never another agent's kept
//   // memory, never a person-only kept memory, never another person's memory), each
//   // `content` DECRYPTED under the owner's DEK within the owner-filtered set. Refused
//   // when the connection has no memory permission.
//   type SearchedMemory = {
//     id: string; content: string; scope: "kept" | "shared";
//     sourceAgentId: string | null; createdAt: Date;
//   };
//   type SearchMemoryResult =
//     | { status: "ok"; memories: ReadonlyArray<SearchedMemory> }
//     | { status: "refused"; reason: string };
//   interface SearchMemoryTool {
//     readonly name: string;           // "search_memory"
//     readonly inputSchema: z.ZodType; // a z.object whose .shape has an OPTIONAL string
//                                       // `query` and the universal OPTIONAL `reason`.
//     handle(input: unknown, connection: AgentConnection): Promise<SearchMemoryResult>;
//   }
//   function createSearchMemoryTool(deps: MemoryToolDeps): SearchMemoryTool;
//
// The owning person and the agent are ALWAYS taken from the session `connection`, never a
// value in the input (the permission lookup is keyed by `connection.connectionId`; the
// memory owner is `connection.userId`; the source / read filter is `connection.agentId`).
// Memory permission is the person's `memoryRead` grant for the connection; its `sharing`
// grant decides a saved memory's scope.
//
// "records the memory write in the activity feed" (an AC) is pinned by routing `remember`
// through a real `createAgentCallPipeline` (the production path: `remember` is a core tool
// the registry routes through the pipeline), which writes ONE `source:"warthog"` activity
// entry for the call BEFORE the response — Warthog writes the record itself (principle 14).
//
// Every db handle is closed in a `finally` so node:test leaves no open handle; each test
// uses its own `freshDb()` (an isolated in-memory PGlite with the real migrations). Tests
// never touch the network, Azure or a real database.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";

import { createRememberTool, createSearchMemoryTool } from "./memory";
import { createMemory, listMemoriesForUser } from "../../db/memories";
import { createAgentCallPipeline, type AgentCall, type AgentCallResult } from "../pipeline";
import { createRateLimiter } from "../rate-limit";
import { createInMemoryRecorder, type ActivityEntryInput } from "../../activity/recorder";
import { createUser } from "../../db/users";
import { upsertPermissions } from "../../db/agent-permissions";
import { freshDb } from "../../../test/db";
import { localAesKeyWrapper, type KeyWrapper } from "../../crypto/key-wrapper";
import { fixedClock, type Clock } from "../../seams/clock";
import type { AgentConnection } from "../context";
import type { Db } from "../../db/index";

// --- loose result shapes so the (absent) module's exact types do not gate compile. The
// tests assert on `status` + the field a status carries, leaving the builder free to pick
// the exact discriminated-union members as long as the behaviour holds.
interface RememberResult {
  readonly status: string;
  readonly id?: string;
  readonly scope?: string;
  readonly reason?: string;
}
interface SearchedMemory {
  readonly id?: string;
  readonly content?: string;
  readonly scope?: string;
  readonly sourceAgentId?: string | null;
  readonly createdAt?: unknown;
}
interface SearchMemoryResult {
  readonly status: string;
  readonly memories?: ReadonlyArray<SearchedMemory>;
  readonly reason?: string;
}

type Grants = Parameters<typeof upsertPermissions>[1];

// --- fixtures ---------------------------------------------------------------------

const DEK_BYTES = 32; // a 256-bit per-person data key
const KEK_BYTES = 32; // the local AES-256 KEK the KeyWrapper seam wraps the DEK under

// The frozen instant the tools (and the pipeline) read time through. Mid-month noon UTC,
// so the pipeline's budget-period / rate-limit buckets are unambiguous in UTC arithmetic.
const NOW = new Date("2026-11-15T12:00:00.000Z");

function keyWrapperFor(): KeyWrapper {
  return localAesKeyWrapper(randomBytes(KEK_BYTES));
}

// Create a person whose wrapped DEK REALLY unwraps under `keyWrapper` (the tool resolves
// the DEK from the user row through the wrapper, exactly as the pipeline does), returning
// their id and the raw DEK — so reading back under that same raw key proves a tool stored
// / read under the person's OWN key.
async function makePerson(
  db: Db,
  who: string,
  keyWrapper: KeyWrapper,
): Promise<{ userId: string; dek: Uint8Array }> {
  const dek = randomBytes(DEK_BYTES);
  const wrappedDek = await keyWrapper.wrap(dek);
  const user = await createUser(db, { email: `${who}@warthog.com.au`, wrappedDek });
  return { userId: user.id, dek };
}

// A fresh agent id (an opaque uuid — the same id space the memory store scopes its source
// / read filter by).
function agentId(): string {
  return randomUUID();
}

// The resolved connection a tool acts for. Built as a variable (not a literal at the call
// site) so a superset of fields stays assignable to the tool's param type. `agentId`
// defaults to `connectionId` (the E07-S09 shape).
function connectionFor(
  userId: string,
  opts: { connectionId?: string; agentId?: string; active?: boolean } = {},
): AgentConnection {
  const connectionId = opts.connectionId ?? randomUUID();
  return {
    userId,
    connectionId,
    agentId: opts.agentId ?? connectionId,
    active: opts.active ?? true,
  };
}

// The tool deps, built via a helper (a non-literal) so an excess-property check never
// bites whichever subset the builder's factory declares.
function memoryDeps(db: Db, keyWrapper: KeyWrapper, clock: Clock) {
  return { db, keyWrapper, clock };
}

// A fully-populated grants record for a connection; a test overrides only what it is
// about (memoryRead gates the tools; sharing decides a saved memory's scope). Built via a
// helper (a non-literal) so excess-property checks never bite.
function baseGrants(userId: string, connectionId: string, overrides: Partial<Grants> = {}): Grants {
  return {
    userId,
    connectionId,
    grantedConnectors: [],
    readTools: true,
    changeTools: "ask_first",
    identityAccess: true,
    highTierAccess: false,
    cardAccess: false,
    cardBudget: null,
    skillsScope: [],
    memoryRead: true,
    sharing: false,
    rulesScope: [],
    rateLimit: 120,
    ...overrides,
  } as Grants;
}

// Grant one connection its memory permission (memoryRead) + sharing setting, so the tool's
// own permission lookup finds them. Keyed by connectionId, exactly as the tool reads it.
async function grant(
  db: Db,
  userId: string,
  connectionId: string,
  opts: { memoryRead?: boolean; sharing?: boolean } = {},
): Promise<void> {
  await upsertPermissions(
    db,
    baseGrants(userId, connectionId, {
      memoryRead: opts.memoryRead ?? true,
      sharing: opts.sharing ?? false,
    }),
  );
}

// A recorder that wraps the REAL in-memory recorder (so redaction + chaining really happen)
// and captures each input, so the pipeline test can prove the memory write was recorded.
function spyRecorder(clock: Clock) {
  const base = createInMemoryRecorder({ clock });
  const inputs: ActivityEntryInput[] = [];
  const recorder = {
    async record(input: ActivityEntryInput) {
      inputs.push(input);
      return base.record(input);
    },
  };
  return { recorder, inputs };
}

// Narrowing helper (assert.fail is `never`, so the result narrows after).
function expectExecuted(r: AgentCallResult) {
  if (r.status !== "executed") assert.fail(`expected an executed result, got "${r.status}": ${JSON.stringify(r)}`);
  return r;
}

// ===========================================================================
// AC1 — remember saves a memory for the connection's person with the AGENT as source and
// the connection's SHARING setting as scope. Here sharing is OFF ⇒ scope "kept".
// ===========================================================================

test("remember saves a memory sourced to the agent, scope 'kept' when sharing is off", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const { userId, dek } = await makePerson(db, "save-kept", keyWrapper);
    const conn = connectionFor(userId);
    await grant(db, userId, conn.connectionId, { sharing: false });

    const tool = createRememberTool(memoryDeps(db, keyWrapper, fixedClock(NOW)));
    const CONTENT = "The person prefers window seats on flights over four hours.";
    const result = (await tool.handle({ content: CONTENT }, conn)) as RememberResult;
    assert.equal(result.status, "saved", "a permitted remember reports it saved the memory");

    // The STORED row is the proof: read it back under the person's OWN key.
    const stored = await listMemoriesForUser(db, userId, dek);
    assert.equal(stored.length, 1, "exactly one memory was written for the person");
    assert.equal(stored[0].content, CONTENT, "the content round-trips (encrypted under the person's DEK)");
    assert.equal(stored[0].sourceAgentId, conn.agentId, "the SOURCE is the calling agent");
    assert.equal(stored[0].scope, "kept", "sharing off ⇒ the memory is KEPT to the agent that saved it");
    assert.equal(stored[0].createdAt.getTime(), NOW.getTime(), "createdAt is stamped from the injected clock");
  } finally {
    await db.close();
  }
});

test("remember saves scope 'shared' when the connection's sharing setting is on", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const { userId, dek } = await makePerson(db, "save-shared", keyWrapper);
    const conn = connectionFor(userId);
    await grant(db, userId, conn.connectionId, { sharing: true });

    const tool = createRememberTool(memoryDeps(db, keyWrapper, fixedClock(NOW)));
    const result = (await tool.handle(
      { content: "The household's electricity plan renews in March." },
      conn,
    )) as RememberResult;
    assert.equal(result.status, "saved", "a permitted remember with sharing on saves the memory");

    const stored = await listMemoriesForUser(db, userId, dek);
    assert.equal(stored.length, 1, "one memory written");
    assert.equal(stored[0].scope, "shared", "sharing on ⇒ the memory is SHARED with the person's other agents");
    assert.equal(stored[0].sourceAgentId, conn.agentId, "still sourced to the saving agent");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC3 (remember) — the owner and the source come ONLY from the CONNECTION (the input
// carries no identity field at all): the memory belongs to the connection's person and is
// sourced to the connection's agent, and never lands against any other person.
// ===========================================================================

test("remember owns the memory to the connection's person and sources it to the connection's agent", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const me = await makePerson(db, "owner-me", keyWrapper);
    const other = await makePerson(db, "other-person", keyWrapper);
    const conn = connectionFor(me.userId);
    await grant(db, me.userId, conn.connectionId, { sharing: false });

    const tool = createRememberTool(memoryDeps(db, keyWrapper, fixedClock(NOW)));
    await tool.handle({ content: "Routed by the connection, not the request." }, conn);

    // It landed under MY id, sourced to MY agent — the connection is the sole source of identity.
    const mine = await listMemoriesForUser(db, me.userId, me.dek);
    assert.equal(mine.length, 1, "the memory is owned by the connection's person");
    assert.equal(mine[0].sourceAgentId, conn.agentId, "the source is the connection's agent");

    const theirs = await listMemoriesForUser(db, other.userId, other.dek);
    assert.equal(theirs.length, 0, "nothing was written against any other person");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC3 (remember) — a connection WITHOUT memory permission is refused, and nothing is saved.
// ===========================================================================

test("remember refuses a connection without memory permission and writes no memory", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const { userId, dek } = await makePerson(db, "no-perm-remember", keyWrapper);
    const conn = connectionFor(userId);
    await grant(db, userId, conn.connectionId, { memoryRead: false });

    const tool = createRememberTool(memoryDeps(db, keyWrapper, fixedClock(NOW)));
    const result = (await tool.handle({ content: "Should never be stored." }, conn)) as RememberResult;

    assert.equal(result.status, "refused", "no memory permission ⇒ refused");
    assert.ok((result.reason ?? "").length > 0, "the refusal carries a plain reason");
    const stored = await listMemoriesForUser(db, userId, dek);
    assert.equal(stored.length, 0, "a refused remember writes nothing");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC2 — search_memory returns ONLY the memories THIS agent may read: every SHARED memory
// (whatever its source) PLUS the agent's OWN kept memories — never another agent's kept
// memory, and never a person-only kept memory — each content DECRYPTED. The set is seeded
// directly through the tested store so the read authorisation is exercised in isolation.
// ===========================================================================

test("search_memory returns shared memories plus the agent's own kept memories, decrypted — and nothing else", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const { userId, dek } = await makePerson(db, "search-scope", keyWrapper);
    const me = agentId();
    const other = agentId();
    const clock = fixedClock(NOW);

    const MINE_KEPT = "My own kept note — only I should see this.";
    const MINE_SHARED = "A fact I shared with the person's other agents.";
    const OTHER_SHARED = "Another agent's shared fact — readable by all permitted agents.";
    const OTHER_KEPT = "Another agent's PRIVATE kept note — off limits to me.";
    const PERSON_ONLY = "The person's own private note (no source agent) — not for agents.";

    await createMemory(db, { userId, content: MINE_KEPT, sourceAgentId: me, scope: "kept" }, dek, clock);
    await createMemory(db, { userId, content: MINE_SHARED, sourceAgentId: me, scope: "shared" }, dek, clock);
    await createMemory(db, { userId, content: OTHER_SHARED, sourceAgentId: other, scope: "shared" }, dek, clock);
    await createMemory(db, { userId, content: OTHER_KEPT, sourceAgentId: other, scope: "kept" }, dek, clock);
    await createMemory(db, { userId, content: PERSON_ONLY, sourceAgentId: null, scope: "kept" }, dek, clock);

    await grant(db, userId, me, { memoryRead: true });

    const tool = createSearchMemoryTool(memoryDeps(db, keyWrapper, clock));
    const conn = connectionFor(userId, { connectionId: me, agentId: me });
    const result = (await tool.handle({}, conn)) as SearchMemoryResult;

    assert.ok(Array.isArray(result.memories), "a permitted search returns a list of memories");
    const contents = new Set((result.memories ?? []).map((m) => m.content));

    assert.ok(contents.has(MINE_KEPT), "the agent's OWN kept memory is returned");
    assert.ok(contents.has(MINE_SHARED), "the agent's own shared memory is returned");
    assert.ok(contents.has(OTHER_SHARED), "a shared memory from ANOTHER agent is returned");
    assert.ok(!contents.has(OTHER_KEPT), "another agent's KEPT memory is NEVER returned");
    assert.ok(!contents.has(PERSON_ONLY), "a person-only kept memory is NEVER returned to an agent");
    assert.equal(contents.size, 3, "exactly the three readable memories come back — no more");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC3 (search_memory) — member scope: the person comes from the connection, so one
// person's agent never reads ANOTHER person's memories, even shared ones.
// ===========================================================================

test("search_memory never reads another person's memories (userId comes from the connection)", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const a = await makePerson(db, "person-a", keyWrapper);
    const b = await makePerson(db, "person-b", keyWrapper);
    const clock = fixedClock(NOW);

    const A_SHARED = "Person A's shared memory — A's agents only.";
    await createMemory(db, { userId: a.userId, content: A_SHARED, sourceAgentId: agentId(), scope: "shared" }, a.dek, clock);

    // B's agent is fully permitted for B, and asks — but B owns no memories, and A's never cross.
    const bConn = connectionFor(b.userId);
    await grant(db, b.userId, bConn.connectionId, { memoryRead: true });

    const tool = createSearchMemoryTool(memoryDeps(db, keyWrapper, clock));
    const result = (await tool.handle({}, bConn)) as SearchMemoryResult;

    assert.ok(Array.isArray(result.memories), "B's permitted agent gets a (possibly empty) list, not a refusal");
    const contents = (result.memories ?? []).map((m) => m.content);
    assert.ok(!contents.includes(A_SHARED), "A's shared memory never crosses to another person's agent");
    assert.equal(contents.length, 0, "B has no memories of their own, so the list is empty");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC3 (search_memory) — a connection WITHOUT memory permission is refused (no memories).
// ===========================================================================

test("search_memory refuses a connection without memory permission", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const { userId, dek } = await makePerson(db, "no-perm-search", keyWrapper);
    // The person DOES have a shared memory — so a refusal can only be the permission gate.
    await createMemory(
      db,
      { userId, content: "A shared memory that is nonetheless off limits.", sourceAgentId: agentId(), scope: "shared" },
      dek,
      fixedClock(NOW),
    );
    const conn = connectionFor(userId);
    await grant(db, userId, conn.connectionId, { memoryRead: false });

    const tool = createSearchMemoryTool(memoryDeps(db, keyWrapper, fixedClock(NOW)));
    const result = (await tool.handle({}, conn)) as SearchMemoryResult;

    assert.equal(result.status, "refused", "no memory permission ⇒ refused");
    assert.ok((result.reason ?? "").length > 0, "the refusal carries a plain reason");
    assert.ok(
      result.memories === undefined || result.memories.length === 0,
      "a refused search hands back no memories",
    );
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC1 — the memory WRITE is recorded in the activity feed. Routed through a real pipeline
// (the production path for a core tool), an allowed `remember` executes (saves the memory)
// and Warthog writes ONE `source:"warthog"` activity entry for the call.
// ===========================================================================

test("through the pipeline: an allowed remember saves the memory and records ONE Warthog entry", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const { userId, dek } = await makePerson(db, "pipe-remember", keyWrapper);
    const conn = connectionFor(userId);
    await upsertPermissions(db, baseGrants(userId, conn.connectionId, { memoryRead: true, sharing: false }));

    const tool = createRememberTool(memoryDeps(db, keyWrapper, fixedClock(NOW)));
    const rec = spyRecorder(fixedClock(NOW));
    let saves = 0;
    const pipeline = createAgentCallPipeline({
      db,
      keyWrapper,
      clock: fixedClock(NOW),
      rateLimiter: createRateLimiter(fixedClock(NOW)),
      recorder: rec.recorder,
      // The pipeline executes remember by dispatching to the tool body, taking the agent /
      // person from the resolved connection it is handed — never from the call body.
      executeTool: async (call: AgentCall, connection: AgentConnection) => {
        saves += 1;
        return tool.handle(call.params, connection);
      },
    });

    const call: AgentCall = {
      connector: null,
      tool: "remember",
      makesChange: true,
      params: { content: "Booked the dentist for the 20th; reminder set." },
    };
    const outcome = expectExecuted(await pipeline.handleAgentCall(conn, call));
    const body = outcome.result as RememberResult;
    assert.equal(body.status, "saved", "the allowed call saved the memory");
    assert.equal(saves, 1, "the tool body ran exactly once");

    // The memory really landed.
    const stored = await listMemoriesForUser(db, userId, dek);
    assert.equal(stored.length, 1, "the memory write persisted through the pipeline");

    // Warthog recorded the memory write itself — ONE entry, labelled source "warthog".
    const entries = rec.inputs.filter((e) => e.tool === "remember");
    assert.equal(entries.length, 1, "the memory write is recorded as exactly ONE activity entry");
    assert.equal(entries[0].source, "warthog", "Warthog writes the record itself (not the agent)");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// Envelope — the tools name themselves and carry the right input schema. `remember`
// requires a non-empty `content`; `search_memory` takes an optional `query`; both carry
// the universal OPTIONAL `reason` (design §6.2 "every tool takes an optional reason").
// ===========================================================================

test("the memory tools are named and their input schemas require the right fields", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const remember = createRememberTool(memoryDeps(db, keyWrapper, fixedClock(NOW)));
    const search = createSearchMemoryTool(memoryDeps(db, keyWrapper, fixedClock(NOW)));

    assert.equal(remember.name, "remember", "the save tool names itself remember");
    assert.equal(search.name, "search_memory", "the read tool names itself search_memory");

    // remember: `content` is REQUIRED and must be a non-empty string; `reason` is optional.
    const content = subschema(remember.inputSchema, "content");
    assert.ok(content, "remember exposes a `content` field");
    assert.equal(content!.safeParse("a fact to keep").success, true, "`content` accepts a non-empty string");
    assert.equal(content!.safeParse(undefined).success, false, "`content` is REQUIRED");
    assert.equal(content!.safeParse("").success, false, "`content` rejects the empty string");
    assert.equal(content!.safeParse(123).success, false, "`content` rejects a non-string");
    const rReason = subschema(remember.inputSchema, "reason");
    assert.ok(rReason, "remember exposes a `reason` field");
    assert.equal(rReason!.safeParse(undefined).success, true, "`reason` is OPTIONAL on remember");
    assert.equal(rReason!.safeParse(123).success, false, "`reason` rejects a non-string");

    // search_memory: `query` is OPTIONAL (a bare search returns everything readable); it
    // rejects a non-string. `reason` is optional too.
    const query = subschema(search.inputSchema, "query");
    assert.ok(query, "search_memory exposes a `query` field");
    assert.equal(query!.safeParse(undefined).success, true, "`query` is OPTIONAL");
    assert.equal(query!.safeParse("dentist").success, true, "`query` accepts a string");
    assert.equal(query!.safeParse(123).success, false, "`query` rejects a non-string");
    const sReason = subschema(search.inputSchema, "reason");
    assert.ok(sReason, "search_memory exposes a `reason` field");
    assert.equal(sReason!.safeParse(undefined).success, true, "`reason` is OPTIONAL on search_memory");
  } finally {
    await db.close();
  }
});

// --- small helpers ----------------------------------------------------------------

// Read a named sub-schema of the input's z.object `.shape` defensively (the schema exposes
// `.shape` at runtime). Returns undefined when absent, so a test asserts a HELPFUL failure
// rather than throwing.
function subschema(
  schema: unknown,
  field: string,
): { safeParse(v: unknown): { success: boolean } } | undefined {
  const shape = (schema as { shape?: Record<string, { safeParse(v: unknown): { success: boolean } }> } | null)
    ?.shape;
  return shape?.[field];
}
