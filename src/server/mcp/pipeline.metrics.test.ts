// E17-S03 — Request metrics in the agent-call pipeline (`src/server/mcp/pipeline.ts`;
// brief "Operations readiness": request volumes, latencies and error rates are core
// operational numbers; the pipeline is the ONE place that sees every agent call, its
// outcome and its timing, so it is where these are measured).
//
// RED-first: `./pipeline` already exists (E07-S16/S17), but the request-metrics seam
// it must use does NOT yet. So these tests fail — the injected metrics recorder is never
// called, so the spy captures nothing and every metric assertion fails — until the builder
// wires `handleAgentCall` to record the two metrics. That absence IS the point of
// test-first; do NOT implement anything to make these pass. The builder extends
// `pipeline.ts` afterwards. Every earlier pipeline test (pipeline.test.ts /
// pipeline.obligations.test.ts) builds the pipeline WITHOUT this optional seam, so it must
// stay green — a pipeline built without the seam records no metrics.
//
// These tests pin BEHAVIOUR (what the pipeline DOES: which metrics it hands the recorder,
// with which name/value/dimensions, for a given outcome), never the source text of any
// module — a later rename that preserves behaviour must not redden them. A decision is
// driven through the ALREADY-BUILT, tested seams (grants via `upsertPermissions`, rules via
// `createRule`, a person via `createUser` + a real `KeyWrapper`, the real rate limiter and
// the real in-memory activity recorder); the tool executor and the METRICS recorder are
// spies, so "what was recorded" is observed directly. One test wires the REAL guarded
// recorder (`recordMetricEvent` over a real PGlite db) end-to-end and reads the rows back
// through E17-S01's `queryMetrics`, exactly as pipeline.test.ts wires the real notifier.
//
// ---------------------------------------------------------------------------
// THE PINNED CONTRACT (chosen by the tester; the implementation conforms to it).
//
//   // A NEW, OPTIONAL injected seam on PipelineDeps — the request-metrics recorder. Shape
//   // mirrors E17-S02's RecordMetricInput (name + finite numeric value + an OPTIONAL open
//   // map of dimensions). Production wires it to the guarded recorder:
//   //     recordMetric: (input) => recordMetricEvent(db, clock, input)
//   // A pipeline built WITHOUT it records no metrics (so every earlier pin stays intact).
//   type RecordMetricSeam =
//     (input: { name: string; value: number; dimensions?: Record<string, unknown> }) => Promise<void>;
//   interface PipelineDeps { /* …existing… */ recordMetric?: RecordMetricSeam; }
//
//   // For EVERY call handleAgentCall handles — executed, refused (disconnected /
//   // rate-limited / denied), pending_approval, or a thrown tool executor — the pipeline
//   // records EXACTLY one request-count metric and EXACTLY one request-latency metric:
//   //   • name "agent.request"            value 1               (a count increment)
//   //   • name "agent.request.latency_ms" value = elapsed ms    (a FINITE number ≥ 0)
//   // BOTH carry an `outcome` dimension = the AgentCallResult status
//   //   ("executed" | "refused" | "pending_approval"); a thrown executor uses a short
//   //   failure-outcome label.
//   // On a FAILED call (any `refused`, or a thrown executor) BOTH metrics additionally
//   //   carry an `errorCategory` dimension — a short identifier label naming the failure
//   //   class (distinct classes get distinct categories). On executed / pending_approval
//   //   there is NO errorCategory.
//   // The metrics carry ONLY the four allowlisted non-personal dimensions
//   //   ({platform, connectorId, outcome, errorCategory}) — NEVER tool params, identity
//   //   values, merchant, recipients, reason or message content.
//
// Acceptance criteria → tests:
//   AC1 "A completed agent call records a request-count metric and a latency metric tagged
//        with the outcome." — an executed call records one count (1) + one latency (finite
//        ≥0), both outcome="executed", no errorCategory; pending_approval likewise with
//        outcome="pending_approval". A real-recorder end-to-end test reads both rows back.
//   AC2 "A failed call records an error-category dimension on its metric." — a disconnected,
//        a denied and a rate-limited call each record both metrics with outcome="refused"
//        PLUS an errorCategory short label; distinct failure classes carry distinct
//        categories; a thrown tool executor also records a failure metric (and the error
//        still propagates). Each over-limit call in a burst records its OWN metric (metrics
//        are per-call, NOT burst-summarised like the activity entry).
//   AC3 "The recorded metrics contain no tool parameters, identity values or message
//        content." — distinctive tokens planted in params / merchant / recipients / reason
//        and the owning userId appear in NO recorded metric input (scoped to the metric
//        payloads — the unit under test).
//   AC4 [obligation:validate-and-parameterize-input] (INV-102) — a handler on the
//        `../http/validate` boundary rejects malformed / oversized / mis-shaped input with a
//        4xx BEFORE the pipeline runs (so no metric is recorded); every metric field reaches
//        the store BOUND (never spliced); a SQL-injection probe in a call field never
//        becomes a metric dimension and cannot alter a query — the metric_events table
//        survives and stays queryable.
//   AC5 [obligation:secrets-from-env] (INV-103) — the pipeline + metric recording read no
//        `process.env`: a decoy secret in the environment never lands in a recorded metric.
//
// Every db handle is closed in a `finally`; each db-backed test uses its own `freshDb()`
// (an isolated in-memory PGlite with the real migrations, including E17-S01's 0044_metrics),
// so tests share no state. Tests never touch the network or Azure.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { z } from "zod";

