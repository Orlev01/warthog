// E17-S05 — Metrics snapshot job (`src/server/metrics/snapshot-job.ts`).
//
// RED-first: the snapshot-job module does NOT exist yet, so importing `./snapshot-job` throws
// and every test here fails until the builder writes it. That absence IS the point of
// test-first — do NOT implement anything to make these pass; the builder writes the snapshot
// job afterwards. The sibling stores this job reads from (users, households, agents,
// connections) and the metric seams it writes through (E17-S01's `recordMetric`/`queryMetrics`,
// E17-S02's guarded `recordMetricEvent`) already exist.
//
// These tests pin BEHAVIOUR (what running the job DOES: it appends point-in-time operational
// COUNT metrics — total users, total households, active agents per platform, and per-connector
// connection + failure counts — into the E17-S01 store, stamped from the injected clock, and
// carrying ONLY counts and the allowlisted non-personal dimensions). They read the result back
// THROUGH the real store (`queryMetrics`) and scan the real `metric_events` rows, so no test
// asserts on the source text of any module — a later behaviour-preserving refactor (a rename,
// a moved import, a different SQL shape) stays green.
//
// WHY this exists (task E17-S05): user and household counts, active agents by platform, and
// connector connection/failure rates are operational numbers DERIVED BY COUNTING ROWS rather
// than emitted per event (brief "Operations readiness"). A periodic snapshot job computes them
// at a point in time and records each as a metric event — the time series the admin app reads
// later (which, per constitution principle 19, still gains no path to vault contents, because
// a metric is structurally only a named count with a few short non-personal dimensions).
//
// ---------------------------------------------------------------------------
// THE PINNED CONTRACT (chosen by the tester; the implementation conforms to it).
//
//   runMetricsSnapshot(db: Db, clock: Clock): Promise<void>
//     • counts the operational rows and APPENDS one metric event per count through the guarded
//       recorder (so every value is bound — INV-102 — and stamped from `clock`, never
//       Date.now()). It is a point-in-time SNAPSHOT: running it twice appends a second set of
//       rows (an append log, never an upsert). It reads no `process.env` (INV-103).
//
//   The metric NAMES + value/dimension shapes the job records (the tester's pinned contract,
//   as `agent.request` / `approval.decision` are in E17-S03/S04):
//     • "users.total"            value = total users           (ONE global row per run, no dims)
//     • "households.total"       value = total households       (ONE global row per run, no dims)
//     • "agents.active"          value = count of CONNECTED agents on that platform,
//                                dimension platform=<platform>  (one row per active platform)
//     • "connector.connections"  value = count of ALL connections for that connector (any
//                                status), dimension connectorId=<connector>  (one row per connector)
//     • "connector.failures"     value = count of that connector's connections whose status is
//                                needs_reconnect OR error, dimension connectorId=<connector>
//                                (one row per connector)
//
// Acceptance criteria → tests:
//   AC1 "Running the job records user-count, household-count and active-agent-by-platform
//        metrics." + "records per-connector connection-count and failure-count metrics keyed by
//        connector id." — a seeded world is snapshotted and every count reads back through
//        queryMetrics with the right value, keyed by its dimension; counts are point-in-time and
//        stamped from the clock; households.total is recorded even at 0; a second run appends.
//   AC2 "The recorded metrics contain only counts and non-personal dimensions, never any user
//        identity or content." — no seeded user id / email / household / connection / agent id
//        and no personal marker appears in any recorded metric cell (scoped to metric_events —
//        the unit under test); every stored dimension value is a short non-personal label.
//   AC3 [obligation:validate-and-parameterize-input] (INV-102) — a handler on the
//        `../http/validate` boundary rejects malformed / oversized / mis-shaped input with a 4xx
//        BEFORE any query; an injection-shaped field never reaches a query and the tables
//        survive; and every value the snapshot writes travels BOUND (never spliced into SQL).
//        The handler below is a test fixture (the intended usage), not an implementation file.
//   AC4 [obligation:secrets-from-env] (INV-103) — the snapshot reads no `process.env`: a decoy
//        secret planted in the environment never lands in a recorded metric.
//
// Each real-db test uses its own `freshDb()` (an isolated in-memory PGlite with the real
// migrations, including E17-S01's 0044_metrics) and closes it in a `finally`, so tests share no
// state. Tests never touch the network or Azure.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";

