// E12-S10 — Approval decision actions (`src/app/(portal)/(protected)/inbox/actions.ts`).
//
// RED-first: the inbox-decision seam does not exist yet (the inbox dir holds only a
// placeholder `page.tsx`), so importing `./actions` throws and every test here fails
// until the builder adds it. That absence IS the point of test-first — do NOT implement
// anything to make these pass. The builder adds `actions.ts` afterwards as the minimum
// code that turns these green.
//
// These tests pin BEHAVIOUR (what each decision CHANGES in the database, what it RUNS,
// and what it REFUSES) against an isolated in-memory PGlite with the REAL migrations
// (src/test/db) and the REAL sibling seams: the approvals store (`decide`/`getApproval`),
// the held-requests store, the pipeline's own ask path + `executeApprovedHold`, the
// session + step-up seams, a real `KeyWrapper`, and the validation boundary. No test
// asserts on the source text of any module, so a later behaviour-preserving refactor (a
// rename, a moved import) stays green.
//
// Why a sibling `actions.ts` factory (not `page.tsx`): a Next `page.tsx` entry file may
// export ONLY its framework fields, so it cannot carry an injectable, unit-testable seam
// without breaking `next build`. The thin protected-page loader renders the inbox; the
// testable decision logic lives in the plain sibling `actions.ts` (the convention's
// `createXActions(deps)` factory, here `createInboxActions(deps)` — the same shape as the
// already-built security-settings actions). These tests drive the factory directly with
// real seams; the page wires thin server-action wrappers over it.
//
// ─── The contract this task defines (the builder implements exactly this) ─────────────
//
//   createInboxActions(deps): {
//     approveApproval(session, approvalId):              Promise<{ ok:true } | { ok:false; reason }>
//     denyApproval(session, approvalId):                 Promise<{ ok:true } | { ok:false; reason }>
//     askForMoreDetail(session, approvalId, question):   Promise<{ ok:true } | { ok:false; reason }>
//   }
//
//   deps: { db: Db; clock: Clock; keyWrapper: KeyWrapper;
//           executeApprovedHold: (userId, approvalId) => Promise<ApprovedHoldResult> }
//
//   • Every method takes the person's VERIFIED Session and derives the acting user id
//     from `session.userId` — never from a client-supplied value (CLAUDE.md member
//     scope). So a user can never decide another user's approval by id.
//   • approveApproval moves the approval to `approved`; for a held NON-release call it
//     then triggers that call's single execution via the pipeline's `executeApprovedHold`
//     (so an approved held call runs exactly once). denyApproval moves it to `denied`;
//     askForMoreDetail moves it to `more_detail`, recording the person's question.
//   • Each decision marks the approval `opened` (the inbox view write, member-scoped).
//   • Approving a HIGH-TIER or CARD release is a sensitive hand-over: it requires a fresh
//     step-up (within the last 5 minutes). Without one the action is refused with a plain
//     reason, the approval is NOT approved, and nothing is handed over. A release is NEVER
//     run through the pipeline (the agent collects it via `collect_release`); only a held
//     non-release call is executed on approval.
//
// ─── Obligations (this task's cross-cutting invariants, as behaviour) ─────────────────
//   [obligation:validate-and-parameterize-input] (INV-102) — a mis-shaped approval id is
//     rejected at the validation boundary with a 4xx `HttpError` (never cast at
//     `WHERE id = $1`, never a 500); an oversized/empty question is rejected with a 4xx;
//     and a SQL-injection probe in an input field travels as a BOUND value and cannot
//     alter a query.
//   [obligation:secrets-from-env] (INV-103) — the actions run purely from their injected
//     seams and read no `process.env`, so a decoy env secret never lands in a result or in
//     stored approval content.
//
// NOTE on the acceptance-criteria wording "an approval id that is not a positive integer":
// that is the obligation's GENERIC template phrasing. In THIS codebase the approvals table
// keys on a `uuid` (`db/migrations/0011_approvals.sql`: `id uuid PRIMARY KEY DEFAULT
// gen_random_uuid()`), and the sibling security actions already validate ids as `z.uuid()`.
// So the real boundary shape here is a well-formed UUID, and these tests pin exactly that:
// a value that is not a well-formed UUID is rejected with a 4xx — the same OBS-049 defence
// the "positive integer" phrasing is a stand-in for. (Noted for the build.)
//
// Every db handle is closed in a `finally`; each test uses its own `freshDb()`, so tests
// share no state. Tests never touch the network or Azure.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

import { createInboxActions } from "./actions";

import { createSession, recordStepUp, type Session } from "../../../../server/auth/session";
import { createAgentCallPipeline } from "../../../../server/mcp/pipeline";
import { createRateLimiter } from "../../../../server/mcp/rate-limit";
import { createInMemoryRecorder } from "../../../../server/activity/recorder";
import { createUser } from "../../../../server/db/users";
import { createAgent } from "../../../../server/db/agents";
import { createConnection } from "../../../../server/db/connections";
import { upsertPermissions } from "../../../../server/db/agent-permissions";
import { adoptStandIn, grantServices } from "../../../../test/grants";
import { createCheckApprovalTool } from "../../../../server/mcp/tools/check-approval";
import { readActivity } from "../../../../server/activity/writer";
import { createRule } from "../../../../server/db/rules";
import { saveHighTierField } from "../../../../server/db/high-tier-fields";
import { getApproval } from "../../../../server/db/approvals";
import { getByApproval } from "../../../../server/db/held-requests";
import { HttpError } from "../../../../server/http/validate";
import { localAesKeyWrapper, type KeyWrapper } from "../../../../server/crypto/key-wrapper";
import { fixedClock, type Clock } from "../../../../server/seams/clock";
import { systemRandom } from "../../../../server/seams/random";
import { freshDb } from "../../../../test/db";
import type { Db, QueryResult } from "../../../../server/db/index";

// --- shapes derived from the collaborators' own signatures, so a later type rename that
// preserves behaviour does not redden these tests. --------------------------------------
type Grants = Parameters<typeof upsertPermissions>[1];
type Pipeline = ReturnType<typeof createAgentCallPipeline>;
type AgentCallArg = Parameters<Pipeline["handleAgentCall"]>[1];
type HandleResult = Awaited<ReturnType<Pipeline["handleAgentCall"]>>;
type ExecuteApprovedHold = Pipeline["executeApprovedHold"];

type InboxActions = ReturnType<typeof createInboxActions>;
type ActionResult = Awaited<ReturnType<InboxActions["approveApproval"]>>;

// --- fixtures --------------------------------------------------------------------------

const DEK_BYTES = 32; // a 256-bit per-person data key
const KEK_BYTES = 32; // the local AES-256 key-encryption key for the KeyWrapper seam

const CONN = "11111111-1111-1111-1111-111111111111";

// The frozen instant the pipeline and the actions read time through. Mid-month noon UTC.
const NOW = new Date("2026-11-15T12:00:00.000Z");
// A step-up recorded here is 10 minutes old at NOW — comfortably OUTSIDE the 5-minute
// freshness window, so it must NOT satisfy the sensitive-release gate.
const STALE_STEP_UP = new Date(NOW.getTime() - 10 * 60_000);

function keyWrapperFor(): KeyWrapper {
  return localAesKeyWrapper(randomBytes(KEK_BYTES));
}

// Create a person whose wrapped DEK really unwraps under `keyWrapper`, returning their id
// and the DEK the approval detail / held args are encrypted under (same resolution path
// the pipeline and the actions use: getUserById + keyWrapper.unwrap).
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

// The resolved connection of a REAL agent: its row id (agents.id — what approvals and
// held requests are keyed by) is distinct from its connection id (what tool grants are
// keyed by), exactly as in production.
function connectionFor(userId: string, agentId: string) {
  return { userId, connectionId: CONN, agentId, active: true };
}

