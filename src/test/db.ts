// Test database helper: an isolated, in-process (PGlite) database with every real
// migration applied. Tests run against the production schema with no Postgres
// server and no Docker (design: database tests use PGlite with the real
// migrations through this shared helper).
//
// freshDb() goes through the project's real driver seam (`createDb` with a
// `pglite:memory` URL) and applies the migrations through the real runner
// (`loadMigrations` + `runMigrations`) — the production code path with an
// in-memory data source, never a re-implementation. Each call builds its own
// `new PGlite("memory://")`, so two instances are separate in-memory databases
// that never share state.

import { createDb, loadMigrations, runMigrations, type Db } from "../server/db/index";

// An isolated in-process database with every db/migrations file already applied.
// Close it when done (every caller does so in a `finally`) to release the handle.
export async function freshDb(): Promise<Db> {
  const db = await createDb("pglite:memory");
  await runMigrations(db, await loadMigrations());
  return db;
}
