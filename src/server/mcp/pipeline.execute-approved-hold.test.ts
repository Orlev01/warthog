// E07-S18 — Agent call pipeline: executeApprovedHold
// (`src/server/mcp/pipeline.ts`, design §6.1 pipeline / §6.2 held requests;
// brief "Agents wait safely"; constitution principle 14 "Warthog writes the
// record", added as a method on the pipeline the earlier stories built).
//
// RED-first: `createAgentCallPipeline` exists (E07-S16/S17) but has NO
// `executeApprovedHold` method yet, so every test here throws a TypeError at the
// call site until the builder adds it. That absence IS the point of test-first; do
// NOT implement anything to make these pass — the builder adds the method to
// `pipeline.ts` afterwards, as the minimum code that turns these green.
//
// These tests pin BEHAVIOUR (what executeApprovedHold DOES for an approval in a
// given state: does it run the held tool? how many times? does it record the
// outcome? what does it return?), never the source text of any module — a later
// rename that preserves behaviour must not redden them. State is arranged through
// the ALREADY-BUILT, tested seams: a connection's grants (`upsertPermissions`), its
// owning person (`createUser` + a real `KeyWrapper`), the real rate limiter
// (`createRateLimiter`), the real redacting recorder (`createInMemoryRecorder`), the
// pipeline's own `handleAgentCall` ask path (to create the PENDING approval + the
// linked HELD request exactly as production does), and the approvals store's
// `decide` (to move the approval to approved / denied / expired). The tool executor
// is a spy, so "ran / did not run" and "exactly once" are observed directly.
//
// ---------------------------------------------------------------------------
// THE PINNED CONTRACT (chosen by the tester; the implementation conforms to it).
//
//   // A new method on the pipeline the factory returns. `userId` is the OWNING
//   // person — taken by the trusted CALLER from its session (the inbox approve
//   // action) or the resolved agent connection (check_approval), NEVER a client
//   // value — and every read/write inside is member-scoped by it. `approvalId`
//   // names the approval whose held call is to be run.
//   executeApprovedHold(userId: string, approvalId: string): Promise<ApprovedHoldResult>;
//
//   // A discriminated union on `status` (the repo idiom).
//   type ApprovedHoldResult =
//     | { status: "executed"; result: unknown }  // approved + still held → the held
//     |                                           //   tool ran exactly once; its result returned
//     | { status: "refused";  reason: string };  // not approved / already executed / expired →
//                                                 //   the tool is NOT run
//
// Behaviour (acceptance criteria):
//   - executeApprovedHold runs an APPROVED held call exactly once, records its
//     outcome as ONE Warthog activity entry (execute BEFORE record), marks the held
//     request executed, and returns the tool's result.
//   - A hold whose approval is still PENDING, DENIED or EXPIRED, or whose held
//     request has ALREADY been executed, is REFUSED and the tool is not run.
//   - (constitution: member scope + ownership) another person's id can never run
//     this person's hold; the held call is left untouched.
//   - (CLAUDE.md redaction hard rule / INV-103) the recorded outcome entry's
//     parameters pass through redaction: no secret-named field value and no card
//     number survive raw in the recorded entry.
//
// The `executeApprovedHold` method is reached through a structural VIEW
// (`holds(pipeline)`) so this file type-checks both before and after the builder
// adds the method; at runtime the method is absent until implemented, so the call
// throws and the test fails RED exactly as test-first requires.
//
// Every db handle is closed in a `finally`; each test uses its own `freshDb()` (an
// isolated in-memory PGlite with the real migrations), so tests share no state.
// Tests never touch the network or Azure.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

import { createAgentCallPipeline } from "./pipeline";
import { createRateLimiter } from "./rate-limit";
import { createInMemoryRecorder } from "../activity/recorder";
import { createUser } from "../db/users";
import { createAgent } from "../db/agents";
import { upsertPermissions } from "../db/agent-permissions";
import { decide, getApproval } from "../db/approvals";
import { getByApproval } from "../db/held-requests";
import { freshDb } from "../../test/db";
import { localAesKeyWrapper, type KeyWrapper } from "../crypto/key-wrapper";
import { fixedClock, type Clock } from "../seams/clock";
import type { Db } from "../db/index";

