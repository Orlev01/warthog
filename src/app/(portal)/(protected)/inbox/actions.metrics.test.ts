// E17-S04 — Approval-response metrics in the inbox actions
// (`src/app/(portal)/(protected)/inbox/actions.ts`).
//
// RED-first: `createInboxActions` already exists (E12-S10), but the request-metrics seam
// it must use does NOT yet. So these tests fail — the injected metrics recorder is never
// called, so the spy captures nothing and every metric assertion fails — until the builder
// wires the decision actions (approve / deny / ask-for-more-detail) to record the two
// metrics. That absence IS the point of test-first; do NOT implement anything to make
// these pass. The builder extends `actions.ts` afterwards. The EARLIER inbox test
// (`actions.test.ts`, E12-S10) builds the actions WITHOUT this optional seam, so it must
// stay green — an actions object built without the seam records no metrics.
//
// These tests pin BEHAVIOUR (which metrics a decision hands the recorder, with which
// name / value / dimensions; that a REFUSED action records none; that no personal content
// reaches a metric) against an isolated in-memory PGlite with the REAL migrations
// (`src/test/db`, including E17-S01's 0044_metrics) and the REAL sibling seams (the
// approvals store `createApproval`/`getApproval`/`decide`, the session + step-up seams, a
// real `KeyWrapper`, the validation boundary, and — end to end — E17-S02's guarded
// `recordMetricEvent` + E17-S01's `queryMetrics`). No test asserts on the source text of
// any module, so a later behaviour-preserving refactor (a rename, a moved import) stays
// green.
//
// WHY this exists (task E17-S04): approval response time is an explicit operational metric
// (brief "Operations readiness"). Recording it WHEN THE PERSON DECIDES captures how long an
// approval waited (created-to-decided) without storing what the approval was about — so the
// metrics carry NO approval detail, recipient, amount, field, reason, question, agent id or
// user id, only the allowlisted non-personal dimensions. The decision actions are the one
// place that sees a pending approval turn into a decided one, so that is where these are
// measured — exactly as E17-S03 measures request metrics in the agent-call pipeline.
//
// ---------------------------------------------------------------------------
// THE PINNED CONTRACT (chosen by the tester; the implementation conforms to it).
//
//   // A NEW, OPTIONAL injected seam on InboxActionsDeps — the metrics recorder. Shape
//   // mirrors E17-S02's RecordMetricInput (name + finite numeric value + an OPTIONAL open
//   // map of dimensions). Production wires it to the guarded recorder:
//   //     recordMetric: (input) => recordMetricEvent(db, clock, input)
//   // An actions object built WITHOUT it records no metrics (so the E12-S10 pins stay intact).
//   type RecordMetricSeam =
//     (input: { name: string; value: number; dimensions?: Record<string, unknown> }) => Promise<void>;
//   interface InboxActionsDeps { /* …existing… */ recordMetric?: RecordMetricSeam; }
//
//   // When a pending approval is SUCCESSFULLY DECIDED (approveApproval / denyApproval /
//   // askForMoreDetail lands the approval in a decided status), the actions record EXACTLY
//   // two metrics through the seam, and NO OTHER metric:
//   //   • name "approval.response_time_ms"  value = decidedAt − createdAt in ms
//   //                                        (a FINITE number ≥ 0 — created-to-decided)
//   //   • name "approval.decision"          value 1   (an outcome-count increment),
//   //                                        carrying an `outcome` dimension = the decision
//   //                                        status ("approved" | "denied" | "more_detail").
//   // Both metrics carry ONLY the four allowlisted non-personal dimensions
//   //   ({platform, connectorId, outcome, errorCategory}) — NEVER approval detail,
//   //   recipient, amount, merchant, field, reason, question, agent id or user id.
//   // A REFUSED action records NOTHING: when the action refuses (another person's approval →
//   //   not_found; a high-tier / card release missing a fresh step-up → step_up_required)
//   //   nothing was decided, so no metric is recorded.
//
// The two metric NAMES above are the tester's pinned contract (as `agent.request` /
// `agent.request.latency_ms` are in E17-S03); the builder conforms to them.
//
// Acceptance criteria → tests:
//   AC1 "Deciding a pending approval records an approval-response-time metric and an
//        outcome-count metric." — approve (a held non-release call and a stepped-up card
//        release), deny and ask each record exactly one response-time metric (value =
//        created-to-decided ms) + one outcome count (value 1, outcome = the decision
//        status). A real-recorder end-to-end test reads both rows back through queryMetrics.
//   AC2 "The recorded metrics carry no approval detail, recipient, amount or other personal
//        content." — distinctive tokens planted in the approval's detail (recipient, amount,
//        merchant, field, reason, sentence) and the owning userId / approvalId appear in NO
//        recorded metric input (scoped to the metric payloads — the unit under test); every
//        metric dimension key is allowlisted.
//   AC3 [obligation:validate-and-parameterize-input] (INV-102) — a handler on the
//        `../../../../server/http/validate` boundary rejects malformed / oversized input with
//        a 4xx BEFORE any metric is recorded or any query runs; a mis-shaped approval id is
//        likewise rejected with a 4xx and records no metric; a SQL-injection probe in the
//        question travels as a BOUND value (stored verbatim as data, never spliced into the
//        SQL) and never becomes a metric dimension.
//   AC4 [obligation:secrets-from-env] (INV-103) — the actions + metric recording read no
//        `process.env`: a decoy secret in the environment never lands in a recorded metric
//        or in the result.
//
// Every db handle is closed in a `finally`; each test uses its own `freshDb()`, so tests
// share no state. Tests never touch the network or Azure.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { z } from "zod";

