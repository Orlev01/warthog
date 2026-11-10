// E14-S07 — the task core tools, the obligation acceptance criteria
// (`src/server/mcp/tools/tasks.ts` + its validation / parameterize / no-secret
// boundaries; INV-102 validate-and-parameterize-input, INV-103 secrets-from-env).
//
// RED-first: `./tasks` does not exist yet, so importing the four tool factories throws
// and every test here fails until the builder writes the module. That absence IS the
// point of test-first; do NOT implement anything to make these pass.
//
// These tests pin BEHAVIOUR, never source text. The pinned tool contract is documented
// in the sibling `tasks.test.ts`; this file depends on the same
// `createListTasksTool` / `createCreateTaskTool` / `createUpdateTaskTool` /
// `createCompleteTaskTool` factories and their `handle(input, connection)` surface.
//
//   AC [obligation:validate-and-parameterize-input] (INV-102) —
//     • each handler rejects a malformed / oversized / mis-shaped input with a 4xx
//       HttpError BEFORE any database access (a LANDMINE db throws a plain Error if
//       reached, so skipped validation surfaces as a non-4xx and reddens the test); and
//     • a SQL-injection probe in an input field cannot alter a query: create_task stores
//       its title DEK-encrypted and binds the plaintext assignee as a value through the
//       parameterized tasks store, so a SQL-shaped field is inert data — it drops
//       nothing, is stored verbatim, and the real tasks survive and stay readable.
//   AC [obligation:secrets-from-env] (INV-103) — the tools run purely from their injected
//     `db` + `keyWrapper` seams and read no `process.env`, so a decoy env secret never
//     lands in a returned result; config flows in, never baked in.
//
// Each real-db test uses its own `freshDb()` (an isolated in-memory PGlite with the real
// migrations) closed in a `finally`. Tests never touch the network or Azure.

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
import { createUser } from "../../db/users";
import { upsertPermissions } from "../../db/agent-permissions";
import { freshDb } from "../../../test/db";
import { HttpError } from "../../http/validate";
import { fixedClock, type Clock } from "../../seams/clock";
import { localAesKeyWrapper, type KeyWrapper } from "../../crypto/key-wrapper";
import type { AgentConnection } from "../context";
import type { Db } from "../../db/index";

interface TaskToolResult {
  readonly status: string;
  readonly id?: string;
  readonly tasks?: ReadonlyArray<{ title?: string }>;
  readonly reason?: string;
}

type Grants = Parameters<typeof upsertPermissions>[1];

const DEK_BYTES = 32;
const KEK_BYTES = 32;
const NOW = new Date("2026-11-15T12:00:00.000Z");

const is4xx = (err: unknown): boolean =>
  err instanceof HttpError && err.status >= 400 && err.status < 500;

function keyWrapperFor(): KeyWrapper {
  return localAesKeyWrapper(randomBytes(KEK_BYTES));
}

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

function connectionFor(userId: string, connectionId = randomUUID()): AgentConnection {
  return { userId, connectionId, agentId: connectionId, active: true };
}

function tasksDeps(db: Db, keyWrapper: KeyWrapper, clock: Clock) {
  return { db, keyWrapper, clock };
}

