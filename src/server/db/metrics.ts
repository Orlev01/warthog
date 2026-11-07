// The operational metric-events store's data access (task E17-S01; brief "Operations
// readiness": operational metrics recorded from day one — user and household counts,
// active agents by platform, connector connection counts and failure rates, request
// volumes and latencies, approval response times, errors). An APPEND-ONLY log of NAMED
// numbers: recordMetric appends one row; queryMetrics reads one metric name over an
// inclusive time range, oldest-first. The admin app that reads these later (brief "no
// admin UI in V1") never gains a path to vault contents (constitution principle 19).
//
// A metric row is a NAMED numeric value with a SMALL FIXED set of CONSTRAINED,
// non-personal dimensions (platform, connector id, outcome, error category) — a shape
// that structurally cannot hold personal content: the schema (0044_metrics) carries no
// json/jsonb column and no free-text column, every text-bearing column being a short,
// length-capped identifier. Operational numbers are GLOBAL operational data, NOT
// member-scoped personal content — so, like the exchange rates and unlike vault fields,
// cards or released values, they are PLAINTEXT and NOT DEK-encrypted, and this module
// holds no key and reads no `process.env` (config flows from `src/server/config.ts`
// alone, INV-103).
//
// Every statement is parameterized through the `Db` seam (INV-102): the name, value,
// instant and each dimension travel as BOUND values, never concatenated into the SQL
// text, so a value shaped like SQL is stored as data and cannot alter the query.

import type { Db } from "./index";

// What recordMetric takes: the metric name, the numeric value (a count, rate, latency,
// …), the instant it happened (ISO-8601), and the optional non-personal dimensions. An
// omitted dimension is stored as NULL.
export interface RecordMetricInput {
  readonly name: string;
  readonly value: number;
  readonly recordedAt: string;
  readonly platform?: string | null;
  readonly connectorId?: string | null;
  readonly outcome?: string | null;
  readonly errorCategory?: string | null;
}

// One metric event read back from the store: the value comes back as a number (not a
// numeric string), the instant as an ISO-8601 string, and each absent dimension as null.
export interface MetricEvent {
  readonly name: string;
  readonly value: number;
  readonly recordedAt: string;
  readonly platform: string | null;
  readonly connectorId: string | null;
  readonly outcome: string | null;
  readonly errorCategory: string | null;
}

// What queryMetrics takes: one metric name over an inclusive [from, to] instant range.
export interface MetricQuery {
  readonly name: string;
  readonly from: string;
  readonly to: string;
}

// APPEND one metric event. It is an append log: recording the same input twice stores TWO
// rows — it never upserts, overwrites or dedupes. Omitted dimensions are stored as NULL.
// Every value is bound as a parameter, never concatenated into the statement text.
export async function recordMetric(db: Db, input: RecordMetricInput): Promise<void> {
  await db.query(
    `INSERT INTO metric_events
       (name, value, recorded_at, platform, connector_id, outcome, error_category)
     VALUES ($1, $2, $3::timestamptz, $4, $5, $6, $7)`,
    [
      input.name,
      input.value,
      input.recordedAt,
      input.platform ?? null,
      input.connectorId ?? null,
      input.outcome ?? null,
      input.errorCategory ?? null,
    ],
  );
}

// Read every event whose name equals `query.name` AND whose recorded instant is within
// the INCLUSIVE range [from, to], ordered oldest-first (ascending recordedAt). Events of
// a different name, or outside the range, are excluded; no match yields []. The name and
// both bounds are bound as parameters. The value reads back as a number and the instant
// as an ISO-8601 string.
export async function queryMetrics(db: Db, query: MetricQuery): Promise<MetricEvent[]> {
  const result = await db.query(
    `SELECT name, value, recorded_at, platform, connector_id, outcome, error_category
       FROM metric_events
      WHERE name = $1
        AND recorded_at >= $2::timestamptz
        AND recorded_at <= $3::timestamptz
      ORDER BY recorded_at ASC, id ASC`,
    [query.name, query.from, query.to],
  );
  return result.rows.map((row) => ({
    name: row.name as string,
    value: Number(row.value),
    recordedAt: toIso(row.recorded_at),
    platform: (row.platform ?? null) as string | null,
    connectorId: (row.connector_id ?? null) as string | null,
    outcome: (row.outcome ?? null) as string | null,
    errorCategory: (row.error_category ?? null) as string | null,
  }));
}

// Normalise a timestamptz read back from the driver (a Date, or a text representation) to
// an ISO-8601 UTC instant string, independent of the session's DateStyle.
function toIso(value: unknown): string {
  return new Date(value as string | number | Date).toISOString();
}
