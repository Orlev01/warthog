// Test database helper: an isolated, in-process (PGlite) database with every real
// migration applied. Tests run against the production schema with no Postgres
// server and no Docker (design: database tests use PGlite with the real
// migrations through this shared helper).
//
// The migrations are applied once per test process, through the real runner
// (`loadMigrations` + `runMigrations`) over the real driver adapter (`pgliteDb`, what
// `createDb("pglite:memory")` returns), never a re-implementation. That migrated
// database is dumped, and each freshDb() opens its own `new PGlite` from the dump: a
// separate in-memory database that never shares state with another. Copying is about
// five times faster than applying every migration again, and most of the suite's
// time used to go on exactly that.

import { PGlite } from "@electric-sql/pglite";
import { loadMigrations, pgliteDb, runMigrations, type Db } from "../server/db/index";

let migrated: Promise<Blob> | undefined;

// The data directory of one database with every db/migrations file applied, built on first use.
function migratedTemplate(): Promise<Blob> {
  migrated ??= (async () => {
    const pglite = new PGlite("memory://");
    await pglite.waitReady;
    try {
      await runMigrations(pgliteDb(pglite), await loadMigrations());
      return await pglite.dumpDataDir("none");
    } finally {
      await pglite.close();
    }
  })();
  return migrated;
}

// An isolated in-process database with every db/migrations file already applied.
// Close it when done (every caller does so in a `finally`) to release the handle.
export async function freshDb(): Promise<Db> {
  const pglite = new PGlite({ loadDataDir: await migratedTemplate() });
  await pglite.waitReady;
  return pgliteDb(pglite);
}
