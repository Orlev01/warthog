// E01-S04 — Test database helper (`src/test/db.ts`).
//
// RED-first: `src/test/db.ts` does not exist yet, so importing `freshDb` fails and
// every test here fails until the helper is built. That absence is the point of
// test-first — do not add the helper to make these pass; the builder does that.
//
// These tests pin BEHAVIOUR — what a `freshDb()` instance IS and DOES — never the
// helper's source text.
//
// Contract under test:
//   freshDb(): an isolated, in-process (PGlite) database with EVERY real migration
//   file (db/migrations/*) already applied through the project's migration runner.
//   It is a `Db`-shaped handle usable by repo code and the runner:
//     query(text, values?) => Promise<{ rows }>, and close() to release it.
//
// Acceptance criteria:
//   AC1: freshDb() returns an isolated PGlite instance with every db/migrations file applied.
//   AC2: Two helper instances do not share state.
//
// "Every migration applied" is proven BEHAVIOURALLY: the runner records each applied
// migration by name in its own `schema_migrations` table, so after `freshDb()` every
// name that `loadMigrations()` reads from `db/migrations` is present there, and the
// real runner, re-run over the handle, finds nothing pending. Reading the migration
// set from `loadMigrations()` (not a hard-coded list) keeps these tests correct as
// migrations are added or renamed. The handle runs SQL with no Postgres server and no
// Docker, which is the whole reason the helper exists (PGlite, in-process).
//
// The db handle is awaited everywhere so these pass whether `freshDb` is sync or
// async, and every handle is closed in a `finally` so node:test leaves no open handle.
import { test } from "node:test";
import assert from "node:assert/strict";

import { freshDb } from "./db";
import { loadMigrations, runMigrations } from "../server/db/index";

type Row = Record<string, unknown>;

// The structural shape these tests depend on: a parameterizing `query` and a `close`.
interface DbHandle {
  query(text: string, values?: unknown[]): Promise<{ rows: Row[] }>;
  close(): Promise<void>;
}

function rowsOf(result: { rows: Row[] }): Row[] {
  return result.rows;
}

// The set of migration names the runner has recorded as applied on this handle.
async function appliedMigrationNames(db: DbHandle): Promise<Set<string>> {
  const result = await db.query("SELECT name FROM schema_migrations");
  return new Set(rowsOf(result).map((r) => String(r.name)));
}

// Whether a relation of this exact name exists on this handle. `to_regclass` yields
// the relation name when it exists and NULL when it does not — a non-throwing probe
// scoped to the one table under test.
async function tableExists(db: DbHandle, name: string): Promise<boolean> {
  const result = await db.query("SELECT to_regclass($1) AS t", [name]);
  return rowsOf(result)[0]?.t != null;
}

// --- AC1: freshDb() is an isolated in-process database with every migration applied -

test("freshDb() returns a usable in-process database (runs SQL with no server)", async () => {
  const db: DbHandle = await freshDb();
  try {
    const rows = rowsOf(await db.query("SELECT 1 AS n"));
    assert.equal(rows.length, 1);
    assert.equal(Number(rows[0]?.n), 1);
    assert.equal(typeof db.close, "function", "the handle must be closeable to release it");
  } finally {
    await db.close();
  }
});

test("freshDb() has applied every db/migrations file (each recorded in schema_migrations)", async () => {
  const db: DbHandle = await freshDb();
  try {
    const migrations = await loadMigrations(); // the project's real db/migrations
    assert.ok(migrations.length >= 1, "expected at least the initial migration (db/migrations/0001_init.sql)");

    const applied = await appliedMigrationNames(db);
    for (const m of migrations) {
      assert.ok(
        applied.has(m.name),
        `freshDb() did not apply migration ${m.name} (missing from schema_migrations)`,
      );
    }
  } finally {
    await db.close();
  }
});

test("a freshDb() has no pending migrations — re-running the real runner applies nothing", async () => {
  const db: DbHandle = await freshDb();
  try {
    const migrations = await loadMigrations();
    // If freshDb() had skipped any migration, the runner would apply it now and name
    // it here; an empty result proves every one was already applied.
    const again = await runMigrations(db, migrations);
    assert.deepEqual(again, [], "freshDb() must have applied every migration already");
  } finally {
    await db.close();
  }
});

// --- AC2: two helper instances do not share state ----------------------------------

test("two freshDb() instances do not share state", async () => {
  const a: DbHandle = await freshDb();
  const b: DbHandle = await freshDb();
  try {
    await a.query("CREATE TABLE iso_a (id integer PRIMARY KEY)");
    await b.query("CREATE TABLE iso_b (id integer PRIMARY KEY)");

    // A table created in one instance is visible there and nowhere else — the two
    // are fully isolated in-process databases, not one shared handle.
    assert.equal(await tableExists(a, "iso_a"), true, "db A must see the table it created");
    assert.equal(await tableExists(b, "iso_b"), true, "db B must see the table it created");
    assert.equal(await tableExists(a, "iso_b"), false, "db A must NOT see a table created in db B");
    assert.equal(await tableExists(b, "iso_a"), false, "db B must NOT see a table created in db A");
  } finally {
    await a.close();
    await b.close();
  }
});

test("data written to one freshDb() instance is invisible to another", async () => {
  const a: DbHandle = await freshDb();
  const b: DbHandle = await freshDb();
  try {
    await a.query("CREATE TABLE notes (id serial PRIMARY KEY, body text NOT NULL)");
    await b.query("CREATE TABLE notes (id serial PRIMARY KEY, body text NOT NULL)");
    await a.query("INSERT INTO notes (body) VALUES ($1)", ["only-in-a"]);

    const inA = rowsOf(await a.query("SELECT body FROM notes"));
    assert.deepEqual(
      inA.map((r) => r.body),
      ["only-in-a"],
      "db A keeps its own row",
    );

    const inB = rowsOf(await b.query("SELECT body FROM notes"));
    assert.equal(inB.length, 0, "db B must not see the row inserted into db A");
  } finally {
    await a.close();
    await b.close();
  }
});