import { createAgentCallPipeline } from "./pipeline";
import { createRateLimiter } from "./rate-limit";
import { createInMemoryRecorder } from "../activity/recorder";
import { createUser } from "../db/users";
import { upsertPermissions } from "../db/agent-permissions";
import { createRule } from "../db/rules";
import { recordMetricEvent } from "../metrics/record";
import { queryMetrics } from "../db/metrics";
import { parseBody, HttpError } from "../http/validate";
import { freshDb } from "../../test/db";
import { localAesKeyWrapper, type KeyWrapper } from "../crypto/key-wrapper";
import { fixedClock, type Clock } from "../seams/clock";
import type { Db, QueryResult } from "../db/index";

// --- shapes derived from the stores' own signatures (a later type rename that preserves
// behaviour must not redden these tests) ------------------------------------------------
type Grants = Parameters<typeof upsertPermissions>[1];
type NewRule = Parameters<typeof createRule>[1];
type Pipeline = ReturnType<typeof createAgentCallPipeline>;
type Result = Awaited<ReturnType<Pipeline["handleAgentCall"]>>;
type RecorderBase = ReturnType<typeof createInMemoryRecorder>;

// The metric input the pipeline hands the recorder seam (structural, so a rename of E17-S02's
// RecordMetricInput cannot redden these tests).
interface MetricInput {
  readonly name: string;
  readonly value: number;
  readonly dimensions?: Record<string, unknown>;
}
type RecordMetricSeam = (input: MetricInput) => Promise<void>;

// --- fixtures --------------------------------------------------------------------------

const DEK_BYTES = 32; // a 256-bit per-person data key
const KEK_BYTES = 32; // the local AES-256 key-encryption key for the KeyWrapper seam

const CONN = "11111111-1111-1111-1111-111111111111";

// The frozen instant the pipeline reads time through (budget-period key + rate-limit window).
const NOW = new Date("2026-11-15T12:00:00.000Z");
// A whole-day window around NOW, for queryMetrics read-backs.
const DAY_FROM = "2026-11-15T00:00:00.000Z";
const DAY_TO = "2026-11-15T23:59:59.999Z";

// The two metric names the pipeline records for every handled call.
const REQUEST_COUNT_METRIC = "agent.request";
const REQUEST_LATENCY_METRIC = "agent.request.latency_ms";

// A short, safe identifier label (the E17-S01/S02 dimension shape). An outcome / error
// category is one of these; free text, an email, prose or an object is not.
const SHORT_LABEL = /^[A-Za-z0-9][A-Za-z0-9_.\-]{0,63}$/;

// The injection probe reused across the parameterize tests.
const INJECTION = "boom'); DROP TABLE metric_events; --";

const ANY_AGENT = { type: "any_agent" } as const;
const ANY_CHANGE = { type: "any_change" } as const;

function keyWrapperFor(): KeyWrapper {
  return localAesKeyWrapper(randomBytes(KEK_BYTES));
}

// Create a person whose wrapped DEK really unwraps under `keyWrapper`.
async function makePerson(db: Db, who: string, keyWrapper: KeyWrapper): Promise<{ userId: string; dek: Uint8Array }> {
  const dek = randomBytes(DEK_BYTES);
  const wrappedDek = await keyWrapper.wrap(dek);
  const user = await createUser(db, { email: `${who}@warthog.com.au`, wrappedDek });
  return { userId: user.id, dek };
}

