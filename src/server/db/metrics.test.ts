// E17-S01 — Metric-events store
// (`src/server/db/metrics.ts`, `db/migrations/0044_metrics.sql`).
//
// RED-first: neither the data-access module nor the migration exists yet, so importing
// `./metrics` throws and `freshDb()` has no `metric_events` table — every test here fails
// until the builder adds them. That absence IS the point of test-first; do NOT implement
// anything to make these pass — the builder writes the module and the migration afterwards.
//
// These tests pin BEHAVIOUR (what the functions DO: a metric event with a name, a numeric
// value, a timestamp and a small fixed set of non-personal dimensions is appended and read
// back; reads filter by metric name and an inclusive time range; the append log never
// overwrites; the schema carries no free-text column that could hold identity values, message
// content or tool parameters; a handler rejects malformed / oversized / mis-shaped input with
// a 4xx before any query; every value reaches the query layer BOUND as a parameter; the repo
// reads no secret from the environment), never the source text of the module or the SQL file —
// a later rename that preserves behaviour must not redden them.
//
// WHY this exists (task E17-S01; brief "Operations readiness": "Operational metrics recorded
// from day one without any personal content — user and household counts, active agents by
// platform, connector connection counts and failure rates by connector, request volumes and
// latencies, approval response times, errors"; and the design requirement "THE SYSTEM SHALL
// record operational metrics (counts, rates, latencies, error categories) without any personal
// content, identity value, message content or tool parameters"). A table of NAMED metrics with
// a numeric value and a small fixed set of CONSTRAINED, non-personal dimensions is a shape that
// structurally cannot hold personal content — so it holds no free-text column, and the admin
// app that reads it later (brief "no admin UI in V1") never gains a path to vault contents.
// Operational numbers are GLOBAL operational data (not member-scoped personal content), so —
// like the exchange rates and unlike vault fields, cards or released values — they are NOT
// DEK-encrypted and this module holds no key and reads no `process.env`.
//
// ---------------------------------------------------------------------------
// THE PINNED CONTRACT (chosen by the tester; the implementation conforms to it).
//
//   interface RecordMetricInput {
//     name: string;                     // the metric name, e.g. "agent.request"
//     value: number;                    // the numeric value (a count, rate, latency, …)
//     recordedAt: string;               // when it happened, ISO-8601 instant (UTC "…Z" or offset)
//     platform?: string | null;         // dimension: agent platform, e.g. "claude" (optional)
//     connectorId?: string | null;      // dimension: connector catalogue id, e.g. "gmail" (optional)
//     outcome?: string | null;          // dimension: e.g. "ok" | "denied" | "error" (optional)
//     errorCategory?: string | null;    // dimension: e.g. "timeout" | "ssrf_blocked" (optional)
//   }
//
//   interface MetricEvent {              // one event read back from the store
//     name: string;
//     value: number;                     // read back as a number (not a numeric string)
//     recordedAt: string;                // the instant it was recorded (ISO-8601)
//     platform: string | null;
//     connectorId: string | null;
//     outcome: string | null;
//     errorCategory: string | null;
//   }
//
//   interface MetricQuery {              // filter: one metric name over an inclusive [from, to] range
//     name: string;
//     from: string;                      // ISO-8601 instant, inclusive lower bound
//     to: string;                        // ISO-8601 instant, inclusive upper bound
//   }
//
//   recordMetric(db, input: RecordMetricInput): Promise<void>
//     • APPENDS one row (name, value, recordedAt, dimensions). It is an append log: recording
//       the same input twice stores TWO rows — it never upserts/overwrites/dedupes. Omitted
//       dimensions are stored as NULL. Every value is BOUND, never concatenated.
//   queryMetrics(db, query: MetricQuery): Promise<MetricEvent[]>
//     • returns every event whose name equals `query.name` AND whose recordedAt is within the
//       INCLUSIVE range [from, to], ordered oldest-first (ascending recordedAt). Events of a
//       different name, or outside the range, are excluded. No match → []. Name/from/to are
//       BOUND as parameters.
//
// Acceptance criteria → tests:
//   AC1 "A metric event (name, dimensions, numeric value, timestamp) can be inserted and read
//        back." — recordMetric then queryMetrics round-trips the name, the numeric value (as a
//        number, integer and fractional), the instant and each dimension; omitted dimensions
//        read back as null; the same input recorded twice yields two rows (append log).
//   AC2 "The schema has no free-text column that could hold identity values, message content or
//        tool parameters." — the live `metric_events` schema has NO json/jsonb column and NO
//        character column outside the fixed {name, recorded_at, platform, connector_id, outcome,
//        error_category} set; and every one of those columns rejects a grossly oversized string
//        (it is length-constrained at the schema, so it cannot hold message content / tool
//        parameters). (Asserts the live DB schema's behaviour, never the SQL file's source text.)
//   AC3 "Reads can filter by metric name and time range using parameterized queries." —
//        queryMetrics returns only the named metric's events within the inclusive [from, to]
//        range (boundaries included), excludes other names and out-of-range events, orders them
//        oldest-first, returns [] on no match, and BINDS name/from/to as parameters.
//   AC4 [obligation:validate-and-parameterize-input] (INV-102) — a handler on the
//        `../http/validate` boundary rejects malformed / oversized / missing / mis-typed /
//        mis-shaped / injection-shaped input with a 4xx BEFORE any query runs; a SQL-injection
//        probe routed through the repo travels as a BOUND value (placeholders, never
//        concatenation) so the table survives either way. The handler below is a test fixture
//        (the intended usage), not an implementation file.
//   AC5 [obligation:secrets-from-env] (INV-103) — the repo takes its db as a dependency, reads
//        no `process.env` and holds no secret, so a decoy secret planted in the environment never
//        lands in a stored or returned metric.
//   Migration: the `metric_events` relation exists after the project migrations, 0044_metrics is
//        part of the migration set, and a second run of every migration changes nothing.
//
// Every db handle is closed in a `finally` so node:test leaves no open handle; each real-db test
// uses its own `freshDb()` (an isolated in-memory PGlite with the real migrations), so tests
// share no state.

