// E07-S14 — the `check_approval` core tool (`src/server/mcp/tools/check-approval.ts`,
// design §6.2 MCP server "check_approval (wait_seconds ≤ 25, long-poll)";
// brief "Agents wait safely"). An agent that got `{status:"pending_approval",
// approval_id, …}` from a held call long-polls this tool to learn the outcome.
//
// RED-first: `./check-approval` does not exist yet, so importing
// `createCheckApprovalTool` throws and every test here fails until the builder writes
// the minimum code to pass. That absence IS the point of test-first; do NOT implement
// anything to make these pass — the builder writes `check-approval.ts` afterwards.
//
// These tests pin BEHAVIOUR (what the tool RETURNS for an approval in a given state,
// how long it waits, whether the held tool runs and how many times, and that it takes
// identity from the session connection), never the source text of any module — a
// later rename that preserves behaviour must not redden them. State is arranged
// through the ALREADY-BUILT, tested seams: a connection's grants
// (`upsertPermissions`), its owning person (`createUser` + a real `KeyWrapper`), the
// real rate limiter, the real redacting recorder, the pipeline's OWN `handleAgentCall`
// ask path (to create the PENDING approval + the linked HELD request exactly as
// production does), the approvals store's `decide` (to move the approval to approved /
// denied / expired / more_detail), and the pipeline's `executeApprovedHold` (how an
// approved held call's result reaches the agent). The tool executor is a spy, so
// "ran / did not run" and "exactly once" are observed directly, and TIME + WAITING are
// driven by an injected clock + a fake `sleep` that advances that clock, so the
// long-poll is fully deterministic (no real wall-clock delay).
//
// ---------------------------------------------------------------------------
// THE PINNED CONTRACT (chosen by the tester; the implementation conforms to it).
//
//   import { z } from "zod";
//   import type { AgentConnection } from "../context";
//   import type { Db } from "../../db/index";
//   import type { KeyWrapper } from "../../crypto/key-wrapper";
//   import type { Clock } from "../../seams/clock";
//
//   // What an approved held call hands back (the pipeline's ApprovedHoldResult shape).
//   type ApprovedHoldResult =
//     | { status: "executed"; result: unknown }
//     | { status: "refused";  reason: string };
//
//   // What check_approval returns to the waiting agent.
//   type CheckApprovalResult =
//     | { status: "pending";     approval_id: string }          // still pending after the wait
//     | { status: "executed";    result: unknown }              // approved → the held call's result
//     | { status: "refused";     reason: string }               // denied / expired / already-run / not yours
//     | { status: "more_detail"; approval_id: string; question: string }; // the person's question
//
//   interface CheckApprovalTool {
//     readonly name: string;           // "check_approval"
//     readonly inputSchema: z.ZodType; // a z.object(...) whose .shape carries a REQUIRED string
//                                       // `approval_id`, an OPTIONAL number `wait_seconds`, and the
//                                       // universal OPTIONAL string `reason` (design §6.2).
//     // Validate `input` (a bad / oversized / mis-shaped input THROWS HttpError 4xx
//     // BEFORE anything is read or run); then read the approval MEMBER-SCOPED by
//     // connection.userId AND owned by connection.agentId (another connection's id
//     // finds nothing → refused), and:
//     //   pending     → long-poll: re-read up to min(wait_seconds, 25) seconds (reading
//     //                 the clock, sleeping between reads via the injected `sleep`);
//     //                 return the first non-pending outcome, else `pending`.
//     //   approved    → run the held call via executeApprovedHold EXACTLY ONCE and
//     //                 return its result (a second call finds it already run → refused).
//     //   denied/expired → refused.
//     //   more_detail → return the person's question.
//     handle(input: unknown, connection: AgentConnection): Promise<CheckApprovalResult>;
//   }
//
//   interface CheckApprovalDeps {
//     readonly db: Db;
//     readonly keyWrapper: KeyWrapper;
//     readonly clock: Clock;
//     readonly sleep: (ms: number) => Promise<void>;
//     readonly executeApprovedHold: (userId: string, approvalId: string) => Promise<ApprovedHoldResult>;
//   }
//
//   function createCheckApprovalTool(deps: CheckApprovalDeps): CheckApprovalTool;
//
// The obligation acceptance criteria (4xx validation BEFORE any read/run, SQL-injection
// parameter binding, secrets-from-env) live in the sibling
// `check-approval.obligations.test.ts`.
//
// Every db handle is closed in a `finally`; each test uses its own `freshDb()` (an
// isolated in-memory PGlite with the real migrations), so tests share no state. Tests
// never touch the network or Azure.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

