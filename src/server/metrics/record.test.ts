// E17-S02 — Metrics recorder with personal-content guard (`src/server/metrics/record.ts`).
//
// RED-first: the recorder module does NOT exist yet, so importing `./record` throws and every
// test here fails until the builder writes it. That absence IS the point of test-first — do NOT
// implement anything to make these pass; the builder writes the recorder afterwards.
//
// These tests pin BEHAVIOUR (what the recorder DOES: a metric with allowlisted dimensions and a
// finite numeric value is written as ONE event; a metric carrying a non-allowlisted dimension key
// or a free-text / structured dimension value is REJECTED and writes NOTHING; a non-numeric
// (NaN/∞) value is rejected; the recorder stamps the instant from the injected clock; a handler on
// the `../http/validate` boundary rejects malformed / oversized / mis-shaped / smuggling input with
// a 4xx before any query; every field reaches the query layer BOUND; the recorder reads no
// `process.env`). It never asserts the source text of the module — a later rename that preserves
// behaviour must not redden it.
//
// WHY this exists (task E17-S02): metrics carry NO personal content. The ONE write path enforces an
// allowlist of dimension KEYS — {platform, connectorId, outcome, errorCategory}, the four
// constrained, non-personal dimensions of the E17-S01 store — so no caller can smuggle an identity
// value, message or tool parameter into metrics. Enforcing it at the single recorder guarantees it
// regardless of the caller. The recorder writes THROUGH E17-S01's `recordMetric` (every value bound,
// constitution INV-102) and is NOT member-scoped — operational numbers are global, not personal, so
// the guard here is the allowlist, not DEK-encryption.
//
// ---------------------------------------------------------------------------
// THE PINNED CONTRACT (chosen by the tester; the implementation conforms to it).
//
//   interface RecordMetricInput {
//     name: string;                      // the operational metric name, e.g. "agent.request"
//     value: number;                     // a FINITE operational number (count, rate, latency);
//                                        //   NaN / +Infinity / -Infinity are rejected
//     dimensions?: Record<string, unknown>;
//                                        // an OPEN map: ONLY allowlisted keys with short-identifier
//                                        //   STRING values survive; any other key, or a free-text /
//                                        //   structured / non-string value, is REJECTED (nothing stored)
//   }
//
//   recordMetricEvent(db: Db, clock: Clock, input: RecordMetricInput): Promise<void>
//     • the SINGLE guarded write path. It stamps the event's instant from `clock`, enforces the
//       dimension-key allowlist {platform, connectorId, outcome, errorCategory} and a finite numeric
//       value, maps each allowlisted dimension onto the corresponding E17-S01 column, then writes ONE
//       row through `recordMetric` with every field BOUND as a parameter. On a guard violation it
//       REJECTS (the returned promise rejects) and writes NOTHING.
//
// Acceptance criteria → tests:
//   AC1 "Recording a metric with allowlisted dimensions and a numeric value stores one metric event."
//       — recordMetricEvent with the four allowlisted dimensions + a numeric value appends exactly one
//         event that reads back (via E17-S01 queryMetrics) with its value, every dimension, and the
//         clock's instant; omitted dimensions read back null; a fractional value round-trips.
//   AC2 "Recording a metric with a non-allowlisted or free-text dimension key is rejected and stores
//       nothing." — a dimension under any key outside the allowlist is rejected and no row is written;
//       a free-text / structured dimension VALUE (prose, email, oversized, an object) is rejected too.
//   AC3 "The recorder never persists tool parameters, identity values or message content." — an
//       attempt to smuggle an identity value, a message or a tool parameter (as a dimension key or a
//       free-text value) is rejected and never reaches a stored cell.
//   AC4 [obligation:validate-and-parameterize-input] (INV-102) — a handler on the `../http/validate`
//       boundary rejects malformed / oversized / missing / mis-typed / non-allowlisted / free-text /
//       injection-shaped input with a 4xx BEFORE any query; a SQL-injection probe routed through the
//       recorder cannot alter a query (it is bound, or the guard rejects it — the table survives
//       either way). The handler below is a test fixture (the intended usage), not an implementation.
//   AC5 [obligation:secrets-from-env] (INV-103) — the recorder reads no `process.env` and holds no
//       secret: a decoy secret planted in the environment never lands in a stored or returned metric;
//       the recorder runs purely from its injected db + clock + input.
//
// Each real-db test uses its own `freshDb()` (an isolated in-memory PGlite with the real migrations,
// including E17-S01's 0044_metrics) and closes it in a `finally`, so tests share no state.

