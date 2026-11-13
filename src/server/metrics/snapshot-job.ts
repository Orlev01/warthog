// E17-S05 — the metrics snapshot job (brief "Operations readiness"). A few operational
// numbers are not emitted per event but DERIVED BY COUNTING ROWS at a point in time:
// total users, total households, active agents per platform, and per-connector
// connection + failure counts. This background job computes each count and APPENDS it as a
// metric event through E17-S02's guarded recorder, so every value is bound (INV-102) and
// stamped from the injected clock (never Date.now()). It is a point-in-time SNAPSHOT:
// running it twice appends a second set of rows (the metric store is an append log, never
// an upsert).
//
// The counts are GLOBAL operational data, not member-scoped personal content, so there is
// no userId scope here — the whole point is the organisation-wide total. A metric is
// structurally only a named count plus the four constrained, non-personal dimensions the
// guard allows, so no user identity or content can reach it (constitution principle 19):
// the only dimension values written here are the platform and connector slugs read back
// from the rows, both short non-personal labels.
//
// Every statement is parameterized through the `Db` seam (INV-102): the count queries take
// no caller input (the counts are global) and splice nothing into their SQL, and each
// value the recorder writes travels BOUND. This module reads no `process.env` and holds no
// secret (INV-103): it runs purely from the injected db + clock.

import type { Db } from "../db/index";
import type { Clock } from "../seams/clock";
import { recordMetricEvent } from "./record";

// The metric names the snapshot records (the pinned operational contract).
const USERS_TOTAL = "users.total";
const HOUSEHOLDS_TOTAL = "households.total";
const AGENTS_ACTIVE = "agents.active";
const CONNECTOR_CONNECTIONS = "connector.connections";
const CONNECTOR_FAILURES = "connector.failures";

// Read a single-row count back as an exact number, regardless of whether the driver hands
// `count(*)` back as a number or a numeric string, defaulting to 0 when there is no row.
function readCount(rows: readonly Record<string, unknown>[], column: string): number {
  return Number(rows[0]?.[column] ?? 0);
}

// Count the operational rows at THIS instant and append each count as a metric event
// through the guarded recorder (every value bound, every metric stamped from `clock`).
export async function runMetricsSnapshot(db: Db, clock: Clock): Promise<void> {
  // The two headline global counts — one row each, every run, so the time series has a
  // data point even when a count is 0.
  // A deleted account keeps a crypto-shredded row until purge; it is not a user.
  const users = await db.query("SELECT count(*)::int AS n FROM users WHERE wrapped_dek <> ''");
  await recordMetricEvent(db, clock, { name: USERS_TOTAL, value: readCount(users.rows, "n") });

  const households = await db.query("SELECT count(*)::int AS n FROM households");
  await recordMetricEvent(db, clock, { name: HOUSEHOLDS_TOTAL, value: readCount(households.rows, "n") });

  // Active agents per platform: one row per platform with at least one CONNECTED agent (a
  // platform whose agents are all disconnected is not active, so it is absent).
  const agents = await db.query(
    `SELECT platform, count(*)::int AS n
       FROM agents
      WHERE status = 'connected'
      GROUP BY platform`,
  );
  for (const row of agents.rows) {
    await recordMetricEvent(db, clock, {
      name: AGENTS_ACTIVE,
      value: Number(row.n),
      dimensions: { platform: row.platform as string },
    });
  }

  // Per-connector connection + failure counts: one connections row and one failures row
  // per connector that has any connection. Connections counts EVERY status; failures
  // counts the needs_reconnect / error connections.
  const connectors = await db.query(
    `SELECT connector_id,
            count(*)::int AS connections,
            SUM(CASE WHEN status IN ('needs_reconnect', 'error') THEN 1 ELSE 0 END)::int AS failures
       FROM connections
      GROUP BY connector_id`,
  );
  for (const row of connectors.rows) {
    const connectorId = row.connector_id as string;
    await recordMetricEvent(db, clock, {
      name: CONNECTOR_CONNECTIONS,
      value: Number(row.connections),
      dimensions: { connectorId },
    });
    await recordMetricEvent(db, clock, {
      name: CONNECTOR_FAILURES,
      value: Number(row.failures),
      dimensions: { connectorId },
    });
  }
}