import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";

import { recordMetric, queryMetrics } from "./metrics";
// Documentary type anchors — the exact names/shapes the implementation exports. Erased at
// runtime (and test files are excluded from `tsc`), so a rename cannot break these tests; the
// runtime assertions below are what actually gate behaviour.
import type { RecordMetricInput, MetricEvent, MetricQuery } from "./metrics";
import { freshDb } from "../../test/db";
import { loadMigrations, runMigrations, type Db, type QueryResult } from "./index";
import { parseBody, HttpError } from "../http/validate";

// --- fixtures ---------------------------------------------------------------------

// A db seam stand-in that records every call instead of running it, so a test can prove WHAT
// reached the query layer and HOW (bound value vs. spliced text). Returns no rows and satisfies
// the `Db` shape structurally (query + close).
interface RecordingDb extends Db {
  readonly calls: { text: string; values: unknown[] }[];
}
function recordingDb(): RecordingDb {
  const calls: { text: string; values: unknown[] }[] = [];
  return {
    calls,
    query(text: string, values: unknown[] = []): Promise<QueryResult> {
      calls.push({ text, values });
      return Promise.resolve({ rows: [] as Record<string, unknown>[] });
    },
    close() {
      return Promise.resolve();
    },
  };
}

// Whether a relation of this exact name exists on this handle. `to_regclass` yields the relation
// name when it exists and NULL when it does not — a non-throwing probe scoped to the one table
// under test (behaviour, not source text).
async function tableExists(db: Db, name: string): Promise<boolean> {
  const result = await db.query("SELECT to_regclass($1) AS t", [name]);
  return result.rows[0]?.t != null;
}

// The live columns of a table (name + SQL data type), read from the information schema — the
// migrated database's ACTUAL shape, not the SQL file's text. Used to prove no free-text column
// was smuggled in (AC2).
async function columnsOf(db: Db, table: string): Promise<{ name: string; dataType: string }[]> {
  const result = await db.query(
    "SELECT column_name, data_type FROM information_schema.columns " +
      "WHERE table_schema = 'public' AND table_name = $1",
    [table],
  );
  return result.rows.map((row) => ({
    name: String(row.column_name),
    dataType: String(row.data_type),
  }));
}

// Total number of rows in metric_events — proves an append wrote (or a rejected write did not).
async function totalRows(db: Db): Promise<number> {
  const result = await db.query("SELECT count(*)::int AS n FROM metric_events");
  return result.rows[0]!.n as number;
}

// Assert a probe reached the query layer as a BOUND value and never as spliced SQL text, scoped
// to each recorded call (the parameterize half of INV-102).
function assertBoundNotSpliced(db: RecordingDb, probe: string): void {
  assert.ok(db.calls.length >= 1, "at least one query was issued");
  assert.ok(db.calls.some((c) => c.values.includes(probe)), "the probe travels as a bound value");
  for (const call of db.calls) {
    assert.ok(!call.text.includes(probe), "the input is bound, never concatenated into the SQL");
    assert.ok(!call.text.includes("DROP TABLE"), "no injected statement appears in the SQL text");
  }
}

