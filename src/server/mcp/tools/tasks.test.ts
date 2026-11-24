import { createAgent } from "../../db/agents";
// E14-S07 — the `list_tasks` / `create_task` / `update_task` / `complete_task` core
// tools (`src/server/mcp/tools/tasks.ts`, design §6.2 MCP core tools; brief §"Tasks
// and hand-offs": "a task list the person and agents share: the person (or an agent)
// creates a task, assigns it to a specific agent or 'any agent', and agents pick it
// up, add notes and mark it done"; constitution principle 14 "Warthog … SHALL record
// every tool call itself at the moment it handles it").
//
// RED-first: `./tasks` does not exist yet, so importing the four tool factories throws
// and every test here fails until the builder writes the minimum code to pass. That
// absence IS the point of test-first; do NOT implement anything to make these pass —
// the builder writes `tasks.ts` afterwards. (The tasks STORE these tools read/write —
// `createTask` / `listTasksForUser` / `tasksForAgent` / `updateTask` / `addNote` /
// `completeTask` — the permission store `getConnectionPermissions` / `upsertPermissions`,
// the registry and the pipeline they route through all ALREADY exist and are driven
// here as real, tested seams.)
//
// These tests pin BEHAVIOUR (what each tool DOES: the task row it stores, the set it
// hands an agent, who it refuses, the person's-own scope, and that it runs through the
// pipeline so a tool call is recorded), never the source text of any module — a later
// rename that preserves behaviour must not redden them.
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
//   interface TasksToolDeps {
//     readonly db: Db;                 // the parameterizing db seam (permissions + the tasks store)
//     readonly keyWrapper: KeyWrapper; // unwraps the person's DEK (encrypt title/notes / decrypt on read)
//     readonly clock?: Clock;          // harmless if unused — the tasks store takes no clock
//   }
//
//   // list_tasks — hand the agent the tasks it may SEE: the person's tasks whose
//   // assignee is THIS agent or 'any' (via the store's `tasksForAgent`), each title
//   // DECRYPTED. Refused when the connection has no tasks permission.
//   type ListTasksResult =
//     | { status: "ok"; tasks: ReadonlyArray<{ id; title; assignee; status; notes; createdBy }> }
//     | { status: "refused"; reason: string };
//   function createListTasksTool(deps): { name: "list_tasks"; inputSchema; handle(input, connection) };
//
//   // create_task — create a task FOR the connection's person, assigned to a specific
//   // agent or 'any' (defaulting to 'any'), created-by the connection's AGENT, status
//   // 'open'. Refused when the connection has no tasks permission.
//   type CreateTaskResult =
//     | { status: "created"; id: string }
//     | { status: "refused"; reason: string };
//   function createCreateTaskTool(deps): { name: "create_task"; inputSchema; handle(input, connection) };
//
//   // update_task — change a task the person OWNS (member-scoped by the connection's
//   // userId): set its `status` (pick it up) and/or append a `note` authored by the
//   // connection's agent. Refused without the tasks permission; a refusal (NOT a throw)
//   // when no such task belongs to the person.
//   type UpdateTaskResult =
//     | { status: "updated"; id: string }
//     | { status: "refused"; reason: string };
//   function createUpdateTaskTool(deps): { name: "update_task"; inputSchema; handle(input, connection) };
//
//   // complete_task — mark a task the person OWNS done. Refused without the tasks
//   // permission; a refusal when no such task belongs to the person.
//   type CompleteTaskResult =
//     | { status: "completed"; id: string }
//     | { status: "refused"; reason: string };
//   function createCompleteTaskTool(deps): { name: "complete_task"; inputSchema; handle(input, connection) };
//
// THE TASKS PERMISSION. The connection's grants carry no dedicated "tasks" flag (the
// brief lists read tools and change-making tools separately); so a READ (`list_tasks`)
// needs the connection's `readTools` grant and a CHANGE (`create_task`/`update_task`/
// `complete_task`) needs its `changeTools` grant to be on. A connection that can
// NEITHER read NOR change — `readTools:false` AND `changeTools:"off"` — has no tasks
// permission and every tool refuses it with a plain reason. (The refusal lives INSIDE
// the tool, like the memory tools' `memoryRead` gate: the policy engine does not gate a
// core tool whose `connector` is null, so the tool checks its own permission.)
//
// The OWNING person and the agent are ALWAYS taken from the session `connection`
// (`connection.userId` owns; `connection.agentId` is the assignee scope / the note's
// and the task's author / the permission key via `connection.connectionId`), never a
// value in the input — so one agent can never create against, read, or change another
// person's tasks.
//
// "records an activity entry" (an AC) is pinned by routing `create_task` through a real
// `createAgentCallPipeline` (the production path: it is a core tool the registry routes
// through the pipeline), which writes ONE `source:"warthog"` activity entry for the
// call BEFORE the response — Warthog writes the record itself (principle 14). "exposed
// through the core tool registry" is pinned by building the real registry and finding
// the four tool names in its always-available core.
//
// Every db handle is closed in a `finally` so node:test leaves no open handle; each test
// uses its own `freshDb()` (an isolated in-memory PGlite with the real migrations). Tests
// never touch the network, Azure or a real database.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";

