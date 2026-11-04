// E01-S03 — database access seam + plain-SQL migration runner (`src/server/db/index.ts`).
//
// These tests are RED-first: the module does not exist yet. They pin BEHAVIOUR
// (what a db does when you run SQL through it), never the source text of the module.
//
// The contract this task's tests define:
//   createDb(databaseUrl): Promise<Db>        — selects the driver from the URL scheme.
//     • "pglite:*"   -> an in-process PGlite database (runs SQL offline, no server).
//     • "postgres:*" -> a real networked pg client (a pg Pool).
//     • anything else -> rejected (malformed/unsupported input, never a silent default).
//   Db = { query(text, values?): Promise<{ rows }>; close(): Promise<void> }
//     • query binds `values` as PARAMETERS (no string-concatenated SQL).
//   runMigrations(db, migrations): Promise<string[]>
//     • applies each not-yet-applied migration and returns the names applied this run;
//       a second run applies nothing new (idempotent).
//   loadMigrations(dir?): Promise<{ name, sql }[]>
//     • reads the plain-SQL migration files (default: the project's `db/migrations`).
//
// The db object is awaited everywhere so these tests pass whether `createDb` is sync
// or async. All db lifecycles are closed in a `finally` so node:test leaves no open
// handles (a pglite in-memory db / a pg Pool).
//
// Obligation mapping:
//   [obligation:validate-and-parameterize-input] (INV-102). The PARAMETERIZE half lives
//   here, where queries actually run (config.test.ts explicitly deferred it to this
//   task): a value full of SQL metacharacters is bound, not concatenated, and cannot
//   alter the statement. The db factory's share of the VALIDATE half is refusing a
//   malformed/unsupported database URL. The HTTP-specific "reject oversized input with
//   a 4xx" belongs to the first task that ships an HTTP handler — this task has no HTTP
//   surface, so that half is characterized there (the mirror of config.test.ts's note).
//   [obligation:secrets-from-env] (INV-103). The scheme-drives-the-driver tests prove
//   the connection target comes from the supplied URL (from config -> env), not a
//   hard-coded constant; process.env reading itself is owned and tested in config.ts.
import { test } from "node:test";
import assert from "node:assert/strict";

import { createDb, runMigrations, loadMigrations } from "./index";

type Row = Record<string, unknown>;

function rowsOf(result: unknown): Row[] {
  return (result as { rows: Row[] }).rows;
}

function migration(name: string, sql: string): { name: string; sql: string } {
  return { name, sql };
}

// --- AC1 / AC5: the driver is selected from the URL scheme (nothing hard-coded) ----

test("a pglite: URL yields an in-process database that runs SQL offline (PGlite)", async () => {
  const db = await createDb("pglite:memory");
  try {
    const result = await db.query("SELECT 1 AS n");
    const rows = rowsOf(result);
    assert.equal(rows.length, 1);
    assert.equal(Number(rows[0]?.n), 1);
  } finally {
    await db.close();
  }
});

test("a postgres: URL yields a real networked pg client, not an offline engine", async () => {
  // Pointed at a local port with nothing listening. A real pg client MUST attempt a
  // network connection and fail; an in-process engine (PGlite) would succeed offline.
  // The contrast with the pglite test above proves the scheme chose the driver.
  let err: unknown;
  let db: Awaited<ReturnType<typeof createDb>> | undefined;
  try {
    db = await createDb("postgres://u:p@127.0.0.1:1/none");
    await db.query("SELECT 1");
  } catch (e) {
    err = e;
  } finally {
    if (db) {
      try {
        await db.close();
      } catch {
        /* closing an unconnected pool is fine */
      }
    }
  }
  assert.ok(err, "a postgres:// database must use a networked pg client (it did not fail offline)");
  const signature = `${(err as { code?: string })?.code ?? ""} ${(err as { message?: string })?.message ?? ""}`;
  assert.match(
    signature,
    /ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENOTFOUND|EACCES|connect|connection|socket|network/i,
    "expected a real network connection failure, confirming the pg driver was selected (not a scheme error, not an offline result)",
  );
});

test("createDb rejects a database URL with an unsupported scheme (malformed input, no silent default)", async () => {
  await assert.rejects(async () => {
    const db = await createDb("mysql://u:p@localhost/x");
    // If it wrongly returned a db instead of rejecting, clean up so the assertion is the failure.
    await db.close();
  });
});

// --- AC2 / AC4: queries are parameterized (bound, never concatenated) --------------

test("a bound parameter full of SQL metacharacters is stored as data, not executed", async () => {
  const db = await createDb("pglite:memory");
  try {
    await db.query("CREATE TABLE accounts (id serial PRIMARY KEY, label text NOT NULL)");
    const probe = "Robert'); DROP TABLE accounts; --";
    await db.query("INSERT INTO accounts (label) VALUES ($1)", [probe]);

    // The injection did NOT execute: the table still exists and holds exactly one row,
    // whose label is the probe stored verbatim (bound as a value, not interpreted as SQL).
    const result = await db.query("SELECT label FROM accounts");
    const rows = rowsOf(result);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.label, probe);
  } finally {
    await db.close();
  }
});