// The three held-call shapes, each of which the policy engine routes to "ask" (so the
// pipeline HOLDS it and creates a PENDING approval + a linked HELD request, the exact
// production shape). A test overrides only what it is about.
//
//   • a NON-release change call (a connector tool with the connector's changes set to
//     "ask me first") — no `request`, so detail.request is undefined → executed on approval.
function nonReleaseCall(overrides: Record<string, unknown> = {}): AgentCallArg {
  return {
    connector: "gmail",
    tool: "send_email",
    makesChange: true,
    params: { to: "finance@example.com", body: "the monthly report" },
    ...overrides,
  } as AgentCallArg;
}
//   • a CARD release — detail.request === "card" → a sensitive hand-over (step-up), not run.
function cardCall(overrides: Record<string, unknown> = {}): AgentCallArg {
  return {
    connector: null,
    tool: "request_card",
    makesChange: true,
    request: "card",
    amount: 42,
    currency: "AUD",
    merchant: "BoxCo",
    params: { note: "a box of widgets" },
    ...overrides,
  } as AgentCallArg;
}
//   • a HIGH-TIER release — detail.request === "high_tier" → a sensitive hand-over, not run.
function highTierCall(overrides: Record<string, unknown> = {}): AgentCallArg {
  return {
    connector: null,
    tool: "reveal_passport",
    makesChange: false,
    request: "high_tier",
    params: { field: "passport" },
    ...overrides,
  } as AgentCallArg;
}

// A tool executor spy: records every invocation (so "ran / did not run" and "exactly once"
// are observed) and returns a sentinel result.
function spyExecutor(result: unknown = { ran: "INBOX-APPROVED-RESULT" }) {
  const calls: { call: unknown; connection: unknown }[] = [];
  const fn = async (call: unknown, connection: unknown): Promise<unknown> => {
    calls.push({ call, connection });
    return result;
  };
  return { fn, calls };
}

// Wrap the REAL pipeline's executeApprovedHold so the actions' use of it is observed
// (how many times, with which userId/approvalId) while still running the real thing — so
// "an approved held call runs exactly once" is proven end-to-end, not mocked away.
function wrapExecuteApprovedHold(pipeline: Pipeline) {
  const calls: { userId: string; approvalId: string }[] = [];
  const fn: ExecuteApprovedHold = async (userId, approvalId) => {
    calls.push({ userId, approvalId });
    return pipeline.executeApprovedHold(userId, approvalId);
  };
  return { fn, calls };
}

// Narrowers (assert.fail is `never`, so the result narrows after).
function expectPending(r: HandleResult) {
  if (r.status !== "pending_approval") {
    assert.fail(`expected a pending_approval, got "${r.status}": ${JSON.stringify(r)}`);
  }
  return r;
}
function expectOk(r: ActionResult, label: string) {
  if (!r.ok) assert.fail(`${label}: expected success, got refusal "${r.reason}"`);
  return r;
}
function expectRefused(r: ActionResult, label: string) {
  if (r.ok) assert.fail(`${label}: expected a refusal, got success`);
  assert.ok(r.reason.length > 0, `${label}: the refusal carries a plain reason`);
  return r;
}

// Assert that awaiting `fn()` rejects with a 4xx HttpError (the validation boundary).
async function assertRejects4xx(label: string, fn: () => Promise<unknown>): Promise<void> {
  let threw = false;
  try {
    await fn();
  } catch (err) {
    threw = true;
    assert.ok(
      err instanceof HttpError,
      `${label}: must be rejected at the validation boundary (HttpError), got ${String(err)}`,
    );
    assert.ok(
      err.status >= 400 && err.status < 500,
      `${label}: the rejection must carry a 4xx status, got ${err.status}`,
    );
  }
  assert.ok(threw, `${label}: must be rejected (nothing was thrown)`);
}

// A fresh (never stepped up) session for `userId` — steppedUpAt is null.
async function freshSession(db: Db, userId: string): Promise<Session> {
  return (await createSession(db, userId, { clock: fixedClock(NOW), random: systemRandom })).session;
}
// A session carrying a step-up recorded at `at` (read later against the NOW clock).
async function sessionWithStepUpAt(db: Db, userId: string, at: Date): Promise<Session> {
  const c = fixedClock(at);
  const created = await createSession(db, userId, { clock: c, random: systemRandom });
  return recordStepUp(db, created.session.id, { clock: c });
}

// The `opened_at` stamp on an approval, member-scoped — a direct probe so the "marked
// opened" claim is checked at the row level, independent of any read path.
async function openedAt(db: Db, userId: string, id: string): Promise<Date | null> {
  const r = await db.query("SELECT opened_at FROM approvals WHERE id = $1 AND user_id = $2", [id, userId]);
  const value = r.rows[0]?.opened_at;
  return value == null ? null : new Date(value as string | number | Date);
}

// Arrange a held call the production way: create the person + grants, drive the pipeline's
// OWN ask path (so the PENDING approval + the linked HELD request exist in the exact
// production shape, with detail.request set by the call), and return everything a test
// needs to then decide it. The inbox actions are built over the same db/clock/keyWrapper,
// with the (wrapped, real) executeApprovedHold as their pipeline seam.
async function arrangeHeld(
  db: Db,
  keyWrapper: KeyWrapper,
  who: string,
  call: AgentCallArg,
  grantsOverrides: Partial<Grants> = {},
  pipelineExtras: Partial<Parameters<typeof createAgentCallPipeline>[0]> = {},
) {
  const clock: Clock = fixedClock(NOW);
  const { userId, dek } = await makePerson(db, who, keyWrapper);
  await grantServices(db, baseGrants(userId, CONN, grantsOverrides));
  const agent = await createAgent(
    db,
    { userId, connectionId: CONN, displayName: "Claude", platform: "claude" },
    clock,
  );

  const exec = spyExecutor();
  const pipeline = createAgentCallPipeline({
    db,
    keyWrapper,
    clock,
    rateLimiter: createRateLimiter(clock),
    recorder: createInMemoryRecorder({ clock }),
    executeTool: exec.fn,
    ...pipelineExtras,
  });
  const execHold = wrapExecuteApprovedHold(pipeline);
  const actions = createInboxActions({ db, clock, keyWrapper, executeApprovedHold: execHold.fn });

  const connection = connectionFor(userId, agent.id);
  const held = expectPending(await pipeline.handleAgentCall(connection, call));
  return { userId, dek, pipeline, exec, execHold, actions, agent, connection, approvalId: held.approval_id };
}

// =====================================================================================
// AC1 — approveApproval on a held NON-RELEASE call: it moves the approval to `approved`,
// marks it opened, and triggers the call's SINGLE execution via the pipeline — the tool
// runs exactly once and the held request is consumed. No step-up is needed for a plain
// held change call (step-up is only for releases, below).
// =====================================================================================