import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";

import { recordMetricEvent } from "./record";
// Documentary type anchor — the input shape the implementation exports. Erased at runtime (test
// files are excluded from `tsc`), so a rename cannot break these tests; the runtime assertions are
// what gate behaviour.
import type { RecordMetricInput } from "./record";
import { queryMetrics, type MetricEvent } from "../db/metrics";
import { freshDb } from "../../test/db";
import type { Db, QueryResult } from "../db/index";
import { fixedClock, type Clock } from "../seams/clock";
import { parseBody, HttpError } from "../http/validate";

// --- fixtures ---------------------------------------------------------------------

// A db seam stand-in that records every call instead of running it, so a test can prove WHAT reached
// the query layer and HOW (bound value vs. spliced text), and that a REJECTED write issues no query
// at all. Returns no rows and satisfies the `Db` shape structurally (query + close).
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

// Whether a relation of this exact name exists on this handle (a non-throwing probe scoped to the
// one table under test — behaviour, not source text).
async function tableExists(db: Db, name: string): Promise<boolean> {
  const result = await db.query("SELECT to_regclass($1) AS t", [name]);
  return result.rows[0]?.t != null;
}

// Total rows in metric_events — proves a write landed (or a rejected write did not).
async function totalRows(db: Db): Promise<number> {
  const result = await db.query("SELECT count(*)::int AS n FROM metric_events");
  return result.rows[0]!.n as number;
}

// The same instant regardless of whether the store returns an ISO string or a Date.
function sameInstant(a: unknown, b: string): boolean {
  return new Date(a as string | number | Date).getTime() === new Date(b).getTime();
}

// The injection probe reused across the parameterize tests.
const INJECTION = "boom'); DROP TABLE metric_events; --";

// A fixed clock: the recorder must stamp the event from THIS, never Date.now().
const AT = "2026-11-05T02:30:00.000Z";
const CLOCK: Clock = fixedClock(new Date(AT));
const DAY_FROM = "2026-11-05T00:00:00.000Z";
const DAY_TO = "2026-11-05T23:59:59.999Z";

// The four allowlisted dimension keys (the E17-S01 store's constrained, non-personal dimensions).
// A metric may carry only these; any other key is a smuggling vector and is rejected.
const ALLOWED_DIMENSIONS = {
  platform: "claude",
  connectorId: "gmail",
  outcome: "ok",
  errorCategory: "timeout",
} as const;

// ===========================================================================
// AC1 — an allowlisted metric is written as ONE event and reads back; the clock stamps the instant;
// omitted dimensions are null; a fractional value round-trips.
// ===========================================================================

test("records one event with allowlisted dimensions + a numeric value, read back through the store", async () => {
  const db = await freshDb();
  try {
    const input: RecordMetricInput = {
      name: "agent.request",
      value: 1,
      dimensions: { ...ALLOWED_DIMENSIONS },
    };
    await recordMetricEvent(db, CLOCK, input);

    const events: MetricEvent[] = await queryMetrics(db, { name: "agent.request", from: DAY_FROM, to: DAY_TO });
    assert.equal(events.length, 1, "exactly the one recorded event is stored");
    const event = events[0]!;
    assert.equal(event.name, "agent.request", "the metric name round-trips");
    assert.equal(typeof event.value, "number", "the value is a number, not a numeric string");
    assert.equal(event.value, 1, "the numeric value round-trips");
    assert.equal(event.platform, "claude", "the platform dimension maps onto its column");
    assert.equal(event.connectorId, "gmail", "the connector id dimension maps onto its column");
    assert.equal(event.outcome, "ok", "the outcome dimension maps onto its column");
    assert.equal(event.errorCategory, "timeout", "the error-category dimension maps onto its column");
  } finally {
    await db.close();
  }
});