import { createInboxActions } from "./actions";

import { createSession, recordStepUp, type Session } from "../../../../server/auth/session";
import { createUser } from "../../../../server/db/users";
import { createApproval, getApproval } from "../../../../server/db/approvals";
import { recordMetricEvent } from "../../../../server/metrics/record";
import { queryMetrics } from "../../../../server/db/metrics";
import { HttpError, parseBody } from "../../../../server/http/validate";
import { localAesKeyWrapper, type KeyWrapper } from "../../../../server/crypto/key-wrapper";
import { fixedClock, type Clock } from "../../../../server/seams/clock";
import { systemRandom } from "../../../../server/seams/random";
import { freshDb } from "../../../../test/db";
import type { Db, QueryResult } from "../../../../server/db/index";

// --- shapes derived from the collaborators' own signatures, so a later type rename that
// preserves behaviour does not redden these tests. --------------------------------------
type InboxActions = ReturnType<typeof createInboxActions>;
type ActionResult = Awaited<ReturnType<InboxActions["approveApproval"]>>;

// The metric input the actions hand the recorder seam (structural, so a rename of E17-S02's
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

// The approval is CREATED at this instant and DECIDED 90 seconds later. The response-time
// metric is created-to-decided, so it must read exactly 90_000 ms — a non-zero, non-round
// gap well inside the state machine's 15-minute default expiry window, so every decision is
// legal. The 90s decision instant is also used as the fresh-step-up instant for releases.
const CREATED_AT = new Date("2026-11-15T12:00:00.000Z");
const DECIDED_AT = new Date("2026-11-15T12:01:30.000Z");
const RESPONSE_MS = DECIDED_AT.getTime() - CREATED_AT.getTime(); // 90_000

// A whole-day window around the decision, for queryMetrics read-backs.
const DAY_FROM = "2026-11-15T00:00:00.000Z";
const DAY_TO = "2026-11-15T23:59:59.999Z";

// The two metric names the actions record for every decision (the tester's pinned contract).
const RESPONSE_TIME_METRIC = "approval.response_time_ms";
const DECISION_METRIC = "approval.decision";

// The four allowlisted dimension keys (the E17-S01/S02 store's constrained, non-personal
// dimensions). A metric may carry only these; anything else is a personal-content vector.
const ALLOWED_DIMENSION_KEYS = ["platform", "connectorId", "outcome", "errorCategory"];

// The injection probe reused across the parameterize tests.
const INJECTION = "'; DROP TABLE approvals; -- and what is the amount?";

function keyWrapperFor(): KeyWrapper {
  return localAesKeyWrapper(randomBytes(KEK_BYTES));
}