test("approveApproval runs a held non-release call exactly once and moves the approval to approved", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const a = await arrangeHeld(db, keyWrapper, "approve-nonrelease", nonReleaseCall());
    // A plain signed-in session with NO step-up — a non-release change needs no step-up.
    const session = await freshSession(db, a.userId);

    assert.equal(await openedAt(db, a.userId, a.approvalId), null, "unopened before the decision");

    const result = expectOk(await a.actions.approveApproval(session, a.approvalId), "approve non-release");

    // The approval is now approved…
    const approval = await getApproval(db, a.userId, a.approvalId, a.dek);
    assert.equal(approval!.status, "approved", "the approval is moved to approved");
    // …and it was marked opened (the inbox view write).
    assert.notEqual(await openedAt(db, a.userId, a.approvalId), null, "the approval is marked opened");

    // The held call was executed EXACTLY ONCE, through the pipeline, under the session's id.
    assert.equal(a.execHold.calls.length, 1, "the pipeline execution seam is triggered exactly once");
    assert.deepEqual(
      a.execHold.calls[0],
      { userId: a.userId, approvalId: a.approvalId },
      "the execution is triggered for the session's own user and this approval",
    );
    assert.equal(a.exec.calls.length, 1, "the held tool runs exactly once");
    const ran = a.exec.calls[0]!.call as { tool?: string };
    assert.equal(ran.tool, "send_email", "the held tool is the one that was parked");

    // The held request is consumed (single-shot), so it can never run again.
    const stored = await getByApproval(db, a.userId, a.approvalId, a.dek);
    assert.equal(stored!.status, "executed", "the held request is marked executed");

    // Nothing about the result leaks the outcome shape beyond success.
    assert.equal(result.ok, true);
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC1 — denyApproval moves the approval to `denied`, marks it opened, and runs nothing.
// =====================================================================================

test("denyApproval moves the approval to denied, marks it opened, and executes nothing", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const a = await arrangeHeld(db, keyWrapper, "deny-nonrelease", nonReleaseCall());
    const session = await freshSession(db, a.userId);

    expectOk(await a.actions.denyApproval(session, a.approvalId), "deny");

    const approval = await getApproval(db, a.userId, a.approvalId, a.dek);
    assert.equal(approval!.status, "denied", "the approval is moved to denied");
    assert.notEqual(await openedAt(db, a.userId, a.approvalId), null, "the approval is marked opened");

    assert.equal(a.execHold.calls.length, 0, "deny never triggers an execution");
    assert.equal(a.exec.calls.length, 0, "deny never runs the held tool");
    const stored = await getByApproval(db, a.userId, a.approvalId, a.dek);
    assert.equal(stored!.status, "held", "the held request is left waiting (held), never executed");
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC1 — askForMoreDetail moves the approval to `more_detail`, records the person's
// question, marks it opened, and runs nothing.
// =====================================================================================

test("askForMoreDetail moves the approval to more_detail, records the question, and executes nothing", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const a = await arrangeHeld(db, keyWrapper, "more-detail", nonReleaseCall());
    const session = await freshSession(db, a.userId);
    const QUESTION = "Who is the recipient and why now?";

    expectOk(await a.actions.askForMoreDetail(session, a.approvalId, QUESTION), "askForMoreDetail");

    const approval = await getApproval(db, a.userId, a.approvalId, a.dek);
    assert.equal(approval!.status, "more_detail", "the approval is moved to more_detail");
    assert.equal(approval!.question, QUESTION, "the person's question is recorded on the approval");
    assert.notEqual(await openedAt(db, a.userId, a.approvalId), null, "the approval is marked opened");

    assert.equal(a.execHold.calls.length, 0, "asking for detail never triggers an execution");
    assert.equal(a.exec.calls.length, 0, "asking for detail never runs the held tool");
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC2 — approving a CARD release requires a FRESH step-up. With one, the approval is
// approved — but the release is NEVER run through the pipeline (the agent collects it
// separately via collect_release), so the held request is left untouched.
// =====================================================================================

test("approving a card release with a fresh step-up approves it but never runs it through the pipeline", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const a = await arrangeHeld(db, keyWrapper, "card-stepup-ok", cardCall(), {
      cardAccess: true,
      cardBudget: { amount: 500, currency: "AUD", period: "month" },
    });
    const session = await sessionWithStepUpAt(db, a.userId, NOW); // fresh step-up

    expectOk(await a.actions.approveApproval(session, a.approvalId), "approve card (stepped up)");

    const approval = await getApproval(db, a.userId, a.approvalId, a.dek);
    assert.equal(approval!.status, "approved", "a stepped-up card release is approved");
    assert.equal(a.execHold.calls.length, 0, "a card release is never run through the pipeline");
    assert.equal(a.exec.calls.length, 0, "no tool runs for a card release");
    const stored = await getByApproval(db, a.userId, a.approvalId, a.dek);
    assert.equal(stored!.status, "held", "the held request is left for collection, not executed");
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC2 — approving a card release WITHOUT a fresh step-up is refused with a plain reason;
// the approval is NOT approved and nothing is handed over.
// =====================================================================================

test("approving a card release without a step-up is refused and the approval stays pending", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const a = await arrangeHeld(db, keyWrapper, "card-no-stepup", cardCall(), {
      cardAccess: true,
      cardBudget: { amount: 500, currency: "AUD", period: "month" },
    });
    const session = await freshSession(db, a.userId); // never stepped up

    expectRefused(await a.actions.approveApproval(session, a.approvalId), "approve card (no step-up)");

    const approval = await getApproval(db, a.userId, a.approvalId, a.dek);
    assert.equal(approval!.status, "pending", "the card release is left pending without a step-up");
    assert.equal(a.execHold.calls.length, 0, "a refused approval triggers no execution");
    assert.equal(a.exec.calls.length, 0, "a refused approval runs no tool");
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC2 — a STALE step-up (older than the 5-minute window) does NOT satisfy the gate: the
// card release is refused and stays pending.
// =====================================================================================

test("approving a card release with a stale (>5 min) step-up is refused and the approval stays pending", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const a = await arrangeHeld(db, keyWrapper, "card-stale-stepup", cardCall(), {
      cardAccess: true,
      cardBudget: { amount: 500, currency: "AUD", period: "month" },
    });
    const session = await sessionWithStepUpAt(db, a.userId, STALE_STEP_UP); // 10 minutes old at NOW

    expectRefused(await a.actions.approveApproval(session, a.approvalId), "approve card (stale step-up)");

    const approval = await getApproval(db, a.userId, a.approvalId, a.dek);
    assert.equal(approval!.status, "pending", "a stale step-up does not approve a card release");
    assert.equal(a.exec.calls.length, 0, "a refused approval runs no tool");
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC2 — the SAME gate applies to a HIGH-TIER release: with a fresh step-up it is
// approved (but never run through the pipeline); without one it is refused.
// =====================================================================================

test("approving a high-tier release requires a fresh step-up (approved with one, never run; refused without)", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    // Refused without a step-up.
    const noStep = await arrangeHeld(db, keyWrapper, "high-tier-no-stepup", highTierCall(), {
      highTierAccess: true,
    });
    const freshNoStep = await freshSession(db, noStep.userId);
    expectRefused(await noStep.actions.approveApproval(freshNoStep, noStep.approvalId), "approve high-tier (no step-up)");
    assert.equal(
      (await getApproval(db, noStep.userId, noStep.approvalId, noStep.dek))!.status,
      "pending",
      "a high-tier release is left pending without a step-up",
    );

    // Approved with a fresh step-up — but the release is never run through the pipeline.
    const ok = await arrangeHeld(db, keyWrapper, "high-tier-stepup-ok", highTierCall(), {
      highTierAccess: true,
    });
    const stepped = await sessionWithStepUpAt(db, ok.userId, NOW);
    expectOk(await ok.actions.approveApproval(stepped, ok.approvalId), "approve high-tier (stepped up)");
    assert.equal(
      (await getApproval(db, ok.userId, ok.approvalId, ok.dek))!.status,
      "approved",
      "a stepped-up high-tier release is approved",
    );
    assert.equal(ok.execHold.calls.length, 0, "a high-tier release is never run through the pipeline");
    assert.equal(ok.exec.calls.length, 0, "no tool runs for a high-tier release");
  } finally {
    await db.close();
  }
});

// =====================================================================================
// Member scope / ownership (CLAUDE.md: userId from the session; every member-scoped task
// has an ownership test) — a signed-in user can NEVER decide ANOTHER user's approval by
// id. Even fully stepped up, the owner's approval is left untouched, nothing is executed,
// and the owner's approval is not even marked opened by the intruder (the view write is
// member-scoped too).
// =====================================================================================

test("a signed-in user cannot decide another user's approval by id — it is refused and the owner's approval is untouched", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    // The owner parks a held non-release call.
    const owner = await arrangeHeld(db, keyWrapper, "owner", nonReleaseCall());

    // A different person, fully stepped up, tries to decide the owner's approval by its id.
    const intruder = await makePerson(db, "intruder", keyWrapper);
    const intruderSession = await sessionWithStepUpAt(db, intruder.userId, NOW);

    expectRefused(await owner.actions.approveApproval(intruderSession, owner.approvalId), "intruder approve");
    expectRefused(await owner.actions.denyApproval(intruderSession, owner.approvalId), "intruder deny");
    expectRefused(
      await owner.actions.askForMoreDetail(intruderSession, owner.approvalId, "mine now?"),
      "intruder askForMoreDetail",
    );

    // The owner's approval is exactly as it was: still pending, never executed, never opened.
    const approval = await getApproval(db, owner.userId, owner.approvalId, owner.dek);
    assert.equal(approval!.status, "pending", "the owner's approval is left pending");
    assert.equal(await openedAt(db, owner.userId, owner.approvalId), null, "the intruder cannot mark it opened");
    assert.equal(owner.execHold.calls.length, 0, "a non-owner never triggers an execution");
    assert.equal(owner.exec.calls.length, 0, "a non-owner never runs the held tool");
    const stored = await getByApproval(db, owner.userId, owner.approvalId, owner.dek);
    assert.equal(stored!.status, "held", "the owner's held call is left untouched (still held)");
  } finally {
    await db.close();
  }
});

// =====================================================================================
// [obligation:validate-and-parameterize-input] — a mis-shaped approval id (not a
// well-formed UUID; see the NOTE at the top on the "positive integer" wording) is
// rejected at the validation boundary with a 4xx HttpError, for ALL THREE actions, and
// never reaches a query as a cast. A fully stepped-up session is used so the id SHAPE is
// the only thing that can reject the call. A SQL-shaped id is likewise rejected here —
// never bound into a running query.
// =====================================================================================

test("a mis-shaped approval id is rejected with a 4xx at the validation boundary (all three actions)", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const { userId } = await makePerson(db, "malformed-id", keyWrapper);
    const clock: Clock = fixedClock(NOW);
    const exec = spyExecutor();
    const pipeline = createAgentCallPipeline({
      db,
      keyWrapper,
      clock,
      rateLimiter: createRateLimiter(clock),
      recorder: createInMemoryRecorder({ clock }),
      executeTool: exec.fn,
    });
    const actions = createInboxActions({
      db,
      clock,
      keyWrapper,
      executeApprovedHold: wrapExecuteApprovedHold(pipeline).fn,
    });
    const session = await sessionWithStepUpAt(db, userId, NOW); // stepped up, so only the id shape can reject

    for (const bad of ["not-a-uuid-at-all", "42", "'; DROP TABLE approvals; --"]) {
      await assertRejects4xx(`approveApproval(${bad})`, () => actions.approveApproval(session, bad));
      await assertRejects4xx(`denyApproval(${bad})`, () => actions.denyApproval(session, bad));
      await assertRejects4xx(`askForMoreDetail(${bad})`, () => actions.askForMoreDetail(session, bad, "why?"));
    }

    assert.equal(exec.calls.length, 0, "a mis-shaped id never reaches an execution");
  } finally {
    await db.close();
  }
});

