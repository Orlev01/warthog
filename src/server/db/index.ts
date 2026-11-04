// The database access seam. Every aggregate stores through this module, so the
// rest of the codebase never imports a driver directly: it takes a `Db` and runs
// parameterized SQL through it (constitution: validate-and-parameterize-input,
// INV-102 — values are bound, never concatenated into the statement text).
//
// The driver is chosen from the URL scheme, which comes from config (from the
// environment, INV-103): `postgres://` / `postgresql://` use a real networked pg
// Pool; `pglite:` uses an in-process PGlite database (tests and local dev, no
// server). An unsupported scheme is rejected rather than silently defaulted.
//
// A tiny plain-SQL migration runner applies the project's migration files once
// each and records them in a `schema_migrations` bookkeeping table it owns, so a
// second run over the same database applies nothing new (idempotent).

import { PGlite } from "@electric-sql/pglite";
import { Pool } from "pg";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// A single query result. Only the rows matter to callers; the driver-specific
// metadata (row count, command tag, fields) is deliberately not surfaced.
export type Row = Record<string, unknown>;
export interface QueryResult {
  readonly rows: Row[];
}

// The database seam the whole app depends on. `query` binds `values` as
// parameters; `close` releases the underlying handle (a pg Pool / a PGlite db).
export interface Db {
  query(text: string, values?: unknown[]): Promise<QueryResult>;
  close(): Promise<void>;
}

// A plain-SQL migration: a stable name and the SQL that applies it.
export interface Migration {
  readonly name: string;
  readonly sql: string;
}

// The project's migration files live at the repo root, not relative to cwd, so
// resolve the default directory from this module's location.
const DEFAULT_MIGRATIONS_DIR = fileURLToPath(new URL("../../../db/migrations", import.meta.url));

// Select the driver from the URL scheme (never a hard-coded default). The scheme
// — not the credentials — is all we ever report, so a rejected URL cannot leak a
// password into an error message or log.
export async function createDb(databaseUrl: string): Promise<Db> {
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(databaseUrl)?.[1]?.toLowerCase();

  if (scheme === "pglite") {
    return createPgliteDb(databaseUrl.slice("pglite:".length));
  }
  if (scheme === "postgres" || scheme === "postgresql") {
    return createPgPoolDb(databaseUrl);
  }
  throw new Error(`Unsupported database URL scheme: ${scheme ?? "(none)"}`);
}

// An in-process PGlite database. `pglite:memory` is in-memory; any other target
// (e.g. `pglite:./.data/dev`) is a native data directory.
function createPgliteDb(target: string): Db {
  const dataDir = target === "" || target === "memory" ? "memory://" : target;
  const pglite = new PGlite(dataDir);
  return {
    async query(text, values) {
      if (values && values.length > 0) {
        // Extended protocol: a single parameterized statement.
        const result = await pglite.query(text, values);
        return { rows: result.rows as Row[] };
      }
      // No parameters: `exec` runs the simple protocol, which allows a migration
      // file to carry several statements. The last statement's rows are returned.
      const results = await pglite.exec(text);
      const last = results[results.length - 1];
      return { rows: (last?.rows ?? []) as Row[] };
    },
    async close() {
      await pglite.close();
    },
  };
}

// A real networked pg client. Creating the Pool does not connect; the first query
// does, so a `postgres://` URL pointed at a dead port fails with a network error
// (proving a real driver was selected, not an offline engine).
function createPgPoolDb(connectionString: string): Db {
  const pool = new Pool({ connectionString });
  return {
    async query(text, values) {
      const raw =
        values && values.length > 0 ? await pool.query(text, values) : await pool.query(text);
      // A multi-statement simple query yields one result per statement; a single
      // statement yields one result object. Either way, return the last rows.
      if (Array.isArray(raw)) {
        const last = raw[raw.length - 1];
        return { rows: (last?.rows ?? []) as Row[] };
      }
      return { rows: raw.rows as Row[] };
    },
    async close() {
      await pool.end();
    },
  };
}

// Read the plain-SQL migration files, ordered by file name so `0001_` applies
// before `0002_`. A migration's name is its file name without the `.sql` suffix.
export async function loadMigrations(dir: string = DEFAULT_MIGRATIONS_DIR): Promise<Migration[]> {
  const files = (await readdir(dir)).filter((name) => name.endsWith(".sql")).sort();
  const migrations: Migration[] = [];
  for (const file of files) {
    const sql = await readFile(join(dir, file), "utf8");
    migrations.push({ name: file.replace(/\.sql$/, ""), sql });
  }
  return migrations;
}

// Apply every not-yet-applied migration in order and return the names applied on
// this run. The runner owns `schema_migrations`: it ensures the table exists, so
// it never depends on a migration to create its own bookkeeping, and records each
// migration as it applies it — so a second run finds them all present and applies
// nothing new.
export async function runMigrations(db: Db, migrations: Migration[]): Promise<string[]> {
  await db.query(
    "CREATE TABLE IF NOT EXISTS schema_migrations (" +
      "name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
  );
  const existing = await db.query("SELECT name FROM schema_migrations");
  const alreadyApplied = new Set(existing.rows.map((row) => row.name as string));

  const appliedNow: string[] = [];
  for (const migration of migrations) {
    if (alreadyApplied.has(migration.name)) continue;
    await db.query(migration.sql);
    await db.query("INSERT INTO schema_migrations (name) VALUES ($1)", [migration.name]);
    appliedNow.push(migration.name);
  }
  return appliedNow;
}