test("stamps the event's instant from the INJECTED clock, not wall-clock time", async () => {
  const db = await freshDb();
  try {
    const instant = "2026-11-05T09:15:30.000Z";
    await recordMetricEvent(db, fixedClock(new Date(instant)), { name: "household.count", value: 42 });

    const events = await queryMetrics(db, { name: "household.count", from: DAY_FROM, to: DAY_TO });
    assert.equal(events.length, 1, "the event is stored");
    assert.ok(sameInstant(events[0]!.recordedAt, instant), "recordedAt is the clock's instant");
  } finally {
    await db.close();
  }
});

test("omitted dimensions are stored and read back as null (no smuggled default)", async () => {
  const db = await freshDb();
  try {
    await recordMetricEvent(db, CLOCK, { name: "household.count", value: 7 });

    const events = await queryMetrics(db, { name: "household.count", from: DAY_FROM, to: DAY_TO });
    assert.equal(events.length, 1, "the dimension-less event is stored");
    const event = events[0]!;
    assert.equal(event.value, 7, "its value round-trips");
    assert.equal(event.platform, null, "an omitted platform reads back null");
    assert.equal(event.connectorId, null, "an omitted connector id reads back null");
    assert.equal(event.outcome, null, "an omitted outcome reads back null");
    assert.equal(event.errorCategory, null, "an omitted error category reads back null");
  } finally {
    await db.close();
  }
});

test("an explicitly null allowlisted dimension is accepted and stored as null", async () => {
  const db = await freshDb();
  try {
    await recordMetricEvent(db, CLOCK, {
      name: "agent.request",
      value: 1,
      dimensions: { platform: "claude", connectorId: null, outcome: "ok", errorCategory: null },
    });

    const events = await queryMetrics(db, { name: "agent.request", from: DAY_FROM, to: DAY_TO });
    assert.equal(events.length, 1, "the event is stored");
    assert.equal(events[0]!.platform, "claude", "a present dimension is stored");
    assert.equal(events[0]!.connectorId, null, "an explicit null dimension stays null");
    assert.equal(events[0]!.errorCategory, null, "an explicit null dimension stays null");
  } finally {
    await db.close();
  }
});

test("a fractional numeric value (a rate/latency) round-trips exactly as a number", async () => {
  const db = await freshDb();
  try {
    await recordMetricEvent(db, CLOCK, { name: "connector.failure_rate", value: 0.125 });

    const events = await queryMetrics(db, { name: "connector.failure_rate", from: DAY_FROM, to: DAY_TO });
    assert.equal(events.length, 1, "the rate metric is stored");
    assert.equal(typeof events[0]!.value, "number", "a fractional value is a number, not a string");
    assert.equal(events[0]!.value, 0.125, "the fractional value round-trips exactly");
  } finally {
    await db.close();
  }
});