// =====================================================================================
// [obligation:validate-and-parameterize-input] — askForMoreDetail rejects malformed
// (empty) and oversized question input with a 4xx at the boundary, rather than letting a
// bad value through to the state machine as an uncontrolled 500.
// =====================================================================================

test("askForMoreDetail rejects an empty or oversized question with a 4xx", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const a = await arrangeHeld(db, keyWrapper, "bad-question", nonReleaseCall());
    const session = await freshSession(db, a.userId);

    await assertRejects4xx("empty question", () => a.actions.askForMoreDetail(session, a.approvalId, ""));
    await assertRejects4xx("oversized question", () =>
      a.actions.askForMoreDetail(session, a.approvalId, "a".repeat(1_000_000)),
    );

    // The rejected calls changed nothing — the approval is still pending and unopened.
    const approval = await getApproval(db, a.userId, a.approvalId, a.dek);
    assert.equal(approval!.status, "pending", "a rejected question leaves the approval pending");
  } finally {
    await db.close();
  }
});

// =====================================================================================
// [obligation:validate-and-parameterize-input] — a SQL-injection probe in an input field
// (the question) travels as a BOUND value: it is stored verbatim as DATA (the table is
// not dropped and the value round-trips unchanged) and never appears concatenated into
// the SQL text. The acting user id and the approval id are bound too. Proven with a
// recording proxy over a real db that passes queries through while capturing text+values.
// =====================================================================================

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

test("a SQL-injection probe in the question is bound and stored as data, never altering a query", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    // Seed the pending held call over the REAL db (these queries are not captured).
    const a = await arrangeHeld(db, keyWrapper, "sqli-question", nonReleaseCall());
    const session = await freshSession(db, a.userId);

    // Now run the decision through a recording proxy, so only THIS call's queries are seen.
    const proxy = recordingProxy(db);
    const actions = createInboxActions({
      db: proxy,
      clock: fixedClock(NOW),
      keyWrapper,
      executeApprovedHold: a.execHold.fn,
    });

    const PROBE = "'; DROP TABLE approvals; -- and what is the amount?";
    expectOk(await actions.askForMoreDetail(session, a.approvalId, PROBE), "askForMoreDetail with a SQL probe");

    // Stored verbatim as DATA: the table still exists and the question round-trips unchanged.
    const approval = await getApproval(db, a.userId, a.approvalId, a.dek);
    assert.equal(approval!.status, "more_detail", "the approval moved to more_detail");
    assert.equal(approval!.question, PROBE, "the probe is stored verbatim as data, not executed");

    // Every captured query bound its values; the probe, the user id and the approval id all
    // travel as BOUND values, never spliced into the SQL text.
    assert.ok(proxy.calls.length >= 1, "the action issues at least one member-scoped query");
    const allValues = proxy.calls.flatMap((c) => c.values);
    assert.ok(allValues.includes(PROBE), "the question travels as a bound value");
    assert.ok(allValues.includes(a.userId), "the acting user id travels as a bound value");
    assert.ok(allValues.includes(a.approvalId), "the approval id travels as a bound value");
    for (const call of proxy.calls) {
      assert.ok(!call.text.includes(PROBE), "the question is bound, never concatenated into the SQL");
      assert.ok(!call.text.includes("DROP TABLE"), "no injected statement appears in the SQL text");
    }
  } finally {
    await db.close();
  }
});

// =====================================================================================
// [obligation:secrets-from-env] — the actions run purely from their injected seams and
// read no `process.env`: a decoy secret set in the environment never appears in a result
// or in stored approval content. (Config reaches the actions only as injected seams.)
// =====================================================================================

test("the actions read no process.env: a decoy env secret never appears in a result or stored content", async () => {
  const DECOY = "sk_live_DECOY_must_never_appear_in_warthog_inbox";
  const prev = process.env.WARTHOG_DECOY_SECRET;
  process.env.WARTHOG_DECOY_SECRET = DECOY;
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const a = await arrangeHeld(db, keyWrapper, "env-decoy", nonReleaseCall());
    const session = await freshSession(db, a.userId);

    const approved = await a.actions.approveApproval(session, a.approvalId);
    assert.equal(approved.ok, true, "the action works purely from its injected seams");
    assert.ok(!JSON.stringify(approved).includes(DECOY), "no ambient env value is folded into the result");

    const stored = await getApproval(db, a.userId, a.approvalId, a.dek);
    assert.ok(!JSON.stringify(stored).includes(DECOY), "no ambient env value is folded into stored approval content");
  } finally {
    await db.close();
    if (prev === undefined) delete process.env.WARTHOG_DECOY_SECRET;
    else process.env.WARTHOG_DECOY_SECRET = prev;
  }
});

// =====================================================================================
// Review fix C5 — decisions are compare-and-swap. A concurrent approve and deny (two
// devices, a double-click) used to BOTH report success while the held call ran and the
// record ended "denied". Now exactly one wins; the other is refused as already decided,
// and the held call runs if and only if the approval ends approved. An approval past
// its window is refused as expired (and nothing runs), even before the sweep.
// =====================================================================================

test("a concurrent approve and deny: exactly one succeeds, and the held call runs only if it ends approved", async () => {
  for (const order of ["approve-first", "deny-first"] as const) {
    const db = await freshDb();
    const keyWrapper = keyWrapperFor();
    try {
      const a = await arrangeHeld(db, keyWrapper, `c5-race-${order}`, nonReleaseCall());
      const session = await freshSession(db, a.userId);

      const approve = () => a.actions.approveApproval(session, a.approvalId);
      const deny = () => a.actions.denyApproval(session, a.approvalId);
      const results = await Promise.all(order === "approve-first" ? [approve(), deny()] : [deny(), approve()]);

      assert.equal(results.filter((r) => r.ok).length, 1, `${order}: exactly one decision succeeds`);
      const refused = results.find((r) => !r.ok);
      assert.ok(refused && !refused.ok && refused.reason === "already_decided", `${order}: the loser is told it was already decided`);

      const approval = await getApproval(db, a.userId, a.approvalId, a.dek);
      const held = await getByApproval(db, a.userId, a.approvalId, a.dek);
      if (approval!.status === "approved") {
        assert.equal(held!.status, "executed", `${order}: an approved hold runs`);
        assert.equal(a.exec.calls.length, 1, `${order}: exactly once`);
      } else {
        assert.equal(approval!.status, "denied", `${order}: otherwise it ends denied`);
        assert.equal(held!.status, "held", `${order}: a denied hold never runs`);
        assert.equal(a.exec.calls.length, 0, `${order}: nothing ran`);
      }
    } finally {
      await db.close();
    }
  }
});