function baseGrants(userId: string, connectionId: string, overrides: Partial<Grants> = {}): Grants {
  return {
    userId,
    connectionId,
    grantedConnectors: [],
    readTools: true,
    changeTools: "allow",
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

async function grantTasks(db: Db, userId: string, connectionId: string): Promise<void> {
  await upsertPermissions(db, baseGrants(userId, connectionId));
}

// A db seam whose every method throws: if validation is skipped and a handler reaches
// the db for an invalid input, the thrown error is a plain Error (NOT a 4xx HttpError)
// and the `is4xx` predicate fails the test — proving validation runs BEFORE any db access.
function landmineDb(): Db {
  return {
    query(): never {
      throw new Error("db.query must not run for invalid input");
    },
    close(): Promise<void> {
      return Promise.resolve();
    },
  } as Db;
}

// A KeyWrapper landmine: an invalid input must be rejected before any crypto work.
function landmineKeyWrapper(): KeyWrapper {
  return {
    wrap(): never {
      throw new Error("keyWrapper.wrap must not run for invalid input");
    },
    unwrap(): never {
      throw new Error("keyWrapper.unwrap must not run for invalid input");
    },
  } as KeyWrapper;
}

// A recording wrapper over a REAL db: it records each (text, values) and delegates, so a
// test can prove WHAT reached the query layer and HOW (bound value vs. spliced text).
interface RecordingDb extends Db {
  readonly calls: { text: string; values: unknown[] }[];
}
function recordingDb(real: Db): RecordingDb {
  const calls: { text: string; values: unknown[] }[] = [];
  return {
    calls,
    query(text: string, values: unknown[] = []) {
      calls.push({ text, values });
      return real.query(text, values);
    },
    close() {
      return real.close();
    },
  };
}

// ===========================================================================
// AC [validate-and-parameterize-input] — a mis-shaped / oversized input is rejected with
// a 4xx BEFORE any db access. The db + keyWrapper are LANDMINES: reaching either before
// validating turns the rejection into a non-4xx and fails the test.
// ===========================================================================

test("create_task rejects a mis-shaped or oversized input with a 4xx, before any db access", async () => {
  const tool = createCreateTaskTool(tasksDeps(landmineDb(), landmineKeyWrapper(), fixedClock(NOW)));
  const conn = connectionFor("validate-create");

  await assert.rejects(() => tool.handle(42, conn), (e: unknown) => is4xx(e), "a number input is a 4xx");
  await assert.rejects(() => tool.handle("a string", conn), (e: unknown) => is4xx(e), "a bare string input is a 4xx");
  await assert.rejects(() => tool.handle({ reason: "fyi" }, conn), (e: unknown) => is4xx(e), "a MISSING title is a 4xx");
  await assert.rejects(() => tool.handle({ title: 999 }, conn), (e: unknown) => is4xx(e), "a non-string title is a 4xx");
  await assert.rejects(() => tool.handle({ title: "" }, conn), (e: unknown) => is4xx(e), "an EMPTY title is a 4xx");
  await assert.rejects(
    () => tool.handle({ title: "x".repeat(100_000) }, conn),
    (e: unknown) => is4xx(e),
    "a grossly oversized title is a 4xx",
  );
  await assert.rejects(
    () => tool.handle({ title: "ok", reason: "x".repeat(100_000) }, conn),
    (e: unknown) => is4xx(e),
    "a grossly oversized reason is a 4xx",
  );
});

test("update_task rejects a mis-shaped or oversized input with a 4xx, before any db access", async () => {
  const tool = createUpdateTaskTool(tasksDeps(landmineDb(), landmineKeyWrapper(), fixedClock(NOW)));
  const conn = connectionFor("validate-update");

  await assert.rejects(() => tool.handle(42, conn), (e: unknown) => is4xx(e), "a number input is a 4xx");
  await assert.rejects(() => tool.handle({ status: "done" }, conn), (e: unknown) => is4xx(e), "a MISSING id is a 4xx");
  await assert.rejects(() => tool.handle({ id: 999 }, conn), (e: unknown) => is4xx(e), "a non-string id is a 4xx");
  await assert.rejects(() => tool.handle({ id: "" }, conn), (e: unknown) => is4xx(e), "an EMPTY id is a 4xx");
  await assert.rejects(
    () => tool.handle({ id: "task-1", note: "x".repeat(100_000) }, conn),
    (e: unknown) => is4xx(e),
    "a grossly oversized note is a 4xx",
  );
});

test("complete_task rejects a mis-shaped input with a 4xx, before any db access", async () => {
  const tool = createCompleteTaskTool(tasksDeps(landmineDb(), landmineKeyWrapper(), fixedClock(NOW)));
  const conn = connectionFor("validate-complete");

  await assert.rejects(() => tool.handle(42, conn), (e: unknown) => is4xx(e), "a number input is a 4xx");
  await assert.rejects(() => tool.handle({}, conn), (e: unknown) => is4xx(e), "a MISSING id is a 4xx");
  await assert.rejects(() => tool.handle({ id: 999 }, conn), (e: unknown) => is4xx(e), "a non-string id is a 4xx");
  await assert.rejects(() => tool.handle({ id: "" }, conn), (e: unknown) => is4xx(e), "an EMPTY id is a 4xx");
});

test("list_tasks rejects a mis-shaped or oversized input with a 4xx, before any db access", async () => {
  const tool = createListTasksTool(tasksDeps(landmineDb(), landmineKeyWrapper(), fixedClock(NOW)));
  const conn = connectionFor("validate-list");

  await assert.rejects(() => tool.handle(42, conn), (e: unknown) => is4xx(e), "a number input is a 4xx");
  await assert.rejects(() => tool.handle({ reason: 999 }, conn), (e: unknown) => is4xx(e), "a non-string reason is a 4xx");
  await assert.rejects(
    () => tool.handle({ reason: "x".repeat(100_000) }, conn),
    (e: unknown) => is4xx(e),
    "a grossly oversized reason is a 4xx",
  );
});

test("the task tools accept small, well-formed input and reach the store (not a 4xx)", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const { userId } = await makePerson(db, "accepted", keyWrapper);
    const conn = connectionFor(userId);
    await grantTasks(db, userId, conn.connectionId);
    const deps = tasksDeps(db, keyWrapper, fixedClock(NOW));

    const created = (await createCreateTaskTool(deps).handle(
      { title: "A small, well-formed task.", reason: "ok" },
      conn,
    )) as TaskToolResult;
    assert.equal(created.status, "created", "a well-formed create_task is stored, not rejected as a 4xx");

    const listed = (await createListTasksTool(deps).handle({ reason: "ok" }, conn)) as TaskToolResult;
    assert.equal(listed.status, "ok", "a well-formed list_tasks reads the store, not a 4xx");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC [validate-and-parameterize-input] — a SQL-injection probe is inert: create_task
// stores free text DEK-encrypted and rejects an invalid assignee before writing.
// Neither probe changes SQL; the real task survives and stays readable.
// Parameter binding is proven on the recording db.
// ===========================================================================

test("a SQL-shaped create_task is inert data: saved, nothing dropped, the real task survives", async () => {
  const real = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const { userId, dek } = await makePerson(real, "sql-create", keyWrapper);
    const conn = connectionFor(userId);
    await grantTasks(real, userId, conn.connectionId);

    // A canary task created BEFORE the probe — it must still be there afterwards.
    const CANARY = "A canary task that must survive the probe.";
    await createTask(real, { userId, title: CANARY, assignee: "any", createdBy: { kind: "person" } }, dek);

    const rec = recordingDb(real);
    const tool = createCreateTaskTool(tasksDeps(rec, keyWrapper, fixedClock(NOW)));

    const titleProbe = "Buy milk'; DROP TABLE tasks; --";
    const assigneeProbe = "any'; DROP TABLE tasks; --";
    const rejected = (await tool.handle({ title: titleProbe, assignee: assigneeProbe }, conn)) as TaskToolResult;
    assert.equal(rejected.status, "refused", "an assignee must be any or an owned connected agent");
    assert.equal((await listTasksForUser(real, userId, dek)).length, 1, "invalid assignment writes nothing");
    const result = (await tool.handle({ title: titleProbe, assignee: "any" }, conn)) as TaskToolResult;
    assert.equal(result.status, "created", "free-text probe content is stored as ordinary data");

    // If a probe had been spliced into SQL, the tasks table would be gone; it is not —
    // the canary AND the probe-as-literal-data are both readable.
    const stored = await listTasksForUser(real, userId, dek);
    const titles = stored.map((t) => t.title);
    assert.ok(titles.includes(CANARY), "the tasks table survived — the canary is intact");
    assert.ok(titles.includes(titleProbe), "the title probe was stored verbatim as inert data, not executed");
    const probed = stored.find((t) => t.title === titleProbe);
    assert.equal(probed!.assignee, "any", "the valid assignment is preserved");

    // Parameter binding: neither attacker string ever appears in any SQL TEXT, and the
    // owning user id and the plaintext assignee travel as BOUND values.
    for (const call of rec.calls) {
      assert.ok(!call.text.includes(titleProbe), "the title probe is never spliced into the SQL text");
      assert.ok(!call.text.includes(assigneeProbe), "the assignee probe is never spliced into the SQL text");
      assert.ok(!call.text.toUpperCase().includes("DROP TABLE"), "no injected statement appears in the SQL");
    }
    assert.ok(
      rec.calls.some((c) => c.values.includes(userId)),
      "the owning user id travels as a BOUND value (member-scoped, parameterized)",
    );
    assert.ok(
      rec.calls.some((c) => c.values.includes("any")),
      "the plaintext assignee travels as a BOUND value, never spliced into the SQL",
    );
  } finally {
    await real.close();
  }
});

// ===========================================================================
// AC [secrets-from-env] — the tools read no process.env: a decoy env secret never appears
// in a returned result. They run purely from their injected db + keyWrapper + clock seams.
// ===========================================================================

test("the task tools read no process.env: a decoy env secret never appears in a result", async () => {
  const DECOY = "sk_live_DECOY_must_never_appear_in_warthog";
  const prev = process.env.WARTHOG_DECOY_SECRET;
  process.env.WARTHOG_DECOY_SECRET = DECOY;
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const { userId } = await makePerson(db, "secrets-env", keyWrapper);
    const conn = connectionFor(userId);
    await grantTasks(db, userId, conn.connectionId);
    const deps = tasksDeps(db, keyWrapper, fixedClock(NOW));

    const created = await createCreateTaskTool(deps).handle({ title: "A task worth doing.", reason: "go" }, conn);
    assert.ok(!JSON.stringify(created ?? {}).includes(DECOY), "no ambient env value is folded into the create result");

    const listed = await createListTasksTool(deps).handle({}, conn);
    assert.ok(!JSON.stringify(listed ?? {}).includes(DECOY), "no ambient env value is folded into the list result");
  } finally {
    await db.close();
    if (prev === undefined) delete process.env.WARTHOG_DECOY_SECRET;
    else process.env.WARTHOG_DECOY_SECRET = prev;
  }
});