test("the recorder is a plain append path — recording the same metric twice stores two rows", async () => {
  const db = await freshDb();
  try {
    await recordMetricEvent(db, CLOCK, { name: "agent.request", value: 1, dimensions: { outcome: "ok" } });
    await recordMetricEvent(db, CLOCK, { name: "agent.request", value: 1, dimensions: { outcome: "ok" } });

    assert.equal(await totalRows(db), 2, "two physical rows exist (an append log, not an upsert)");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC2 — a non-allowlisted dimension KEY, or a free-text / structured dimension VALUE, is rejected and
// nothing is stored. A non-numeric (NaN/∞) value is rejected too ("accepting only a numeric value").
// ===========================================================================

// Keys that are NOT on the allowlist — each a vector for an identity value, message or tool
// parameter. The store has no column for any of them; the recorder must reject them outright.
const NON_ALLOWLISTED_KEYS = [
  "userId",
  "user_id",
  "email",
  "phone",
  "name",
  "message",
  "content",
  "body",
  "toolParams",
  "tool_params",
  "args",
  "merchant",
  "address",
  "note",
  "foo",
];

test("a dimension under a non-allowlisted key is rejected and issues NO query", async () => {
  for (const key of NON_ALLOWLISTED_KEYS) {
    const db = recordingDb();
    await assert.rejects(
      () => recordMetricEvent(db, CLOCK, { name: "agent.request", value: 1, dimensions: { [key]: "x" } }),
      `a dimension under "${key}" (not on the allowlist) must be rejected`,
    );
    assert.equal(db.calls.length, 0, `a rejected "${key}" dimension must never reach a query`);
  }
});

test("a non-allowlisted dimension key stores nothing against a real database", async () => {
  const db = await freshDb();
  try {
    await assert.rejects(
      () => recordMetricEvent(db, CLOCK, { name: "agent.request", value: 1, dimensions: { userId: "u_123" } }),
      "a userId dimension must be rejected",
    );
    assert.equal(await totalRows(db), 0, "no row is written when a non-allowlisted key is present");
  } finally {
    await db.close();
  }
});

test("an allowlisted key mixed WITH a non-allowlisted key is rejected whole — the good part is not saved", async () => {
  const db = await freshDb();
  try {
    await assert.rejects(
      () =>
        recordMetricEvent(db, CLOCK, {
          name: "agent.request",
          value: 1,
          dimensions: { platform: "claude", message: "the user said hello" },
        }),
      "a mix of an allowlisted and a non-allowlisted key must be rejected",
    );
    assert.equal(await totalRows(db), 0, "the write is rejected whole — no partial row is stored");
  } finally {
    await db.close();
  }
});

// Free-text / structured VALUES under an otherwise-allowlisted key — prose, an email, an oversized
// string, or a nested object (a shape tool parameters arrive in). A dimension is a SHORT identifier
// label; none of these is, so each is rejected ("rejecting any free-text dimension").
const FREE_TEXT_VALUES: { key: keyof typeof ALLOWED_DIMENSIONS; value: unknown; why: string }[] = [
  { key: "outcome", value: "the user said hello", why: "prose with spaces" },
  { key: "platform", value: "person@example.com", why: "an email / identity value" },
  { key: "connectorId", value: "hello, world!", why: "punctuation typical of prose" },
  { key: "errorCategory", value: "x".repeat(500), why: "an oversized string (a message fragment)" },
  { key: "outcome", value: { nested: "tool params" }, why: "a structured object (tool parameters)" },
];

test("a free-text or structured dimension value under an allowlisted key is rejected and issues NO query", async () => {
  for (const { key, value, why } of FREE_TEXT_VALUES) {
    const db = recordingDb();
    await assert.rejects(
      () =>
        recordMetricEvent(db, CLOCK, {
          name: "agent.request",
          value: 1,
          dimensions: { [key]: value } as Record<string, unknown>,
        }),
      `a ${why} dimension value must be rejected (dimensions are short identifiers, not free text)`,
    );
    assert.equal(db.calls.length, 0, `a rejected ${why} value must never reach a query`);
  }
});

test("a free-text dimension value stores nothing against a real database", async () => {
  const db = await freshDb();
  try {
    await assert.rejects(
      () =>
        recordMetricEvent(db, CLOCK, {
          name: "agent.request",
          value: 1,
          dimensions: { outcome: "the agent sent a long message about the user" },
        }),
      "a free-text outcome must be rejected",
    );
    assert.equal(await totalRows(db), 0, "no row is written for a free-text dimension value");
  } finally {
    await db.close();
  }
});

test('"accepting only a numeric value": NaN, +Infinity and -Infinity are rejected and store nothing', async () => {
  for (const value of [NaN, Infinity, -Infinity]) {
    const db = recordingDb();
    await assert.rejects(
      () => recordMetricEvent(db, CLOCK, { name: "agent.request", value }),
      `value ${String(value)} is not a finite number and must be rejected`,
    );
    assert.equal(db.calls.length, 0, `a non-finite value (${String(value)}) must never reach a query`);
  }

  const db = await freshDb();
  try {
    await assert.rejects(() => recordMetricEvent(db, CLOCK, { name: "agent.request", value: NaN }));
    assert.equal(await totalRows(db), 0, "no NaN row lands in the real store");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC3 — the recorder never persists tool parameters, identity values or message content: a smuggle
// attempt (as a dimension key OR a free-text value) is rejected and the probe never reaches a cell.
// ===========================================================================

test("an identity value / message / tool parameter smuggled as a dimension key never lands in the store", async () => {
  const PERSONAL = "Jane Qs Medicare 2468 1357 9000 secret-note";
  // Each key/value pair is a realistic smuggle vector: an identity field, message content, a tool
  // parameter. Every one carries PERSONAL as its value so we can scan the store for a leak.
  const vectors: Record<string, string> = {
    userId: PERSONAL,
    email: PERSONAL,
    message: PERSONAL,
    content: PERSONAL,
    toolParams: PERSONAL,
    merchant: PERSONAL,
  };
  const db = await freshDb();
  try {
    for (const [key, value] of Object.entries(vectors)) {
      await assert.rejects(
        () => recordMetricEvent(db, CLOCK, { name: "agent.request", value: 1, dimensions: { [key]: value } }),
        `smuggling under "${key}" must be rejected`,
      );
    }
    assert.equal(await totalRows(db), 0, "no smuggle attempt wrote a row");

    // Scan every cell of the one table under test for the personal probe (scoped narrowly — this
    // value is not a legitimate datum, so it must appear nowhere in metric_events).
    const all = await db.query("SELECT * FROM metric_events");
    for (const row of all.rows) {
      for (const cell of Object.values(row)) {
        if (typeof cell === "string") {
          assert.ok(!cell.includes("secret-note"), "no smuggled personal content reached a column");
        }
      }
    }
  } finally {
    await db.close();
  }
});

test("message content smuggled as a free-text value under an allowlisted key never lands in the store", async () => {
  const MESSAGE = "please pay invoice for Jane at 12 Pine St this is a whole sentence";
  const db = await freshDb();
  try {
    await assert.rejects(
      () => recordMetricEvent(db, CLOCK, { name: "agent.request", value: 1, dimensions: { outcome: MESSAGE } }),
      "a message pasted into an allowlisted dimension must be rejected",
    );
    assert.equal(await totalRows(db), 0, "the message never produced a row");

    const all = await db.query("SELECT * FROM metric_events");
    for (const row of all.rows) {
      for (const cell of Object.values(row)) {
        if (typeof cell === "string") {
          assert.ok(!cell.includes("Pine St"), "no message content reached a column");
        }
      }
    }
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC4 (parameterize half) — a valid metric reaches the query layer BOUND, never spliced; a
// SQL-injection probe cannot alter a query (the guard rejects it, or the store binds it — the table
// survives either way).
// ===========================================================================

test("recordMetricEvent binds every valid field as a parameter, never woven into the SQL text", async () => {
  const db = recordingDb();
  await recordMetricEvent(db, CLOCK, { name: "agent.request", value: 7, dimensions: { ...ALLOWED_DIMENSIONS } });

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
    assert.ok(!call.text.includes("'gmail'"), "the connector id is bound, never concatenated into the SQL");
  }
});

test("a SQL-injection probe in the metric name cannot alter a query: it is bound or rejected, and the table survives", async () => {
  // Recording db: if the recorder issues a statement at all, the probe must be BOUND, never spliced.
  const rec = recordingDb();
  try {
    await recordMetricEvent(rec, CLOCK, { name: INJECTION, value: 1 });
  } catch {
    /* a guard rejection is equally acceptable — either way no injected statement ran */
  }
  for (const call of rec.calls) {
    assert.ok(!call.text.includes("DROP TABLE"), "no injected statement appears in the SQL text");
    assert.ok(!call.text.includes(INJECTION), "the probe is never concatenated into the SQL text");
  }
  if (rec.calls.length > 0) {
    assert.ok(rec.calls.some((c) => c.values.includes(INJECTION)), "if issued, the probe travels as a bound value");
  }

  // Real db: the injected DROP must never run — the table survives, and if a row was stored it is
  // inert data under that literal name (bound), not an executed statement.
  const db = await freshDb();
  try {
    let stored = true;
    try {
      await recordMetricEvent(db, CLOCK, { name: INJECTION, value: 1 });
    } catch {
      stored = false;
    }
    assert.equal(await tableExists(db, "metric_events"), true, "the metric_events table still exists");
    if (stored) {
      const back = await queryMetrics(db, { name: INJECTION, from: DAY_FROM, to: DAY_TO });
      assert.equal(back.length, 1, "the probe was stored as literal data (bound), never executed");
    }
  } finally {
    await db.close();
  }
});

test("a SQL-injection probe in a dimension cannot alter a query: it is rejected or bound, and the table survives", async () => {
  const rec = recordingDb();
  try {
    await recordMetricEvent(rec, CLOCK, { name: "agent.request", value: 1, dimensions: { platform: INJECTION } });
  } catch {
    /* the free-text guard rejecting the probe is the expected path */
  }
  for (const call of rec.calls) {
    assert.ok(!call.text.includes("DROP TABLE"), "no injected statement appears in the SQL text");
    assert.ok(!call.text.includes(INJECTION), "the probe is never concatenated into the SQL text");
  }

  const db = await freshDb();
  try {
    try {
      await recordMetricEvent(db, CLOCK, { name: "agent.request", value: 1, dimensions: { platform: INJECTION } });
    } catch {
      /* tolerate a guard rejection */
    }
    assert.equal(await tableExists(db, "metric_events"), true, "the table survives a probe in a dimension");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC4 (validate half) — a handler on the `../http/validate` boundary rejects malformed / oversized /
// missing / mis-typed / non-allowlisted / free-text / injection-shaped input with a 4xx BEFORE any
// query, and accepts a well-formed body and stores it through the recorder. This handler is a test
// fixture that EXERCISES the modules (parseBody → the guarded recorder) — NOT an implementation file.
// ===========================================================================

const METRIC_NAME = /^[a-z][a-z0-9_.]{0,99}$/; // a dotted, lowercase, bounded operational metric name
const DIMENSION = /^[A-Za-z0-9][A-Za-z0-9_.\-]{0,63}$/; // a short, safe, bounded dimension label

function recordMetricHandler(db: Db, clock: Clock): (req: Request) => Promise<Response> {
  // The body carries the metric name, the numeric value, and OPTIONAL dimensions. The dimensions
  // object is STRICT — only the four allowlisted keys exist, so any other key is rejected HERE and
  // never reaches a query — and each dimension is validated to a short safe shape (so a free-text or
  // injection-shaped value is rejected too). The recorder stamps the instant, so the body has none.
  const schema = z.object({
    name: z.string().regex(METRIC_NAME),
    value: z.number(),
    dimensions: z
      .object({
        platform: z.string().regex(DIMENSION).nullish(),
        connectorId: z.string().regex(DIMENSION).nullish(),
        outcome: z.string().regex(DIMENSION).nullish(),
        errorCategory: z.string().regex(DIMENSION).nullish(),
      })
      .strict()
      .optional(),
  });
  return async (req: Request): Promise<Response> => {
    try {
      const body = await parseBody(schema, req, { maxBytes: 4 * 1024 });
      await recordMetricEvent(db, clock, { name: body.name, value: body.value, dimensions: body.dimensions });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    } catch (err) {
      if (err instanceof HttpError) {
        return new Response(JSON.stringify({ error: "invalid input" }), { status: err.status });
      }
      // A non-HttpError escaping the boundary is an uncontrolled 500; surface it so a test sees the
      // raw-500 failure rather than a masked success.
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
  dimensions: { platform: "claude", connectorId: "gmail", outcome: "ok", errorCategory: null },
});

test("the handler rejects malformed JSON with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const res = await recordMetricHandler(db, CLOCK)(jsonRequest("{ not valid json"));
  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "malformed input must never reach a query");
});

test("the handler rejects an oversized body with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const res = await recordMetricHandler(db, CLOCK)(
    jsonRequest(JSON.stringify({ name: "agent.request", value: 1, junk: "x".repeat(10 * 1024) })),
  );
  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "an oversized body must never reach a query");
});

test("the handler rejects a body missing the metric name with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const res = await recordMetricHandler(db, CLOCK)(jsonRequest(JSON.stringify({ value: 1 })));
  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "a schema violation must never reach a query");
});

test("the handler rejects a body missing the numeric value with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const res = await recordMetricHandler(db, CLOCK)(jsonRequest(JSON.stringify({ name: "agent.request" })));
  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "a schema violation must never reach a query");
});

test("the handler rejects a mis-typed value (string, not number) with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const res = await recordMetricHandler(db, CLOCK)(jsonRequest(JSON.stringify({ name: "agent.request", value: "1" })));
  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "a mis-typed value must never reach a query");
});

test("the handler rejects a NON-ALLOWLISTED dimension key with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const res = await recordMetricHandler(db, CLOCK)(
    jsonRequest(JSON.stringify({ name: "agent.request", value: 1, dimensions: { userId: "u_123" } })),
  );
  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "a non-allowlisted dimension key is rejected at the boundary, never queried");
});