// --- shapes derived from the stores' own signatures, so a later type rename that
// preserves behaviour does not redden these tests. ---------------------------------
type Grants = Parameters<typeof upsertPermissions>[1];
type Pipeline = ReturnType<typeof createAgentCallPipeline>;
type HandleResult = Awaited<ReturnType<Pipeline["handleAgentCall"]>>;
type RecorderBase = ReturnType<typeof createInMemoryRecorder>;
type RecEntry = Awaited<ReturnType<RecorderBase["record"]>>;
type RecInput = Parameters<RecorderBase["record"]>[0];

// The method E07-S18 adds to the pipeline (the pinned contract above). Accessed
// through a structural view so the file type-checks before the method exists; at
// runtime it is absent until the builder adds it, so each test fails RED.
type ApprovedHoldResult =
  | { status: "executed"; result: unknown }
  | { status: "refused"; reason: string }
  | { status: "in_progress" };

interface ExecutesApprovedHolds {
  executeApprovedHold(userId: string, approvalId: string): Promise<ApprovedHoldResult>;
}

function holds(pipeline: Pipeline): ExecutesApprovedHolds {
  return pipeline as unknown as ExecutesApprovedHolds;
}

// --- fixtures ----------------------------------------------------------------------

const DEK_BYTES = 32; // a 256-bit per-person data key
const KEK_BYTES = 32; // the local AES-256 key-encryption key for the KeyWrapper seam

const CONN = "11111111-1111-1111-1111-111111111111";

// The frozen instant the pipeline reads time through. Mid-month noon UTC.
const NOW = new Date("2026-11-15T12:00:00.000Z");
// Well past the default 15-minute approval window — used only to drive `decide`'s
// expiry transition, never the pipeline itself.
const AFTER_EXPIRY = new Date(NOW.getTime() + 20 * 60_000);

// Compare the MOMENT, not the representation: a stored instant may come back as a
// Date or an ISO/epoch representation — either is reasonable and must not redden a test.
const toMs = (value: unknown): number => new Date(value as never).getTime();

function keyWrapperFor(): KeyWrapper {
  return localAesKeyWrapper(randomBytes(KEK_BYTES));
}

// Create a person whose wrapped DEK really unwraps under `keyWrapper`, returning
// their id and the DEK the approval detail / held args are encrypted under.
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

// A fully-populated grants record; a test overrides only what it is about. Built via
// a helper (a non-literal passed to upsertPermissions) so excess-property checks never bite.
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
  };
}

// The resolved connection the ask path acts for. Built as a variable (not a literal
// at the call site), so a superset of fields stays assignable to the pipeline's param type.
function connectionFor(
  userId: string,
  opts: { connectionId?: string; agentId?: string; active?: boolean } = {},
) {
  const connectionId = opts.connectionId ?? CONN;
  return { userId, connectionId, agentId: opts.agentId ?? connectionId, active: opts.active ?? true };
}

// A connector change the connection's "ask me first" setting holds — so
// `handleAgentCall` creates a PENDING approval + a linked HELD request, exactly as
// production does, and the held call is one Warthog RUNS on approval. A test overrides
// only what it is about.
function heldChangeCall(overrides: Record<string, unknown> = {}) {
  return {
    connector: "gmail" as string | null,
    tool: "send_email",
    makesChange: true,
    params: { note: "a box of widgets" },
    ...overrides,
  };
}

// A card request — the policy engine always reaches "ask" for one. Its approval is a
// RELEASE the agent collects with collect_release; Warthog never runs it as a tool.
function cardCall(overrides: Record<string, unknown> = {}) {
  return {
    connector: null as string | null,
    tool: "request_card",
    makesChange: true,
    request: "card" as const,
    amount: 42,
    currency: "AUD",
    merchant: "BoxCo",
    params: { note: "a box of widgets" },
    ...overrides,
  };
}