import {
  createListTasksTool,
  createCreateTaskTool,
  createUpdateTaskTool,
  createCompleteTaskTool,
} from "./tasks";
import { createTask, listTasksForUser } from "../../db/tasks";
import { createToolRegistry } from "./registry";
import { createAgentCallPipeline, type AgentCall, type AgentCallResult, type AgentCallPipeline } from "../pipeline";
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
// tests assert on `status` + the field a status carries, leaving the builder free to pin
// the exact discriminated-union members as long as the behaviour holds.
interface TaskView {
  readonly id?: string;
  readonly title?: string;
  readonly assignee?: string;
  readonly status?: string;
  readonly notes?: ReadonlyArray<{ author?: unknown; text?: string }>;
  readonly createdBy?: unknown;
}
interface ListTasksResult {
  readonly status: string;
  readonly tasks?: ReadonlyArray<TaskView>;
  readonly reason?: string;
}
interface CreateTaskResult {
  readonly status: string;
  readonly id?: string;
  readonly reason?: string;
}
interface UpdateTaskResult {
  readonly status: string;
  readonly id?: string;
  readonly reason?: string;
}
interface CompleteTaskResult {
  readonly status: string;
  readonly id?: string;
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
// the DEK from the user row through the wrapper), returning their id and the raw DEK — so
// reading tasks back under that same raw key proves a tool stored / read under the
// person's OWN key.
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
// bites whichever subset the builder's factory declares (clock is harmless if unused).
function tasksDeps(db: Db, keyWrapper: KeyWrapper, clock: Clock) {
  return { db, keyWrapper, clock };
}

// A fully-populated grants record for a connection; a test overrides only what it is
// about (readTools gates `list_tasks`; changeTools gates the change tools). Built via a
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

// Grant one connection the tasks permission (it may both read and change) — so every
// task tool is allowed. Keyed by connectionId, exactly as the tool reads it.
async function grantTasks(db: Db, userId: string, connectionId: string): Promise<void> {
  await upsertPermissions(db, baseGrants(userId, connectionId, { readTools: true, changeTools: "allow" }));
}

// Grant one connection NO tasks permission: it may neither read nor change — so every
// task tool refuses it, whichever class a given tool checks.
async function grantNoTasks(db: Db, userId: string, connectionId: string): Promise<void> {
  await upsertPermissions(db, baseGrants(userId, connectionId, { readTools: false, changeTools: "off" }));
}

// A recorder that wraps the REAL in-memory recorder (so redaction + chaining really
// happen) and captures each input, so the pipeline test can prove the tool call was
// recorded.
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

// A pipeline spy for the registry-exposure test: it only needs to satisfy the
// AgentCallPipeline shape the registry closes over.
function spyPipeline(): AgentCallPipeline {
  return {
    async handleAgentCall(): Promise<AgentCallResult> {
      return { status: "executed", result: { ok: true } };
    },
    async executeApprovedHold() {
      return { status: "refused" as const, reason: "unused in these tests" };
    },
  };
}

// Narrowing helper (assert.fail is `never`, so the result narrows after).
function expectExecuted(r: AgentCallResult) {
  if (r.status !== "executed") {
    assert.fail(`expected an executed result, got "${r.status}": ${JSON.stringify(r)}`);
  }
  return r;
}

// Find the one task in a decrypted owner-list whose title matches.
function byTitle(tasks: ReadonlyArray<{ title: string }>, title: string) {
  return tasks.find((t) => t.title === title);
}

// ===========================================================================
// AC1 — create_task creates a task FOR the connection's person, assigned to 'any' by
// default, created-by the connection's agent, status 'open'. The STORED row is the proof.
// ===========================================================================

test("create_task creates a task for the person, assignee defaults to 'any', created-by the agent, status open", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const { userId, dek } = await makePerson(db, "create-default", keyWrapper);
    const conn = connectionFor(userId);
    await grantTasks(db, userId, conn.connectionId);

    const tool = createCreateTaskTool(tasksDeps(db, keyWrapper, fixedClock(NOW)));
    const TITLE = "Switch my energy provider";
    const result = (await tool.handle({ title: TITLE }, conn)) as CreateTaskResult;
    assert.equal(result.status, "created", "a permitted create_task reports it created the task");
    assert.equal(typeof result.id, "string", "it hands back the new task's id");

    // Read it back under the person's OWN key.
    const stored = await listTasksForUser(db, userId, dek);
    assert.equal(stored.length, 1, "exactly one task was written for the person");
    const task = stored[0];
    assert.equal(task.title, TITLE, "the title round-trips (DEK-encrypted at rest)");
    assert.equal(task.assignee, "any", "no assignee given ⇒ the task is for ANY agent");
    assert.equal(task.status, "open", "a new task starts open");
    assert.deepEqual(task.createdBy, { kind: "agent", agentId: conn.agentId }, "created-by the connection's agent");
    assert.equal(task.id, result.id, "the returned id is the stored task's id");
  } finally {
    await db.close();
  }
});

