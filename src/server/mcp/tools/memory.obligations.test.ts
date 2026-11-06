// E13-S05 — the `remember` / `search_memory` core tools, the obligation acceptance
// criteria (`src/server/mcp/tools/memory.ts` + its validation / parameterize / no-secret
// boundaries; INV-102 validate-and-parameterize-input, INV-103 secrets-from-env).
//
// RED-first: `./memory` does not exist yet, so importing `createRememberTool` /
// `createSearchMemoryTool` throws and every test here fails until the builder writes the
// module. That absence IS the point of test-first; do NOT implement anything to make these
// pass.
//
// These tests pin BEHAVIOUR, never source text. The pinned tool contract is documented in
// the sibling `memory.test.ts`; this file depends on the same
// `createRememberTool({ db, keyWrapper, clock })` / `createSearchMemoryTool({...})`
// factories and their `handle(input, connection)` surface.
//
//   AC [obligation:validate-and-parameterize-input] (INV-102) —
//     • each handler rejects a malformed / oversized / mis-shaped input with a 4xx
//       HttpError BEFORE any database access (a LANDMINE db throws a plain Error if
//       reached, so skipped validation surfaces as a non-4xx and reddens the test); and
//     • a SQL-injection probe in an input field cannot alter a query: remember stores its
//       content DEK-encrypted through the parameterized memory store (the probe becomes
//       inert ciphertext bound as a value), and search filters in the app over the
//       owner-scoped set it reads with `user_id` / `source_agent_id` bound — so a
//       SQL-shaped field errors nothing and leaves the real data intact and still readable.
//   AC [obligation:secrets-from-env] (INV-103) — the tools run purely from their injected
//     `db` + `keyWrapper` (+ `clock`) seams and read no `process.env`, so a decoy env
//     secret never lands in a returned result; config flows in, never baked in.
//
// Each real-db test uses its own `freshDb()` (an isolated in-memory PGlite with the real
// migrations) closed in a `finally`. Tests never touch the network or Azure.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";

import { createRememberTool, createSearchMemoryTool } from "./memory";
import { createMemory, listMemoriesForUser } from "../../db/memories";
import { createUser } from "../../db/users";
import { upsertPermissions } from "../../db/agent-permissions";
import { freshDb } from "../../../test/db";
import { HttpError } from "../../http/validate";
import { fixedClock, type Clock } from "../../seams/clock";
import { localAesKeyWrapper, type KeyWrapper } from "../../crypto/key-wrapper";
import type { AgentConnection } from "../context";
import type { Db } from "../../db/index";