// The same instant, regardless of whether the store returns an ISO string or a Date — compare
// metric timestamps by instant, not by exact textual representation.
function sameInstant(a: unknown, b: string): boolean {
  return new Date(a as string | number | Date).getTime() === new Date(b).getTime();
}

// The injection probe reused across the parameterize tests.
const INJECTION = "boom'); DROP TABLE metric_events; --";

// ===========================================================================
// AC1 — an event round-trips: name, numeric value, instant and dimensions read back; omitted
// dimensions are null; the same input twice appends two rows (append log, never an overwrite).
// ===========================================================================

test("a metric event round-trips: name, value, instant and every dimension read back", async () => {
  const db = await freshDb();
  try {
    const input: RecordMetricInput = {
      name: "agent.request",
      value: 1,
      recordedAt: "2026-11-05T02:30:00.000Z",
      platform: "claude",
      connectorId: "gmail",
      outcome: "ok",
      errorCategory: "timeout",
    };
    await recordMetric(db, input);

    const events: MetricEvent[] = await queryMetrics(db, {
      name: "agent.request",
      from: "2026-11-05T00:00:00.000Z",
      to: "2026-11-05T23:59:59.999Z",
    });
    assert.equal(events.length, 1, "exactly the one appended event is read back");
    const event = events[0]!;
    assert.equal(event.name, "agent.request", "the metric name round-trips");
    assert.equal(typeof event.value, "number", "the value comes back as a number, not a numeric string");
    assert.equal(event.value, 1, "the numeric value round-trips");
    assert.ok(sameInstant(event.recordedAt, "2026-11-05T02:30:00.000Z"), "the recorded instant round-trips");
    assert.equal(event.platform, "claude", "the platform dimension round-trips");
    assert.equal(event.connectorId, "gmail", "the connector id dimension round-trips");
    assert.equal(event.outcome, "ok", "the outcome dimension round-trips");
    assert.equal(event.errorCategory, "timeout", "the error-category dimension round-trips");
  } finally {
    await db.close();
  }
});

test("omitted dimensions are stored and read back as null (never a smuggled default)", async () => {
  const db = await freshDb();
  try {
    await recordMetric(db, { name: "household.count", value: 42, recordedAt: "2026-11-05T00:00:00.000Z" });

    const events = await queryMetrics(db, {
      name: "household.count",
      from: "2026-11-01T00:00:00.000Z",
      to: "2026-11-30T00:00:00.000Z",
    });
    assert.equal(events.length, 1, "the dimension-less event is stored");
    const event = events[0]!;
    assert.equal(event.value, 42, "its value round-trips");
    assert.equal(event.platform, null, "an omitted platform reads back as null");
    assert.equal(event.connectorId, null, "an omitted connector id reads back as null");
    assert.equal(event.outcome, null, "an omitted outcome reads back as null");
    assert.equal(event.errorCategory, null, "an omitted error category reads back as null");
  } finally {
    await db.close();
  }
});

test("fractional numeric values (rates, latencies) round-trip exactly as numbers", async () => {
  const db = await freshDb();
  try {
    await recordMetric(db, { name: "approval.latency_ms", value: 42.5, recordedAt: "2026-11-05T03:00:00.000Z" });
    await recordMetric(db, { name: "connector.failure_rate", value: 0.125, recordedAt: "2026-11-05T03:00:01.000Z" });

    const latency = await queryMetrics(db, {
      name: "approval.latency_ms",
      from: "2026-11-05T00:00:00.000Z",
      to: "2026-11-05T23:59:59.999Z",
    });
    assert.equal(latency.length, 1, "the latency metric is stored");
    assert.equal(typeof latency[0]!.value, "number", "a fractional value is a number, not a string");
    assert.equal(latency[0]!.value, 42.5, "the fractional latency round-trips exactly");

    const rate = await queryMetrics(db, {
      name: "connector.failure_rate",
      from: "2026-11-05T00:00:00.000Z",
      to: "2026-11-05T23:59:59.999Z",
    });
    assert.equal(rate[0]!.value, 0.125, "the fractional rate round-trips exactly");
  } finally {
    await db.close();
  }
});