test("a SQL-injection probe in a WHERE parameter cannot widen the result set", async () => {
  const db = await createDb("pglite:memory");
  try {
    await db.query("CREATE TABLE secrets (id serial PRIMARY KEY, owner text NOT NULL)");
    await db.query("INSERT INTO secrets (owner) VALUES ($1)", ["alice"]);
    await db.query("INSERT INTO secrets (owner) VALUES ($1)", ["bob"]);

    // Concatenated, `' OR '1'='1` would return every row; bound, it matches nothing.
    const injected = await db.query("SELECT owner FROM secrets WHERE owner = $1", ["' OR '1'='1"]);
    assert.equal(rowsOf(injected).length, 0);

    // A legitimate exact match still returns exactly its one row.
    const legit = await db.query("SELECT owner FROM secrets WHERE owner = $1", ["alice"]);
    const rows = rowsOf(legit);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.owner, "alice");
  } finally {
    await db.close();
  }
});

// --- AC3: the migration runner applies pending migrations and is idempotent --------

test("runMigrations applies a pending migration and reports it by name", async () => {
  const db = await createDb("pglite:memory");
  try {
    const applied = await runMigrations(db, [
      migration("0001_create_widgets", "CREATE TABLE widgets (id integer PRIMARY KEY)"),
    ]);
    assert.deepEqual(applied, ["0001_create_widgets"]);

    // The migration's effect is observable.
    const result = await db.query("SELECT count(*)::int AS c FROM widgets");
    assert.equal(Number(rowsOf(result)[0]?.c), 0);
  } finally {
    await db.close();
  }
});

test("a second run applies nothing new (idempotent)", async () => {
  const db = await createDb("pglite:memory");
  try {
    const migrations = [migration("0001_create_widgets", "CREATE TABLE widgets (id integer PRIMARY KEY)")];

    const first = await runMigrations(db, migrations);
    assert.deepEqual(first, ["0001_create_widgets"]);

    // Re-running must NOT re-execute 0001 — re-running its `CREATE TABLE` would throw
    // "already exists". So "returns []" AND "does not throw" both prove idempotency.
    const second = await runMigrations(db, migrations);
    assert.deepEqual(second, []);
  } finally {
    await db.close();
  }
});

test("a later run applies only the newly-added migration", async () => {
  const db = await createDb("pglite:memory");
  try {
    const m1 = migration("0001_create_widgets", "CREATE TABLE widgets (id integer PRIMARY KEY)");
    const m2 = migration("0002_create_gadgets", "CREATE TABLE gadgets (id integer PRIMARY KEY)");

    const first = await runMigrations(db, [m1]);
    assert.deepEqual(first, ["0001_create_widgets"]);

    const second = await runMigrations(db, [m1, m2]);
    assert.deepEqual(second, ["0002_create_gadgets"]);

    // Both tables now exist (querying a missing table would throw).
    await db.query("SELECT 1 FROM widgets");
    await db.query("SELECT 1 FROM gadgets");
  } finally {
    await db.close();
  }
});

// --- AC3 end-to-end: the project's initial migration loads and applies -------------

test("the project's migrations (incl. the initial 0001) load and apply through the runner, idempotently", async () => {
  const db = await createDb("pglite:memory");
  try {
    const migrations = await loadMigrations(); // default: the project's db/migrations
    assert.ok(migrations.length >= 1, "expected at least the initial migration (db/migrations/0001_init.sql)");
    for (const m of migrations) {
      assert.equal(typeof m.name, "string");
      assert.ok(m.name.length > 0, "every migration has a non-empty name");
      assert.equal(typeof m.sql, "string");
      assert.ok(m.sql.trim().length > 0, "every migration carries SQL");
    }

    const first = await runMigrations(db, migrations);
    assert.equal(first.length, migrations.length, "a fresh database applies every pending migration");

    const second = await runMigrations(db, migrations);
    assert.deepEqual(second, [], "a second run over the same database applies nothing new");
  } finally {
    await db.close();
  }
});

// Operator fix (dev boot smoke test): `DATABASE_URL=pglite:./.data/dev` failed on a fresh
// checkout because PGlite does not create missing parent directories, and its start-up error
// escaped as an unhandled rejection instead of rejecting createDb.
test("a pglite: data directory whose parents do not exist yet is created and usable", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = await mkdtemp(join(tmpdir(), "wh-pglite-"));
  const db = await createDb(`pglite:${join(root, "nested", "dev")}`);
  try {
    const result = await db.query("SELECT 1 AS one");
    assert.equal(Number(result.rows[0]?.one), 1);
  } finally {
    await db.close();
    await rm(root, { recursive: true, force: true });
  }
});