// Create a person whose wrapped DEK really unwraps under `keyWrapper`, returning their id
// and the DEK the approval detail is encrypted under (same resolution path the actions use).
async function makePerson(
  db: Db,
  who: string,
  keyWrapper: KeyWrapper,
): Promise<{ userId: string; dek: Uint8Array }> {
  const dek = randomBytes(DEK_BYTES);
  const wrappedDek = await keyWrapper.wrap(dek);
  const user = await createUser(db, { email: `${who}@warthog.com.au`, wrappedDek });
  return { userId: user.id, dek };
}

// Seed a PENDING approval for a fresh person directly through the approvals store (the exact
// production row: DEK-encrypted detail, created at CREATED_AT), returning what a test needs
// to then decide it. The decision logic under test never inspects HOW the approval was
// created, only that it is this person's pending approval — so seeding it directly is faithful
// and lets a test control the stored detail and timestamps precisely.
async function seedPending(
  db: Db,
  keyWrapper: KeyWrapper,
  who: string,
  detail: Record<string, unknown>,
): Promise<{ userId: string; dek: Uint8Array; approvalId: string }> {
  const { userId, dek } = await makePerson(db, who, keyWrapper);
  const approval = await createApproval(
    db,
    { userId, agentId: CONN, detail },
    dek,
    fixedClock(CREATED_AT),
  );
  return { userId, dek, approvalId: approval.id };
}

// The detail shapes the actions route on `detail.request`: a plain held change (no `request`
// → executed on approval), a card release and a high-tier release (both sensitive hand-overs
// gated on a fresh step-up, never run through the pipeline). A test overrides only what it
// is about.
function nonReleaseDetail(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { sentence: "Send the monthly report to finance", recipient: "finance@example.com", ...overrides };
}
function cardDetail(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { request: "card", sentence: "Pay BoxCo for a box of widgets", amount: "$42.00", merchant: "BoxCo", ...overrides };
}

// A stub pipeline execution seam: records each invocation and returns a sentinel. The
// actions call it only for an approved held NON-release call; this task is about metrics, not
// the single-shot execution (pinned by E12-S10), so the real pipeline is not needed here.
function stubExecuteApprovedHold(result: unknown = { ran: "INBOX-APPROVED-RESULT" }) {
  const calls: { userId: string; approvalId: string }[] = [];
  const fn = async (userId: string, approvalId: string): Promise<unknown> => {
    calls.push({ userId, approvalId });
    return result;
  };
  return { fn, calls };
}

// Build the inbox actions over `db`, deciding at DECIDED_AT, with an optional metrics seam.
// Passing `recordMetric: undefined` is how a test exercises the "no seam" path (the field is
// optional; undefined ≡ absent at runtime).
function buildActions(
  db: Db,
  keyWrapper: KeyWrapper,
  opts: { recordMetric?: RecordMetricSeam; clock?: Clock } = {},
): { actions: InboxActions; execHold: ReturnType<typeof stubExecuteApprovedHold> } {
  const execHold = stubExecuteApprovedHold();
  const actions = createInboxActions({
    db,
    clock: opts.clock ?? fixedClock(DECIDED_AT),
    keyWrapper,
    executeApprovedHold: execHold.fn,
    // The seam under test (the builder adds this optional field to InboxActionsDeps).
    recordMetric: opts.recordMetric,
  } as Parameters<typeof createInboxActions>[0]);
  return { actions, execHold };
}

// The metrics-recorder SPY: captures each metric input the actions hand the seam.
function spyMetrics(): { metrics: MetricInput[]; recordMetric: RecordMetricSeam } {
  const metrics: MetricInput[] = [];
  const recordMetric: RecordMetricSeam = async (input) => {
    metrics.push(input);
  };
  return { metrics, recordMetric };
}

// --- sessions --------------------------------------------------------------------------