import { runMetricsSnapshot } from "./snapshot-job";
import { queryMetrics, type MetricEvent } from "../db/metrics";
import { createUser } from "../db/users";
import { createHousehold } from "../db/households";
import { createConnection } from "../db/connections";
import { createAgent } from "../db/agents";
import { fixedClock, type Clock } from "../seams/clock";
import { parseBody, HttpError } from "../http/validate";
import { freshDb } from "../../test/db";
import type { Db, QueryResult } from "../db/index";

// --- constants --------------------------------------------------------------------

// A fixed snapshot instant: every recorded metric must be stamped from THIS clock, never
// Date.now(). The whole-day window brackets it for queryMetrics read-backs.
const AT = "2026-11-20T03:00:00.000Z";
const CLOCK: Clock = fixedClock(new Date(AT));
const DAY_FROM = "2026-11-20T00:00:00.000Z";
const DAY_TO = "2026-11-20T23:59:59.999Z";

// The metric names the snapshot records (the tester's pinned contract; the builder conforms).
const USERS_TOTAL = "users.total";
const HOUSEHOLDS_TOTAL = "households.total";
const AGENTS_ACTIVE = "agents.active";
const CONNECTOR_CONNECTIONS = "connector.connections";
const CONNECTOR_FAILURES = "connector.failures";

// A distinctive marker woven into every seeded email / display name, so any fragment surfacing
// in a metric cell is a genuine personal-content leak, not a coincidence.
const MARKER = "PERSONALTOKEN";

// The injection probe reused across the parameterize tests.
const INJECTION = "boom'); DROP TABLE metric_events; --";

// A short, safe dimension label (an alphanumeric first char, then up to 63 of
// alphanumerics/_/./-): the shape a non-personal dimension must take. Prose (spaces), an email
// (`@`) and most sentences fail it, so a value matching it cannot be a message or identity blob.
const DIMENSION_LABEL = /^[A-Za-z0-9][A-Za-z0-9_.\-]{0,63}$/;

// --- fixtures ---------------------------------------------------------------------

// A db seam stand-in that records every call instead of running it, so a test can prove a
// REJECTED request issues NO query at all. Returns no rows; satisfies `Db` structurally.
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

// A pass-through proxy over a real db that captures text + values, so a test can prove each
// value the snapshot writes travelled BOUND (in values) and was never concatenated into the SQL.
interface RecordingProxy extends Db {
  readonly calls: { text: string; values: unknown[] }[];
}
function recordingProxy(real: Db): RecordingProxy {
  const calls: { text: string; values: unknown[] }[] = [];
  return {
    calls,
    query(text: string, values: unknown[] = []): Promise<QueryResult> {
      calls.push({ text, values });
      return real.query(text, values);
    },
    close(): Promise<void> {
      return real.close();
    },
  };
}

// Whether a relation of this exact name exists on this handle (a non-throwing probe scoped to
// the one table under test — behaviour, not source text).
async function tableExists(db: Db, name: string): Promise<boolean> {
  const result = await db.query("SELECT to_regclass($1) AS t", [name]);
  return result.rows[0]?.t != null;
}

// Row count of a known, tester-controlled table name (never caller input), for "nothing was
// written / nothing was destroyed" assertions.
async function countRows(db: Db, table: string): Promise<number> {
  const result = await db.query(`SELECT count(*)::int AS n FROM ${table}`);
  return result.rows[0]!.n as number;
}

// The same instant regardless of whether the store returns an ISO string or a Date.
function sameInstant(a: unknown, b: string): boolean {
  return new Date(a as string | number | Date).getTime() === new Date(b).getTime();
}

// Build a value map from a set of per-group metric events, keyed by the given dimension. A
// null-dimension row is skipped (it is not a per-group row).
function dimensionMap(events: MetricEvent[], dim: "platform" | "connectorId"): Map<string, number> {
  const m = new Map<string, number>();
  for (const e of events) {
    const key = dim === "platform" ? e.platform : e.connectorId;
    if (key == null) continue;
    m.set(key, e.value);
  }
  return m;
}

