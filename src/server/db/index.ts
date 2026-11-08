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
// second run over the same database applies nothing new (idempotent). Each migration
// and its bookkeeping row commit together in ONE transaction that holds the migration
// advisory lock, so a crash can never leave a migration applied but unrecorded, and two
// processes starting at once (a revision switch) never both apply the same migration.
//
// PGlite is a devDependency and is excluded from the standalone server's file tracing, so the
// production image does not contain it. It is therefore loaded only when a `pglite:` URL is
// opened (a dynamic import inside createPgliteDb), never at module load: a `postgres://`
// process must be able to import this module without PGlite installed.

import { Pool } from "pg";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

// A single query result. Only the rows matter to callers; the driver-specific
// metadata (row count, command tag, fields) is deliberately not surfaced.
export type Row = Record<string, unknown>;
export interface QueryResult {
  readonly rows: Row[];
}

// The database seam the whole app depends on. `query` binds `values` as
// parameters; `close` releases the underlying handle (a pg Pool / a PGlite db).
//
// `transaction` runs `fn` inside ONE real database transaction, handing it a handle
// pinned to a single connection: every statement `fn` issues commits together or
// rolls back together. Only a driver that pools connections needs it (a pg Pool hands
// out an arbitrary connection per `query`, so BEGIN / COMMIT on bare `query` calls do
// NOT bracket the writes); an in-process PGlite is already a single connection, so it
// omits `transaction` and `withTransaction` drives BEGIN / COMMIT / ROLLBACK straight
// through its `query`. Callers never call this directly — they go through
// `withTransaction`, which handles both driver shapes.
export interface Db {
  query(text: string, values?: unknown[]): Promise<QueryResult>;
  close(): Promise<void>;
  transaction?<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
}

// Run `fn` inside one database transaction and return its result: the `tx` handed to
// `fn` is pinned to a single connection, so every statement it issues commits together
// on success and rolls back together — discarding every write — if `fn` or the commit
// throws. A pooled driver supplies a native `transaction` that checks out one client
// for the whole unit of work (so the "one transaction" is real against a real pg Pool,
// not a sequence of statements scattered across pooled connections); an in-process
// PGlite, already a single connection, has none, so BEGIN / COMMIT / ROLLBACK are driven
// straight through its own `query`. This is the ONE place a transaction is opened, so
// every caller gets the same atomicity on either driver (one source of truth).
export async function withTransaction<T>(db: Db, fn: (tx: Db) => Promise<T>): Promise<T> {
  if (db.transaction) {
    return db.transaction(fn);
  }
  await db.query("BEGIN");
  try {
    const result = await fn(db);
    await db.query("COMMIT");
    return result;
  } catch (err) {
    // Roll the whole unit of work back, preserving the original failure even if the
    // rollback itself cannot be issued (the connection is already broken).
    try {
      await db.query("ROLLBACK");
    } catch {
      /* keep the original error */
    }
    throw err;
  }
}

// A plain-SQL migration: a stable name and the SQL that applies it.
export interface Migration {
  readonly name: string;
  readonly sql: string;
}

// The project's migration files live in db/migrations at the app root. Resolve them from the
// working directory, which is the app root for `npm test`, `next dev`, `next start` and the
// standalone server (next.config traces db/migrations into it). Never resolve them from
// import.meta.url: Next bundles server code into .next/, where a module-relative path points
// nowhere, and its bundler treats `new URL(…, import.meta.url)` as an asset import and fails.
const DEFAULT_MIGRATIONS_DIR = join(process.cwd(), "db", "migrations");

