// Operator scaffolding — the process-wide server database (src/server/db/server.ts).
//
// Route entries must share ONE database per process, already migrated: a PGlite data directory
// opened twice in one process corrupts, a pg Pool per request exhausts connections, and nothing
// else applies the migrations when the app boots (only the test helper did). These tests pin the
// getter's behaviour through the real driver seam with an in-memory PGlite.
import { test } from "node:test";
import assert from "node:assert/strict";

import { makeServerDb } from "./server";

test("a separate migration connection closes before requests receive the runtime database", async () => {
  const calls: string[] = [];
  const runtime = { query: async () => ({ rows: [] }), close: async () => {} };
  const migration = { query: async (sql: string) => { calls.push(sql.startsWith("CREATE") ? "migration-ddl" : "migration-query"); return { rows: [] }; }, close: async () => { calls.push("migration-close"); } };
  const getDb = makeServerDb({ databaseUrl: () => "runtime", migrationDatabaseUrl: () => "migration",
    openDb: async (url) => { calls.push(`open-${url}`); return url === "migration" ? migration : runtime; } });
  assert.equal(await getDb(), runtime);
  assert.ok(calls.includes("migration-ddl"));
  assert.ok(calls.indexOf("migration-close") < calls.indexOf("open-runtime"));
  assert.equal(await getDb(), runtime);
  assert.equal(calls.filter((s) => s === "open-migration").length, 1);
});

test("the getter returns one shared database across calls, including concurrent first calls", async () => {
  let urlReads = 0;
  const getDb = makeServerDb({ databaseUrl: () => (urlReads++, "pglite:memory") });
  const [a, b] = await Promise.all([getDb(), getDb()]);
  const c = await getDb();
  try {
    assert.equal(a, b, "concurrent first calls share one bring-up");
    assert.equal(a, c, "later calls reuse the same database");
    assert.equal(urlReads, 1, "the database is opened exactly once");
  } finally {
    await a.close();
  }
});

test("the shared database arrives with every migration applied", async () => {
  const getDb = makeServerDb({ databaseUrl: () => "pglite:memory" });
  const db = await getDb();
  try {
    const applied = await db.query("SELECT name FROM schema_migrations ORDER BY name");
    const names = applied.rows.map((r) => r.name as string);
    assert.ok(names.length > 0 && names[0] === "0001_init", `migrations applied in order, got ${names.join(",")}`);
    const users = await db.query("SELECT count(*)::int AS n FROM users");
    assert.equal(Number(users.rows[0]?.n), 0, "the users table exists and is empty");
  } finally {
    await db.close();
  }
});

test("a failed bring-up is not cached: the next call retries", async () => {
  let attempt = 0;
  const getDb = makeServerDb({ databaseUrl: () => (attempt++ === 0 ? "nosuch:db" : "pglite:memory") });
  await assert.rejects(getDb(), /Unsupported database URL scheme/);
  const db = await getDb();
  try {
    assert.equal(attempt, 2, "the second call opened a database instead of replaying the failure");
  } finally {
    await db.close();
  }
});