test("recording the same input twice appends two rows (an append log, never an overwrite)", async () => {
  const db = await freshDb();
  try {
    const input: RecordMetricInput = {
      name: "agent.request",
      value: 1,
      recordedAt: "2026-11-05T04:00:00.000Z",
      platform: "chatgpt",
      outcome: "ok",
    };
    await recordMetric(db, input);
    await recordMetric(db, input);

    const events = await queryMetrics(db, {
      name: "agent.request",
      from: "2026-11-05T00:00:00.000Z",
      to: "2026-11-05T23:59:59.999Z",
    });
    assert.equal(events.length, 2, "both appends are present — the identical event was not deduped");
    assert.equal(await totalRows(db), 2, "two physical rows exist (append log, not an upsert)");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC2 — the live schema carries no free-text column: no json/jsonb column, no character column
// outside the fixed dimension/name set, and every such column is length-constrained.
// ===========================================================================

test("metric_events has no json/jsonb column (nowhere to put arbitrary content or tool parameters)", async () => {
  const db = await freshDb();
  try {
    const columns = await columnsOf(db, "metric_events");
    assert.ok(columns.length > 0, "metric_events has columns (the table exists)");
    for (const col of columns) {
      assert.ok(
        col.dataType !== "json" && col.dataType !== "jsonb",
        `column ${col.name} must not be a json/jsonb column (it could hold arbitrary content), got ${col.dataType}`,
      );
    }
  } finally {
    await db.close();
  }
});

test("metric_events has no character column outside the fixed name + dimension set", async () => {
  const db = await freshDb();
  try {
    // The ONLY text-bearing columns allowed: the metric name, the timestamp (if stored as text),
    // and the four constrained dimensions. Any OTHER character column is a free-text column that
    // could hold identity values, message content or tool parameters — forbidden by AC2. (A
    // surrogate key / value / timestamp stored as a numeric or timestamp type is not a character
    // column and so is not constrained here.)
    const allowed = new Set([
      "name",
      "recorded_at",
      "platform",
      "connector_id",
      "outcome",
      "error_category",
    ]);
    const columns = await columnsOf(db, "metric_events");
    for (const col of columns) {
      const isCharacter = col.dataType === "text" || col.dataType.startsWith("character");
      if (isCharacter) {
        assert.ok(
          allowed.has(col.name),
          `unexpected free-text column "${col.name}" (${col.dataType}) — the metrics schema must carry no column that could hold personal content`,
        );
      }
    }
  } finally {
    await db.close();
  }
});

test("every name/dimension column is length-constrained: a grossly oversized string is rejected", async () => {
  // Each string the store accepts is a SHORT identifier; the schema caps its length so the table
  // structurally cannot hold message content or tool parameters. A ~100k-char value is far beyond
  // any reasonable cap, so the database must reject the write (and store no row) for every one.
  const huge = "x".repeat(100_000);
  const base: RecordMetricInput = {
    name: "agent.request",
    value: 1,
    recordedAt: "2026-11-05T05:00:00.000Z",
  };
  const fields: (keyof RecordMetricInput)[] = [
    "name",
    "platform",
    "connectorId",
    "outcome",
    "errorCategory",
  ];

  for (const field of fields) {
    const db = await freshDb();
    try {
      const input = { ...base, [field]: huge } as RecordMetricInput;
      await assert.rejects(
        () => recordMetric(db, input),
        `an oversized ${field} must be rejected by the schema (the column is length-constrained)`,
      );
      assert.equal(
        await totalRows(db),
        0,
        `no row is stored when ${field} is oversized — the constraint held`,
      );
    } finally {
      await db.close();
    }
  }
});

// ===========================================================================
// AC3 — reads filter by metric name and an inclusive time range; other names and out-of-range
// events are excluded; results come back oldest-first; no match → []; name/from/to are bound.
// ===========================================================================

// Seed a mixed set and return the db. Distinct `value`s identify which events a query returned,
// independent of ordering.
async function seedMixed(db: Db): Promise<void> {
  // agent.request on 2026-11-05 at 01:00 and 02:00, and on 2026-11-06.
  await recordMetric(db, { name: "agent.request", value: 10, recordedAt: "2026-11-05T01:00:00.000Z", platform: "claude", outcome: "ok" });
  await recordMetric(db, { name: "agent.request", value: 20, recordedAt: "2026-11-05T02:00:00.000Z", platform: "chatgpt", outcome: "error", errorCategory: "timeout" });
  await recordMetric(db, { name: "agent.request", value: 30, recordedAt: "2026-11-06T00:00:00.000Z", platform: "claude", outcome: "ok" });
  // A DIFFERENT metric name on 2026-11-05 — must never answer an agent.request query.
  await recordMetric(db, { name: "connector.failure", value: 40, recordedAt: "2026-11-05T01:30:00.000Z", connectorId: "gmail", outcome: "error" });
}

test("queryMetrics filters by name and inclusive range: other names and out-of-range events are excluded", async () => {
  const db = await freshDb();
  try {
    await seedMixed(db);

    // agent.request within 2026-11-05 only: the 01:00 and 02:00 events, NOT the 2026-11-06 event,
    // NOT the connector.failure event (different name).
    const events = await queryMetrics(db, {
      name: "agent.request",
      from: "2026-11-05T00:00:00.000Z",
      to: "2026-11-05T23:59:59.999Z",
    });
    const values = events.map((e) => e.value).sort((a, b) => a - b);
    assert.deepEqual(values, [10, 20], "only the in-range agent.request events are returned");
    assert.ok(events.every((e) => e.name === "agent.request"), "no other metric name leaks into the result");
  } finally {
    await db.close();
  }
});

test("queryMetrics is INCLUSIVE of both range boundaries (from == first event, to == last event)", async () => {
  const db = await freshDb();
  try {
    await seedMixed(db);

    // from = the 01:00 event's exact instant, to = the 02:00 event's exact instant: both included.
    const events = await queryMetrics(db, {
      name: "agent.request",
      from: "2026-11-05T01:00:00.000Z",
      to: "2026-11-05T02:00:00.000Z",
    });
    const values = events.map((e) => e.value).sort((a, b) => a - b);
    assert.deepEqual(values, [10, 20], "an event exactly on either boundary is included");
  } finally {
    await db.close();
  }
});

test("queryMetrics returns results oldest-first (ascending recordedAt)", async () => {
  const db = await freshDb();
  try {
    await seedMixed(db);

    const events = await queryMetrics(db, {
      name: "agent.request",
      from: "2026-11-01T00:00:00.000Z",
      to: "2026-11-30T00:00:00.000Z",
    });
    assert.deepEqual(
      events.map((e) => e.value),
      [10, 20, 30],
      "the three agent.request events come back oldest-first",
    );
    // The recorded instants are non-decreasing in the returned order.
    for (let i = 1; i < events.length; i++) {
      assert.ok(
        new Date(events[i - 1]!.recordedAt as string).getTime() <= new Date(events[i]!.recordedAt as string).getTime(),
        "results are ordered oldest-first by recordedAt",
      );
    }
  } finally {
    await db.close();
  }
});

test("queryMetrics returns [] for a name with no events and for a range that excludes them all", async () => {
  const db = await freshDb();
  try {
    await seedMixed(db);

    const unknownName = await queryMetrics(db, {
      name: "metric.that.was.never.recorded",
      from: "2026-11-01T00:00:00.000Z",
      to: "2026-11-30T00:00:00.000Z",
    });
    assert.deepEqual(unknownName, [], "an unrecorded metric name yields no events");

    const outOfRange = await queryMetrics(db, {
      name: "agent.request",
      from: "2025-01-01T00:00:00.000Z",
      to: "2025-12-31T23:59:59.999Z",
    });
    assert.deepEqual(outOfRange, [], "a range before every stored event yields no events");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC4 (parameterize half) — every field reaches the query layer BOUND; a SQL-injection probe
// routed through the repo cannot alter a query; the table survives.
// ===========================================================================

test("recordMetric binds every field as a parameter, never woven into the SQL text", async () => {
  const db = recordingDb();
  await recordMetric(db, {
    name: "agent.request",
    value: 7,
    recordedAt: "2026-11-05T06:00:00.000Z",
    platform: "claude",
    connectorId: "gmail",
    outcome: "ok",
    errorCategory: "timeout",
  });

  assert.ok(db.calls.length >= 1, "a statement was issued");
  const bound = db.calls.flatMap((c) => c.values);
  assert.ok(bound.includes("agent.request"), "the metric name travels as a bound value");
  assert.ok(bound.includes(7), "the numeric value travels as a bound value");
  assert.ok(bound.includes("claude"), "the platform travels as a bound value");
  assert.ok(bound.includes("gmail"), "the connector id travels as a bound value");
  assert.ok(bound.includes("ok"), "the outcome travels as a bound value");
  assert.ok(bound.includes("timeout"), "the error category travels as a bound value");
  for (const call of db.calls) {
    assert.ok(!call.text.includes("'agent.request'"), "the name is bound, never concatenated into the SQL");
    assert.ok(!call.text.includes("'claude'"), "the platform is bound, never concatenated into the SQL");
  }
});

test("queryMetrics binds the name and the time range as parameters, never woven into the SQL text", async () => {
  const db = recordingDb();
  const events = await queryMetrics(db, {
    name: "agent.request",
    from: "2026-11-05T00:00:00.000Z",
    to: "2026-11-05T23:59:59.999Z",
  });

  // The recording db returns no rows, so a read reports [] carrying no leaked SQL — but whatever
  // statement it issued must have BOUND the name and the range.
  assert.deepEqual(events, [], "no rows → empty result");
  assert.ok(db.calls.length >= 1, "a statement was issued");
  const bound = db.calls.flatMap((c) => c.values);
  assert.ok(bound.includes("agent.request"), "the metric name is bound");
  assert.ok(bound.includes("2026-11-05T00:00:00.000Z"), "the range lower bound is bound");
  assert.ok(bound.includes("2026-11-05T23:59:59.999Z"), "the range upper bound is bound");
});

test("a SQL-injection probe in the metric name is bound, never run: recordMetric cannot drop the table", async () => {
  const recorder = recordingDb();
  await recordMetric(recorder, {
    name: INJECTION,
    value: 1,
    recordedAt: "2026-11-05T07:00:00.000Z",
  });
  assertBoundNotSpliced(recorder, INJECTION);

  // And against a REAL database: the probe is bound, so even if it reaches the repo it cannot
  // execute the injected statement — the table must still be there afterwards. (A schema
  // constraint may reject it; either way the DROP never runs.)
  const db = await freshDb();
  try {
    try {
      await recordMetric(db, { name: INJECTION, value: 1, recordedAt: "2026-11-05T07:00:00.000Z" });
    } catch {
      /* tolerate a constraint/shape error — the point is that no injected statement ran */
    }
    assert.equal(
      await tableExists(db, "metric_events"),
      true,
      "the metric_events table must still exist (the probe was bound, never executed as SQL)",
    );
  } finally {
    await db.close();
  }
});

test("a SQL-injection probe in a dimension is bound, never run: recordMetric cannot drop the table", async () => {
  const recorder = recordingDb();
  await recordMetric(recorder, {
    name: "agent.request",
    value: 1,
    recordedAt: "2026-11-05T07:30:00.000Z",
    platform: INJECTION,
  });
  assertBoundNotSpliced(recorder, INJECTION);

  const db = await freshDb();
  try {
    try {
      await recordMetric(db, {
        name: "agent.request",
        value: 1,
        recordedAt: "2026-11-05T07:30:00.000Z",
        platform: INJECTION,
      });
    } catch {
      /* tolerate a constraint/shape error */
    }
    assert.equal(await tableExists(db, "metric_events"), true, "the table survives a probe in a dimension");
  } finally {
    await db.close();
  }
});

test("a SQL-injection probe in the query name is bound, never run: queryMetrics cannot drop the table", async () => {
  const recorder = recordingDb();
  const result = await queryMetrics(recorder, {
    name: INJECTION,
    from: "2026-11-05T00:00:00.000Z",
    to: "2026-11-05T23:59:59.999Z",
  });
  assert.deepEqual(result, [], "no rows → empty result");
  assertBoundNotSpliced(recorder, INJECTION);

  const db = await freshDb();
  try {
    const live = await queryMetrics(db, {
      name: INJECTION,
      from: "2026-11-05T00:00:00.000Z",
      to: "2026-11-05T23:59:59.999Z",
    });
    assert.deepEqual(live, [], "the probe name simply matches nothing — it is a value, not SQL");
    assert.equal(await tableExists(db, "metric_events"), true, "the table survives a probe in the query name");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC4 (validate half) — a handler on the `../http/validate` boundary rejects malformed /
// oversized / missing / mis-typed / mis-shaped / injection-shaped input with a 4xx BEFORE any
// query runs, and accepts a well-formed body and stores it. This handler is a test fixture that
// EXERCISES the modules (parseBody → the parameterized repo) — it is NOT an implementation file.
// ===========================================================================

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;
const METRIC_NAME = /^[a-z][a-z0-9_.]{0,99}$/; // a dotted, lowercase, bounded metric name
const DIMENSION = /^[A-Za-z0-9][A-Za-z0-9_.\-]{0,63}$/; // a short, safe, bounded dimension label

function recordMetricHandler(db: Db): (req: Request) => Promise<Response> {
  // The body carries one metric event. The name and dimensions are validated to a short safe
  // shape (so a mis-shaped or injection-shaped value is rejected HERE and never reaches a query),
  // the value to a number, and the instant to an ISO-8601 shape — a well-formed value is then
  // BOUND by the repo.
  const schema = z.object({
    name: z.string().regex(METRIC_NAME),
    value: z.number(),
    recordedAt: z.string().regex(ISO_INSTANT),
    platform: z.string().regex(DIMENSION).nullish(),
    connectorId: z.string().regex(DIMENSION).nullish(),
    outcome: z.string().regex(DIMENSION).nullish(),
    errorCategory: z.string().regex(DIMENSION).nullish(),
  });
  return async (req: Request): Promise<Response> => {
    try {
      const body = await parseBody(schema, req, { maxBytes: 4 * 1024 });
      await recordMetric(db, {
        name: body.name,
        value: body.value,
        recordedAt: body.recordedAt,
        platform: body.platform ?? null,
        connectorId: body.connectorId ?? null,
        outcome: body.outcome ?? null,
        errorCategory: body.errorCategory ?? null,
      });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    } catch (err) {
      if (err instanceof HttpError) {
        return new Response(JSON.stringify({ error: "invalid input" }), { status: err.status });
      }
      // A non-HttpError escaping the boundary is an uncontrolled 500; surface it so a test sees
      // the raw-500 failure rather than a masked success.
      return new Response("internal error", { status: 500 });
    }
  };
}

function jsonRequest(body: string): Request {
  return new Request("https://warthog.com.au/api/metrics", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

const WELL_FORMED_BODY = JSON.stringify({
  name: "agent.request",
  value: 1,
  recordedAt: "2026-11-05T02:30:00.000Z",
  platform: "claude",
  connectorId: "gmail",
  outcome: "ok",
  errorCategory: null,
});

test("the handler rejects malformed JSON with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = recordMetricHandler(db);

  const res = await handler(jsonRequest("{ not valid json"));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "malformed input must never reach a query");
});

test("the handler rejects an oversized body with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = recordMetricHandler(db);

  // ~10 KiB body, well over the handler's 4 KiB cap: rejected by size before parse.
  const res = await handler(
    jsonRequest(
      JSON.stringify({
        name: "agent.request",
        value: 1,
        recordedAt: "2026-11-05T02:30:00.000Z",
        junk: "x".repeat(10 * 1024),
      }),
    ),
  );

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "an oversized body must never reach a query");
});

test("the handler rejects a body missing the metric name with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = recordMetricHandler(db);

  const res = await handler(jsonRequest(JSON.stringify({ value: 1, recordedAt: "2026-11-05T02:30:00.000Z" })));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "a schema violation must never reach a query");
});

test("the handler rejects a body missing the numeric value with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = recordMetricHandler(db);

  const res = await handler(jsonRequest(JSON.stringify({ name: "agent.request", recordedAt: "2026-11-05T02:30:00.000Z" })));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "a schema violation must never reach a query");
});

test("the handler rejects a mis-typed value (string, not number) with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = recordMetricHandler(db);

  const res = await handler(
    jsonRequest(JSON.stringify({ name: "agent.request", value: "1", recordedAt: "2026-11-05T02:30:00.000Z" })),
  );

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "a mis-typed value must never reach a query");
});

test("the handler rejects an over-long metric name with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = recordMetricHandler(db);

  // 101 chars — over the handler's name cap, so rejected before any query.
  const res = await handler(
    jsonRequest(JSON.stringify({ name: "a".repeat(101), value: 1, recordedAt: "2026-11-05T02:30:00.000Z" })),
  );

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "an over-long name must never reach a query");
});