test("approving an approval past its window is refused as expired and the held call never runs", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const a = await arrangeHeld(db, keyWrapper, "c5-overdue", nonReleaseCall());
    // The same actions, read 16 minutes later — past the default 15-minute window.
    const late = fixedClock(new Date(NOW.getTime() + 16 * 60_000));
    const lateActions = createInboxActions({ db, clock: late, keyWrapper, executeApprovedHold: a.execHold.fn });
    const session = await freshSession(db, a.userId);

    const result = await lateActions.approveApproval(session, a.approvalId);
    assert.ok(!result.ok && result.reason === "expired", "the person is told the request expired");

    const approval = await getApproval(db, a.userId, a.approvalId, a.dek);
    assert.equal(approval!.status, "expired", "it is stored expired at once");
    assert.equal(a.execHold.calls.length, 0, "the held call is never run");
    assert.equal(a.exec.calls.length, 0, "the held tool never runs");
  } finally {
    await db.close();
  }
});

// =====================================================================================
// Review fix C2 — the outcome of a hold the INBOX ran reaches the agent. Approving runs
// the held call at once; the agent's later check_approval used to be told "This
// approved request has already been run." (the result was thrown away). Now it gets the
// call's own result. And when the held call cannot be carried out (here: its agent was
// disconnected after asking), the person is told so instead of a bare "Approved".
// =====================================================================================

test("after an inbox approval runs the hold, the agent's check_approval gets the call's result", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const a = await arrangeHeld(db, keyWrapper, "c2-inbox-then-check", nonReleaseCall());
    const session = await freshSession(db, a.userId);
    expectOk(await a.actions.approveApproval(session, a.approvalId), "approve");
    assert.equal(a.exec.calls.length, 1, "the inbox ran the held call");
    const ranUnder = a.exec.calls[0]!.connection as { connectionId: string; agentId: string };
    assert.equal(ranUnder.connectionId, CONN, "under the agent's real connection id");
    assert.equal(ranUnder.agentId, a.agent.id, "and its own agent id");

    const checkApproval = createCheckApprovalTool({
      db,
      keyWrapper,
      clock: fixedClock(NOW),
      sleep: async () => {},
      executeApprovedHold: (userId, approvalId) => a.pipeline.executeApprovedHold(userId, approvalId),
    });
    for (const attempt of ["first", "second"]) {
      const checked = await checkApproval.handle({ approval_id: a.approvalId, wait_seconds: 0 }, a.connection);
      assert.deepEqual(
        checked,
        { status: "executed", result: { ran: "INBOX-APPROVED-RESULT" } },
        `${attempt} check: the agent is handed the held call's result`,
      );
    }
    assert.equal(a.exec.calls.length, 1, "the held call still ran exactly once");
  } finally {
    await db.close();
  }
});

test("approving a hold whose agent has since disconnected approves it but tells the person nothing was carried out", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const a = await arrangeHeld(db, keyWrapper, "c2-inbox-disconnected", nonReleaseCall());
    await db.query("UPDATE agents SET status = 'disconnected' WHERE id = $1", [a.agent.id]);
    const session = await freshSession(db, a.userId);

    const result = await a.actions.approveApproval(session, a.approvalId);
    assert.deepEqual(result, { ok: false, reason: "approved_not_run" }, "the person is told it was not carried out");
    assert.equal(a.exec.calls.length, 0, "a disconnected agent's held call never runs");
    assert.equal((await getByApproval(db, a.userId, a.approvalId, a.dek))!.status, "held", "the hold is left unrun");
  } finally {
    await db.close();
  }
});

// =====================================================================================
// Review fix C10 — the brief: the activity feed holds "every approval request and
// decision". Deciding an approval used to write nothing to the tamper-evident record.
// Each decision now writes ONE Warthog entry (kind approval_decision) naming the agent
// and the outcome; a refused decision (lost race) writes nothing.
// =====================================================================================

test("each decision is recorded once in the person's activity feed, naming the agent and the outcome", async () => {
  for (const [label, decideIt, outcome] of [
    ["approve", (a: Awaited<ReturnType<typeof arrangeHeld>>, s: Session) => a.actions.approveApproval(s, a.approvalId), "approved"],
    ["deny", (a: Awaited<ReturnType<typeof arrangeHeld>>, s: Session) => a.actions.denyApproval(s, a.approvalId), "denied"],
    [
      "ask",
      (a: Awaited<ReturnType<typeof arrangeHeld>>, s: Session) => a.actions.askForMoreDetail(s, a.approvalId, "Which report?"),
      "more_detail",
    ],
  ] as const) {
    const db = await freshDb();
    const keyWrapper = keyWrapperFor();
    try {
      const a = await arrangeHeld(db, keyWrapper, `c10-${label}`, nonReleaseCall());
      const session = await freshSession(db, a.userId);
      expectOk(await decideIt(a, session), label);

      const decisions = (await readActivity(db, a.userId, a.dek)).filter((e) => e.kind === "approval_decision");
      assert.equal(decisions.length, 1, `${label}: exactly one decision entry`);
      const entry = decisions[0]!;
      assert.equal(entry.source, "warthog", `${label}: Warthog writes the record`);
      assert.equal(entry.agentId, a.agent.id, `${label}: attributed to the requesting agent`);
      assert.equal(entry.outcome, outcome, `${label}: with the decision's outcome`);
      assert.equal(entry.tool, "send_email", `${label}: naming the held tool`);

      // Deciding again is refused and records nothing more.
      await a.actions.denyApproval(session, a.approvalId);
      const after = (await readActivity(db, a.userId, a.dek)).filter((e) => e.kind === "approval_decision");
      assert.equal(after.length, 1, `${label}: a refused second decision records nothing`);
    } finally {
      await db.close();
    }
  }
});

// =====================================================================================
// Review fix C6 — the inbox shows WHAT the agent wants. A card request used to reach the
// person with no amount, no merchant, no sentence and no rule (the pipeline stored a
// numeric amount and `recipients`, the inbox read text `amount` and singular
// `recipient`). Now the pipeline stores a display-ready detail and the inbox renders
// the exact lines: To, Amount (+ Converted with the rate's date), Merchant, Field,
// Purpose — plus the plain sentence and the rule that triggered it.
// =====================================================================================

// A line up front or behind "Details".
function line(view: { details: readonly { label: string; value: string }[]; extras?: readonly { label: string; value: string }[] }, label: string): string | undefined {
  return [...view.details, ...(view.extras ?? [])].find((d) => d.label === label)?.value;
}

test("a card request reaches the inbox with its amount, merchant, sentence, reason and rule", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const a = await arrangeHeld(
      db,
      keyWrapper,
      "c6-card",
      cardCall({ amount: 149.99, currency: "AUD", merchant: "JB Hi-Fi", reason: "new headphones" }),
      { cardAccess: true, cardBudget: { amount: 500, currency: "AUD", period: "month" } },
    );
    const view = (await a.actions.load(await freshSession(db, a.userId))).pending[0]!;

    assert.equal(line(view, "Amount"), "$149.99", "the exact amount, in its currency");
    assert.equal(line(view, "Merchant"), "JB Hi-Fi", "the merchant");
    assert.equal(view.sentence, "wants to use your card for $149.99 at JB Hi-Fi", "a plain sentence");
    assert.equal(view.reason, "new headphones", "the agent's stated reason");
    assert.equal(view.rule, "", "the default 'needs your approval' reason isn't shown up front");
    assert.ok(line(view, "Why you're asked"), "the reason it was held is in the details");
  } finally {
    await db.close();
  }
});