test("the handler rejects a free-text dimension value with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const res = await recordMetricHandler(db, CLOCK)(
    jsonRequest(JSON.stringify({ name: "agent.request", value: 1, dimensions: { outcome: "the user said hello" } })),
  );
  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "a free-text dimension value is rejected at the boundary, never queried");
});

test("the handler rejects an injection-shaped metric name with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const res = await recordMetricHandler(db, CLOCK)(jsonRequest(JSON.stringify({ name: INJECTION, value: 1 })));
  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx for the probe, got ${res.status}`);
  assert.equal(db.calls.length, 0, "an injection-shaped name is rejected by validation and never queried");
});

test("the handler rejects an injection-shaped dimension value with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const res = await recordMetricHandler(db, CLOCK)(
    jsonRequest(JSON.stringify({ name: "agent.request", value: 1, dimensions: { platform: INJECTION } })),
  );
  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx for the probe, got ${res.status}`);
  assert.equal(db.calls.length, 0, "an injection-shaped dimension is rejected by validation and never queried");
});

test("the handler accepts a well-formed body and persists the metric event through the recorder", async () => {
  const db = await freshDb();
  try {
    const res = await recordMetricHandler(db, CLOCK)(jsonRequest(WELL_FORMED_BODY));
    assert.ok(res.status >= 200 && res.status < 300, `expected a 2xx, got ${res.status}`);

    const events = await queryMetrics(db, { name: "agent.request", from: DAY_FROM, to: DAY_TO });
    assert.equal(events.length, 1, "the submitted metric is stored");
    assert.equal(events[0]!.value, 1, "its value reads back as submitted");
    assert.equal(events[0]!.platform, "claude", "with its submitted platform dimension");
    assert.equal(events[0]!.connectorId, "gmail", "with its submitted connector id dimension");
    assert.equal(events[0]!.errorCategory, null, "and an explicit null dimension stays null");
    assert.ok(sameInstant(events[0]!.recordedAt, AT), "stamped with the handler's clock instant");
  } finally {
    await db.close();
  }
});