test("the handler rejects a mis-shaped recordedAt with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = recordMetricHandler(db);

  // "05/11/2026" is not an ISO-8601 instant — rejected before any query.
  const res = await handler(jsonRequest(JSON.stringify({ name: "agent.request", value: 1, recordedAt: "05/11/2026" })));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "a mis-shaped instant must never reach a query");
});

test("the handler rejects an injection-shaped metric name with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = recordMetricHandler(db);

  const res = await handler(jsonRequest(JSON.stringify({ name: INJECTION, value: 1, recordedAt: "2026-11-05T02:30:00.000Z" })));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx for the probe, got ${res.status}`);
  assert.equal(db.calls.length, 0, "an injection-shaped name is rejected by validation and never reaches a query");
});

test("the handler rejects an injection-shaped dimension with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = recordMetricHandler(db);

  const res = await handler(
    jsonRequest(JSON.stringify({ name: "agent.request", value: 1, recordedAt: "2026-11-05T02:30:00.000Z", platform: INJECTION })),
  );

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx for the probe, got ${res.status}`);
  assert.equal(db.calls.length, 0, "an injection-shaped dimension is rejected by validation and never reaches a query");
});

test("the handler accepts a well-formed body and persists the metric event", async () => {
  const db = await freshDb();
  try {
    const handler = recordMetricHandler(db);

    const res = await handler(jsonRequest(WELL_FORMED_BODY));
    assert.ok(res.status >= 200 && res.status < 300, `expected a 2xx, got ${res.status}`);

    const events = await queryMetrics(db, {
      name: "agent.request",
      from: "2026-11-05T00:00:00.000Z",
      to: "2026-11-05T23:59:59.999Z",
    });
    assert.equal(events.length, 1, "the submitted metric is stored");
    assert.equal(events[0]!.value, 1, "and reads back as submitted");
    assert.equal(events[0]!.platform, "claude", "with its submitted platform dimension");
    assert.equal(events[0]!.connectorId, "gmail", "with its submitted connector id dimension");
    assert.equal(events[0]!.errorCategory, null, "and an explicit null dimension stays null");
  } finally {
    await db.close();
  }
});