test("create_task can assign a task to a SPECIFIC agent (an agent hands work to another)", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const { userId, dek } = await makePerson(db, "create-assigned", keyWrapper);
    const maker = connectionFor(userId);
    const target = await createAgent(db, { userId, connectionId: randomUUID(), displayName: "Other", platform: "Other" }, fixedClock(NOW));
    const other = connectionFor(userId, {agentId: target.id, connectionId: target.connectionId});
    await grantTasks(db, userId, maker.connectionId);

    const tool = createCreateTaskTool(tasksDeps(db, keyWrapper, fixedClock(NOW)));
    const result = (await tool.handle(
      { title: "Book removalists", assignee: other.agentId },
      maker,
    )) as CreateTaskResult;
    assert.equal(result.status, "created", "the assigned create_task succeeds");

    const stored = await listTasksForUser(db, userId, dek);
    assert.equal(stored.length, 1, "one task written");
    assert.equal(stored[0].assignee, other.agentId, "the task is assigned to the named agent");
    assert.deepEqual(stored[0].createdBy, { kind: "agent", agentId: maker.agentId }, "still created-by the MAKER agent");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC1 — list_tasks returns the tasks THIS agent may see: the person's tasks assigned to
// it OR to 'any', each title DECRYPTED — never one assigned to a DIFFERENT specific agent.
// The set is seeded through the tested store so the read authorisation is exercised alone.
// ===========================================================================

test("list_tasks returns tasks assigned to the agent or 'any', decrypted — and not another agent's", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const { userId, dek } = await makePerson(db, "list-scope", keyWrapper);
    const me = connectionFor(userId);
    const other = connectionFor(userId);

    const MINE = "Renew my passport (mine to do)";
    const ANY = "Anyone can pick this up";
    const THEIRS = "Assigned to the other agent only";
    await createTask(db, { userId, title: MINE, assignee: me.agentId, createdBy: { kind: "person" } }, dek);
    await createTask(db, { userId, title: ANY, assignee: "any", createdBy: { kind: "person" } }, dek);
    await createTask(db, { userId, title: THEIRS, assignee: other.agentId, createdBy: { kind: "person" } }, dek);

    await grantTasks(db, userId, me.connectionId);

    const tool = createListTasksTool(tasksDeps(db, keyWrapper, fixedClock(NOW)));
    const result = (await tool.handle({}, me)) as ListTasksResult;
    assert.equal(result.status, "ok", "a permitted list_tasks returns a list");
    const titles = new Set((result.tasks ?? []).map((t) => t.title));

    assert.ok(titles.has(MINE), "a task assigned to THIS agent is returned");
    assert.ok(titles.has(ANY), "a task assigned to 'any' is returned");
    assert.ok(!titles.has(THEIRS), "a task assigned to ANOTHER specific agent is NOT returned");
    assert.equal(titles.size, 2, "exactly the two the agent may see — no more");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC1 — update_task changes a task the person owns: set its STATUS (pick it up) and
// APPEND a note authored by the agent, both verified in the stored row under the owner's key.
// ===========================================================================

test("update_task sets the status on the person's task (picking it up)", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const { userId, dek } = await makePerson(db, "update-status", keyWrapper);
    const conn = connectionFor(userId);
    await grantTasks(db, userId, conn.connectionId);

    const TITLE = "Chase the energy rebate";
    const seeded = await createTask(db, { userId, title: TITLE, assignee: conn.agentId, createdBy: { kind: "person" } }, dek);

    const tool = createUpdateTaskTool(tasksDeps(db, keyWrapper, fixedClock(NOW)));
    const result = (await tool.handle({ id: seeded.id, status: "in_progress" }, conn)) as UpdateTaskResult;
    assert.equal(result.status, "updated", "a permitted update_task reports it updated the task");

    const stored = await listTasksForUser(db, userId, dek);
    const task = byTitle(stored, TITLE);
    assert.ok(task, "the task is still there");
    assert.equal(task!.status, "in_progress", "the status moved to in_progress");
    assert.equal(task!.title, TITLE, "the title is untouched by a status-only update");
  } finally {
    await db.close();
  }
});