import { createCheckApprovalTool } from "./check-approval";
import { createAgentCallPipeline } from "../pipeline";
import { createRateLimiter } from "../rate-limit";
import { createInMemoryRecorder } from "../../activity/recorder";
import { createUser } from "../../db/users";
import { createAgent } from "../../db/agents";
import { upsertPermissions, type PermissionGrants } from "../../db/agent-permissions";
import { decide, getApproval, markReleased } from "../../db/approvals";
import { getByApproval } from "../../db/held-requests";
import { freshDb } from "../../../test/db";
import { localAesKeyWrapper, type KeyWrapper } from "../../crypto/key-wrapper";
import { fixedClock, type Clock } from "../../seams/clock";
import type { AgentConnection } from "../context";
import type { Db } from "../../db/index";

import { grantServices } from "../../../test/grants";
// --- fixtures ----------------------------------------------------------------------

const DEK_BYTES = 32; // a 256-bit per-person data key
const KEK_BYTES = 32; // the local AES-256 key-encryption key for the KeyWrapper seam

const CONN = "11111111-1111-1111-1111-111111111111";
const AGENT = CONN; // the connection's agent id == its connection id (E07-S09 shape)

// The frozen instant the pipeline (and the approval's createdAt / expiresAt) read time
// through. Mid-month noon UTC. The default 15-minute approval window ends at NOW+15m,
// well past the 25-second long-poll ceiling, so a pending approval never expires
// underneath the wait in these tests.
const NOW = new Date("2026-11-15T12:00:00.000Z");
// Well past the default 15-minute window — used only to drive `decide`'s expiry
// transition, never the tool itself.
const AFTER_EXPIRY = new Date(NOW.getTime() + 20 * 60_000);

// The long-poll ceiling (design §6.2 "wait_seconds ≤ 25").
const MAX_WAIT_MS = 25_000;

// The result shape the tool returns, kept LOOSE on purpose: the tests assert on
// `status` + the field that status carries, so the builder is free to pick the exact
// discriminated-union member types as long as the behaviour holds.
interface CheckResult {
  readonly status: string;
  readonly result?: unknown;
  readonly reason?: string;
  readonly question?: string;
  readonly approval_id?: string;
}

// The pipeline method shape check_approval is handed (its executeApprovedHold).
type ApprovedHoldResult =
  | { status: "executed"; result: unknown }
  | { status: "refused"; reason: string }
  | { status: "in_progress" };

function keyWrapperFor(): KeyWrapper {
  return localAesKeyWrapper(randomBytes(KEK_BYTES));
}

// Create a person whose wrapped DEK really unwraps under `keyWrapper`, returning their
// id and the DEK the approval detail / held args are encrypted under.
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