test("the handler cannot be SQL-injected via the metric name: the metric_events table survives", async () => {
  const db = await freshDb();
  try {
    const handler = recordMetricHandler(db);

    const res = await handler(jsonRequest(JSON.stringify({ name: INJECTION, value: 1, recordedAt: "2026-11-05T02:30:00.000Z" })));

    // The injection-shaped value fails the name-shape validation, so it is rejected (never run).
    assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx for the probe, got ${res.status}`);
    assert.equal(await tableExists(db, "metric_events"), true, "the metric_events table must still exist");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC5 — the repo reads no process.env: a decoy secret in the environment never lands in a
// stored or returned metric.
// ===========================================================================

test("the repo reads no process.env: a decoy secret in the environment never lands in a metric", async () => {
  const DECOY = "sk_live_DECOY_must_never_appear_in_warthog";
  const prev = process.env.WARTHOG_DECOY_SECRET;
  process.env.WARTHOG_DECOY_SECRET = DECOY;
  const db = await freshDb();
  try {
    await recordMetric(db, {
      name: "agent.request",
      value: 1,
      recordedAt: "2026-11-05T08:00:00.000Z",
      platform: "claude",
    });

    const events = await queryMetrics(db, {
      name: "agent.request",
      from: "2026-11-05T00:00:00.000Z",
      to: "2026-11-05T23:59:59.999Z",
    });
    assert.equal(events.length, 1, "the write and read run purely from the injected db + inputs — no app env needed");
    assert.ok(
      !JSON.stringify(events).includes(DECOY),
      "no ambient env value is folded into the returned metric",
    );

    // Scan every cell of the one table under test for the decoy (scoped narrowly — the same value
    // could legitimately live elsewhere if it were a real datum, which it is not).
    const all = await db.query("SELECT * FROM metric_events");
    for (const row of all.rows) {
      for (const cell of Object.values(row)) {
        if (typeof cell === "string") {
          assert.ok(!cell.includes(DECOY), "no ambient env value is written to a column");
        }
      }
    }
  } finally {
    await db.close();
    if (prev === undefined) delete process.env.WARTHOG_DECOY_SECRET;
    else process.env.WARTHOG_DECOY_SECRET = prev;
  }
});

// ===========================================================================
// Migration — the table applies, 0044_metrics is part of the set, and a second run of every
// migration changes nothing.
// ===========================================================================

test("the metric_events migration applies and re-running every migration changes nothing", async () => {
  const db = await freshDb();
  try {
    assert.equal(
      await tableExists(db, "metric_events"),
      true,
      "the metric_events table must exist after the project migrations",
    );

    const migrations = await loadMigrations();
    assert.ok(
      migrations.some((m) => m.name === "0044_metrics"),
      "db/migrations/0044_metrics.sql must be part of the project migrations",
    );

    // A second run over the same database applies nothing new and does not throw — re-executing
    // 0044's CREATE would throw "already exists", so an empty result AND no throw together prove
    // the migration's second run changes nothing.
    const again = await runMigrations(db, migrations);
    assert.deepEqual(again, [], "a second migration run must change nothing");
  } finally {
    await db.close();
  }
});

// Keep the documentary input/query/event types referenced so a drift in their names is noticed
// at authoring time (the imports are erased at runtime; this never executes).
export type __RecordMetricInputAnchor = RecordMetricInput;
export type __MetricEventAnchor = MetricEvent;
export type __MetricQueryAnchor = MetricQuery;