test("a foreign-currency card request shows the converted amount and the rate's date", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const clock: Clock = fixedClock(NOW);
    const { userId } = await makePerson(db, "c6-converted", keyWrapper);
    await grantServices(
      db,
      baseGrants(userId, CONN, { cardAccess: true, cardBudget: { amount: 500, currency: "AUD", period: "month" } }),
    );
    const agent = await createAgent(db, { userId, connectionId: CONN, displayName: "Claude", platform: "claude" }, clock);
    const pipeline = createAgentCallPipeline({
      db,
      keyWrapper,
      clock,
      rateLimiter: createRateLimiter(clock),
      recorder: createInMemoryRecorder({ clock }),
      executeTool: spyExecutor().fn,
      rate: { from: "USD", to: "AUD", rate: 1.525, date: "2026-11-14" },
    });
    expectPending(
      await pipeline.handleAgentCall(connectionFor(userId, agent.id), cardCall({ amount: 100, currency: "USD", merchant: "Steam" })),
    );
    const actions = createInboxActions({ db, clock, keyWrapper, executeApprovedHold: pipeline.executeApprovedHold });
    const view = (await actions.load(await freshSession(db, userId))).pending[0]!;

    assert.match(line(view, "Amount") ?? "", /100\.00/, "the amount as the agent asked for it");
    const converted = line(view, "Converted") ?? "";
    assert.match(converted, /\$152\.50/, "the amount converted into the account currency");
    assert.match(converted, /2026-11-14/, "with the reference rate's date");
  } finally {
    await db.close();
  }
});

test("a rule-triggered held email shows who it goes to and the rule's own sentence", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const clock: Clock = fixedClock(NOW);
    const { userId, dek } = await makePerson(db, "c6-rule", keyWrapper);
    // Changes are allowed without asking; only the rule asks.
    await grantServices(db, baseGrants(userId, CONN, { changeTools: "allow" }));
    await createRule(
      db,
      {
        userId,
        kind: "ask_first",
        scope: { type: "any_agent" },
        action: { type: "send_message", channel: "email" },
        condition: { type: "recipient_is", address: "manager@example.com" },
      },
      dek,
    );
    const agent = await createAgent(db, { userId, connectionId: CONN, displayName: "Claude", platform: "claude" }, clock);
    const pipeline = createAgentCallPipeline({
      db,
      keyWrapper,
      clock,
      rateLimiter: createRateLimiter(clock),
      recorder: createInMemoryRecorder({ clock }),
      executeTool: spyExecutor().fn,
    });
    expectPending(
      await pipeline.handleAgentCall(
        connectionFor(userId, agent.id),
        nonReleaseCall({ messageChannel: "email", recipients: ["manager@example.com", "hr@example.com"] }),
      ),
    );
    const actions = createInboxActions({ db, clock, keyWrapper, executeApprovedHold: pipeline.executeApprovedHold });
    const view = (await actions.load(await freshSession(db, userId))).pending[0]!;

    assert.equal(line(view, "To"), "manager@example.com, hr@example.com", "every recipient");
    assert.equal(view.rule, "Ask me before any agent sends email to manager@example.com", "the rule's exact sentence");
    assert.equal(view.sentence, "wants to use “Send email” in Gmail", "a plain sentence, in words (no tool or service ids)");
  } finally {
    await db.close();
  }
});

test("a high-tier request shows the field and the stated purpose", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const a = await arrangeHeld(
      db,
      keyWrapper,
      "c6-high-tier",
      highTierCall({ tool: "request_identity_detail", field: "passport", purpose: "the booking form" }),
      { highTierAccess: true },
    );
    const view = (await a.actions.load(await freshSession(db, a.userId))).pending[0]!;

    assert.equal(line(view, "Field"), "passport", "the field requested");
    assert.equal(line(view, "Purpose"), "the booking form", "the stated purpose");
    assert.equal(view.sentence, "wants to see your passport", "a plain sentence");
  } finally {
    await db.close();
  }
});

// =====================================================================================
// Review fix C7 — a high-tier "Approve and release" used to decrypt an EMPTY ciphertext
// (the inbox never loaded the requested detail), so it always failed. The loader now
// hands each high-tier request the person's own saved high-tier details — the one
// matching the requested field first — as device-decryptable ciphertext only.
// =====================================================================================

test("a high-tier request carries the person's saved details, the requested field first, as ciphertext only", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const a = await arrangeHeld(
      db,
      keyWrapper,
      "c7-high-tier-fields",
      highTierCall({ tool: "request_identity_detail", field: "passport" }),
      { highTierAccess: true },
    );
    await saveHighTierField(db, { userId: a.userId, type: "driver_licence", label: "Driver licence", ciphertext: "v1:licenceCipher" });
    await saveHighTierField(db, { userId: a.userId, type: "passport", label: "Passport", ciphertext: "v1:passportCipher" });
    // Another person's detail must never be offered.
    const other = await makePerson(db, "c7-someone-else", keyWrapper);
    await saveHighTierField(db, { userId: other.userId, type: "passport", label: "Their passport", ciphertext: "v1:theirCipher" });

    const view = (await a.actions.load(await freshSession(db, a.userId))).pending[0]!;
    const fields = view.highTierFields ?? [];
    assert.equal(fields.length, 2, "both of the person's own details, and nobody else's");
    assert.equal(fields[0]!.label, "Passport", "the requested field comes first");
    assert.equal(fields[0]!.ciphertext, "v1:passportCipher", "as the device-decryptable ciphertext");
    assert.equal(fields[1]!.label, "Driver licence");
  } finally {
    await db.close();
  }
});

// =====================================================================================
// UI/UX pass content-02 — a held change on a connected service reads by its human names:
// the tool in words and the service as the catalogue names it, rebuilt at read time (so
// requests stored with the old wording read well too), never `send_email on gmail`.
// =====================================================================================

test("a held service change reads as the tool in words in the service's catalogue name, pending and decided", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const a = await arrangeHeld(db, keyWrapper, "c02-names", nonReleaseCall({ connector: "google-calendar", tool: "google-calendar__create_event" }));
    const named = createInboxActions({
      db,
      clock: fixedClock(NOW),
      keyWrapper,
      executeApprovedHold: a.execHold.fn,
      serviceName: (id) => (id === "google-calendar" ? "Google Calendar" : undefined),
    });
    const session = await freshSession(db, a.userId);
    const loaded = await named.load(session);
    assert.equal(loaded.pending[0]!.sentence, "wants to use “Create event” in Google Calendar");
    assert.equal(loaded.hasAgents, true, "the loader says the person has an agent");

    expectOk(await named.denyApproval(session, a.approvalId), "deny");
    const after = await named.load(session);
    assert.equal(after.history[0]!.sentence, "wants to use “Create event” in Google Calendar", "the history reads the same way");
    assert.equal(after.history[0]!.outcome, "You denied this", "one verb pair: Approve / Deny");
  } finally {
    await db.close();
  }
});

test("a person with no agents is told so by the loader", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const { userId } = await makePerson(db, "c02-no-agents", keyWrapper);
    const actions = createInboxActions({ db, clock: fixedClock(NOW), keyWrapper, executeApprovedHold: async () => { throw new Error("not run"); } });
    assert.equal((await actions.load(await freshSession(db, userId))).hasAgents, false);
  } finally {
    await db.close();
  }
});

test("a request names the agent conversation that asked and the product it came through", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const run = { id: "5d0c2a4e-8b1f-4c3d-9e2a-7f6b5a4c3d2e", label: "Buying the headphones" };
    const a = await arrangeHeld(
      db,
      keyWrapper,
      "runs-card",
      { ...cardCall({ amount: 149.99, currency: "AUD", merchant: "JB Hi-Fi", reason: "new headphones" }), run, via: "Claude Code" },
      { cardAccess: true, cardBudget: { amount: 500, currency: "AUD", period: "month" } },
    );
    const view = (await a.actions.load(await freshSession(db, a.userId))).pending[0]!;
    assert.equal(line(view, "Conversation (as the agent described it)"), "Buying the headphones", "which of the agent's conversations is asking, in its own words");
    assert.equal(line(view, "Came through (as the app reported it)"), "Claude Code");
    assert.deepEqual(view.extras!.map((detail) => detail.label).slice(-2), ["Conversation (as the agent described it)", "Came through (as the app reported it)"], "claims follow what Warthog checked, in the details");
    assert.equal(view.details[0]!.label, "Amount");

    const plain = await arrangeHeld(db, keyWrapper, "runs-card-plain", cardCall({ amount: 10, currency: "AUD", merchant: "Cafe" }), { cardAccess: true, cardBudget: { amount: 500, currency: "AUD", period: "month" } });
    const before = (await plain.actions.load(await freshSession(db, plain.userId))).pending[0]!;
    assert.ok([...before.details, ...(before.extras ?? [])].every((detail) => !/Conversation|Came through/.test(detail.label)), "a request made outside any conversation shows none");
  } finally {
    await db.close();
  }
});