interface RememberResult {
  readonly status: string;
  readonly reason?: string;
}
interface SearchMemoryResult {
  readonly status: string;
  readonly memories?: ReadonlyArray<{ content?: string }>;
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

function memoryDeps(db: Db, keyWrapper: KeyWrapper, clock: Clock) {
  return { db, keyWrapper, clock };
}

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

async function grantMemory(db: Db, userId: string, connectionId: string): Promise<void> {
  await upsertPermissions(db, baseGrants(userId, connectionId, { memoryRead: true }));
}

// A db seam whose every method throws: if validation is skipped and a handler reaches the
// db for an invalid input, the thrown error is a plain Error (NOT a 4xx HttpError) and the
// `is4xx` predicate fails the test — proving validation runs BEFORE any db access.
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
// AC [validate-and-parameterize-input] — a mis-shaped input is rejected with a 4xx BEFORE
// any db access. The db + keyWrapper are LANDMINES: reaching either before validating turns
// the rejection into a non-4xx and fails the test.
// ===========================================================================

test("remember rejects a mis-shaped input with a 4xx, before any db access", async () => {
  const tool = createRememberTool(memoryDeps(landmineDb(), landmineKeyWrapper(), fixedClock(NOW)));
  const conn = connectionFor("validate-person");

  await assert.rejects(() => tool.handle(42, conn), (e: unknown) => is4xx(e), "a number input is a 4xx");
  await assert.rejects(
    () => tool.handle("just a string", conn),
    (e: unknown) => is4xx(e),
    "a bare string input is a 4xx (the input is an object with a `content`)",
  );
  await assert.rejects(
    () => tool.handle({ reason: "fyi" }, conn),
    (e: unknown) => is4xx(e),
    "a MISSING content is a 4xx (a memory is saved WITH content)",
  );
  await assert.rejects(
    () => tool.handle({ content: 999 }, conn),
    (e: unknown) => is4xx(e),
    "a non-string content is a 4xx",
  );
  await assert.rejects(
    () => tool.handle({ content: "" }, conn),
    (e: unknown) => is4xx(e),
    "an EMPTY content is a 4xx (there is nothing to remember)",
  );
});

test("remember rejects an OVERSIZED content or reason with a 4xx before any db access", async () => {
  const tool = createRememberTool(memoryDeps(landmineDb(), landmineKeyWrapper(), fixedClock(NOW)));
  const conn = connectionFor("oversize-person");

  await assert.rejects(
    () => tool.handle({ content: "x".repeat(100_000) }, conn),
    (e: unknown) => is4xx(e),
    "a grossly oversized content is rejected with a 4xx",
  );
  await assert.rejects(
    () => tool.handle({ content: "ok", reason: "x".repeat(100_000) }, conn),
    (e: unknown) => is4xx(e),
    "a grossly oversized reason is rejected with a 4xx",
  );
});

test("search_memory rejects a mis-shaped or oversized input with a 4xx before any db access", async () => {
  const tool = createSearchMemoryTool(memoryDeps(landmineDb(), landmineKeyWrapper(), fixedClock(NOW)));
  const conn = connectionFor("validate-search");

  await assert.rejects(() => tool.handle(42, conn), (e: unknown) => is4xx(e), "a number input is a 4xx");
  await assert.rejects(
    () => tool.handle({ query: 999 }, conn),
    (e: unknown) => is4xx(e),
    "a non-string query is a 4xx",
  );
  await assert.rejects(
    () => tool.handle({ query: "x".repeat(100_000) }, conn),
    (e: unknown) => is4xx(e),
    "a grossly oversized query is rejected with a 4xx",
  );
});

test("the memory tools accept a small, well-formed input and reach the store (not a 4xx)", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const { userId } = await makePerson(db, "accepted", keyWrapper);
    const conn = connectionFor(userId);
    await grantMemory(db, userId, conn.connectionId);

    const saved = (await createRememberTool(memoryDeps(db, keyWrapper, fixedClock(NOW))).handle(
      { content: "A small, well-formed fact.", reason: "ok" },
      conn,
    )) as RememberResult;
    assert.equal(saved.status, "saved", "a well-formed remember is stored, not rejected as a 4xx");

    const searched = (await createSearchMemoryTool(memoryDeps(db, keyWrapper, fixedClock(NOW))).handle(
      { reason: "ok" },
      conn,
    )) as SearchMemoryResult;
    assert.ok(Array.isArray(searched.memories), "a well-formed search reads the store, not a 4xx");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC [validate-and-parameterize-input] — a SQL-injection probe in `content` is inert: it is
// stored as DATA (DEK-encrypted, bound as a value), drops nothing, and the real memory
// survives and stays readable. Parameter binding is proven on the recording db.
// ===========================================================================

test("a SQL-shaped remember content is inert data: saved, nothing dropped, the real memory survives", async () => {
  const real = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const { userId, dek } = await makePerson(real, "sql-remember", keyWrapper);
    const conn = connectionFor(userId);
    await grantMemory(real, userId, conn.connectionId);

    // A canary memory created BEFORE the probe — it must still be there afterwards.
    const CANARY = "A canary memory that must survive the probe.";
    await createMemory(real, { userId, content: CANARY, sourceAgentId: conn.agentId, scope: "kept" }, dek, fixedClock(NOW));

    const rec = recordingDb(real);
    const tool = createRememberTool(memoryDeps(rec, keyWrapper, fixedClock(NOW)));

    const probe = "Buy milk'; DROP TABLE memories; --";
    const result = (await tool.handle({ content: probe }, conn)) as RememberResult;
    assert.equal(result.status, "saved", "the probe content is stored as ordinary data");

    // If the probe had been spliced into SQL, the memories table would be gone; it is not —
    // the canary AND the probe-as-literal-data are both readable.
    const stored = await listMemoriesForUser(real, userId, dek);
    const contents = stored.map((m) => m.content);
    assert.ok(contents.includes(CANARY), "the memories table survived — the canary is intact");
    assert.ok(contents.includes(probe), "the probe was stored verbatim as inert content, not executed");

    // Parameter binding: the attacker string never appears in any SQL TEXT, and the owning
    // user id travels as a BOUND value.
    for (const call of rec.calls) {
      assert.ok(!call.text.includes(probe), "the probe is never spliced into the SQL text");
      assert.ok(!call.text.toUpperCase().includes("DROP TABLE"), "no injected statement appears in the SQL");
    }
    assert.ok(
      rec.calls.some((c) => c.values.includes(userId)),
      "the owning user id travels as a BOUND value (member-scoped, parameterized)",
    );
  } finally {
    await real.close();
  }
});

test("a SQL-shaped search query is inert: it errors nothing and the real memories stay readable", async () => {
  const real = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const { userId, dek } = await makePerson(real, "sql-search", keyWrapper);
    const conn = connectionFor(userId);
    await grantMemory(real, userId, conn.connectionId);

    const REAL = "A shared fact the agent is allowed to read.";
    await createMemory(real, { userId, content: REAL, sourceAgentId: conn.agentId, scope: "shared" }, dek, fixedClock(NOW));

    const rec = recordingDb(real);
    const tool = createSearchMemoryTool(memoryDeps(rec, keyWrapper, fixedClock(NOW)));

    const probe = "milk' OR '1'='1'; DROP TABLE memories; --";
    const result = (await tool.handle({ query: probe }, conn)) as SearchMemoryResult;
    assert.notEqual(result.status, "refused", "a SQL-shaped query is handled, not refused as an error");
    assert.ok(Array.isArray(result.memories), "the search returns a (filtered) list, never throwing");

    // The query is an in-app filter, never SQL: it is nowhere in the issued SQL text, and the
    // owning user id travels as a bound value. The table is untouched, so a plain search still
    // reads the real memory.
    for (const call of rec.calls) {
      assert.ok(!call.text.includes(probe), "the query is never spliced into the SQL text");
      assert.ok(!call.text.toUpperCase().includes("DROP TABLE"), "no injected statement appears in the SQL");
    }
    assert.ok(
      rec.calls.some((c) => c.values.includes(userId)),
      "the owning user id travels as a BOUND value (member-scoped, parameterized)",
    );

    const after = (await tool.handle({}, conn)) as SearchMemoryResult;
    assert.ok(
      (after.memories ?? []).some((m) => m.content === REAL),
      "the memories table survived the probe — the real memory is still readable",
    );
  } finally {
    await real.close();
  }
});