test("the handler cannot be SQL-injected via the metric name: the metric_events table survives", async () => {
  const db = await freshDb();
  try {
    const res = await recordMetricHandler(db, CLOCK)(jsonRequest(JSON.stringify({ name: INJECTION, value: 1 })));
    assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx for the probe, got ${res.status}`);
    assert.equal(await tableExists(db, "metric_events"), true, "the metric_events table must still exist");
    assert.equal(await totalRows(db), 0, "the rejected probe wrote no row");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC5 — the recorder reads no process.env: a decoy secret in the environment never lands in a stored
// or returned metric, and the recorder runs purely from its injected db + clock + input.
// ===========================================================================

test("the recorder reads no process.env: a decoy secret in the environment never lands in a metric", async () => {
  const DECOY = "sk_live_DECOY_must_never_appear_in_warthog";
  const prev = process.env.WARTHOG_DECOY_SECRET;
  process.env.WARTHOG_DECOY_SECRET = DECOY;
  const db = await freshDb();
  try {
    await recordMetricEvent(db, CLOCK, { name: "agent.request", value: 1, dimensions: { platform: "claude" } });

    const events = await queryMetrics(db, { name: "agent.request", from: DAY_FROM, to: DAY_TO });
    assert.equal(events.length, 1, "the write and read run purely from the injected db + clock + input");
    assert.ok(!JSON.stringify(events).includes(DECOY), "no ambient env value is folded into the returned metric");

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

// Keep the documentary input type referenced so a drift in its name is noticed at authoring time (the
// import is erased at runtime; this never executes).
export type __RecordMetricInputAnchor = RecordMetricInput;