// A fully-populated grants record; a test overrides only what it is about. Built via a
// helper (a non-literal) so excess-property checks never bite.
function baseGrants(userId: string, connectionId: string, overrides: Partial<Grants> = {}): Grants {
  return {
    userId,
    connectionId,
    grantedConnectors: ["gmail", "google-calendar"],
    readTools: true,
    changeTools: "ask_first",
    identityAccess: true,
    highTierAccess: false,
    cardAccess: false,
    cardBudget: null,
    skillsScope: ["house-skill"],
    memoryRead: true,
    sharing: false,
    rulesScope: [],
    rateLimit: 120,
    ...overrides,
  } as Grants;
}

function connectionFor(userId: string, opts: { connectionId?: string; agentId?: string; active?: boolean } = {}) {
  const connectionId = opts.connectionId ?? CONN;
  return { userId, connectionId, agentId: opts.agentId ?? connectionId, active: opts.active ?? true };
}

// One agent call; a test overrides only what it is about. The default is a core READ
// (connector null, no change) — allowed by policy with a bare permissions row.
function callFor(overrides: Record<string, unknown> = {}) {
  return {
    connector: null as string | null,
    tool: "search_memory",
    makesChange: false,
    params: { query: "hello" },
    ...overrides,
  };
}

// The REAL in-memory activity recorder (so redaction + chaining really happen); the pipeline
// writes its activity entries through this, SEPARATELY from the metrics seam under test.
function activityRecorder(): RecorderBase {
  return createInMemoryRecorder({ clock: fixedClock(NOW) });
}

// The metrics-recorder SPY: captures each metric input the pipeline hands the seam.
function spyMetrics() {
  const metrics: MetricInput[] = [];
  const recordMetric: RecordMetricSeam = async (input) => {
    metrics.push(input);
  };
  return { metrics, recordMetric };
}

// A tool executor spy: records every invocation (so "executed vs not" is observed) and
// returns a sentinel result.
function spyExecutor(result: unknown = { ok: true, ran: true }) {
  const calls: unknown[] = [];
  const fn = async (call: unknown): Promise<unknown> => {
    calls.push(call);
    return result;
  };
  return { fn, calls };
}

interface Seams {
  clock?: Clock;
  rateLimiter?: ReturnType<typeof createRateLimiter>;
  recorder?: RecorderBase;
  executeTool: (call: never, connection: never) => Promise<unknown>;
  recordMetric: RecordMetricSeam;
}

function buildPipeline(db: Db, keyWrapper: KeyWrapper, seams: Seams): Pipeline {
  const clock = seams.clock ?? fixedClock(NOW);
  return createAgentCallPipeline({
    db,
    keyWrapper,
    clock,
    rateLimiter: seams.rateLimiter ?? createRateLimiter(clock),
    recorder: seams.recorder ?? activityRecorder(),
    executeTool: seams.executeTool,
    // The seam under test (the builder adds this optional field to PipelineDeps).
    recordMetric: seams.recordMetric,
  } as Parameters<typeof createAgentCallPipeline>[0]);
}

// --- metric helpers --------------------------------------------------------------------

const countMetrics = (ms: MetricInput[]): MetricInput[] => ms.filter((m) => m.name === REQUEST_COUNT_METRIC);
const latencyMetrics = (ms: MetricInput[]): MetricInput[] => ms.filter((m) => m.name === REQUEST_LATENCY_METRIC);
const dim = (m: MetricInput, key: string): unknown => (m.dimensions ?? {})[key];

// Assert a metric carries the expected outcome, and (for a failure) a short-label error
// category, (for a success) none. Returns the error category (if any) for distinctness checks.
function assertTagged(m: MetricInput, outcome: string, opts: { failure: boolean }): unknown {
  assert.equal(dim(m, "outcome"), outcome, `the ${m.name} metric is tagged outcome="${outcome}"`);
  const cat = dim(m, "errorCategory");
  if (opts.failure) {
    assert.equal(typeof cat, "string", `a failed call's ${m.name} metric carries an errorCategory`);
    assert.ok((cat as string).length > 0, "the error category is non-empty");
    assert.match(cat as string, SHORT_LABEL, "the error category is a short identifier label, not free text");
  } else {
    assert.ok(cat == null, `a non-failed call's ${m.name} metric carries NO errorCategory (got ${JSON.stringify(cat)})`);
  }
  return cat;
}