// Seed a deterministic operational world and return the counts the snapshot must compute plus
// every personal token that must NOT surface in a metric. Connections and agents are all owned
// by one person (operational counts are GLOBAL, not member-scoped, so ownership is irrelevant to
// the counts); the statuses are mixed so the "active" / "failure" filters are exercised.
async function seedWorld(db: Db): Promise<{
  personal: string[];
  expected: {
    users: number;
    households: number;
    agentsActive: Map<string, number>;
    connections: Map<string, number>;
    failures: Map<string, number>;
  };
}> {
  const dek = randomBytes(32); // a real AES-256 key, so createConnection's envelope encrypts
  const personal: string[] = [];

  // Four people, each with a distinctive marked email.
  const users = [];
  for (const who of ["alice", "bob", "carol", "dave"]) {
    const u = await createUser(db, { email: `${who}-${MARKER}@warthog.com.au`, wrappedDek: "wrapped-dek-opaque" });
    users.push(u);
    personal.push(u.id, u.email);
  }

  // Two households, owned by the first two people.
  for (const owner of [users[0]!, users[1]!]) {
    const h = await createHousehold(db, { ownerId: owner.id, currency: "AUD" });
    personal.push(h.id);
  }

  // Connections: gmail × 3 (connected, needs_reconnect, error) → 3 total / 2 failures;
  //              google × 2 (connected, needs_reconnect)       → 2 total / 1 failure.
  const connSpecs = [
    { connectorId: "gmail", status: "connected" },
    { connectorId: "gmail", status: "needs_reconnect" },
    { connectorId: "gmail", status: "error" },
    { connectorId: "google", status: "connected" },
    { connectorId: "google", status: "needs_reconnect" },
  ];
  for (const s of connSpecs) {
    const c = await createConnection(
      db,
      { userId: users[0]!.id, connectorId: s.connectorId, accountLabel: `${MARKER}-acct`, credentials: { token: "t" }, status: s.status as never },
      dek,
      CLOCK,
    );
    personal.push(c.id);
  }

  // Agents: claude × 3 (connected, connected, disconnected) → 2 active; chatgpt × 1 (connected) → 1 active.
  const agentSpecs = [
    { platform: "claude", status: "connected" },
    { platform: "claude", status: "connected" },
    { platform: "claude", status: "disconnected" },
    { platform: "chatgpt", status: "connected" },
  ];
  for (const s of agentSpecs) {
    const a = await createAgent(
      db,
      { userId: users[0]!.id, connectionId: randomUUID(), displayName: `${MARKER}-agent`, platform: s.platform, status: s.status as never },
      CLOCK,
    );
    personal.push(a.id);
  }

  return {
    personal,
    expected: {
      users: 4,
      households: 2,
      agentsActive: new Map([
        ["claude", 2],
        ["chatgpt", 1],
      ]),
      connections: new Map([
        ["gmail", 3],
        ["google", 2],
      ]),
      failures: new Map([
        ["gmail", 2],
        ["google", 1],
      ]),
    },
  };
}

// ===========================================================================
// AC1 — running the job records the operational counts, keyed by dimension, read back through
// the real store.
// ===========================================================================

test("records a single global user-count and household-count metric with the correct values", async () => {
  const db = await freshDb();
  try {
    const { expected } = await seedWorld(db);
    await runMetricsSnapshot(db, CLOCK);

    const users = await queryMetrics(db, { name: USERS_TOTAL, from: DAY_FROM, to: DAY_TO });
    assert.equal(users.length, 1, "exactly one users.total row is recorded per run (a single global count)");
    assert.equal(typeof users[0]!.value, "number", "the user count is a number, not a numeric string");
    assert.equal(users[0]!.value, expected.users, "the user count equals the number of users");
    assert.equal(users[0]!.platform, null, "the global user count carries no per-group dimension");
    assert.equal(users[0]!.connectorId, null, "the global user count carries no connector dimension");

    const households = await queryMetrics(db, { name: HOUSEHOLDS_TOTAL, from: DAY_FROM, to: DAY_TO });
    assert.equal(households.length, 1, "exactly one households.total row is recorded per run");
    assert.equal(households[0]!.value, expected.households, "the household count equals the number of households");
  } finally {
    await db.close();
  }
});

test("records active-agent-by-platform metrics keyed by platform, counting connected agents only", async () => {
  const db = await freshDb();
  try {
    const { expected } = await seedWorld(db);
    await runMetricsSnapshot(db, CLOCK);

    const events = await queryMetrics(db, { name: AGENTS_ACTIVE, from: DAY_FROM, to: DAY_TO });
    assert.equal(events.length, expected.agentsActive.size, "one active-agent row per platform with active agents, no duplicates");

    const byPlatform = dimensionMap(events, "platform");
    assert.equal(byPlatform.size, expected.agentsActive.size, "every active-agent row is keyed by a platform dimension");
    assert.equal(byPlatform.get("claude"), 2, "claude has two CONNECTED agents (the disconnected one is not active)");
    assert.equal(byPlatform.get("chatgpt"), 1, "chatgpt has one connected agent");
  } finally {
    await db.close();
  }
});