// A fresh (never stepped up) session for `userId`, created at the decision instant.
async function freshSession(db: Db, userId: string): Promise<Session> {
  return (await createSession(db, userId, { clock: fixedClock(DECIDED_AT), random: systemRandom })).session;
}
// A session carrying a FRESH step-up (recorded at the decision instant, so it is 0 minutes
// old against the actions' DECIDED_AT clock — inside the 5-minute window).
async function steppedUpSession(db: Db, userId: string): Promise<Session> {
  const c = fixedClock(DECIDED_AT);
  const created = await createSession(db, userId, { clock: c, random: systemRandom });
  return recordStepUp(db, created.session.id, { clock: c });
}

// A hand-built verified session — used only where the request is REJECTED at the validation
// boundary before the session is ever read from the database (malformed body, mis-shaped id),
// so no DB-backed session row is needed. Only `userId` would ever be read, and the rejection
// precedes even that.
function fakeSession(userId: string): Session {
  return {
    id: "session-fake",
    userId,
    createdAt: DECIDED_AT,
    lastSeenAt: DECIDED_AT,
    steppedUpAt: null,
  };
}

// --- metric helpers --------------------------------------------------------------------

const byName = (ms: MetricInput[], name: string): MetricInput[] => ms.filter((m) => m.name === name);
const dim = (m: MetricInput, key: string): unknown => (m.dimensions ?? {})[key];

// Assert that one successful decision recorded EXACTLY the two metrics: a response-time
// metric (value = created-to-decided ms, finite ≥ 0) and an outcome count (value 1, tagged
// `outcome`), and that every dimension key on either is allowlisted (no personal content).
function assertDecisionMetrics(ms: MetricInput[], outcome: string): void {
  assert.equal(ms.length, 2, "a decision records exactly two metrics (a response time + an outcome count)");

  const times = byName(ms, RESPONSE_TIME_METRIC);
  const counts = byName(ms, DECISION_METRIC);
  assert.equal(times.length, 1, `exactly one "${RESPONSE_TIME_METRIC}" metric is recorded`);
  assert.equal(counts.length, 1, `exactly one "${DECISION_METRIC}" metric is recorded`);

  const time = times[0]!;
  const count = counts[0]!;

  assert.equal(typeof time.value, "number", "the response-time value is a number");
  assert.ok(Number.isFinite(time.value), "the response time is a finite number (acceptable to the guarded recorder)");
  assert.ok(time.value >= 0, "the response time is non-negative");
  assert.equal(time.value, RESPONSE_MS, "the response time is created-to-decided (decidedAt − createdAt) in ms");

  assert.equal(count.value, 1, "the outcome-count metric's value is 1 (a count increment)");
  assert.equal(dim(count, "outcome"), outcome, `the outcome-count metric is tagged outcome="${outcome}"`);

  for (const m of ms) {
    for (const key of Object.keys(m.dimensions ?? {})) {
      assert.ok(
        ALLOWED_DIMENSION_KEYS.includes(key),
        `a recorded metric dimension key must be allowlisted (non-personal), not "${key}"`,
      );
    }
  }
}

// --- narrowers -------------------------------------------------------------------------

function expectOk(r: ActionResult, label: string): void {
  if (!r.ok) assert.fail(`${label}: expected success, got refusal "${r.reason}"`);
}
function expectRefused(r: ActionResult, label: string): void {
  if (r.ok) assert.fail(`${label}: expected a refusal, got success`);
  assert.ok(r.reason.length > 0, `${label}: the refusal carries a plain reason`);
}

// =====================================================================================
// AC1 — deciding a pending approval records a response-time metric + an outcome count.
// =====================================================================================

test("denyApproval records a response-time metric and an outcome count tagged outcome=denied", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const seeded = await seedPending(db, keyWrapper, "deny-metrics", nonReleaseDetail());
    const metrics = spyMetrics();
    const { actions } = buildActions(db, keyWrapper, { recordMetric: metrics.recordMetric });
    const session = await freshSession(db, seeded.userId);

    expectOk(await actions.denyApproval(session, seeded.approvalId), "deny");

    assert.equal((await getApproval(db, seeded.userId, seeded.approvalId, seeded.dek))!.status, "denied", "the approval is decided (denied)");
    assertDecisionMetrics(metrics.metrics, "denied");
  } finally {
    await db.close();
  }
});