// --- approval-card truth (docs/adr/approval-card-truth.md) -------------------------------

function emailCall(overrides: Record<string, unknown> = {}): AgentCallArg {
  return {
    connector: "gmail",
    tool: "gmail__send",
    makesChange: true,
    messageChannel: "email",
    recipients: ["accounts@payfast-au.co"],
    reason: "Following up the invoice email.",
    params: { to: ["accounts@payfast-au.co"], subject: "Updated bank details", text: "Hi, as requested, here are the account details for the transfer." },
    ...overrides,
  } as AgentCallArg;
}

test("a held email shows who it goes to, its subject and opening words, with the rest behind Details", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const a = await arrangeHeld(db, keyWrapper, "card-truth", { ...emailCall(), tool: "google-gmail__send", connector: "google-gmail", connectorAccountLabel: "sam@example.com" }, { grantedConnectors: ["google-gmail"] });
    const view = (await a.actions.load(await freshSession(db, a.userId))).pending[0]!;
    assert.equal(view.sentence, "wants to send an email to accounts@payfast-au.co");
    assert.deepEqual(view.preview, { title: "Updated bank details", body: "Hi, as requested, here are the account details for the transfer." });
    assert.equal(view.reason, "Following up the invoice email.");
    assert.equal(view.rule, "", "the default ask-first reason isn't shown up front");
    assert.equal(view.headsUp, undefined, "nothing unusual, no heads-up");
    assert.equal(line(view, "Why you're asked"), "Changes with this connector need your approval first.");
    assert.equal(line(view, "To"), "accounts@payfast-au.co");
    assert.ok(view.details.every((detail) => detail.label !== "To"), "the recipient is in the sentence, not repeated up front");
    assert.ok(view.extras!.some((detail) => detail.label === "To"), "everyone it goes to is in Details");
  } finally {
    await db.close();
  }
});

test("a first email to a new address gets one gentle heads-up; a failed check says so only in Details", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const fresh = await arrangeHeld(db, keyWrapper, "card-new", { ...emailCall(), tool: "google-gmail__send", connector: "google-gmail" }, { grantedConnectors: ["google-gmail"] },
      { recipientHistory: async () => ({ fresh: ["accounts@payfast-au.co"], unchecked: [] }) });
    const view = (await fresh.actions.load(await freshSession(db, fresh.userId))).pending[0]!;
    assert.equal(view.headsUp, "You haven't emailed accounts@payfast-au.co before.");

    const known = await arrangeHeld(db, keyWrapper, "card-known", { ...emailCall(), tool: "google-gmail__send", connector: "google-gmail" }, { grantedConnectors: ["google-gmail"] },
      { recipientHistory: async () => ({ fresh: [], unchecked: [] }) });
    assert.equal((await known.actions.load(await freshSession(db, known.userId))).pending[0]!.headsUp, undefined, "a known address shows nothing");

    const failed = await arrangeHeld(db, keyWrapper, "card-unchecked", { ...emailCall(), tool: "google-gmail__send", connector: "google-gmail" }, { grantedConnectors: ["google-gmail"] },
      { recipientHistory: async () => { throw new Error("offline"); } });
    const unchecked = (await failed.actions.load(await freshSession(db, failed.userId))).pending[0]!;
    assert.equal(unchecked.headsUp, undefined, "a failed check is not shouted about");
    assert.match(line(unchecked, "Sent mail") ?? "", /couldn't check/);
  } finally {
    await db.close();
  }
});

test("an invitation names its event and guests, and an email's roles and whole text are in Details", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const roles = await arrangeHeld(db, keyWrapper, "card-roles", {
      ...emailCall(), tool: "google-gmail__send", connector: "google-gmail", recipients: ["sam@example.com", "outsider@evil.example"],
      params: { to: ["sam@example.com"], bcc: ["outsider@evil.example"], subject: "Hi", text: "Line one.\nLine two goes on and on." },
    }, { grantedConnectors: ["google-gmail"] });
    const email = (await roles.actions.load(await freshSession(db, roles.userId))).pending[0]!;
    assert.equal(line(email, "Blind copy"), "outsider@evil.example", "a blind copy is named as one");
    assert.equal(line(email, "Full message"), "Line one.\nLine two goes on and on.");

    const invite = await arrangeHeld(db, keyWrapper, "card-invite", {
      connector: "google-calendar", tool: "google-calendar__create", makesChange: true,
      recipients: ["sarah@acme.com.au", "tom@acme.com.au", "jo@acme.com.au"],
      params: { body: JSON.stringify({ summary: "Site visit", start: { dateTime: "2026-11-20T10:00:00+11:00" }, attendees: [{ email: "sarah@acme.com.au" }] }) },
    } as AgentCallArg);
    const view = (await invite.actions.load(await freshSession(db, invite.userId))).pending[0]!;
    assert.equal(view.sentence, "wants to add “Site visit” to your calendar");
    assert.equal(line(view, "Guests"), "sarah@acme.com.au, tom@acme.com.au and 1 more");
    assert.equal(line(view, "All guests"), "sarah@acme.com.au, tom@acme.com.au, jo@acme.com.au");
    assert.match(line(view, "When") ?? "", /20 Nov/, "a time a person reads, not an ISO string");
  } finally {
    await db.close();
  }
});

test("after reading a stranger's email, the card says so: a reply to that sender, or a first email elsewhere", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const recentRead = { lastReadAt: new Date(NOW.getTime() - 3 * 60_000), untilAt: new Date(NOW.getTime() + 57 * 60_000), sources: [{ service: "Gmail", kind: "email" as const, sender: "billing@payfast-au.co" }] };
    const extras = (fresh: string[]) => ({
      recipientHistory: async () => ({ fresh, unchecked: [] }),
      readExposures: { record: async () => {}, active: async () => recentRead },
    });
    const reply = await arrangeHeld(db, keyWrapper, "read-reply", { ...emailCall(), tool: "google-gmail__send", connector: "google-gmail" }, { grantedConnectors: ["google-gmail"] }, extras(["accounts@payfast-au.co"]));
    const elsewhere = (await reply.actions.load(await freshSession(db, reply.userId))).pending[0]!;
    assert.equal(elsewhere.headsUp, "You haven't emailed accounts@payfast-au.co before. Claude read an email from billing@payfast-au.co 3 min ago. Worth a second look if you didn't ask for this.");
    assert.equal(line(elsewhere, "Claude recently read"), "an email from billing@payfast-au.co, 3 min ago");

    const same = await arrangeHeld(db, keyWrapper, "read-same", { ...emailCall({ recipients: ["billing@payfast-au.co"], params: { to: ["billing@payfast-au.co"], text: "Thanks" } }), tool: "google-gmail__send", connector: "google-gmail" }, { grantedConnectors: ["google-gmail"] }, extras(["billing@payfast-au.co"]));
    assert.equal((await same.actions.load(await freshSession(db, same.userId))).pending[0]!.headsUp,
      "You haven't emailed billing@payfast-au.co before. They sent the email Claude read 3 min ago. Worth a second look if you didn't ask for this.");

    const known = await arrangeHeld(db, keyWrapper, "read-known", { ...emailCall(), tool: "google-gmail__send", connector: "google-gmail" }, { grantedConnectors: ["google-gmail"] }, extras([]));
    const quiet = (await known.actions.load(await freshSession(db, known.userId))).pending[0]!;
    assert.equal(quiet.headsUp, undefined, "a known address stays quiet up front");
    assert.ok(line(quiet, "Claude recently read"), "what it read is still in Details");
  } finally {
    await db.close();
  }
});