// Assert a single handled call recorded exactly one count (value 1) + one latency (finite ≥ 0),
// both tagged `outcome`, failure ⇒ both carry a short-label errorCategory. Returns the error
// category seen on the count metric (for distinctness checks).
function assertOneCallTagged(ms: MetricInput[], outcome: string, opts: { failure: boolean }): unknown {
  const counts = countMetrics(ms);
  const lats = latencyMetrics(ms);
  assert.equal(counts.length, 1, "exactly one request-count metric was recorded for the call");
  assert.equal(lats.length, 1, "exactly one request-latency metric was recorded for the call");

  const [count] = counts;
  const [lat] = lats;
  assert.ok(count && lat);
  assert.equal(count.value, 1, "the request-count metric's value is 1 (a count increment)");
  assert.equal(typeof lat.value, "number", "the latency metric's value is a number");
  assert.ok(Number.isFinite(lat.value), "the latency value is a finite number (acceptable to the guarded recorder)");
  assert.ok(lat.value >= 0, "the latency value is non-negative (elapsed milliseconds)");

  assertTagged(count, outcome, opts);
  return assertTagged(lat, outcome, opts);
}

// A db stand-in that records every query instead of running it (so a test proves WHAT reached
// the query layer and HOW — bound value vs. spliced text). Returns no rows.
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

async function tableExists(db: Db, name: string): Promise<boolean> {
  const result = await db.query("SELECT to_regclass($1) AS t", [name]);
  return result.rows[0]?.t != null;
}

// ===========================================================================
// AC1 — a completed (executed) call records a count + latency metric tagged with the outcome.
// ===========================================================================

test("an executed call records one request-count (1) and one request-latency metric, both tagged outcome=executed, no errorCategory", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const { userId } = await makePerson(db, "m-exec", keyWrapper);
    await upsertPermissions(db, baseGrants(userId, CONN));

    const metrics = spyMetrics();
    const exec = spyExecutor();
    const pipeline = buildPipeline(db, keyWrapper, { executeTool: exec.fn, recordMetric: metrics.recordMetric });

    const result: Result = await pipeline.handleAgentCall(connectionFor(userId), callFor({ tool: "search_memory" }));
    assert.equal(result.status, "executed", "the granted core read executes");
    assert.equal(exec.calls.length, 1, "the tool ran exactly once");

    assertOneCallTagged(metrics.metrics, "executed", { failure: false });
  } finally {
    await db.close();
  }
});

test("a pending_approval call records a count + latency metric tagged outcome=pending_approval, no errorCategory", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const { userId, dek } = await makePerson(db, "m-ask", keyWrapper);
    await upsertPermissions(db, baseGrants(userId, CONN));
    // "Ask me before any agent makes a change" → a change-making call is held (ask).
    await createRule(db, { userId, kind: "ask_first", scope: ANY_AGENT, action: ANY_CHANGE } as NewRule, dek);

    const metrics = spyMetrics();
    const exec = spyExecutor();
    const pipeline = buildPipeline(db, keyWrapper, { executeTool: exec.fn, recordMetric: metrics.recordMetric });

    const result: Result = await pipeline.handleAgentCall(
      connectionFor(userId),
      callFor({ connector: null, tool: "update_task", makesChange: true }),
    );
    assert.equal(result.status, "pending_approval", "the change is held behind an approval");
    assert.equal(exec.calls.length, 0, "a held call does not execute the tool");

    // Held, not failed: tagged with the pending outcome, and carries NO error category.
    assertOneCallTagged(metrics.metrics, "pending_approval", { failure: false });
  } finally {
    await db.close();
  }
});

test("the real guarded recorder, wired end-to-end, stores both request metrics (read back through queryMetrics)", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const { userId } = await makePerson(db, "m-realrec", keyWrapper);
    await upsertPermissions(db, baseGrants(userId, CONN));

    const clock = fixedClock(NOW);
    const exec = spyExecutor();
    const pipeline = buildPipeline(db, keyWrapper, {
      clock,
      executeTool: exec.fn,
      // The PRODUCTION wiring: the pipeline's metrics go through E17-S02's guarded recorder,
      // which binds every field and stamps the instant from the clock (E17-S01 store).
      recordMetric: (input) => recordMetricEvent(db, clock, input),
    });

    const result = await pipeline.handleAgentCall(connectionFor(userId), callFor({ tool: "search_memory" }));
    assert.equal(result.status, "executed");

    const counts = await queryMetrics(db, { name: REQUEST_COUNT_METRIC, from: DAY_FROM, to: DAY_TO });
    assert.equal(counts.length, 1, "exactly one request-count row was stored through the guarded recorder");
    assert.equal(counts[0]!.value, 1, "the stored count value is 1");
    assert.equal(counts[0]!.outcome, "executed", "the stored count row is tagged outcome=executed");
    assert.equal(counts[0]!.errorCategory, null, "an executed call stores no error category");

    const lats = await queryMetrics(db, { name: REQUEST_LATENCY_METRIC, from: DAY_FROM, to: DAY_TO });
    assert.equal(lats.length, 1, "exactly one request-latency row was stored");
    assert.equal(typeof lats[0]!.value, "number", "the latency reads back as a number");
    assert.ok(Number.isFinite(lats[0]!.value) && lats[0]!.value >= 0, "the latency is a finite non-negative number");
    assert.equal(lats[0]!.outcome, "executed", "the latency row is tagged outcome=executed");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC2 — a failed call records an error-category dimension on its metric.
// ===========================================================================

test("a disconnected call records a failure metric tagged outcome=refused with an errorCategory", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const { userId } = await makePerson(db, "m-disc", keyWrapper);
    await upsertPermissions(db, baseGrants(userId, CONN));

    const metrics = spyMetrics();
    const exec = spyExecutor();
    const pipeline = buildPipeline(db, keyWrapper, { executeTool: exec.fn, recordMetric: metrics.recordMetric });

    const result: Result = await pipeline.handleAgentCall(connectionFor(userId, { active: false }), callFor());
    assert.equal(result.status, "refused", "a disconnected connection is refused");
    assert.equal(exec.calls.length, 0, "a disconnected call never reaches the tool");

    // Even the earliest gate (disconnected) is a handled call and records both metrics.
    assertOneCallTagged(metrics.metrics, "refused", { failure: true });
  } finally {
    await db.close();
  }
});

