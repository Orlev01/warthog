// The process-wide server database (operator scaffolding). Every route entry and server action
// takes its database from `getServerDb()` — never `createDb` directly — so the process holds ONE
// database: a PGlite data directory opened twice in one process corrupts, and a pg Pool per
// request exhausts connections. The first call opens the database and applies every migration
// through the real runner, so a fresh environment is usable on first request; concurrent first
// calls share that one bring-up, and a failed bring-up is forgotten so the next call retries.

import { loadConfig } from "../config";
import { createDb, loadMigrations, runMigrations, type Db } from "./index";

export interface ServerDbDeps {
  // Read lazily, at first use (the composition root passes the validated config value).
  readonly databaseUrl: () => string;
  // Defaults to the project's db/migrations directory.
  readonly migrationsDir?: string;
}

// A getter over one lazily opened, migrated database (injectable for tests).
export function makeServerDb(deps: ServerDbDeps): () => Promise<Db> {
  let pending: Promise<Db> | undefined;
  return function getDb(): Promise<Db> {
    if (!pending) {
      pending = (async () => {
        const db = await createDb(deps.databaseUrl());
        try {
          await runMigrations(db, await loadMigrations(deps.migrationsDir));
        } catch (error) {
          await db.close().catch(() => {});
          throw error;
        }
        return db;
      })();
      pending.catch(() => {
        pending = undefined;
      });
    }
    return pending;
  };
}

// Kept on globalThis so Next's dev-mode module reloads reuse the same database instead of
// opening a second one on the same data directory.
const KEY = Symbol.for("warthog.serverDb");
type WithServerDb = typeof globalThis & { [KEY]?: () => Promise<Db> };

export function getServerDb(): Promise<Db> {
  const g = globalThis as WithServerDb;
  g[KEY] ??= makeServerDb({ databaseUrl: () => loadConfig().databaseUrl });
  return g[KEY]();
}