// A recorder that wraps the REAL in-memory recorder (so redaction and chaining
// really happen) and captures each stored (redacted) entry for assertions. Appends
// "record" to the order log when one is passed.
function spyRecorder(clock: Clock, order?: string[]) {
  const base = createInMemoryRecorder({ clock });
  const inputs: RecInput[] = [];
  const entries: RecEntry[] = [];
  const recorder = {
    async record(input: RecInput): Promise<RecEntry> {
      inputs.push(input);
      const entry = await base.record(input);
      if (order) order.push("record");
      entries.push(entry);
      return entry;
    },
  };
  return { recorder, inputs, entries };
}

// A tool executor spy: records every invocation (so "ran / did not run" and "exactly
// once" are observed) and returns a sentinel result. Appends "execute" to the order log.
function spyExecutor(order?: string[], result: unknown = { ran: "APPROVED-HOLD-RESULT" }) {
  const calls: { call: unknown; connection: unknown }[] = [];
  const fn = async (call: unknown, connection: unknown): Promise<unknown> => {
    calls.push({ call, connection });
    if (order) order.push("execute");
    return result;
  };
  return { fn, calls };
}

interface Seams {
  clock: Clock;
  rateLimiter: ReturnType<typeof createRateLimiter>;
  recorder: RecorderBase;
  executeTool: (call: never, connection: never) => Promise<unknown>;
}

function buildPipeline(db: Db, keyWrapper: KeyWrapper, seams: Seams): Pipeline {
  return createAgentCallPipeline({
    db,
    keyWrapper,
    clock: seams.clock,
    rateLimiter: seams.rateLimiter,
    recorder: seams.recorder,
    executeTool: seams.executeTool,
  });
}

// --- result narrowing helpers (assert.fail is `never`, so the result narrows after) ---

function expectExecuted(r: ApprovedHoldResult) {
  if (r.status !== "executed") assert.fail(`expected an executed hold, got "${r.status}": ${JSON.stringify(r)}`);
  return r;
}
function expectRefused(r: ApprovedHoldResult) {
  if (r.status !== "refused") assert.fail(`expected a refused hold, got "${r.status}": ${JSON.stringify(r)}`);
  return r;
}
function expectPending(r: HandleResult) {
  if (r.status !== "pending_approval") assert.fail(`expected a pending_approval, got "${r.status}": ${JSON.stringify(r)}`);
  return r;
}

// Arrange a person who can hold a card call, and drive the pipeline's OWN ask path to
// create a PENDING approval + linked HELD request (the exact production shape). Returns
// everything a test needs to then decide the approval and execute (or refuse) the hold.
// The agent is a REAL agents row whose row id differs from its connection id (the
// production two-id model: approvals and held requests are keyed by agents.id, tool
// permissions by the connection id) — so a hold run under the wrong id is caught.
async function arrangeHeldCall(
  db: Db,
  keyWrapper: KeyWrapper,
  who: string,
  opts: {
    order?: string[];
    execResult?: unknown;
    call?: Record<string, unknown>;
    makeCall?: (overrides: Record<string, unknown>) => Record<string, unknown>;
  } = {},
) {
  const { userId, dek } = await makePerson(db, who, keyWrapper);
  await upsertPermissions(
    db,
    baseGrants(userId, CONN, {
      cardAccess: true,
      highTierAccess: true,
      cardBudget: { amount: 500, currency: "AUD", period: "month" },
    }),
  );
  const agent = await createAgent(
    db,
    { userId, connectionId: CONN, displayName: "Claude", platform: "claude" },
    fixedClock(NOW),
  );
  assert.notEqual(agent.id, agent.connectionId, "the agent's row id is distinct from its connection id");

  const rec = spyRecorder(fixedClock(NOW), opts.order);
  const exec = spyExecutor(opts.order, opts.execResult);
  const pipeline = buildPipeline(db, keyWrapper, {
    clock: fixedClock(NOW),
    rateLimiter: createRateLimiter(fixedClock(NOW)),
    recorder: rec.recorder,
    executeTool: exec.fn,
  });

  const conn = connectionFor(userId, { agentId: agent.id });
  const makeCall = opts.makeCall ?? heldChangeCall;
  const held = expectPending(
    await pipeline.handleAgentCall(conn, makeCall(opts.call ?? {}) as Parameters<Pipeline["handleAgentCall"]>[1]),
  );

  return { userId, dek, pipeline, rec, exec, conn, agent, approvalId: held.approval_id };
}