// Several accounts of one service (docs/adr/several-accounts-per-agent.md): the card says which
// inbox the agent read the email in.
test("what the agent recently read names the inbox it was in", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const recentRead = { lastReadAt: new Date(NOW.getTime() - 3 * 60_000), untilAt: new Date(NOW.getTime() + 57 * 60_000),
      sources: [{ service: "Gmail", kind: "email" as const, sender: "billing@payfast-au.co", account: "levyoren1@gmail.com" }] };
    const held = await arrangeHeld(db, keyWrapper, "read-inbox", { ...emailCall(), tool: "google-gmail__send", connector: "google-gmail" }, { grantedConnectors: ["google-gmail"] },
      { recipientHistory: async () => ({ fresh: ["accounts@payfast-au.co"], unchecked: [] }), readExposures: { record: async () => {}, active: async () => recentRead } });
    const card = (await held.actions.load(await freshSession(db, held.userId))).pending[0]!;
    assert.equal(line(card, "Claude recently read"), "an email from billing@payfast-au.co in levyoren1@gmail.com, 3 min ago");
    assert.match(card.headsUp ?? "", /Claude read an email from billing@payfast-au\.co in levyoren1@gmail\.com 3 min ago\./);
  } finally {
    await db.close();
  }
});

// Several accounts of one service (docs/adr/google-published-and-accounts.md): with two Gmail
// accounts connected, the card's sentence says which one it sends from; with one, it doesn't.
test("a card names the account up front only when the person has more than one of that service", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const call = { ...emailCall(), tool: "google-gmail__send", connector: "google-gmail", connectorAccountLabel: "work@gmail.test" } as AgentCallArg;
    const a = await arrangeHeld(db, keyWrapper, "two-accounts", call, { grantedConnectors: ["google-gmail"] });
    const clock = fixedClock(NOW);
    const work = await createConnection(db, { userId: a.userId, connectorId: "google-gmail", accountLabel: "work@gmail.test", credentials: { access_token: "a" } }, a.dek, clock);
    await adoptStandIn(db, a.userId, "google-gmail", work.id);
    const single = (await a.actions.load(await freshSession(db, a.userId))).pending[0]!;
    assert.equal(single.sentence, "wants to send an email to accounts@payfast-au.co", "one account needs no naming");

    await createConnection(db, { userId: a.userId, connectorId: "google-gmail", accountLabel: "home@gmail.test", credentials: { access_token: "b" } }, a.dek, clock);
    const view = (await a.actions.load(await freshSession(db, a.userId))).pending[0]!;
    assert.equal(view.sentence, "wants to send an email to accounts@payfast-au.co from work@gmail.test");
    assert.equal(line(view, "Service account"), "work@gmail.test", "and it stays in Details");
  } finally {
    await db.close();
  }
});

test("a LinkedIn post is held even for an agent allowed to make changes, and its card shows the post", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const held = await arrangeHeld(db, keyWrapper, "card-post", {
      connector: "linkedin", tool: "linkedin__create_post", makesChange: true, alwaysAsk: true, messageChannel: "post", outbound: true,
      params: { text: "We're hiring (two roles)!\nDetails below.", visibility: "PUBLIC",
        link: { url: "https://www.example.com/jobs", title: "Two roles open", description: "Apply by Friday." } },
    } as AgentCallArg, { grantedConnectors: ["linkedin"], changeTools: "allow" });
    assert.equal(held.exec.calls.length, 0, "nothing is posted before the person says yes");
    const view = (await held.actions.load(await freshSession(db, held.userId))).pending[0]!;
    assert.equal(view.sentence, "wants to post on LinkedIn for anyone to see");
    assert.equal(line(view, "Post"), "We're hiring (two roles)! Details below.");
    assert.equal(line(view, "Links to"), "example.com");
    assert.equal(line(view, "Link title"), "Two roles open", "the headline that's published is shown up front");
    assert.equal(line(view, "Full post"), "We're hiring (two roles)!\nDetails below.");
    assert.equal(line(view, "Link description"), "Apply by Friday.");
    assert.equal(line(view, "Link"), "https://www.example.com/jobs");
    assert.match(line(view, "Why you're asked") ?? "", /always/i);
  } finally {
    await db.close();
  }
});

test("an agent deleting a LinkedIn post is held even when changes are allowed, and the card links the post", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const held = await arrangeHeld(db, keyWrapper, "card-post-delete", {
      connector: "linkedin", tool: "linkedin__delete_post", makesChange: true, alwaysAsk: true,
      params: { query: { id: "urn:li:share:7262000000000000001" } },
    } as AgentCallArg, { grantedConnectors: ["linkedin"], changeTools: "allow" });
    assert.equal(held.exec.calls.length, 0, "nothing is deleted before the person says yes");
    const view = (await held.actions.load(await freshSession(db, held.userId))).pending[0]!;
    assert.equal(view.sentence, "wants to delete a post from LinkedIn");
    assert.equal(line(view, "Post"), "https://www.linkedin.com/feed/update/urn:li:share:7262000000000000001/");
  } finally {
    await db.close();
  }
});

// =====================================================================================
// UI/UX audit 2026-11-23 W-01 — a rule that holds Warthog's own tools ("Ask me before Claude
// makes any change") used to give the person three identical "wants to add a task" cards for
// three different tasks. Each held call now says what it would add, pending and decided.
// =====================================================================================

test("held calls to Warthog's own tools each say what they would add, pending and decided", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const clock: Clock = fixedClock(NOW);
    const { userId, dek } = await makePerson(db, "w01-core", keyWrapper);
    await grantServices(db, baseGrants(userId, CONN, { changeTools: "allow" }));
    // The rule the reviewer set: "Ask me before any agent makes any change".
    await createRule(db, { userId, kind: "ask_first", scope: { type: "any_agent" }, action: { type: "any_change" } }, dek);
    const agent = await createAgent(db, { userId, connectionId: CONN, displayName: "Claude", platform: "claude" }, clock);
    const pipeline = createAgentCallPipeline({
      db,
      keyWrapper,
      clock,
      rateLimiter: createRateLimiter(clock),
      recorder: createInMemoryRecorder({ clock }),
      executeTool: spyExecutor().fn,
    });
    const connection = connectionFor(userId, agent.id);
    const task = (title: string) => nonReleaseCall({ connector: null, tool: "create_task", params: { title, assignee: "any" } });
    const first = expectPending(await pipeline.handleAgentCall(connection, task("Book the car service")));
    expectPending(await pipeline.handleAgentCall(connection, task("Renew the passport")));
    expectPending(await pipeline.handleAgentCall(connection, task("Order school uniforms")));
    const actions = createInboxActions({ db, clock, keyWrapper, executeApprovedHold: pipeline.executeApprovedHold });
    const session = await freshSession(db, userId);
    const loaded = await actions.load(session);
    const sentences = loaded.pending.map((p) => p.sentence).sort();
    assert.deepEqual(sentences, [
      "wants to add the task “Book the car service”",
      "wants to add the task “Order school uniforms”",
      "wants to add the task “Renew the passport”",
    ], "three different tasks read as three different requests");
    for (const view of loaded.pending) {
      assert.ok(view.details.some((d) => d.label === "For" && d.value === "Any agent"), "who the task is for is shown up front");
    }
    expectOk(await actions.denyApproval(session, first.approval_id), "deny");
    const after = await actions.load(session);
    assert.equal(after.history[0]!.sentence, "wants to add the task “Book the car service”", "the history says which task it was");
  } finally {
    await db.close();
  }
});

// UI/UX audit 2026-11-23 W-02 — "time left" was a string frozen at page load, so an expired
// request still read "3 minutes left". The view now also carries when the request expires,
// so the page can keep the countdown live.
test("each pending request carries when it expires, so its countdown can stay live", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const a = await arrangeHeld(db, keyWrapper, "w02-expiry", nonReleaseCall());
    const loaded = await a.actions.load(await freshSession(db, a.userId));
    const view = loaded.pending[0]!;
    assert.equal(typeof view.expiresAtMs, "number");
    assert.equal(view.expiresAtMs! - NOW.getTime(), 15 * 60 * 1000, "the default 15-minute window, from the same clock as the label");
    assert.equal(view.timeLeft, "15 minutes left");
  } finally {
    await db.close();
  }
});