test("records per-connector connection-count metrics keyed by connector id, counting all statuses", async () => {
  const db = await freshDb();
  try {
    const { expected } = await seedWorld(db);
    await runMetricsSnapshot(db, CLOCK);

    const events = await queryMetrics(db, { name: CONNECTOR_CONNECTIONS, from: DAY_FROM, to: DAY_TO });
    assert.equal(events.length, expected.connections.size, "one connection-count row per connector, no duplicates");

    const byConnector = dimensionMap(events, "connectorId");
    assert.equal(byConnector.get("gmail"), 3, "gmail's connection count includes every status (connected + needs_reconnect + error)");
    assert.equal(byConnector.get("google"), 2, "google's connection count includes its connected + needs_reconnect connections");
  } finally {
    await db.close();
  }
});

test("records per-connector failure-count metrics keyed by connector id (needs_reconnect + error)", async () => {
  const db = await freshDb();
  try {
    const { expected } = await seedWorld(db);
    await runMetricsSnapshot(db, CLOCK);

    const events = await queryMetrics(db, { name: CONNECTOR_FAILURES, from: DAY_FROM, to: DAY_TO });
    assert.equal(events.length, expected.failures.size, "one failure-count row per connector with connections, no duplicates");

    const byConnector = dimensionMap(events, "connectorId");
    assert.equal(byConnector.get("gmail"), 2, "gmail has two failing connections (one needs_reconnect, one error)");
    assert.equal(byConnector.get("google"), 1, "google has one failing connection (needs_reconnect)");
  } finally {
    await db.close();
  }
});

test("stamps every recorded snapshot metric with the INJECTED clock instant, not wall-clock time", async () => {
  const db = await freshDb();
  try {
    await seedWorld(db);
    await runMetricsSnapshot(db, CLOCK);

    const all = await db.query("SELECT recorded_at FROM metric_events");
    assert.ok(all.rows.length > 0, "the snapshot recorded at least one metric");
    for (const row of all.rows) {
      assert.ok(sameInstant(row.recorded_at, AT), "each snapshot metric is stamped with the clock's instant");
    }
  } finally {
    await db.close();
  }
});

test("households.total is recorded even when there are none — a continuous point-in-time count", async () => {
  const db = await freshDb();
  try {
    // One person, no households: the two headline global counts are still emitted (so the time
    // series has a data point every run), households.total reading 0.
    await createUser(db, { email: `solo-${MARKER}@warthog.com.au`, wrappedDek: "wrapped-dek-opaque" });
    await runMetricsSnapshot(db, CLOCK);

    const users = await queryMetrics(db, { name: USERS_TOTAL, from: DAY_FROM, to: DAY_TO });
    assert.equal(users.length, 1, "users.total is recorded");
    assert.equal(users[0]!.value, 1, "the user count is 1");

    const households = await queryMetrics(db, { name: HOUSEHOLDS_TOTAL, from: DAY_FROM, to: DAY_TO });
    assert.equal(households.length, 1, "households.total is recorded even with no households");
    assert.equal(households[0]!.value, 0, "the household count reads 0, not absent");
  } finally {
    await db.close();
  }
});