test("a denied call records a failure metric tagged outcome=refused with an errorCategory", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const { userId } = await makePerson(db, "m-deny", keyWrapper);
    // Only gmail is granted; the call targets slack → the permission gate denies.
    await upsertPermissions(db, baseGrants(userId, CONN, { grantedConnectors: ["gmail"], readTools: true }));

    const metrics = spyMetrics();
    const exec = spyExecutor();
    const pipeline = buildPipeline(db, keyWrapper, { executeTool: exec.fn, recordMetric: metrics.recordMetric });

    const result: Result = await pipeline.handleAgentCall(
      connectionFor(userId),
      callFor({ connector: "slack", tool: "slack.post", makesChange: false }),
    );
    assert.equal(result.status, "refused", "an ungranted connector is denied");
    assert.equal(exec.calls.length, 0, "a denied call never reaches the tool");

    assertOneCallTagged(metrics.metrics, "refused", { failure: true });
  } finally {
    await db.close();
  }
});

test("distinct failure classes (disconnected vs denied) carry DISTINCT error categories", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const { userId } = await makePerson(db, "m-distinct", keyWrapper);
    await upsertPermissions(db, baseGrants(userId, CONN, { grantedConnectors: ["gmail"], readTools: true }));

    const metrics = spyMetrics();
    const exec = spyExecutor();
    const pipeline = buildPipeline(db, keyWrapper, { executeTool: exec.fn, recordMetric: metrics.recordMetric });

    // Failure 1: disconnected (gate 1).
    await pipeline.handleAgentCall(connectionFor(userId, { active: false }), callFor());
    const afterDisconnected = countMetrics(metrics.metrics);
    assert.equal(afterDisconnected.length, 1, "the disconnected call recorded one count metric");
    const catDisconnected = dim(afterDisconnected[0]!, "errorCategory");

    // Failure 2: denied (permission gate) on an ACTIVE connection.
    await pipeline.handleAgentCall(connectionFor(userId), callFor({ connector: "slack", tool: "slack.post" }));
    const afterDenied = countMetrics(metrics.metrics);
    assert.equal(afterDenied.length, 2, "the denied call recorded a second count metric (per-call, not merged)");
    const catDenied = dim(afterDenied[1]!, "errorCategory");

    assert.equal(typeof catDisconnected, "string");
    assert.equal(typeof catDenied, "string");
    assert.match(catDisconnected as string, SHORT_LABEL);
    assert.match(catDenied as string, SHORT_LABEL);
    assert.notEqual(
      catDisconnected,
      catDenied,
      "a disconnected refusal and a policy denial are told apart by distinct error categories",
    );
  } finally {
    await db.close();
  }
});