// ===========================================================================
// AC [secrets-from-env] — the tools read no process.env: a decoy env secret never appears
// in a returned result. They run purely from their injected db + keyWrapper + clock seams.
// ===========================================================================

test("the memory tools read no process.env: a decoy env secret never appears in a result", async () => {
  const DECOY = "sk_live_DECOY_must_never_appear_in_warthog";
  const prev = process.env.WARTHOG_DECOY_SECRET;
  process.env.WARTHOG_DECOY_SECRET = DECOY;
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const { userId } = await makePerson(db, "secrets-env", keyWrapper);
    const conn = connectionFor(userId);
    await grantMemory(db, userId, conn.connectionId);

    const saved = await createRememberTool(memoryDeps(db, keyWrapper, fixedClock(NOW))).handle(
      { content: "A memory worth keeping.", reason: "go" },
      conn,
    );
    assert.ok(!JSON.stringify(saved ?? {}).includes(DECOY), "no ambient env value is folded into the remember result");

    const searched = await createSearchMemoryTool(memoryDeps(db, keyWrapper, fixedClock(NOW))).handle({}, conn);
    assert.ok(!JSON.stringify(searched ?? {}).includes(DECOY), "no ambient env value is folded into the search result");
  } finally {
    await db.close();
    if (prev === undefined) delete process.env.WARTHOG_DECOY_SECRET;
    else process.env.WARTHOG_DECOY_SECRET = prev;
  }
});