// ===========================================================================
// AC1 — executeApprovedHold runs an APPROVED held call exactly once and records its
// outcome as an activity entry (execute BEFORE record), returning the tool's result.
// ===========================================================================

test("an approved hold runs the held tool exactly once, records ONE Warthog outcome entry, and returns the result", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const order: string[] = [];
    const { userId, dek, pipeline, rec, exec, conn, approvalId } = await arrangeHeldCall(
      db,
      keyWrapper,
      "run-once",
      { order },
    );

    // The person approves the held call from their inbox.
    await decide(db, { userId, id: approvalId, decision: { status: "approved" } }, dek, fixedClock(NOW));

    // One entry so far (the pipeline recorded the held call when it asked); `decide`
    // records nothing. Isolate the ordering of executeApprovedHold's own run.
    const beforeExec = rec.entries.length;
    order.length = 0;

    const result = expectExecuted(await holds(pipeline).executeApprovedHold(userId, approvalId));

    // The held tool ran exactly once, and its result is handed back.
    assert.equal(exec.calls.length, 1, "the approved held call runs the tool exactly once");
    assert.deepEqual(result.result, { ran: "APPROVED-HOLD-RESULT" }, "the tool's result is returned");

    // The tool received the held call Warthog parked on the ask (the args round-trip
    // under the person's own DEK), not something new.
    const ran = exec.calls[0]!.call as { tool?: string; params?: unknown };
    assert.equal(ran.tool, "send_email", "the executor is handed the held tool");
    assert.deepEqual(ran.params, { note: "a box of widgets" }, "the executor is handed the held call's params");

    // Warthog writes exactly ONE outcome entry for the run (it writes the record
    // itself), AFTER the tool ran.
    assert.equal(rec.entries.length, beforeExec + 1, "the run records exactly one new activity entry");
    assert.deepEqual(order, ["execute", "record"], "the tool runs, then the outcome is recorded");
    const entry = rec.entries[rec.entries.length - 1]!;
    assert.equal(entry.source, "warthog", "Warthog writes the record itself (not the agent)");
    assert.equal(entry.tool, "send_email", "the outcome entry names the held tool");
    assert.equal(entry.agentId, conn.agentId, "the outcome entry is attributed to the held call's agent");
    assert.ok((entry.outcome ?? "").length > 0, "the outcome entry carries an outcome");

    // The held request is consumed: marked executed (single-shot), so it cannot run again.
    const stored = await getByApproval(db, userId, approvalId, dek);
    assert.ok(stored, "the held request is still reachable from its approval");
    assert.equal(stored!.status, "executed", "the held request is marked executed");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC2 (exactly once) — a second executeApprovedHold on the same, already-executed
// hold is refused and does NOT run the tool again.
// ===========================================================================

test("a second executeApprovedHold on an already-executed hold hands back the SAME result and never runs the tool again", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const { userId, dek, pipeline, exec, approvalId } = await arrangeHeldCall(db, keyWrapper, "exactly-once");
    await decide(db, { userId, id: approvalId, decision: { status: "approved" } }, dek, fixedClock(NOW));

    const first = expectExecuted(await holds(pipeline).executeApprovedHold(userId, approvalId));
    assert.equal(exec.calls.length, 1, "the first run executes the tool once");

    // Review fix C2: the inbox runs the hold on approval and the agent asks later via
    // check_approval — it must get the call's result back, not "already run".
    const second = expectExecuted(await holds(pipeline).executeApprovedHold(userId, approvalId));
    assert.deepEqual(second.result, first.result, "the stored result is handed back however often it is asked for");
    assert.equal(exec.calls.length, 1, "the second attempt does NOT run the tool again — exactly once");

    // The held request stays executed — the second attempt changed nothing.
    const stored = await getByApproval(db, userId, approvalId, dek);
    assert.equal(stored!.status, "executed", "the held request is left executed, not re-run");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC2 — a hold whose approval is still PENDING is refused and the tool is not run.
// ===========================================================================

test("a still-pending approval is refused: the held tool is not run and the hold is left held", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const { userId, dek, pipeline, exec, approvalId } = await arrangeHeldCall(db, keyWrapper, "pending");
    // No decision made — the approval is still pending in the person's inbox.

    const result = expectRefused(await holds(pipeline).executeApprovedHold(userId, approvalId));
    assert.ok(result.reason.length > 0, "the refusal carries a plain reason");
    assert.equal(exec.calls.length, 0, "a pending hold never runs the tool");

    const approval = await getApproval(db, userId, approvalId, dek);
    assert.equal(approval!.status, "pending", "the approval is left pending");
    const stored = await getByApproval(db, userId, approvalId, dek);
    assert.equal(stored!.status, "held", "the held request is left waiting (held)");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC2 — a DENIED approval is refused and the tool is not run.
// ===========================================================================

test("a denied approval is refused: the held tool is not run and the hold is left held", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const { userId, dek, pipeline, exec, approvalId } = await arrangeHeldCall(db, keyWrapper, "denied");
    await decide(db, { userId, id: approvalId, decision: { status: "denied" } }, dek, fixedClock(NOW));

    const result = expectRefused(await holds(pipeline).executeApprovedHold(userId, approvalId));
    assert.ok(result.reason.length > 0, "the refusal carries a plain reason");
    assert.equal(exec.calls.length, 0, "a denied hold never runs the tool");

    const stored = await getByApproval(db, userId, approvalId, dek);
    assert.equal(stored!.status, "held", "the held request is left waiting (held), never executed");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC2 — an EXPIRED approval is refused and the tool is not run.
// ===========================================================================

test("an expired approval is refused: the held tool is not run and the hold is left held", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const { userId, dek, pipeline, exec, approvalId } = await arrangeHeldCall(db, keyWrapper, "expired");
    // The window passes before anyone decides → the approval expires.
    const expired = await decide(
      db,
      { userId, id: approvalId, decision: { status: "expired" } },
      dek,
      fixedClock(AFTER_EXPIRY),
    );
    assert.equal(expired.status, "expired", "the approval is now expired (precondition)");

    const result = expectRefused(await holds(pipeline).executeApprovedHold(userId, approvalId));
    assert.ok(result.reason.length > 0, "the refusal carries a plain reason");
    assert.equal(exec.calls.length, 0, "an expired hold never runs the tool");

    const stored = await getByApproval(db, userId, approvalId, dek);
    assert.equal(stored!.status, "held", "the held request is left waiting (held), never executed");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// Member scope / ownership (constitution: userId from the session; every member-
// scoped task has an ownership test) — another person can never run this person's
// approved hold. The member-scoped read finds no approval for the non-owner, so the
// attempt is REFUSED (reported, never a silent failure) and the owner's held call is
// left untouched.
// ===========================================================================

test("another person's id cannot run this person's approved hold: it is refused and the owner's hold is untouched", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const owner = await arrangeHeldCall(db, keyWrapper, "owner");
    await decide(
      db,
      { userId: owner.userId, id: owner.approvalId, decision: { status: "approved" } },
      owner.dek,
      fixedClock(NOW),
    );

    // A different person (with their own real wrapped DEK) tries to run it.
    const { userId: otherUserId } = await makePerson(db, "intruder", keyWrapper);

    const result = expectRefused(
      await holds(owner.pipeline).executeApprovedHold(otherUserId, owner.approvalId),
    );
    assert.ok(result.reason.length > 0, "the non-owner attempt is refused with a plain reason");
    assert.equal(owner.exec.calls.length, 0, "a non-owner never runs the held tool");

    // The owner's approved hold is left exactly as it was — still held, not executed.
    const stored = await getByApproval(db, owner.userId, owner.approvalId, owner.dek);
    assert.equal(stored!.status, "held", "the owner's held call is left untouched (still held)");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// SEC — the recorded outcome entry's parameters pass through redaction: no secret-
// named field value and no card number survive raw in the recorded entry (CLAUDE.md
// redaction hard rule; INV-103). Scoped to the ONE new outcome entry.
// ===========================================================================

test("the recorded outcome entry runs the held call's parameters through redaction: no raw secret or card number survives", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const SECRET = "sk-live-TOPSECRET-value-xyz";
    const PAN = "4242424242424242"; // a Luhn-valid 16-digit number

    const { userId, dek, pipeline, rec, approvalId } = await arrangeHeldCall(db, keyWrapper, "sec-redaction", {
      // `apiKey` is a secret FIELD NAME (redacted by key); the card number sits in a
      // free-text, non-secret field (redacted by the Luhn card rule).
      call: { params: { apiKey: SECRET, note: `charge ref ${PAN} now` } },
    });
    await decide(db, { userId, id: approvalId, decision: { status: "approved" } }, dek, fixedClock(NOW));

    const beforeExec = rec.entries.length;
    expectExecuted(await holds(pipeline).executeApprovedHold(userId, approvalId));

    assert.equal(rec.entries.length, beforeExec + 1, "the run records exactly one new outcome entry");
    const entry = rec.entries[rec.entries.length - 1]!;
    const recorded = JSON.stringify(entry);
    assert.ok(!recorded.includes(SECRET), "a secret-named field value must not appear raw in the recorded outcome entry");
    assert.ok(!recorded.includes(PAN), "a card number must not appear raw in the recorded outcome entry");
    assert.ok(recorded.includes("[redacted]"), "the secret-named field is replaced with [redacted]");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// Review fix C2 — an approved hold runs under its agent's REAL connection, never a
// made-up one, and its outcome reaches the agent.
//
// executeApprovedHold used to run the held call as `{ connectionId: agentId, agentId,
// active: true }`: agents.id is NOT the connection id, so every permission-checked
// tool body (remember, tasks, records) found no grants and refused, the activity log
// still said "executed", and the result was thrown away (a later check_approval got
// "already run"). It also forced `active: true`, so a disconnected agent's approved
// hold still ran, and it ran card/high-tier holds as tools (which have no body).
// ===========================================================================

test("the held call runs under the agent's real connection: its connection id, its agent id", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const { userId, dek, pipeline, exec, agent, approvalId } = await arrangeHeldCall(db, keyWrapper, "c2-real-conn");
    await decide(db, { userId, id: approvalId, decision: { status: "approved" } }, dek, fixedClock(NOW));

    expectExecuted(await holds(pipeline).executeApprovedHold(userId, approvalId));

    const ranUnder = exec.calls[0]!.connection as { userId: string; connectionId: string; agentId: string; active: boolean };
    assert.equal(ranUnder.connectionId, agent.connectionId, "the tool sees the connection id its grants are keyed by");
    assert.equal(ranUnder.agentId, agent.id, "the tool sees the agent's own row id");
    assert.equal(ranUnder.userId, userId, "the tool runs for the owning person");
  } finally {
    await db.close();
  }
});

test("an approved hold whose agent has since been disconnected is refused, never run, and left held", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const { userId, dek, pipeline, exec, rec, agent, approvalId } = await arrangeHeldCall(db, keyWrapper, "c2-disconnected");
    await decide(db, { userId, id: approvalId, decision: { status: "approved" } }, dek, fixedClock(NOW));
    await db.query("UPDATE agents SET status = 'disconnected' WHERE id = $1 AND user_id = $2", [agent.id, userId]);
    const before = rec.entries.length;

    const result = expectRefused(await holds(pipeline).executeApprovedHold(userId, approvalId));
    assert.match(result.reason, /no longer connected/i, "the refusal says the agent is no longer connected");
    assert.equal(exec.calls.length, 0, "a disconnected agent's held call never runs");
    assert.equal((await getByApproval(db, userId, approvalId, dek))!.status, "held", "the hold is left unclaimed");
    assert.equal(rec.entries.length, before, "nothing is recorded as executed");
  } finally {
    await db.close();
  }
});

test("an approved card or high-tier hold is refused before it is claimed: it is collected, never run as a tool", async () => {
  const highTierCall = (overrides: Record<string, unknown>) => ({
    connector: null,
    tool: "request_identity_detail",
    makesChange: false,
    request: "high_tier",
    ...overrides,
  });
  for (const [label, makeCall] of [
    ["card", cardCall],
    ["high-tier", highTierCall],
  ] as const) {
    const db = await freshDb();
    const keyWrapper = keyWrapperFor();
    try {
      const { userId, dek, pipeline, exec, approvalId } = await arrangeHeldCall(db, keyWrapper, `c2-release-${label}`, {
        makeCall: makeCall as (o: Record<string, unknown>) => Record<string, unknown>,
      });
      await decide(db, { userId, id: approvalId, decision: { status: "approved" } }, dek, fixedClock(NOW));

      const result = expectRefused(await holds(pipeline).executeApprovedHold(userId, approvalId));
      assert.match(result.reason, /collect_release/, `${label}: the refusal points at collect_release`);
      assert.equal(exec.calls.length, 0, `${label}: a release is never run as a tool`);
      assert.equal((await getByApproval(db, userId, approvalId, dek))!.status, "held", `${label}: the hold is never burned`);
    } finally {
      await db.close();
    }
  }
});

test("a tool body's refusal is recorded as refused, returned as a refusal, and handed back the same later", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const refusal = { status: "refused", reason: "This agent does not have permission to use memories." };
    const { userId, dek, pipeline, rec, exec, approvalId } = await arrangeHeldCall(db, keyWrapper, "c2-body-refusal", {
      execResult: refusal,
    });
    await decide(db, { userId, id: approvalId, decision: { status: "approved" } }, dek, fixedClock(NOW));

    const first = expectRefused(await holds(pipeline).executeApprovedHold(userId, approvalId));
    assert.equal(first.reason, refusal.reason, "the agent is handed the body's own plain reason");
    assert.equal(rec.entries[rec.entries.length - 1]!.outcome, "refused", "the activity log says refused, not executed");

    const again = expectRefused(await holds(pipeline).executeApprovedHold(userId, approvalId));
    assert.equal(again.reason, refusal.reason, "a later ask gets the same refusal, not 'already run'");
    assert.equal(exec.calls.length, 1, "the tool ran once");
  } finally {
    await db.close();
  }
});

test("two concurrent runs of one approved hold run the tool exactly once", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const { userId, dek, pipeline, exec, approvalId } = await arrangeHeldCall(db, keyWrapper, "c2-concurrent");
    await decide(db, { userId, id: approvalId, decision: { status: "approved" } }, dek, fixedClock(NOW));

    const results = await Promise.all([
      holds(pipeline).executeApprovedHold(userId, approvalId),
      holds(pipeline).executeApprovedHold(userId, approvalId),
    ]);

    assert.equal(exec.calls.length, 1, "the held tool runs exactly once");
    assert.ok(results.some((r) => r.status === "executed"), "one run hands back the result");
    for (const r of results) {
      assert.ok(r.status === "executed" || r.status === "in_progress", `never a refusal for an approved hold (got ${r.status})`);
    }
    const after = expectExecuted(await holds(pipeline).executeApprovedHold(userId, approvalId));
    assert.deepEqual(after.result, { ran: "APPROVED-HOLD-RESULT" }, "afterwards the stored result is handed back");
  } finally {
    await db.close();
  }
});

test("a held call whose tool threw keeps the failure, so a later ask is told it could not be completed", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const { userId, dek, approvalId } = await arrangeHeldCall(db, keyWrapper, "c2-throw");
    await decide(db, { userId, id: approvalId, decision: { status: "approved" } }, dek, fixedClock(NOW));

    // The same person's hold, run by a pipeline whose tool executor throws.
    let attempts = 0;
    const throwing = buildPipeline(db, keyWrapper, {
      clock: fixedClock(NOW),
      rateLimiter: createRateLimiter(fixedClock(NOW)),
      recorder: createInMemoryRecorder({ clock: fixedClock(NOW) }),
      executeTool: (async () => {
        attempts += 1;
        throw new Error("provider exploded");
      }) as never,
    });

    await assert.rejects(holds(throwing).executeApprovedHold(userId, approvalId), /provider exploded/, "the failure is never swallowed");
    const later = expectRefused(await holds(throwing).executeApprovedHold(userId, approvalId));
    assert.match(later.reason, /could not be completed/i, "a later ask is told the request could not be completed");
    assert.equal(attempts, 1, "the held call is never retried behind the person's back");
  } finally {
    await db.close();
  }
});