test("a burst over the rate limit records ONE request metric PER over-limit call (metrics are per-call, not burst-summarised)", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const { userId } = await makePerson(db, "m-burst", keyWrapper);
    // A tiny per-connection limit so a short burst exceeds it deterministically.
    await upsertPermissions(db, baseGrants(userId, CONN, { rateLimit: 2 }));

    const clock = fixedClock(NOW);
    const metrics = spyMetrics();
    const exec = spyExecutor();
    const pipeline = buildPipeline(db, keyWrapper, {
      clock,
      rateLimiter: createRateLimiter(clock),
      executeTool: exec.fn,
      recordMetric: metrics.recordMetric,
    });

    const conn = connectionFor(userId);
    // Two within the limit (executed), then three over (each refused, none executed).
    await pipeline.handleAgentCall(conn, callFor());
    await pipeline.handleAgentCall(conn, callFor());
    for (let i = 0; i < 3; i += 1) {
      const r = await pipeline.handleAgentCall(conn, callFor());
      assert.equal(r.status, "refused", "each over-limit call is refused");
    }
    assert.equal(exec.calls.length, 2, "only the two within-limit calls executed");

    // Request VOLUME counts every request: 5 calls → 5 count + 5 latency metrics. (The
    // activity log summarises the refused burst to ONE entry; the request metric does NOT.)
    const counts = countMetrics(metrics.metrics);
    const lats = latencyMetrics(metrics.metrics);
    assert.equal(counts.length, 5, "every handled call — including each rate-limited one — records its own count metric");
    assert.equal(lats.length, 5, "every handled call records its own latency metric");

    const executed = counts.filter((m) => dim(m, "outcome") === "executed");
    const refused = counts.filter((m) => dim(m, "outcome") === "refused");
    assert.equal(executed.length, 2, "two count metrics are tagged executed");
    assert.equal(refused.length, 3, "three count metrics are tagged refused (one per over-limit call)");
    for (const m of executed) assert.ok(dim(m, "errorCategory") == null, "an executed count has no error category");
    for (const m of refused) {
      const cat = dim(m, "errorCategory");
      assert.equal(typeof cat, "string", "each rate-limited count carries an error category");
      assert.match(cat as string, SHORT_LABEL, "the rate-limit error category is a short label");
    }
  } finally {
    await db.close();
  }
});