test("askForMoreDetail records a response-time metric and an outcome count tagged outcome=more_detail", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const seeded = await seedPending(db, keyWrapper, "ask-metrics", nonReleaseDetail());
    const metrics = spyMetrics();
    const { actions } = buildActions(db, keyWrapper, { recordMetric: metrics.recordMetric });
    const session = await freshSession(db, seeded.userId);

    expectOk(await actions.askForMoreDetail(session, seeded.approvalId, "Who is the recipient and why now?"), "ask");

    assert.equal((await getApproval(db, seeded.userId, seeded.approvalId, seeded.dek))!.status, "more_detail", "the approval is decided (more_detail)");
    assertDecisionMetrics(metrics.metrics, "more_detail");
  } finally {
    await db.close();
  }
});

test("approveApproval on a held non-release call records a response-time metric and an outcome count tagged outcome=approved", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const seeded = await seedPending(db, keyWrapper, "approve-metrics", nonReleaseDetail());
    const metrics = spyMetrics();
    const { actions, execHold } = buildActions(db, keyWrapper, { recordMetric: metrics.recordMetric });
    const session = await freshSession(db, seeded.userId); // a non-release change needs no step-up

    expectOk(await actions.approveApproval(session, seeded.approvalId), "approve");

    assert.equal((await getApproval(db, seeded.userId, seeded.approvalId, seeded.dek))!.status, "approved", "the approval is decided (approved)");
    assert.equal(execHold.calls.length, 1, "a held non-release call is executed on approval (orthogonal to metrics)");
    assertDecisionMetrics(metrics.metrics, "approved");
  } finally {
    await db.close();
  }
});

test("approving a card release with a fresh step-up records a response-time metric and an outcome count tagged outcome=approved", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const seeded = await seedPending(db, keyWrapper, "card-approve-metrics", cardDetail());
    const metrics = spyMetrics();
    const { actions, execHold } = buildActions(db, keyWrapper, { recordMetric: metrics.recordMetric });
    const session = await steppedUpSession(db, seeded.userId); // a release needs a fresh step-up

    expectOk(await actions.approveApproval(session, seeded.approvalId), "approve card (stepped up)");

    assert.equal((await getApproval(db, seeded.userId, seeded.approvalId, seeded.dek))!.status, "approved", "the stepped-up card release is approved");
    assert.equal(execHold.calls.length, 0, "a card release is never run through the pipeline (orthogonal to metrics)");
    assertDecisionMetrics(metrics.metrics, "approved");
  } finally {
    await db.close();
  }
});

test("the real guarded recorder, wired end-to-end, stores both decision metrics (read back through queryMetrics)", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const seeded = await seedPending(db, keyWrapper, "real-recorder", nonReleaseDetail());
    const decideClock = fixedClock(DECIDED_AT);
    // The PRODUCTION wiring: the actions' metrics go through E17-S02's guarded recorder,
    // which binds every field and stamps the instant from the clock (E17-S01 store). Using
    // an ask decision also proves the "more_detail" outcome label survives the recorder's
    // short-identifier guard (a space-separated "more detail" would be rejected).
    const { actions } = buildActions(db, keyWrapper, {
      clock: decideClock,
      recordMetric: (input) => recordMetricEvent(db, decideClock, input),
    });
    const session = await freshSession(db, seeded.userId);

    expectOk(await actions.askForMoreDetail(session, seeded.approvalId, "Could you clarify the amount?"), "ask (real recorder)");

    const times = await queryMetrics(db, { name: RESPONSE_TIME_METRIC, from: DAY_FROM, to: DAY_TO });
    assert.equal(times.length, 1, "exactly one response-time row was stored through the guarded recorder");
    assert.equal(times[0]!.value, RESPONSE_MS, "the stored response time is created-to-decided ms");
    assert.equal(times[0]!.outcome, "more_detail", "the stored response-time row carries the decision outcome");

    const counts = await queryMetrics(db, { name: DECISION_METRIC, from: DAY_FROM, to: DAY_TO });
    assert.equal(counts.length, 1, "exactly one outcome-count row was stored");
    assert.equal(counts[0]!.value, 1, "the stored count value is 1");
    assert.equal(counts[0]!.outcome, "more_detail", "the stored count row is tagged outcome=more_detail");
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC1 (guard) — a REFUSED action records NOTHING: nothing was decided.
// =====================================================================================

test("a card release refused for a missing step-up records NO metric and leaves the approval pending", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const seeded = await seedPending(db, keyWrapper, "card-no-stepup", cardDetail());
    const metrics = spyMetrics();
    const { actions } = buildActions(db, keyWrapper, { recordMetric: metrics.recordMetric });
    const session = await freshSession(db, seeded.userId); // never stepped up → refused

    expectRefused(await actions.approveApproval(session, seeded.approvalId), "approve card (no step-up)");

    assert.equal((await getApproval(db, seeded.userId, seeded.approvalId, seeded.dek))!.status, "pending", "the card release is left pending");
    assert.equal(metrics.metrics.length, 0, "a refused decision (step_up_required) records no metric");
  } finally {
    await db.close();
  }
});

