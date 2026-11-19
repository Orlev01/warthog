// Request kinds (db/migrations/0115_request_kinds.sql; docs/adr/admin-portal.md, amendment of
// 20 November 2026): the store records what a person asked the operator for, the migration
// turns the old prefixed early-access rows into early-access requests, and early access stays
// out of the match-notify scan (it names a service that is already in the catalogue).
import { test } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";

import { loadMigrations, pgliteDb, runMigrations } from "./index";
import { createConnectorRequest, listConnectorRequestsForUser, listPendingConnectorRequests } from "./connector-requests";
import { createUser } from "./users";
import { freshDb } from "../../test/db";
import { fixedClock } from "../seams/clock";

const T0 = new Date("2026-11-19T01:00:00.000Z");

test("migration 0115 backfills early-access requests from their old name prefix and keeps service requests", async () => {
  const pglite = new PGlite("memory://");
  await pglite.waitReady;
  const db = pgliteDb(pglite);
  try {
    const migrations = await loadMigrations();
    await runMigrations(db, migrations.filter((m) => m.name < "0115"));
    const user = await db.query("INSERT INTO users (email, wrapped_dek) VALUES ('old@example.test', 'w') RETURNING id");
    const userId = user.rows[0]!.id as string;
    for (const name of ["Google early access: Gmail", "Google early access: Google Drive", "Google early access: Google Calendar", "Spotify"]) {
      await db.query("INSERT INTO connector_requests (user_id, service_name, status, requested_at) VALUES ($1, $2, 'requested', $3::timestamptz)", [userId, name, T0.toISOString()]);
    }

    await runMigrations(db, migrations);

    const rows = await db.query("SELECT kind, service_name, connector_id, handled_at FROM connector_requests ORDER BY service_name");
    assert.deepEqual(rows.rows.map((r) => [r.kind, r.service_name, r.connector_id, r.handled_at]), [
      ["google_early_access", "Gmail", "google-gmail", null],
      ["google_early_access", "Google Calendar", "google-calendar", null],
      ["google_early_access", "Google Drive", "google-drive", null],
      ["service", "Spotify", null, null],
    ]);
  } finally {
    await pglite.close();
  }
});

test("the store records the kind and catalogue entry, and only service requests are scanned for a match", async () => {
  const db = await freshDb();
  try {
    const user = await createUser(db, { email: "kinds@example.test", wrappedDek: "w" });
    const service = await createConnectorRequest(db, { userId: user.id, serviceName: "LinkedIn" }, fixedClock(T0));
    const early = await createConnectorRequest(db, { userId: user.id, serviceName: "Gmail", kind: "google_early_access", connectorId: "google-gmail" }, fixedClock(T0));
    assert.equal(service.kind, "service");
    assert.equal(service.connectorId, null);
    assert.equal(early.kind, "google_early_access");

    const stored = await listConnectorRequestsForUser(db, user.id);
    assert.deepEqual(stored.map((r) => [r.kind, r.serviceName, r.connectorId, r.handledAt]).sort(), [
      ["google_early_access", "Gmail", "google-gmail", null],
      ["service", "LinkedIn", null, null],
    ]);
    assert.deepEqual((await listPendingConnectorRequests(db)).map((r) => r.serviceName), ["LinkedIn"]);

    await assert.rejects(
      db.query("INSERT INTO connector_requests (user_id, kind, service_name, status, requested_at) VALUES ($1, 'support', 'x', 'requested', $2::timestamptz)", [user.id, T0.toISOString()]),
      "an unknown kind is refused by the schema",
    );
  } finally {
    await db.close();
  }
});