test("a thrown tool executor still records a failure request metric, and the error propagates", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const { userId } = await makePerson(db, "m-throw", keyWrapper);
    await upsertPermissions(db, baseGrants(userId, CONN));

    const metrics = spyMetrics();
    const throwingExecutor = async (): Promise<unknown> => {
      throw new Error("tool executor blew up");
    };
    const pipeline = buildPipeline(db, keyWrapper, {
      executeTool: throwingExecutor,
      recordMetric: metrics.recordMetric,
    });

    // The pipeline does not swallow the executor's failure — the call still rejects.
    await assert.rejects(
      () => pipeline.handleAgentCall(connectionFor(userId), callFor({ tool: "search_memory" })),
      "a thrown tool executor still propagates out of handleAgentCall",
    );

    // …but the operational failure was measured first (error rates capture tool failures).
    const counts = countMetrics(metrics.metrics);
    const lats = latencyMetrics(metrics.metrics);
    assert.equal(counts.length, 1, "a thrown executor records exactly one request-count metric");
    assert.equal(lats.length, 1, "a thrown executor records exactly one request-latency metric");
    assert.equal(counts[0]!.value, 1, "the count value is 1");
    assert.ok(Number.isFinite(lats[0]!.value) && lats[0]!.value >= 0, "the latency is a finite non-negative number");
    for (const m of [counts[0]!, lats[0]!]) {
      assert.match(dim(m, "outcome") as string, SHORT_LABEL, "the executor-failure metric carries a short outcome label");
      const cat = dim(m, "errorCategory");
      assert.equal(typeof cat, "string", "a thrown executor records an error category");
      assert.match(cat as string, SHORT_LABEL, "the tool-error category is a short label");
    }
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC3 — the recorded metrics contain no tool parameters, identity values or message content.
// Scoped to the metric inputs (the unit under test): the same tokens may legitimately appear
// (redacted) in the activity entry and elsewhere, so a whole-output scan would overreach.
// ===========================================================================

test("no tool parameters, identity value, merchant, recipient, reason or message content appears in any recorded metric", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const { userId } = await makePerson(db, "m-nopersonal", keyWrapper);
    await upsertPermissions(db, baseGrants(userId, CONN));

    const metrics = spyMetrics();
    const exec = spyExecutor();
    const pipeline = buildPipeline(db, keyWrapper, { executeTool: exec.fn, recordMetric: metrics.recordMetric });

    // Distinctive tokens across every personal / free-text field of the call. Each is unique,
    // so any occurrence in a metric input is a genuine leak, not a coincidence.
    const SECRET = "sk-live-TOKENLEAK-apikey";
    const MESSAGE = "please pay Jane at 12 Pine St TOKENLEAK-message";
    const MERCHANT = "TOKENLEAK-merchant-pty-ltd";
    const RECIPIENT = "mallory-TOKENLEAK@secret.example";
    const REASON = "TOKENLEAK agent explanation prose";

    const result = await pipeline.handleAgentCall(
      connectionFor(userId),
      callFor({
        tool: "search_memory",
        merchant: MERCHANT,
        recipients: RECIPIENT,
        reason: REASON,
        params: { apiKey: SECRET, note: MESSAGE },
      }),
    );
    assert.equal(result.status, "executed");
    assert.ok(metrics.metrics.length >= 1, "at least one metric was recorded");

    const serialised = JSON.stringify(metrics.metrics);
    for (const token of [SECRET, MESSAGE, MERCHANT, RECIPIENT, REASON, userId]) {
      assert.ok(!serialised.includes(token), `no personal content ("${token}") may appear in a recorded metric`);
    }
    // Belt-and-braces: no metric dimension carries one of the non-allowlisted / personal keys.
    for (const m of metrics.metrics) {
      for (const key of Object.keys(m.dimensions ?? {})) {
        assert.ok(
          ["platform", "connectorId", "outcome", "errorCategory"].includes(key),
          `a metric dimension key must be allowlisted, not "${key}"`,
        );
      }
    }
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC4 — validate (a 4xx before the pipeline) and parameterize (every metric field bound; an
// injection probe cannot alter a query). The handler below is a test fixture (the intended
// usage: parseBody → the pipeline with the SESSION's connection), NOT an implementation file.
// ===========================================================================

function agentCallHandler(pipeline: Pipeline, sessionConnection: ReturnType<typeof connectionFor>) {
  const schema = z.object({
    tool: z.string().max(200),
    connector: z.string().max(200).nullable().optional(),
    makesChange: z.boolean().optional(),
    reason: z.string().max(500).optional(),
  });
  return async (req: Request): Promise<Response> => {
    try {
      const body = await parseBody(schema, req, { maxBytes: 4 * 1024 });
      const result = await pipeline.handleAgentCall(sessionConnection, {
        connector: body.connector ?? null,
        tool: body.tool,
        makesChange: body.makesChange ?? false,
        reason: body.reason,
      });
      return new Response(JSON.stringify({ status: result.status }), { status: 200 });
    } catch (err) {
      if (err instanceof HttpError) return new Response(JSON.stringify({ error: "invalid input" }), { status: err.status });
      return new Response("internal error", { status: 500 });
    }
  };
}

function jsonRequest(body: string): Request {
  return new Request("https://warthog.com.au/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

test("the handler rejects malformed / oversized / mis-shaped input with a 4xx before the pipeline runs — no metric recorded", async () => {
  const keyWrapper = keyWrapperFor();
  const db = recordingDb();
  const metrics = spyMetrics();
  const exec = spyExecutor();
  // The pipeline is never reached for rejected input, so the recording db is never queried.
  const pipeline = buildPipeline(db, keyWrapper, { executeTool: exec.fn, recordMetric: metrics.recordMetric });
  const handler = agentCallHandler(pipeline, connectionFor("session-user"));

  const malformed = await handler(jsonRequest("{ not valid json"));
  const oversized = await handler(jsonRequest(JSON.stringify({ tool: "search_memory", reason: "a".repeat(10 * 1024) })));
  const misshaped = await handler(jsonRequest(JSON.stringify({ tool: 123 })));

  for (const [label, res] of [["malformed", malformed], ["oversized", oversized], ["mis-shaped", misshaped]] as const) {
    assert.ok(res.status >= 400 && res.status < 500, `${label} input must be a 4xx, got ${res.status}`);
  }
  assert.equal(exec.calls.length, 0, "rejected input must never reach the tool");
  assert.equal(metrics.metrics.length, 0, "rejected input must never record a metric");
  assert.equal(db.calls.length, 0, "rejected input must never reach a query");
});

test("the handler accepts a well-formed body: the pipeline runs and records the request metrics", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const { userId } = await makePerson(db, "m-handler-ok", keyWrapper);
    await upsertPermissions(db, baseGrants(userId, CONN));

    const metrics = spyMetrics();
    const exec = spyExecutor();
    const pipeline = buildPipeline(db, keyWrapper, { executeTool: exec.fn, recordMetric: metrics.recordMetric });
    const handler = agentCallHandler(pipeline, connectionFor(userId));

    const res = await handler(jsonRequest(JSON.stringify({ tool: "search_memory" })));
    assert.ok(res.status >= 200 && res.status < 300, `expected a 2xx, got ${res.status}`);

    assertOneCallTagged(metrics.metrics, "executed", { failure: false });
  } finally {
    await db.close();
  }
});

test("every metric field reaches the store BOUND as a parameter, never concatenated into the SQL text", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const { userId } = await makePerson(db, "m-bound", keyWrapper);
    await upsertPermissions(db, baseGrants(userId, CONN));

    // The metrics seam writes through the REAL guarded recorder, but into a SEPARATE recording
    // db, so we can inspect exactly what reached the metric_events INSERT and HOW.
    const metricsDb = recordingDb();
    const clock = fixedClock(NOW);
    const exec = spyExecutor();
    const pipeline = buildPipeline(db, keyWrapper, {
      clock,
      executeTool: exec.fn,
      recordMetric: (input) => recordMetricEvent(metricsDb, clock, input),
    });

    const result = await pipeline.handleAgentCall(connectionFor(userId), callFor({ tool: "search_memory" }));
    assert.equal(result.status, "executed");

    assert.ok(metricsDb.calls.length >= 1, "the metrics recorder issued at least one statement");
    const bound = metricsDb.calls.flatMap((c) => c.values);
    assert.ok(bound.includes(REQUEST_COUNT_METRIC), "the count metric name travels as a bound value");
    assert.ok(bound.includes(REQUEST_LATENCY_METRIC), "the latency metric name travels as a bound value");
    assert.ok(bound.includes(1), "the count value 1 travels as a bound value");
    assert.ok(bound.includes("executed"), "the outcome dimension travels as a bound value");
    for (const call of metricsDb.calls) {
      assert.ok(!call.text.includes(`'${REQUEST_COUNT_METRIC}'`), "the metric name is bound, never spliced into the SQL");
      assert.ok(!call.text.includes("'executed'"), "the outcome is bound, never spliced into the SQL");
    }
  } finally {
    await db.close();
  }
});

test("a SQL-injection probe in a call field never becomes a metric dimension and cannot alter a query (the table survives)", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const { userId } = await makePerson(db, "m-inject", keyWrapper);
    await upsertPermissions(db, baseGrants(userId, CONN));

    const clock = fixedClock(NOW);
    const captured: MetricInput[] = [];
    const exec = spyExecutor();
    const pipeline = buildPipeline(db, keyWrapper, {
      clock,
      executeTool: exec.fn,
      // Capture what the pipeline records AND write it through the real guarded recorder into
      // the live metric_events table (same db).
      recordMetric: async (input) => {
        captured.push(input);
        await recordMetricEvent(db, clock, input);
      },
    });

    const result = await pipeline.handleAgentCall(
      connectionFor(userId),
      callFor({ tool: INJECTION, merchant: INJECTION, params: { note: INJECTION } }),
    );
    assert.equal(result.status, "executed");

    // The probe lives in call fields the pipeline does NOT turn into dimensions, so it never
    // reaches the metrics store at all — and the table is intact and still queryable.
    const serialised = JSON.stringify(captured);
    assert.ok(!serialised.includes("DROP TABLE"), "no injected statement appears in any recorded metric");
    assert.ok(!serialised.includes(INJECTION), "the probe never becomes a metric field");
    assert.equal(await tableExists(db, "metric_events"), true, "the metric_events table survives the call");

    const counts = await queryMetrics(db, { name: REQUEST_COUNT_METRIC, from: DAY_FROM, to: DAY_TO });
    assert.equal(counts.length, 1, "the request-count metric was still stored (through bound parameters)");
    assert.equal(counts[0]!.outcome, "executed", "and it reads back tagged outcome=executed");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC5 — the pipeline + metric recording read no process.env: a decoy env secret never lands
// in a recorded metric.
// ===========================================================================

test("the pipeline reads no process.env: a decoy env secret never appears in a recorded metric", async () => {
  const DECOY = "sk_live_DECOY_must_never_appear_in_warthog";
  const prev = process.env.WARTHOG_DECOY_SECRET;
  process.env.WARTHOG_DECOY_SECRET = DECOY;
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const { userId } = await makePerson(db, "m-env", keyWrapper);
    await upsertPermissions(db, baseGrants(userId, CONN));

    const metrics = spyMetrics();
    const exec = spyExecutor();
    const pipeline = buildPipeline(db, keyWrapper, { executeTool: exec.fn, recordMetric: metrics.recordMetric });

    const result = await pipeline.handleAgentCall(connectionFor(userId), callFor({ tool: "search_memory" }));
    assert.equal(result.status, "executed", "the pipeline works purely from its injected seams");

    assert.ok(metrics.metrics.length >= 1, "at least one metric was recorded");
    assert.ok(
      !JSON.stringify(metrics.metrics).includes(DECOY),
      "no ambient env value is folded into a recorded metric",
    );
  } finally {
    await db.close();
    if (prev === undefined) delete process.env.WARTHOG_DECOY_SECRET;
    else process.env.WARTHOG_DECOY_SECRET = prev;
  }
});