// Tuning for the networked driver. Defaults suit production; a test may shorten them.
export interface CreateDbOptions {
  // Give up acquiring a connection after this long (pg's own default waits forever).
  readonly connectTimeoutMs?: number;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 5_000;
// A runaway statement (an integrity scan, a bad plan) is cancelled rather than holding a
// connection indefinitely. Generous, so a migration on a modest table still fits.
const STATEMENT_TIMEOUT_MS = 60_000;
const POOL_IDLE_TIMEOUT_MS = 30_000;

// Select the driver from the URL scheme (never a hard-coded default). The scheme
// — not the credentials — is all we ever report, so a rejected URL cannot leak a
// password into an error message or log.
export async function createDb(databaseUrl: string, options: CreateDbOptions = {}): Promise<Db> {
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(databaseUrl)?.[1]?.toLowerCase();

  if (scheme === "pglite") {
    return createPgliteDb(databaseUrl.slice("pglite:".length));
  }
  if (scheme === "postgres" || scheme === "postgresql") {
    return createPgPoolDb(databaseUrl, options);
  }
  throw new Error(`Unsupported database URL scheme: ${scheme ?? "(none)"}`);
}

// An in-process PGlite database. `pglite:memory` is in-memory; any other target
// (e.g. `pglite:./.data/dev`) is a native data directory, created (with its parents) if
// missing — PGlite itself only creates the last segment. Start-up is awaited so a failure
// rejects here instead of escaping as an unhandled rejection.
async function createPgliteDb(target: string): Promise<Db> {
  const memory = target === "" || target === "memory";
  const dataDir = memory ? "memory://" : target;
  if (!memory) await mkdir(dataDir, { recursive: true });
  const { PGlite } = await import("@electric-sql/pglite");
  const pglite = new PGlite(dataDir);
  await pglite.waitReady;
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

// Map a pg driver result to our rows-only shape: a multi-statement simple query yields
// one result per statement (an array), a single statement yields one result object —
// either way, return the LAST statement's rows.
function pgRows(raw: { rows: Row[] } | { rows: Row[] }[]): Row[] {
  if (Array.isArray(raw)) {
    return raw[raw.length - 1]?.rows ?? [];
  }
  return raw.rows;
}

// A real networked pg client. Creating the Pool does not connect; the first query
// does, so a `postgres://` URL pointed at a dead port fails with a network error
// (proving a real driver was selected, not an offline engine). Hardened: acquiring a
// connection times out, a runaway statement is cancelled, and an error on an IDLE pooled
// connection (the server dropped it — maintenance, failover) is logged instead of being an
// unhandled 'error' event that kills the process; the pool replaces the connection.
function createPgPoolDb(connectionString: string, options: CreateDbOptions): Db {
  const pool = new Pool({
    connectionString,
    connectionTimeoutMillis: options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
    idleTimeoutMillis: POOL_IDLE_TIMEOUT_MS,
    statement_timeout: STATEMENT_TIMEOUT_MS,
    application_name: "warthog",
  });
  pool.on("error", (error: Error & { code?: string }) => {
    // The code only: a driver message can name the host or user.
    console.error("[warthog db] idle connection error", error.code ?? "unknown");
  });
  return {
    async query(text, values) {
      const raw =
        values && values.length > 0 ? await pool.query(text, values) : await pool.query(text);
      return { rows: pgRows(raw) };
    },
    async close() {
      await pool.end();
    },
    // A real transaction over the pool: check out ONE client, so BEGIN, every write and
    // COMMIT all run on the SAME connection (a bare `pool.query` would hand each
    // statement an arbitrary connection, so they would not bracket). Commit on success,
    // roll back on any failure, and always release the client back to the pool.
    async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      const tx: Db = {
        async query(text, values) {
          const raw =
            values && values.length > 0 ? await client.query(text, values) : await client.query(text);
          return { rows: pgRows(raw) };
        },
        // No-op: the pooled client is released when the transaction ends, below — never
        // by a statement inside it.
        async close() {},
      };
      try {
        await client.query("BEGIN");
        const result = await fn(tx);
        await client.query("COMMIT");
        return result;
      } catch (err) {
        try {
          await client.query("ROLLBACK");
        } catch {
          /* keep the original error */
        }
        throw err;
      } finally {
        client.release();
      }
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

// The advisory-lock key every migration transaction takes (pg_advisory_xact_lock over its
// hash), so concurrent runners — in this process or another — apply migrations one at a time.
const MIGRATION_LOCK_KEY = "warthog.schema_migrations";

// Runs in progress per database handle in THIS process, chained so concurrent calls on one
// handle run one after another (an in-process PGlite is a single session, where the advisory
// lock cannot separate two callers; a pooled pg handle gets the advisory lock as well).
const runsInProgress = new WeakMap<Db, Promise<unknown>>();

// Apply every not-yet-applied migration in order and return the names applied on
// this run. The runner owns `schema_migrations`: it ensures the table exists, so
// it never depends on a migration to create its own bookkeeping, and records each
// migration in the SAME transaction that applies it — so a second run finds them all
// present and applies nothing new, and a failure leaves neither the body nor the row.
// The first failing migration stops the run (later ones depend on it).
export async function runMigrations(db: Db, migrations: Migration[]): Promise<string[]> {
  const previous = runsInProgress.get(db) ?? Promise.resolve();
  const run = previous.catch(() => {}).then(() => applyPending(db, migrations));
  runsInProgress.set(db, run);
  try {
    return await run;
  } finally {
    if (runsInProgress.get(db) === run) runsInProgress.delete(db);
  }
}

async function applyPending(db: Db, migrations: Migration[]): Promise<string[]> {
  await withTransaction(db, async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [MIGRATION_LOCK_KEY]);
    await tx.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (" +
        "name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
    );
  });
  // A cheap first look, outside the lock: only migrations missing here are re-checked under it.
  const existing = await db.query("SELECT name FROM schema_migrations");
  const alreadyApplied = new Set(existing.rows.map((row) => row.name as string));

  const appliedNow: string[] = [];
  for (const migration of migrations) {
    if (alreadyApplied.has(migration.name)) continue;
    const applied = await withTransaction(db, async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [MIGRATION_LOCK_KEY]);
      // Another runner may have applied it while this one waited for the lock.
      const done = await tx.query("SELECT 1 FROM schema_migrations WHERE name = $1", [migration.name]);
      if (done.rows.length > 0) return false;
      await tx.query(migration.sql);
      await tx.query("INSERT INTO schema_migrations (name) VALUES ($1)", [migration.name]);
      return true;
    });
    if (applied) appliedNow.push(migration.name);
  }
  return appliedNow;
}