test("a non-owner cannot record a decision metric against another person's approval — refused, nothing recorded", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const owner = await seedPending(db, keyWrapper, "owner", nonReleaseDetail());
    // A different, fully stepped-up person tries to decide the owner's approval by its id.
    const intruder = await makePerson(db, "intruder", keyWrapper);
    const intruderSession = await steppedUpSession(db, intruder.userId);

    const metrics = spyMetrics();
    const { actions } = buildActions(db, keyWrapper, { recordMetric: metrics.recordMetric });

    expectRefused(await actions.approveApproval(intruderSession, owner.approvalId), "intruder approve");
    expectRefused(await actions.denyApproval(intruderSession, owner.approvalId), "intruder deny");
    expectRefused(await actions.askForMoreDetail(intruderSession, owner.approvalId, "mine now?"), "intruder ask");

    assert.equal((await getApproval(db, owner.userId, owner.approvalId, owner.dek))!.status, "pending", "the owner's approval is untouched");
    assert.equal(metrics.metrics.length, 0, "a refused (not-owner) decision records no metric for anyone");
  } finally {
    await db.close();
  }
});

test("an actions object built WITHOUT the metrics seam still decides successfully (the E12-S10 contract is intact)", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const seeded = await seedPending(db, keyWrapper, "no-seam", nonReleaseDetail());
    const { actions } = buildActions(db, keyWrapper, { recordMetric: undefined }); // no metrics seam
    const session = await freshSession(db, seeded.userId);

    expectOk(await actions.denyApproval(session, seeded.approvalId), "deny without a metrics seam");
    assert.equal((await getApproval(db, seeded.userId, seeded.approvalId, seeded.dek))!.status, "denied", "the decision still lands without the optional seam");
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC2 — the recorded metrics carry no approval detail, recipient, amount or other personal
// content. Scoped to the metric inputs (the unit under test): the same tokens legitimately
// live (DEK-encrypted) in the approval row, so a whole-output scan would overreach.
// =====================================================================================

test("no approval detail, recipient, amount, merchant, field, reason, agent id or user id appears in any recorded metric", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    // Distinctive tokens across every personal field of the approval's detail. Each is unique,
    // so any occurrence in a metric input is a genuine leak, not a coincidence.
    const detail = {
      sentence: "Pay TOKENLEAK-merchant $420 to mallory-TOKENLEAK@secret.example",
      recipient: "mallory-TOKENLEAK@secret.example",
      amount: "$420.00 TOKENLEAK-amount",
      merchant: "TOKENLEAK-merchant-pty-ltd",
      field: "TOKENLEAK-field-passport",
      reason: "TOKENLEAK agent explanation prose",
    };
    const seeded = await seedPending(db, keyWrapper, "no-personal", detail);
    const metrics = spyMetrics();
    const { actions } = buildActions(db, keyWrapper, { recordMetric: metrics.recordMetric });
    const session = await freshSession(db, seeded.userId);

    expectOk(await actions.denyApproval(session, seeded.approvalId), "deny (personal-content scan)");
    assert.ok(metrics.metrics.length >= 1, "at least one metric was recorded");

    const serialised = JSON.stringify(metrics.metrics);
    const tokens = [
      detail.sentence,
      detail.recipient,
      detail.amount,
      detail.merchant,
      detail.field,
      detail.reason,
      "TOKENLEAK", // the shared marker — catches any fragment of the above
      seeded.userId, // the metrics are global, not member-scoped: the person's id must not appear
      seeded.approvalId, // nor the approval's own id
      CONN, // nor the agent id
    ];
    for (const token of tokens) {
      assert.ok(!serialised.includes(token), `no personal content ("${token}") may appear in a recorded metric`);
    }
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC3 [obligation:validate-and-parameterize-input] — a handler on the validation boundary
// rejects malformed / oversized / mis-shaped input with a 4xx BEFORE any metric or query;
// a well-formed body records the two metrics; a SQL-injection probe in the question is
// bound (stored verbatim, never spliced) and never becomes a metric dimension.
//
// The handler below is a test FIXTURE (the intended usage: parseBody → the ask action with
// the SESSION's user), NOT an implementation file.
// =====================================================================================

// A db stand-in that records every query instead of running it, so a test can prove a
// REJECTED request issues no query at all. Returns no rows.
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

// A pass-through proxy over a real db that captures text + values, so a test can prove the
// probe travelled BOUND (in values) and was never concatenated into the SQL text.
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

// The ask-for-more-detail handler fixture: parse the body at the boundary, then call the
// action (which validates the id + question at its own boundary, throwing HttpError). A
// catch-all maps an HttpError to its 4xx; a raw non-HttpError surfaces as a 500 so a test
// sees the masked-success failure rather than a hidden one.
function askDetailHandler(actions: InboxActions, session: Session): (req: Request) => Promise<Response> {
  const schema = z.object({ approvalId: z.string().max(200), question: z.string().max(5000) });
  return async (req: Request): Promise<Response> => {
    try {
      const body = await parseBody(schema, req, { maxBytes: 4 * 1024 });
      const result = await actions.askForMoreDetail(session, body.approvalId, body.question);
      return new Response(JSON.stringify(result), { status: 200 });
    } catch (err) {
      if (err instanceof HttpError) return new Response(JSON.stringify({ error: "invalid input" }), { status: err.status });
      return new Response("internal error", { status: 500 });
    }
  };
}

function jsonRequest(body: string): Request {
  return new Request("https://warthog.com.au/inbox/ask", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

test("the handler rejects malformed / oversized input with a 4xx before any metric is recorded or any query runs", async () => {
  const db = recordingDb();
  const keyWrapper = keyWrapperFor();
  const metrics = spyMetrics();
  const { actions } = buildActions(db, keyWrapper, { recordMetric: metrics.recordMetric });
  const session = fakeSession("session-user"); // the body is rejected before the session is ever read

  const malformed = await askDetailHandler(actions, session)(jsonRequest("{ not valid json"));
  const oversized = await askDetailHandler(actions, session)(
    jsonRequest(JSON.stringify({ approvalId: CONN, question: "a".repeat(10 * 1024) })),
  );

  for (const [label, res] of [["malformed", malformed], ["oversized", oversized]] as const) {
    assert.ok(res.status >= 400 && res.status < 500, `${label} input must be a 4xx, got ${res.status}`);
  }
  assert.equal(metrics.metrics.length, 0, "rejected input must never record a metric");
});

test("the handler rejects a mis-shaped approval id with a 4xx and records no metric (and issues no decision query)", async () => {
  const db = recordingDb();
  const keyWrapper = keyWrapperFor();
  const metrics = spyMetrics();
  const { actions } = buildActions(db, keyWrapper, { recordMetric: metrics.recordMetric });
  const session = fakeSession("session-user"); // the id is rejected before the session is ever read

  const res = await askDetailHandler(actions, session)(
    jsonRequest(JSON.stringify({ approvalId: "not-a-uuid-at-all", question: "why?" })),
  );

  assert.ok(res.status >= 400 && res.status < 500, `a mis-shaped id must be a 4xx, got ${res.status}`);
  assert.equal(metrics.metrics.length, 0, "a mis-shaped id records no metric");
  assert.equal(db.calls.length, 0, "a mis-shaped id is rejected at the boundary before any decision query runs");
});

test("the handler accepts a well-formed body: the ask action runs and records the two decision metrics", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const seeded = await seedPending(db, keyWrapper, "handler-ok", nonReleaseDetail());
    const metrics = spyMetrics();
    const { actions } = buildActions(db, keyWrapper, { recordMetric: metrics.recordMetric });
    const session = await freshSession(db, seeded.userId);

    const res = await askDetailHandler(actions, session)(
      jsonRequest(JSON.stringify({ approvalId: seeded.approvalId, question: "Could you confirm the amount?" })),
    );
    assert.ok(res.status >= 200 && res.status < 300, `expected a 2xx, got ${res.status}`);

    assertDecisionMetrics(metrics.metrics, "more_detail");
  } finally {
    await db.close();
  }
});

test("a SQL-injection probe in the question is bound and stored as data, and never becomes a metric dimension", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    // Seed over the REAL db (these queries are not captured), then decide through a recording
    // proxy so only THIS decision's queries are inspected.
    const seeded = await seedPending(db, keyWrapper, "sqli-question", nonReleaseDetail());
    const proxy = recordingProxy(db);
    const metrics = spyMetrics();
    const { actions } = buildActions(proxy, keyWrapper, { recordMetric: metrics.recordMetric });
    const session = await freshSession(db, seeded.userId);

    expectOk(await actions.askForMoreDetail(session, seeded.approvalId, INJECTION), "ask with a SQL probe");

    // Stored verbatim as DATA: the table survives and the question round-trips unchanged.
    const approval = await getApproval(db, seeded.userId, seeded.approvalId, seeded.dek);
    assert.equal(approval!.status, "more_detail", "the approval moved to more_detail");
    assert.equal(approval!.question, INJECTION, "the probe is stored verbatim as data, not executed");

    // The probe, the user id and the approval id all travel as BOUND values, never spliced.
    const allValues = proxy.calls.flatMap((c) => c.values);
    assert.ok(allValues.includes(INJECTION), "the question travels as a bound value");
    assert.ok(allValues.includes(seeded.userId), "the acting user id travels as a bound value");
    assert.ok(allValues.includes(seeded.approvalId), "the approval id travels as a bound value");
    for (const call of proxy.calls) {
      assert.ok(!call.text.includes(INJECTION), "the probe is bound, never concatenated into the SQL");
      assert.ok(!call.text.includes("DROP TABLE"), "no injected statement appears in the SQL text");
    }

    // And the probe never leaks into a recorded metric dimension.
    assert.ok(!JSON.stringify(metrics.metrics).includes("DROP TABLE"), "no injected statement appears in a recorded metric");
    assert.ok(!JSON.stringify(metrics.metrics).includes(INJECTION), "the probe never becomes a metric field");
    assertDecisionMetrics(metrics.metrics, "more_detail");
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC4 [obligation:secrets-from-env] — the actions + metric recording read no process.env:
// a decoy secret in the environment never appears in a recorded metric or in the result.
// =====================================================================================

test("the actions read no process.env: a decoy env secret never appears in a recorded metric or the result", async () => {
  const DECOY = "sk_live_DECOY_must_never_appear_in_warthog_inbox";
  const prev = process.env.WARTHOG_DECOY_SECRET;
  process.env.WARTHOG_DECOY_SECRET = DECOY;
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const seeded = await seedPending(db, keyWrapper, "env-decoy", nonReleaseDetail());
    const metrics = spyMetrics();
    const { actions } = buildActions(db, keyWrapper, { recordMetric: metrics.recordMetric });
    const session = await freshSession(db, seeded.userId);

    const result = await actions.denyApproval(session, seeded.approvalId);
    expectOk(result, "deny (env-decoy)");

    assert.ok(metrics.metrics.length >= 1, "at least one metric was recorded");
    assert.ok(!JSON.stringify(metrics.metrics).includes(DECOY), "no ambient env value is folded into a recorded metric");
    assert.ok(!JSON.stringify(result).includes(DECOY), "no ambient env value is folded into the result");
  } finally {
    await db.close();
    if (prev === undefined) delete process.env.WARTHOG_DECOY_SECRET;
    else process.env.WARTHOG_DECOY_SECRET = prev;
  }
});