test("the snapshot is a point-in-time APPEND — running twice records two user-count rows", async () => {
  const db = await freshDb();
  try {
    await seedWorld(db);
    await runMetricsSnapshot(db, CLOCK);
    await runMetricsSnapshot(db, CLOCK);

    const users = await queryMetrics(db, { name: USERS_TOTAL, from: DAY_FROM, to: DAY_TO });
    assert.equal(users.length, 2, "each run appends its own point-in-time user count (an append log, not an upsert)");
    for (const e of users) assert.equal(e.value, 4, "each appended snapshot carries the same count");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC2 — the recorded metrics contain only counts and non-personal dimensions, never any user
// identity or content. Scoped to metric_events (the unit under test): the same ids/emails
// legitimately live in the users/connections/… rows, so a whole-database scan would overreach.
// ===========================================================================

test("no user id, email, household/connection/agent id or personal marker appears in any recorded metric", async () => {
  const db = await freshDb();
  try {
    const { personal } = await seedWorld(db);
    await runMetricsSnapshot(db, CLOCK);

    const all = await db.query("SELECT * FROM metric_events");
    assert.ok(all.rows.length > 0, "the snapshot recorded metrics to scan");

    for (const row of all.rows) {
      for (const cell of Object.values(row)) {
        if (typeof cell !== "string") continue;
        assert.ok(!cell.includes(MARKER), "no fragment of a seeded email / display name reached a metric cell");
        for (const token of personal) {
          assert.ok(!cell.includes(token), `no seeded identity (${token.slice(0, 8)}…) reached a metric cell`);
        }
      }
    }
  } finally {
    await db.close();
  }
});

test("every recorded snapshot metric carries only a finite count and short non-personal dimension labels", async () => {
  const db = await freshDb();
  try {
    await seedWorld(db);
    await runMetricsSnapshot(db, CLOCK);

    const all = await db.query(
      "SELECT name, value, platform, connector_id, outcome, error_category FROM metric_events",
    );
    assert.ok(all.rows.length > 0, "the snapshot recorded metrics to inspect");

    for (const row of all.rows) {
      const value = Number(row.value);
      assert.ok(Number.isFinite(value), "every recorded metric value is a finite number (a count)");
      assert.ok(value >= 0, "a count is never negative");

      // Each text-bearing dimension that is present must be a short, safe label — never a
      // sentence, an email or an identity blob.
      for (const col of ["platform", "connector_id", "outcome", "error_category"] as const) {
        const dim = row[col];
        if (dim == null) continue;
        assert.equal(typeof dim, "string", `the ${col} dimension is a string label`);
        assert.ok(DIMENSION_LABEL.test(dim as string), `the ${col} dimension "${String(dim)}" is a short non-personal label`);
      }
    }
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC3 [obligation:validate-and-parameterize-input] — a handler on the `../http/validate`
// boundary rejects malformed / oversized / mis-shaped input with a 4xx BEFORE any query; an
// injection-shaped field never reaches a query and the tables survive; a well-formed request
// runs the snapshot; and every value the snapshot writes travels BOUND. The handler below is a
// test FIXTURE (the intended usage: parseBody → runMetricsSnapshot), NOT an implementation file.
// ===========================================================================

// The snapshot trigger takes NO client-controlled parameters (the counts are global), so the
// body is a STRICT empty object — any field is rejected at the boundary and never reaches a
// query. A larger-than-cap or malformed body is rejected before parse. A valid (empty) body runs
// the snapshot through the guarded recorder.
function snapshotHandler(db: Db, clock: Clock): (req: Request) => Promise<Response> {
  const schema = z.object({}).strict();
  return async (req: Request): Promise<Response> => {
    try {
      await parseBody(schema, req, { maxBytes: 4 * 1024 });
      await runMetricsSnapshot(db, clock);
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
  return new Request("https://warthog.com.au/api/metrics/snapshot", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

test("the handler rejects malformed and oversized input with a 4xx and never reaches a query", async () => {
  const malformedDb = recordingDb();
  const malformed = await snapshotHandler(malformedDb, CLOCK)(jsonRequest("{ not valid json"));
  assert.ok(malformed.status >= 400 && malformed.status < 500, `malformed input must be a 4xx, got ${malformed.status}`);
  assert.equal(malformedDb.calls.length, 0, "malformed input must never reach a query");

  const oversizedDb = recordingDb();
  const oversized = await snapshotHandler(oversizedDb, CLOCK)(jsonRequest(JSON.stringify({ junk: "x".repeat(10 * 1024) })));
  assert.ok(oversized.status >= 400 && oversized.status < 500, `oversized input must be a 4xx, got ${oversized.status}`);
  assert.equal(oversizedDb.calls.length, 0, "an oversized body must never reach a query");
});

test("the handler rejects an injection-shaped extra field with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const res = await snapshotHandler(db, CLOCK)(jsonRequest(JSON.stringify({ trigger: INJECTION })));
  assert.ok(res.status >= 400 && res.status < 500, `an injection-shaped field must be a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "a rejected body is never parsed into a query");
});

test("an injection-shaped request cannot alter a query: the tables survive and nothing is recorded", async () => {
  const db = await freshDb();
  try {
    const { expected } = await seedWorld(db);
    const before = await countRows(db, "users");

    const res = await snapshotHandler(db, CLOCK)(jsonRequest(JSON.stringify({ trigger: INJECTION })));
    assert.ok(res.status >= 400 && res.status < 500, `the probe must be a 4xx, got ${res.status}`);

    assert.equal(await tableExists(db, "metric_events"), true, "the metric_events table still exists");
    assert.equal(await tableExists(db, "users"), true, "the users table still exists");
    assert.equal(await countRows(db, "users"), before, "the users table is untouched by the probe");
    assert.equal(await countRows(db, "metric_events"), 0, "a rejected trigger records no metric");
    assert.equal(expected.users, before, "sanity: the seeded user count is what we measured");
  } finally {
    await db.close();
  }
});

test("the handler accepts a well-formed (empty) body and records the snapshot metrics end-to-end", async () => {
  const db = await freshDb();
  try {
    const { expected } = await seedWorld(db);

    const res = await snapshotHandler(db, CLOCK)(jsonRequest("{}"));
    assert.ok(res.status >= 200 && res.status < 300, `a well-formed body is a 2xx, got ${res.status}`);

    const users = await queryMetrics(db, { name: USERS_TOTAL, from: DAY_FROM, to: DAY_TO });
    assert.equal(users.length, 1, "the snapshot ran through the handler and recorded the user count");
    assert.equal(users[0]!.value, expected.users, "the recorded user count is correct");

    const connections = await queryMetrics(db, { name: CONNECTOR_CONNECTIONS, from: DAY_FROM, to: DAY_TO });
    assert.equal(dimensionMap(connections, "connectorId").get("gmail"), 3, "and the per-connector counts too");
  } finally {
    await db.close();
  }
});

test("every value the snapshot writes travels BOUND as a parameter, never spliced into the SQL text", async () => {
  const db = await freshDb();
  try {
    // A minimal world: one gmail connection (connected) and one claude agent (connected), so the
    // snapshot emits a connector dimension "gmail" and a platform dimension "claude" — values
    // that are DATA read from the db and written into an INSERT. They must be bound, not spliced.
    const dek = randomBytes(32);
    const user = await createUser(db, { email: `bind-${MARKER}@warthog.com.au`, wrappedDek: "wrapped-dek-opaque" });
    await createConnection(
      db,
      { userId: user.id, connectorId: "gmail", accountLabel: "acct", credentials: { token: "t" }, status: "connected" },
      dek,
      CLOCK,
    );
    await createAgent(
      db,
      { userId: user.id, connectionId: randomUUID(), displayName: "agent", platform: "claude", status: "connected" },
      CLOCK,
    );

    const proxy = recordingProxy(db);
    await runMetricsSnapshot(proxy, CLOCK);

    const allValues = proxy.calls.flatMap((c) => c.values);
    assert.ok(allValues.includes("gmail"), "the connector id travels as a bound value");
    assert.ok(allValues.includes("claude"), "the platform travels as a bound value");
    for (const call of proxy.calls) {
      assert.ok(!call.text.includes("'gmail'"), "the connector id is bound, never concatenated into the SQL");
      assert.ok(!call.text.includes("'claude'"), "the platform is bound, never concatenated into the SQL");
      assert.ok(!call.text.includes("DROP TABLE"), "no injected statement appears in the SQL text");
    }

    // And the writes really landed through the proxy (the bound values are inert data).
    const connections = await queryMetrics(db, { name: CONNECTOR_CONNECTIONS, from: DAY_FROM, to: DAY_TO });
    assert.equal(dimensionMap(connections, "connectorId").get("gmail"), 1, "the gmail connection count was stored");
    const agents = await queryMetrics(db, { name: AGENTS_ACTIVE, from: DAY_FROM, to: DAY_TO });
    assert.equal(dimensionMap(agents, "platform").get("claude"), 1, "the claude active-agent count was stored");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC4 [obligation:secrets-from-env] — the snapshot reads no process.env: a decoy secret in the
// environment never lands in a recorded metric; the job runs purely from its injected db + clock.
// ===========================================================================

test("the snapshot reads no process.env: a decoy secret in the environment never lands in a metric", async () => {
  const DECOY = "sk_live_DECOY_must_never_appear_in_warthog_snapshot";
  const prev = process.env.WARTHOG_DECOY_SECRET;
  process.env.WARTHOG_DECOY_SECRET = DECOY;
  const db = await freshDb();
  try {
    await seedWorld(db);
    await runMetricsSnapshot(db, CLOCK);

    const all = await db.query("SELECT * FROM metric_events");
    assert.ok(all.rows.length > 0, "the snapshot recorded metrics to scan");
    for (const row of all.rows) {
      for (const cell of Object.values(row)) {
        if (typeof cell === "string") {
          assert.ok(!cell.includes(DECOY), "no ambient env value is folded into a recorded metric");
        }
      }
    }
  } finally {
    await db.close();
    if (prev === undefined) delete process.env.WARTHOG_DECOY_SECRET;
    else process.env.WARTHOG_DECOY_SECRET = prev;
  }
});