test("update_task appends a note authored by the connection's agent", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const { userId, dek } = await makePerson(db, "update-note", keyWrapper);
    const conn = connectionFor(userId);
    await grantTasks(db, userId, conn.connectionId);

    const TITLE = "Compare removalist quotes";
    const seeded = await createTask(db, { userId, title: TITLE, assignee: conn.agentId, createdBy: { kind: "person" } }, dek);

    const tool = createUpdateTaskTool(tasksDeps(db, keyWrapper, fixedClock(NOW)));
    const NOTE = "Got three quotes; the cheapest is on the 2nd.";
    const result = (await tool.handle({ id: seeded.id, note: NOTE }, conn)) as UpdateTaskResult;
    assert.equal(result.status, "updated", "the note-adding update_task succeeds");

    const stored = await listTasksForUser(db, userId, dek);
    const task = byTitle(stored, TITLE);
    assert.ok(task, "the task survived");
    assert.equal(task!.notes.length, 1, "exactly one note was appended");
    assert.equal(task!.notes[0].text, NOTE, "the note text round-trips (DEK-encrypted at rest)");
    assert.deepEqual(task!.notes[0].author, { kind: "agent", agentId: conn.agentId }, "the note is authored by the connection's agent");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC1 — complete_task marks the person's own task done.
// ===========================================================================

test("complete_task marks the person's task done", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const { userId, dek } = await makePerson(db, "complete", keyWrapper);
    const conn = connectionFor(userId);
    await grantTasks(db, userId, conn.connectionId);

    const TITLE = "File the quarterly return";
    const seeded = await createTask(db, { userId, title: TITLE, assignee: conn.agentId, createdBy: { kind: "person" } }, dek);

    const tool = createCompleteTaskTool(tasksDeps(db, keyWrapper, fixedClock(NOW)));
    const result = (await tool.handle({ id: seeded.id }, conn)) as CompleteTaskResult;
    assert.equal(result.status, "completed", "a permitted complete_task reports it completed the task");

    const stored = await listTasksForUser(db, userId, dek);
    const task = byTitle(stored, TITLE);
    assert.ok(task, "the task is still there");
    assert.equal(task!.status, "done", "its status is now done");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC2 — every tool is refused with a plain reason for a connection WITHOUT the tasks
// permission (it can neither read nor change), and a refused create writes nothing.
// ===========================================================================

test("every task tool refuses a connection without the tasks permission (with a plain reason)", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const { userId, dek } = await makePerson(db, "no-perm", keyWrapper);
    const conn = connectionFor(userId);
    await grantNoTasks(db, userId, conn.connectionId);

    // A task already exists (seeded by the person), so a refusal can only be the gate.
    const seeded = await createTask(db, { userId, title: "A task the agent may not touch", assignee: "any", createdBy: { kind: "person" } }, dek);

    const deps = tasksDeps(db, keyWrapper, fixedClock(NOW));

    const listed = (await createListTasksTool(deps).handle({}, conn)) as ListTasksResult;
    assert.equal(listed.status, "refused", "list_tasks is refused without the tasks permission");
    assert.ok((listed.reason ?? "").length > 0, "the refusal carries a plain reason");

    const created = (await createCreateTaskTool(deps).handle({ title: "Should never be stored" }, conn)) as CreateTaskResult;
    assert.equal(created.status, "refused", "create_task is refused");
    assert.ok((created.reason ?? "").length > 0, "with a plain reason");

    const updated = (await createUpdateTaskTool(deps).handle({ id: seeded.id, status: "in_progress" }, conn)) as UpdateTaskResult;
    assert.equal(updated.status, "refused", "update_task is refused");

    const completed = (await createCompleteTaskTool(deps).handle({ id: seeded.id }, conn)) as CompleteTaskResult;
    assert.equal(completed.status, "refused", "complete_task is refused");

    // Nothing changed: still ONE task, still open, and no second (refused) task was written.
    const stored = await listTasksForUser(db, userId, dek);
    assert.equal(stored.length, 1, "a refused create wrote nothing");
    assert.equal(stored[0].status, "open", "a refused update/complete changed nothing");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC2/AC3 — the owner and the agent come ONLY from the CONNECTION (the input carries no
// identity field): the task belongs to the connection's person and is created-by the
// connection's agent, and never lands against any other person.
// ===========================================================================

test("create_task owns the task to the connection's person and never to another", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const me = await makePerson(db, "owner-me", keyWrapper);
    const other = await makePerson(db, "other-person", keyWrapper);
    const conn = connectionFor(me.userId);
    await grantTasks(db, me.userId, conn.connectionId);

    const tool = createCreateTaskTool(tasksDeps(db, keyWrapper, fixedClock(NOW)));
    await tool.handle({ title: "Routed by the connection, not the body" }, conn);

    const mine = await listTasksForUser(db, me.userId, me.dek);
    assert.equal(mine.length, 1, "the task is owned by the connection's person");
    assert.deepEqual(mine[0].createdBy, { kind: "agent", agentId: conn.agentId }, "created-by the connection's agent");

    const theirs = await listTasksForUser(db, other.userId, other.dek);
    assert.equal(theirs.length, 0, "nothing was written against any other person");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC3 — a tool call cannot READ another person's tasks: the person comes from the
// connection, so one person's agent never sees another person's tasks, even 'any' ones.
// ===========================================================================

test("list_tasks never returns another person's tasks (userId comes from the connection)", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const a = await makePerson(db, "person-a", keyWrapper);
    const b = await makePerson(db, "person-b", keyWrapper);

    const A_ANY = "Person A's 'any' task — A's agents only";
    await createTask(db, { userId: a.userId, title: A_ANY, assignee: "any", createdBy: { kind: "person" } }, a.dek);

    // B's agent is fully permitted FOR B, and asks — but B owns no tasks, and A's never cross.
    const bConn = connectionFor(b.userId);
    await grantTasks(db, b.userId, bConn.connectionId);

    const tool = createListTasksTool(tasksDeps(db, keyWrapper, fixedClock(NOW)));
    const result = (await tool.handle({}, bConn)) as ListTasksResult;

    assert.equal(result.status, "ok", "B's permitted agent gets a (possibly empty) list, not a refusal");
    const titles = (result.tasks ?? []).map((t) => t.title);
    assert.ok(!titles.includes(A_ANY), "A's 'any' task never crosses to another person's agent");
    assert.equal(titles.length, 0, "B has no tasks of their own, so the list is empty");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC3 — a tool call cannot CHANGE another person's tasks: update_task / complete_task on
// another person's task id are refused (NOT a throw) and leave that task untouched.
// ===========================================================================

test("update_task and complete_task cannot change another person's task", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const a = await makePerson(db, "owner-a", keyWrapper);
    const b = await makePerson(db, "intruder-b", keyWrapper);

    const A_TITLE = "Person A's private task";
    const aTask = await createTask(db, { userId: a.userId, title: A_TITLE, assignee: "any", createdBy: { kind: "person" } }, a.dek);

    // B is a fully-permitted agent OF B — the only thing stopping them is the member scope.
    const bConn = connectionFor(b.userId);
    await grantTasks(db, b.userId, bConn.connectionId);
    const deps = tasksDeps(db, keyWrapper, fixedClock(NOW));

    const updated = (await createUpdateTaskTool(deps).handle({ id: aTask.id, status: "done" }, bConn)) as UpdateTaskResult;
    assert.notEqual(updated.status, "updated", "B cannot update A's task");

    const completed = (await createCompleteTaskTool(deps).handle({ id: aTask.id }, bConn)) as CompleteTaskResult;
    assert.notEqual(completed.status, "completed", "B cannot complete A's task");

    // A's task is exactly as A left it.
    const aTasks = await listTasksForUser(db, a.userId, a.dek);
    assert.equal(aTasks.length, 1, "A still has their one task");
    assert.equal(aTasks[0].status, "open", "A's task is untouched by B");
    assert.equal(aTasks[0].title, A_TITLE, "A's task title is untouched by B");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC3 — the four task tools are exposed to the agent through the core tool registry.
// ===========================================================================

test("the four task tools are exposed through the core tool registry", async () => {
  const registry = createToolRegistry({ pipeline: spyPipeline() });
  const coreNames = new Set(registry.coreTools.map((t) => t.name));

  for (const name of ["list_tasks", "create_task", "update_task", "complete_task"]) {
    assert.ok(coreNames.has(name), `${name} is one of the always-available core tools`);
    assert.ok(registry.get(name), `${name} is resolvable by name from the registry`);
  }
});

// ===========================================================================
// AC1 — the tool call is RECORDED. Routed through a real pipeline (the production path
// for a core tool), an allowed create_task executes (creates the task) and Warthog writes
// ONE `source:"warthog"` activity entry for the call.
// ===========================================================================

test("through the pipeline: an allowed create_task creates the task and records ONE Warthog entry", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const { userId, dek } = await makePerson(db, "pipe-create", keyWrapper);
    const conn = connectionFor(userId);
    await grantTasks(db, userId, conn.connectionId);

    const tool = createCreateTaskTool(tasksDeps(db, keyWrapper, fixedClock(NOW)));
    const rec = spyRecorder(fixedClock(NOW));
    let runs = 0;
    const pipeline = createAgentCallPipeline({
      db,
      keyWrapper,
      clock: fixedClock(NOW),
      rateLimiter: createRateLimiter(fixedClock(NOW)),
      recorder: rec.recorder,
      // The pipeline executes create_task by dispatching to the tool body, taking the
      // agent / person from the resolved connection it is handed — never from the body.
      executeTool: async (call: AgentCall, connection: AgentConnection) => {
        runs += 1;
        return tool.handle(call.params, connection);
      },
    });

    const call: AgentCall = {
      connector: null,
      tool: "create_task",
      makesChange: true,
      params: { title: "Booked the dentist for the 20th; reminder set." },
    };
    const outcome = expectExecuted(await pipeline.handleAgentCall(conn, call));
    const body = outcome.result as CreateTaskResult;
    assert.equal(body.status, "created", "the allowed call created the task");
    assert.equal(runs, 1, "the tool body ran exactly once");

    // The task really landed.
    const stored = await listTasksForUser(db, userId, dek);
    assert.equal(stored.length, 1, "the task write persisted through the pipeline");

    // Warthog recorded the call itself — ONE entry, labelled source "warthog".
    const entries = rec.inputs.filter((e) => e.tool === "create_task" && e.kind === "tool_call");
    assert.equal(entries.length, 1, "the call is recorded as exactly ONE activity entry");
    assert.equal(entries[0].source, "warthog", "Warthog writes the record itself (not the agent)");
    assert.equal(entries[0].userId, userId, "the entry is scoped to the connection's person");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// Envelope — the tools name themselves and carry the right input schema. create_task
// requires a non-empty `title`; update_task and complete_task require a non-empty `id`;
// every tool carries the universal OPTIONAL `reason` (design §6.2).
// ===========================================================================

test("the task tools are named and their input schemas require the right fields", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const deps = tasksDeps(db, keyWrapper, fixedClock(NOW));
    const list = createListTasksTool(deps);
    const create = createCreateTaskTool(deps);
    const update = createUpdateTaskTool(deps);
    const complete = createCompleteTaskTool(deps);

    assert.equal(list.name, "list_tasks", "the read tool names itself list_tasks");
    assert.equal(create.name, "create_task", "the create tool names itself create_task");
    assert.equal(update.name, "update_task", "the update tool names itself update_task");
    assert.equal(complete.name, "complete_task", "the complete tool names itself complete_task");

    // Every tool carries the universal OPTIONAL `reason`.
    for (const tool of [list, create, update, complete]) {
      const reason = subschema(tool.inputSchema, "reason");
      assert.ok(reason, `${tool.name} exposes a \`reason\` field`);
      assert.equal(reason!.safeParse(undefined).success, true, `\`reason\` is OPTIONAL on ${tool.name}`);
      assert.equal(reason!.safeParse(123).success, false, `\`reason\` rejects a non-string on ${tool.name}`);
    }

    // create_task: `title` is REQUIRED and must be a non-empty string.
    const title = subschema(create.inputSchema, "title");
    assert.ok(title, "create_task exposes a `title` field");
    assert.equal(title!.safeParse("Do the thing").success, true, "`title` accepts a non-empty string");
    assert.equal(title!.safeParse(undefined).success, false, "`title` is REQUIRED");
    assert.equal(title!.safeParse("").success, false, "`title` rejects the empty string");
    assert.equal(title!.safeParse(123).success, false, "`title` rejects a non-string");

    // update_task and complete_task: `id` is REQUIRED and must be a non-empty string.
    for (const tool of [update, complete]) {
      const id = subschema(tool.inputSchema, "id");
      assert.ok(id, `${tool.name} exposes an \`id\` field`);
      assert.equal(id!.safeParse("task-1").success, true, `\`id\` accepts a non-empty string on ${tool.name}`);
      assert.equal(id!.safeParse(undefined).success, false, `\`id\` is REQUIRED on ${tool.name}`);
      assert.equal(id!.safeParse("").success, false, `\`id\` rejects the empty string on ${tool.name}`);
    }
  } finally {
    await db.close();
  }
});

// --- small helpers ----------------------------------------------------------------

// Read a named sub-schema of the input's z.object `.shape` defensively (the schema
// exposes `.shape` at runtime). Returns undefined when absent, so a test asserts a
// HELPFUL failure rather than throwing.
function subschema(
  schema: unknown,
  field: string,
): { safeParse(v: unknown): { success: boolean } } | undefined {
  const shape = (schema as { shape?: Record<string, { safeParse(v: unknown): { success: boolean } }> } | null)
    ?.shape;
  return shape?.[field];
}

// Review fix (unverified finding, confirmed): update_task and complete_task act only on
// the tasks the calling agent can see — assigned to it or to any agent — exactly the set
// list_tasks shows it, never a task assigned to a different agent.
test("update_task and complete_task refuse a task assigned to a different agent", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const { userId, dek } = await makePerson(db, "task-scope", keyWrapper);
    const conn = connectionFor(userId);
    await grantTasks(db, userId, conn.connectionId);
    const others = await createTask(
      db,
      { userId, title: "Someone else's", assignee: randomUUID(), createdBy: { kind: "person" } },
      dek,
    );
    const shared = await createTask(db, { userId, title: "Anyone's", assignee: "any", createdBy: { kind: "person" } }, dek);
    const deps = tasksDeps(db, keyWrapper, fixedClock(NOW));
    const update = createUpdateTaskTool(deps);
    const complete = createCompleteTaskTool(deps);

    assert.equal((await update.handle({ id: others.id, status: "in_progress" }, conn)).status, "refused");
    assert.equal((await complete.handle({ id: others.id }, conn)).status, "refused");
    const untouched = (await listTasksForUser(db, userId, dek)).find((task) => task.id === others.id);
    assert.equal(untouched?.status, "open", "another agent's task is left unchanged");

    assert.equal((await update.handle({ id: shared.id, status: "in_progress" }, conn)).status, "updated");
    assert.equal((await complete.handle({ id: shared.id }, conn)).status, "completed");
  } finally {
    await db.close();
  }
});

// Building a profile (docs/adr/profile-build.md): a task's title or note can't hold what Warthog
// never keeps; the refusal names the rule, never the value.
test("a task title or note refuses what Warthog never keeps", async () => {
  const { createTaskSchema, updateTaskSchema } = await import("./tasks");
  const title = createTaskSchema.safeParse({ title: "Lodge with TFN 123 456 782" });
  assert.equal(title.success, false);
  assert.match(title.error!.issues[0]!.message, /^The task looks like it has a tax file number\./);
  assert.ok(!title.error!.issues[0]!.message.includes("123 456 782"));
  const note = updateTaskSchema.safeParse({ id: "t1", note: "Pay to BSB 062-000 account 12345678" });
  assert.equal(note.success, false);
  assert.match(note.error!.issues[0]!.message, /^The note looks like it has a BSB and account number\./);
  assert.equal(createTaskSchema.safeParse({ title: "Renew the rego before 14 Dec" }).success, true);
});