// A fully-populated grants record; a test overrides only what it is about. Built via a
// helper (a non-literal passed to upsertPermissions) so excess-property checks never bite.
function baseGrants(
  userId: string,
  connectionId: string,
  overrides: Partial<PermissionGrants> = {},
): PermissionGrants {
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

// The resolved connection the ask path (and check_approval) acts for. Built as a
// variable (not a literal at the call site), so a superset of fields stays assignable.
function connectionFor(
  userId: string,
  opts: { connectionId?: string; agentId?: string; active?: boolean } = {},
): AgentConnection {
  const connectionId = opts.connectionId ?? CONN;
  return { userId, connectionId, agentId: opts.agentId ?? connectionId, active: opts.active ?? true };
}

// A connector change the connection's "ask me first" setting holds — so
// `handleAgentCall` creates a PENDING approval + a linked HELD request, exactly as
// production does, and Warthog RUNS the held call once it is approved.
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

// A tool executor spy: records every invocation (so "ran / did not run" and "exactly
// once" are observed) and returns a sentinel result.
function spyExecutor(result: unknown = { ran: "APPROVED-HOLD-RESULT" }) {
  const calls: { call: unknown; connection: unknown }[] = [];
  const fn = async (call: unknown, connection: unknown): Promise<unknown> => {
    calls.push({ call, connection });
    return result;
  };
  return { fn, calls };
}

// A controllable clock + a fake `sleep` that advances it: the whole long-poll is driven
// by this, so no real time passes. `onTick(count)` runs after each sleep (so a test can
// decide the approval mid-wait). A hard cap turns a degenerate zero-interval poll loop
// into a clear failure instead of an infinite hang.
function sleeper(startMs: number, onTick?: (count: number) => void | Promise<void>) {
  let nowMs = startMs;
  const slept: number[] = [];
  const clock: Clock = { now: () => new Date(nowMs) };
  const sleep = async (ms: number): Promise<void> => {
    slept.push(ms);
    if (slept.length > 100_000) {
      throw new Error("check_approval slept >100000 times — the poll interval must be positive");
    }
    nowMs += ms;
    if (onTick) await onTick(slept.length);
  };
  return { clock, sleep, slept, elapsedMs: () => nowMs - startMs };
}

// Read a named sub-schema of the input's z.object `.shape` defensively (the schema
// exposes `.shape` at runtime). Returns undefined when absent, so a test asserts a
// HELPFUL failure rather than throwing.
function subschema(
  schema: unknown,
  field: string,
): { safeParse(v: unknown): { success: boolean } } | undefined {
  const shape = (schema as { shape?: Record<string, { safeParse(v: unknown): { success: boolean } }> } | null)
    ?.shape;
  return shape?.[field];
}

// Arrange a person who can hold a card call, drive the pipeline's OWN ask path to create
// a PENDING approval + linked HELD request (the exact production shape), and hand back
// everything a test needs: the owner's ids + dek, the approval id, the connection, the
// executor spy (to count held-tool runs), and the `executeApprovedHold` dep for the tool.
async function arrangeHeldCall(
  db: Db,
  keyWrapper: KeyWrapper,
  who: string,
  call: Record<string, unknown> = {},
  makeCall: (overrides: Record<string, unknown>) => Record<string, unknown> = heldChangeCall,
) {
  const { userId, dek } = await makePerson(db, who, keyWrapper);
  await grantServices(
    db,
    baseGrants(userId, CONN, {
      cardAccess: true,
      highTierAccess: true,
      cardBudget: { amount: 500, currency: "AUD", period: "month" },
    }),
  );
  // A REAL agent whose row id differs from its connection id (the production two-id model).
  const agent = await createAgent(
    db,
    { userId, connectionId: CONN, displayName: "Claude", platform: "claude" },
    fixedClock(NOW),
  );

  const recorder = createInMemoryRecorder({ clock: fixedClock(NOW) });
  const exec = spyExecutor();
  const pipeline = createAgentCallPipeline({
    db,
    keyWrapper,
    clock: fixedClock(NOW),
    rateLimiter: createRateLimiter(fixedClock(NOW)),
    recorder,
    executeTool: exec.fn,
  });

  const conn = connectionFor(userId, { agentId: agent.id });
  const held = await pipeline.handleAgentCall(conn, makeCall(call) as Parameters<typeof pipeline.handleAgentCall>[1]);
  if (held.status !== "pending_approval") {
    assert.fail(`arrange: expected a pending_approval, got "${held.status}"`);
  }

  const executeApprovedHold = (uid: string, approvalId: string): Promise<ApprovedHoldResult> =>
    pipeline.executeApprovedHold(uid, approvalId) as Promise<ApprovedHoldResult>;

  return { userId, dek, conn, approvalId: held.approval_id, exec, executeApprovedHold };
}

// Build the tool under test over the arranged owner, with the given clock + sleep.
function buildTool(
  db: Db,
  keyWrapper: KeyWrapper,
  arranged: { executeApprovedHold: (u: string, a: string) => Promise<ApprovedHoldResult> },
  clockAndSleep: { clock: Clock; sleep: (ms: number) => Promise<void> },
) {
  return createCheckApprovalTool({
    db,
    keyWrapper,
    clock: clockAndSleep.clock,
    sleep: clockAndSleep.sleep,
    executeApprovedHold: arranged.executeApprovedHold,
  });
}

// ===========================================================================
// AC "check_approval on a still-pending approval waits up to wait_seconds then returns
// pending." A pending (undecided) approval stays pending; the tool waits roughly the
// requested seconds (driven by the fake clock) and hands back `pending`.
// ===========================================================================

test("a still-pending approval waits up to wait_seconds, then returns pending", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const arranged = await arrangeHeldCall(db, keyWrapper, "pending-wait");

    const s = sleeper(NOW.getTime());
    const tool = buildTool(db, keyWrapper, arranged, s);
    const result = (await tool.handle(
      { approval_id: arranged.approvalId, wait_seconds: 5 },
      arranged.conn,
    )) as CheckResult;

    assert.equal(result.status, "pending", "an undecided approval comes back pending after the wait");
    assert.ok(
      s.elapsedMs() >= 5_000,
      `it waited at least the requested 5s before giving up (waited ${s.elapsedMs()}ms)`,
    );

    // The held tool never ran and the approval is left exactly as it was.
    assert.equal(arranged.exec.calls.length, 0, "a pending check never runs the held tool");
    const approval = await getApproval(db, arranged.userId, arranged.approvalId, arranged.dek);
    assert.equal(approval!.status, "pending", "the approval is left pending");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC "wait_seconds is clamped to a maximum of 25." A pending-forever approval with
// wait_seconds=1000 waits exactly as long as wait_seconds=25 (both clamp to the 25s
// ceiling) — and nowhere near the requested 1000s. The comparison is interval-
// independent: identical setups under the fake clock take the identical path.
// ===========================================================================

test("wait_seconds is clamped to a maximum of 25 seconds", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const arranged = await arrangeHeldCall(db, keyWrapper, "clamp");

    // A fresh sleeper per run, each starting at NOW; the approval stays pending.
    async function waitWith(waitSeconds: number): Promise<{ status: string; elapsed: number }> {
      const s = sleeper(NOW.getTime());
      const tool = buildTool(db, keyWrapper, arranged, s);
      const r = (await tool.handle(
        { approval_id: arranged.approvalId, wait_seconds: waitSeconds },
        arranged.conn,
      )) as CheckResult;
      return { status: r.status, elapsed: s.elapsedMs() };
    }

    const small = await waitWith(5);
    const atCeiling = await waitWith(25);
    const overCeiling = await waitWith(1000);

    for (const [label, r] of [["5s", small], ["25s", atCeiling], ["1000s", overCeiling]] as const) {
      assert.equal(r.status, "pending", `the ${label} wait returns pending (never decided)`);
    }

    // 1000s is clamped to the SAME ceiling as 25s …
    assert.equal(
      overCeiling.elapsed,
      atCeiling.elapsed,
      "wait_seconds=1000 waits exactly as long as wait_seconds=25 — both clamp to the ceiling",
    );
    // … and that ceiling is at least 25s and nowhere near the requested 1000s.
    assert.ok(atCeiling.elapsed >= MAX_WAIT_MS, `the 25s wait waits at least 25s (waited ${atCeiling.elapsed}ms)`);
    assert.ok(
      overCeiling.elapsed < 1000 * 1000,
      `wait_seconds=1000 did NOT wait the full 1000s — it was clamped (waited ${overCeiling.elapsed}ms)`,
    );
    // A smaller request waits no longer than the ceiling.
    assert.ok(small.elapsed <= atCeiling.elapsed, "a 5s wait is no longer than a 25s wait");
    assert.ok(small.elapsed >= 5_000, "a 5s wait waits at least 5s");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC "On an approved held call it returns the executed result exactly once." An
// approved approval runs the held call once and returns its result; a second
// check_approval finds it already run and is refused — the tool never runs twice.
// ===========================================================================

test("an approved held call returns the executed result exactly once", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const arranged = await arrangeHeldCall(db, keyWrapper, "approved-once");
    await decide(
      db,
      { userId: arranged.userId, id: arranged.approvalId, decision: { status: "approved" } },
      arranged.dek,
      fixedClock(NOW),
    );

    // Already approved → returns immediately (no wait) with the held call's result.
    const s1 = sleeper(NOW.getTime());
    const first = (await buildTool(db, keyWrapper, arranged, s1).handle(
      { approval_id: arranged.approvalId, wait_seconds: 25 },
      arranged.conn,
    )) as CheckResult;

    assert.equal(first.status, "executed", "an approved hold comes back executed");
    assert.deepEqual(first.result, { ran: "APPROVED-HOLD-RESULT" }, "the held call's result is returned");
    assert.equal(arranged.exec.calls.length, 1, "the held tool ran exactly once");
    assert.equal(s1.slept.length, 0, "an already-decided approval returns immediately, without waiting");

    // A second check finds the hold already run → it hands back the SAME result (review
    // fix C2: the agent always gets the outcome back), and the tool is NOT re-run.
    const s2 = sleeper(NOW.getTime());
    const second = (await buildTool(db, keyWrapper, arranged, s2).handle(
      { approval_id: arranged.approvalId, wait_seconds: 25 },
      arranged.conn,
    )) as CheckResult;

    assert.equal(second.status, "executed", "a second check on an already-run hold hands back its outcome");
    assert.deepEqual(second.result, first.result, "the same result, however often the agent asks");
    assert.equal(arranged.exec.calls.length, 1, "the held tool is NOT run again — exactly once");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// Long-poll: a decision that ARRIVES during the wait is picked up (the tool re-reads
// the approval after sleeping, rather than reading once and returning pending). The
// approval is approved during the first poll sleep; the tool then runs the held call.
// ===========================================================================

test("a decision arriving during the wait is picked up and the held result returned", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const arranged = await arrangeHeldCall(db, keyWrapper, "mid-wait");

    // Approve the hold right after the FIRST poll sleep — i.e. while the agent is waiting.
    const s = sleeper(NOW.getTime(), async (count) => {
      if (count === 1) {
        await decide(
          db,
          { userId: arranged.userId, id: arranged.approvalId, decision: { status: "approved" } },
          arranged.dek,
          fixedClock(NOW),
        );
      }
    });
    const result = (await buildTool(db, keyWrapper, arranged, s).handle(
      { approval_id: arranged.approvalId, wait_seconds: 25 },
      arranged.conn,
    )) as CheckResult;

    assert.ok(s.slept.length >= 1, "the tool waited (slept at least once) before the decision arrived");
    assert.equal(result.status, "executed", "the mid-wait approval is detected and executed");
    assert.deepEqual(result.result, { ran: "APPROVED-HOLD-RESULT" }, "the held call's result is returned");
    assert.equal(arranged.exec.calls.length, 1, "the held tool ran exactly once");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC "on denied … it returns a refusal." The held tool is not run.
// ===========================================================================

test("a denied approval returns a refusal and never runs the held tool", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const arranged = await arrangeHeldCall(db, keyWrapper, "denied");
    await decide(
      db,
      { userId: arranged.userId, id: arranged.approvalId, decision: { status: "denied" } },
      arranged.dek,
      fixedClock(NOW),
    );

    const s = sleeper(NOW.getTime());
    const result = (await buildTool(db, keyWrapper, arranged, s).handle(
      { approval_id: arranged.approvalId, wait_seconds: 25 },
      arranged.conn,
    )) as CheckResult;

    assert.equal(result.status, "refused", "a denied approval comes back refused");
    assert.ok((result.reason ?? "").length > 0, "the refusal carries a plain reason");
    assert.equal(arranged.exec.calls.length, 0, "a denied hold never runs the tool");
    assert.equal(s.slept.length, 0, "a decided (denied) approval returns immediately, without waiting");

    const held = await getByApproval(db, arranged.userId, arranged.approvalId, arranged.dek);
    assert.equal(held!.status, "held", "the held request is left waiting (held), never executed");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC "on … expired it returns a refusal." The held tool is not run.
// ===========================================================================

test("an expired approval returns a refusal and never runs the held tool", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const arranged = await arrangeHeldCall(db, keyWrapper, "expired");
    // The window passes before anyone decides → the approval expires.
    const expired = await decide(
      db,
      { userId: arranged.userId, id: arranged.approvalId, decision: { status: "expired" } },
      arranged.dek,
      fixedClock(AFTER_EXPIRY),
    );
    assert.equal(expired.status, "expired", "the approval is now expired (precondition)");

    const s = sleeper(NOW.getTime());
    const result = (await buildTool(db, keyWrapper, arranged, s).handle(
      { approval_id: arranged.approvalId, wait_seconds: 25 },
      arranged.conn,
    )) as CheckResult;

    assert.equal(result.status, "refused", "an expired approval comes back refused");
    assert.ok((result.reason ?? "").length > 0, "the refusal carries a plain reason");
    assert.equal(arranged.exec.calls.length, 0, "an expired hold never runs the tool");

    const held = await getByApproval(db, arranged.userId, arranged.approvalId, arranged.dek);
    assert.equal(held!.status, "held", "the held request is left waiting (held), never executed");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC "on more_detail it returns the question." The person asked the agent a question;
// check_approval hands that question back. The held tool is not run.
// ===========================================================================

test("a more_detail approval returns the person's question and never runs the held tool", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const arranged = await arrangeHeldCall(db, keyWrapper, "more-detail");
    const QUESTION = "Which card should I use for this one?";
    await decide(
      db,
      {
        userId: arranged.userId,
        id: arranged.approvalId,
        decision: { status: "more_detail", question: QUESTION },
      },
      arranged.dek,
      fixedClock(NOW),
    );

    const s = sleeper(NOW.getTime());
    const result = (await buildTool(db, keyWrapper, arranged, s).handle(
      { approval_id: arranged.approvalId, wait_seconds: 25 },
      arranged.conn,
    )) as CheckResult;

    assert.equal(result.status, "more_detail", "a more_detail approval comes back as more_detail");
    assert.equal(result.question, QUESTION, "the person's question is handed back to the agent");
    assert.equal(arranged.exec.calls.length, 0, "a more_detail approval never runs the held tool");

    const held = await getByApproval(db, arranged.userId, arranged.approvalId, arranged.dek);
    assert.equal(held!.status, "held", "the held request is left waiting (held)");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC "An agent cannot read another connection's approval by id." A DIFFERENT CONNECTION
// of the SAME person (another agent id) is refused — proving the read is scoped to the
// connection, not merely the person. The held tool is never run and the owner's hold is
// untouched, even though it is approved.
// ===========================================================================

test("another connection of the same person cannot read this connection's approval by id", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const owner = await arrangeHeldCall(db, keyWrapper, "owner-conn");
    await decide(
      db,
      { userId: owner.userId, id: owner.approvalId, decision: { status: "approved" } },
      owner.dek,
      fixedClock(NOW),
    );

    // The SAME person, a DIFFERENT connection (different agent id).
    const otherConn = connectionFor(owner.userId, {
      connectionId: "22222222-2222-2222-2222-222222222222",
      agentId: "agent-OTHER",
    });

    const s = sleeper(NOW.getTime());
    const result = (await buildTool(db, keyWrapper, owner, s).handle(
      { approval_id: owner.approvalId, wait_seconds: 25 },
      otherConn,
    )) as CheckResult;

    assert.equal(result.status, "refused", "another connection cannot read the approval — it is refused");
    assert.equal(result.result, undefined, "the held call's result does not leak to another connection");
    assert.equal(result.question, undefined, "no detail leaks to another connection");
    assert.equal(owner.exec.calls.length, 0, "another connection never runs the owner's held tool");

    const held = await getByApproval(db, owner.userId, owner.approvalId, owner.dek);
    assert.equal(held!.status, "held", "the owner's held call is left untouched (still held)");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// Member scope — another PERSON can never read this person's approval by id (the member-
// scoped read finds nothing for the non-owner). Refused; the held tool is never run.
// ===========================================================================

test("another person cannot read this person's approval by id", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const owner = await arrangeHeldCall(db, keyWrapper, "owner-person");
    await decide(
      db,
      { userId: owner.userId, id: owner.approvalId, decision: { status: "approved" } },
      owner.dek,
      fixedClock(NOW),
    );

    // A different person (with their own real wrapped DEK) tries to read it.
    const { userId: intruderId } = await makePerson(db, "intruder", keyWrapper);
    const intruderConn = connectionFor(intruderId, { connectionId: owner.approvalId });

    const s = sleeper(NOW.getTime());
    const result = (await buildTool(db, keyWrapper, owner, s).handle(
      { approval_id: owner.approvalId, wait_seconds: 25 },
      intruderConn,
    )) as CheckResult;

    assert.equal(result.status, "refused", "another person cannot read the approval — it is refused");
    assert.equal(result.result, undefined, "the held call's result does not leak to another person");
    assert.equal(owner.exec.calls.length, 0, "another person never runs the owner's held tool");

    const held = await getByApproval(db, owner.userId, owner.approvalId, owner.dek);
    assert.equal(held!.status, "held", "the owner's held call is left untouched (still held)");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// The tool names itself and carries its input envelope: a REQUIRED string `approval_id`,
// an OPTIONAL number `wait_seconds`, and the universal OPTIONAL string `reason`
// (design §6.2 "every tool takes an optional reason").
// ===========================================================================

test("the check_approval tool is named and exposes approval_id, wait_seconds and reason in its schema", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const arranged = await arrangeHeldCall(db, keyWrapper, "schema");
    const s = sleeper(NOW.getTime());
    const tool = buildTool(db, keyWrapper, arranged, s);

    assert.equal(tool.name, "check_approval", "the tool names itself check_approval");

    const approvalId = subschema(tool.inputSchema, "approval_id");
    assert.ok(approvalId, "the input schema exposes an `approval_id` field");
    assert.equal(approvalId!.safeParse("appr-123").success, true, "`approval_id` accepts a string");
    assert.equal(approvalId!.safeParse(undefined).success, false, "`approval_id` is REQUIRED");
    assert.equal(approvalId!.safeParse(999).success, false, "`approval_id` rejects a non-string");

    const waitSeconds = subschema(tool.inputSchema, "wait_seconds");
    assert.ok(waitSeconds, "the input schema exposes a `wait_seconds` field");
    assert.equal(waitSeconds!.safeParse(undefined).success, true, "`wait_seconds` is OPTIONAL");
    assert.equal(waitSeconds!.safeParse(10).success, true, "`wait_seconds` accepts a number");
    assert.equal(waitSeconds!.safeParse("ten").success, false, "`wait_seconds` rejects a non-number");

    const reason = subschema(tool.inputSchema, "reason");
    assert.ok(reason, "the input schema exposes a `reason` field");
    assert.equal(reason!.safeParse(undefined).success, true, "`reason` is OPTIONAL");
    assert.equal(reason!.safeParse("a short note").success, true, "`reason` accepts a string");
    assert.equal(reason!.safeParse(12345).success, false, "`reason` rejects a non-string");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// Review fix C2 — check_approval on an approved RELEASE (card / high-tier) used to call
// executeApprovedHold, which ran "request_card" as a tool (no body → an error to the
// agent) and burned the hold. A release is collected, so the agent is told exactly that.
// ===========================================================================

test("an approved card or high-tier release tells the agent to collect it, and never runs anything", async () => {
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
      const arranged = await arrangeHeldCall(db, keyWrapper, `release-${label}`, {}, makeCall as never);
      await decide(
        db,
        { userId: arranged.userId, id: arranged.approvalId, decision: { status: "approved" } },
        arranged.dek,
        fixedClock(NOW),
      );
      let holdRuns = 0;
      const tool = createCheckApprovalTool({
        db,
        keyWrapper,
        ...sleeper(NOW.getTime()),
        executeApprovedHold: async () => {
          holdRuns += 1;
          throw new Error("a release must never reach executeApprovedHold");
        },
      });

      const result = (await tool.handle({ approval_id: arranged.approvalId, wait_seconds: 0 }, arranged.conn)) as CheckResult & {
        next?: string;
      };
      assert.equal(result.status, "approved", `${label}: the agent is told the release was approved`);
      assert.equal(result.next, "collect_release", `${label}: and to collect it with collect_release`);
      assert.equal(result.approval_id, arranged.approvalId, `${label}: naming the approval`);
      assert.equal(holdRuns, 0, `${label}: nothing is run`);
      assert.equal(arranged.exec.calls.length, 0, `${label}: no tool body runs`);
      const held = await getByApproval(db, arranged.userId, arranged.approvalId, arranged.dek);
      assert.equal(held!.status, "held", `${label}: the release's hold is never burned`);
    } finally {
      await db.close();
    }
  }
});

// ===========================================================================
// Review fix C5 — a pending approval past its window is reported expired at once (and
// stored expired), not "pending" until the minute sweep happens to run.
// ===========================================================================

test("a pending approval past its window is refused as expired at once, and stored expired", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const arranged = await arrangeHeldCall(db, keyWrapper, "c5-overdue");
    // No sweep has run; the agent checks 20 minutes later.
    const s = sleeper(AFTER_EXPIRY.getTime());
    const result = (await buildTool(db, keyWrapper, arranged, s).handle(
      { approval_id: arranged.approvalId, wait_seconds: 25 },
      arranged.conn,
    )) as CheckResult;

    assert.equal(result.status, "refused", "the overdue request is refused");
    assert.match(result.reason ?? "", /expired/i, "the refusal says it expired");
    assert.equal(s.slept.length, 0, "the agent is answered at once, without waiting");
    assert.equal(arranged.exec.calls.length, 0, "the held tool never runs");
    const approval = await getApproval(db, arranged.userId, arranged.approvalId, arranged.dek);
    assert.equal(approval!.status, "expired", "the approval is stored expired");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// Review fix C2 — while another caller (the inbox approval) is still running the held
// call, check_approval keeps the agent waiting rather than reporting a refusal.
// ===========================================================================

test("a hold another caller is still running keeps the agent waiting, then returns pending", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const arranged = await arrangeHeldCall(db, keyWrapper, "c2-in-progress");
    await decide(
      db,
      { userId: arranged.userId, id: arranged.approvalId, decision: { status: "approved" } },
      arranged.dek,
      fixedClock(NOW),
    );
    const s = sleeper(NOW.getTime());
    const tool = createCheckApprovalTool({
      db,
      keyWrapper,
      clock: s.clock,
      sleep: s.sleep,
      executeApprovedHold: async () => ({ status: "in_progress" }) as ApprovedHoldResult,
    });

    const result = (await tool.handle({ approval_id: arranged.approvalId, wait_seconds: 3 }, arranged.conn)) as CheckResult;
    assert.equal(result.status, "pending", "the agent is told to keep waiting, not refused");
    assert.ok(s.slept.length >= 1, "the tool kept polling while the run was in progress");
  } finally {
    await db.close();
  }
});

test("once the person's device has handed the value over, the agent is told it was released", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const arranged = await arrangeHeldCall(db, keyWrapper, "released-card", {}, cardCall as never);
    await decide(
      db,
      { userId: arranged.userId, id: arranged.approvalId, decision: { status: "approved" } },
      arranged.dek,
      fixedClock(NOW),
    );
    assert.equal(await markReleased(db, { userId: arranged.userId, id: arranged.approvalId }, fixedClock(NOW)), true);

    const result = (await buildTool(db, keyWrapper, arranged, sleeper(NOW.getTime())).handle(
      { approval_id: arranged.approvalId, wait_seconds: 0 },
      arranged.conn,
    )) as CheckResult & { next?: string };
    assert.equal(result.status, "released", "the agent is told the value has been handed over");
    assert.equal(result.next, "collect_release", "and to collect it now");
  } finally {
    await db.close();
  }
});
