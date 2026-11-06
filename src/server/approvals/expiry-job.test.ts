// E12-S09 — Approval expiry job (`src/server/approvals/expiry-job.ts`), design §6
// ("Ask … Denied / expired → refusal") + the brief NFR:
//   "an unanswered approval expires, is treated as denied, and returns a denial to the
//    waiting agent." This is the TIMER that enforces it: when the job for an approval
//    comes due, it marks a still-PENDING approval whose window has passed as `expired`
//    (the pure state machine's `expireIfDue` — an expired request "is denied") so the
//    waiting agent's next `check_approval` comes back a refusal.
//
// RED-first: `./expiry-job` does not exist yet, so importing `runApprovalExpiry` throws
// and every test here fails until the builder writes the minimum code to pass. That
// absence IS the point of test-first; do NOT implement anything to make these pass — the
// builder writes `expiry-job.ts` afterwards (reusing the already-built, tested approvals
// store `decide` / its `{status:"expired"}` path, which delegates to the pure
// `expireIfDue`, so the lifecycle rules live in ONE place).
//
// These tests pin BEHAVIOUR (what the job DOES to the approval's state, what the waiting
// agent's next check then returns, that a second run changes nothing, that it parameter-
// binds / shape-guards its input), never the source text of any module — a later rename
// that preserves behaviour must not redden them. Every piece of state is arranged through
// ALREADY-BUILT, tested seams: the approvals store (`createApproval`, `decide`,
// `getApproval`), the users store (`createUser`) with a REAL `KeyWrapper` (so the owner's
// wrapped DEK genuinely unwraps), the pure state machine's `agentDecision` (to pin
// "expired is treated as denied" at the domain boundary), and the REAL `check_approval`
// tool (to prove, end-to-end, that the waiting agent's next check returns a denial). No
// network, no Azure.
//
// ---------------------------------------------------------------------------
// THE PINNED CONTRACT (chosen by the tester; the implementation conforms to it).
//
//   import type { Db } from "../db/index";
//   import type { Clock } from "../seams/clock";
//   import type { KeyWrapper } from "../crypto/key-wrapper";
//
//   interface ApprovalExpiryDeps {
//     db: Db;                 // the parameterizing db seam (approvals / users)
//     clock: Clock;           // the current instant — "due" is now >= expires_at (never SQL now())
//     keyWrapper: KeyWrapper; // unwraps the owner's wrapped DEK so the status transition can be
//                             // persisted through the store's `decide`; INJECTED (no process.env)
//   }
//
//   interface ApprovalExpiryInput {
//     approvalId: string;     // the approval the due job carries (its `payload.approvalId`)
//   }
//
//   runApprovalExpiry(deps, input): Promise<void>
//     • When the approval is still PENDING and its window has passed (clock.now() >= expires_at):
//       mark it `expired` (via the pure state machine). The waiting agent's next check then
//       returns a denial (a refusal).
//     • When the approval is NOT yet due (still within its window), leave it PENDING.
//     • When the approval is ALREADY DECIDED (approved / denied / expired / more_detail), leave it
//       UNCHANGED — the status and its decided_at stamp are not touched.
//     • Idempotent: a second run (even at a later clock) over an already-expired approval changes
//       nothing — the status stays `expired` and decided_at is NOT re-stamped to the later time.
//     • `approvalId` is validated AND shape-guarded at the boundary: an empty, oversized or
//       otherwise malformed (non-uuid) id is rejected with a 4xx `HttpError` BEFORE any query runs,
//       so an injection-shaped value never reaches `WHERE id = $1` (the id column is uuid-typed —
//       OBS-049) and cannot alter a query; every real value is bound as a parameter, never
//       concatenated.
//     • Holds no secret and needs no ambient config: it works purely from the injected
//       db / clock / keyWrapper + its input (INV-103).
//
// Acceptance criteria → tests:
//   AC1  a pending approval past its expiry with no decision ⇒ marked `expired`, treated as denied
//        (agentDecision ⇒ "denied"), and the waiting agent's next `check_approval` returns a refusal.
//   AC1b a pending approval still within its window ⇒ left pending (the timer only expires what is due).
//   AC2  an already-decided approval (approved / denied) ⇒ left unchanged (status + decided_at intact).
//   AC3  idempotent ⇒ a second run over the already-expired approval changes nothing (status stays
//        `expired`, decided_at not re-stamped), and the agent still gets a denial.
//   OBL  [validate-and-parameterize-input] a malformed / oversized id is rejected with a 4xx
//        (nothing changed); a SQL-injection-shaped id is rejected with a 4xx and the approvals table
//        is intact (the probe cannot alter a query — the id is shape-guarded, real values are bound).
//   OBL  [secrets-from-env] the job holds no secret and needs no ambient config — it works purely
//        from its injected db / clock / keyWrapper + input.
//
// Every db handle is closed in a `finally` so node:test leaves no open handle; each test uses its
// own `freshDb()` (an isolated in-memory PGlite with the real migrations), so tests share no state.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";

import { runApprovalExpiry } from "./expiry-job";
import { createApproval, decide, getApproval } from "../db/approvals";
import { createUser } from "../db/users";
import { createCheckApprovalTool } from "../mcp/tools/check-approval";
import { freshDb } from "../../test/db";
import { localAesKeyWrapper, type KeyWrapper } from "../crypto/key-wrapper";
import { fixedClock, type Clock } from "../seams/clock";
import { agentDecision, type Approval } from "../../domain/approvals/state-machine";
import type { AgentConnection } from "../mcp/context";
import type { Db } from "../db/index";

// --- fixtures ----------------------------------------------------------------------

const DEK_BYTES = 32; // a 256-bit per-person data key
const KEK_BYTES = 32; // the local AES-256 key-encryption key for the KeyWrapper seam
const MINUTE_MS = 60_000;

// The frozen instant an approval is CREATED at. Mid-month noon UTC; the default 15-minute
// window then ends at NOW + 15m.
const NOW = new Date("2026-11-15T12:00:00.000Z");
// Still inside the window (NOW + 5m < NOW + 15m): the approval is not yet due to expire.
const BEFORE_EXPIRY = new Date(NOW.getTime() + 5 * MINUTE_MS);
// Past the window (NOW + 20m > NOW + 15m): the approval is now due to expire.
const AFTER_EXPIRY = new Date(NOW.getTime() + 20 * MINUTE_MS);
// Later still — used to prove a second expiry run does NOT re-stamp decided_at.
const EVEN_LATER = new Date(NOW.getTime() + 40 * MINUTE_MS);

// The result shape check_approval returns, kept LOOSE: the tests assert on `status` + the
// field that status carries, so the builder is free to pick the exact union members.
interface CheckResult {
  readonly status: string;
  readonly result?: unknown;
  readonly reason?: string;
  readonly question?: string;
  readonly approval_id?: string;
}

function keyWrapperFor(): KeyWrapper {
  return localAesKeyWrapper(randomBytes(KEK_BYTES));
}

// Create a person whose wrapped DEK really unwraps under `keyWrapper`, returning their id
// and the DEK the approval detail is encrypted under (the SAME dek the expiry job recovers
// via the keyWrapper, so the status transition persists through the store).
async function makePerson(
  db: Db,
  who: string,
  keyWrapper: KeyWrapper,
): Promise<{ userId: string; dek: Uint8Array }> {
  const dek = randomBytes(DEK_BYTES);
  const wrappedDek = await keyWrapper.wrap(dek);
  const user = await createUser(db, { email: `${who}-${randomUUID()}@warthog.com.au`, wrappedDek });
  return { userId: user.id, dek };
}

// Arrange a PENDING approval created at NOW (so its window ends at NOW + 15m), owned by a
// fresh person, for a fresh agent connection. Returns everything a test needs: the owner's
// ids + dek, the requesting agent id (an opaque uuid — the agent the waiting check acts for),
// and the approval id.
async function arrangePending(
  db: Db,
  keyWrapper: KeyWrapper,
  who: string,
): Promise<{ userId: string; dek: Uint8Array; agentId: string; approvalId: string }> {
  const { userId, dek } = await makePerson(db, who, keyWrapper);
  const agentId = randomUUID();
  const approval = await createApproval(
    db,
    { userId, agentId, detail: { recipient: "someone@example.com", amount: 42, field: "card" } },
    dek,
    fixedClock(NOW),
  );
  return { userId, dek, agentId, approvalId: approval.id };
}

// The connection the waiting agent's `check_approval` acts for: the approval's OWNER and the
// requesting AGENT (the check is scoped to both). Built as a variable (not a literal at the
// call site) so a superset of fields stays assignable.
function connFor(userId: string, agentId: string): AgentConnection {
  return { userId, connectionId: agentId, agentId, active: true };
}

// Build the REAL `check_approval` tool over the arranged owner, reading time through `clock`.
// `sleep` is a no-op (an already-decided approval returns immediately, without waiting) and
// `executeApprovedHold` THROWS — it must never run for an expired / pending / denied approval,
// so an accidental "approved" state would surface loudly rather than silently.
function buildCheck(db: Db, keyWrapper: KeyWrapper, clock: Clock) {
  return createCheckApprovalTool({
    db,
    keyWrapper,
    clock,
    sleep: async (): Promise<void> => {},
    executeApprovedHold: async (): Promise<never> => {
      throw new Error("executeApprovedHold must not run for an expired / pending / denied approval");
    },
  });
}

// Re-read the stored approval (member-scoped, detail decrypted) — the ground truth a test
// asserts the job's effect against.
async function read(db: Db, userId: string, approvalId: string, dek: Uint8Array) {
  const stored = await getApproval(db, userId, approvalId, dek);
  assert.ok(stored, "fixture/precondition: the approval is readable");
  return stored!;
}

// ===========================================================================
// AC1 — a pending approval past its expiry with no decision is marked `expired`, treated as
// denied, and the waiting agent's next check returns a denial.
// ===========================================================================

test("a pending approval past its expiry with no decision is marked expired and treated as denied", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const { userId, dek, agentId, approvalId } = await arrangePending(db, keyWrapper, "ac1");

    // The window has passed with no decision → the timer fires.
    await runApprovalExpiry(
      { db, clock: fixedClock(AFTER_EXPIRY), keyWrapper },
      { approvalId },
    );

    // The stored status is `expired`.
    const stored = await read(db, userId, approvalId, dek);
    assert.equal(stored.status, "expired", "the overdue, undecided approval is marked expired");

    // "Treated as denied" at the domain boundary: the pure state machine collapses `expired`
    // to a denial for the waiting agent.
    const asApproval: Approval = {
      id: stored.id,
      agentId: stored.agentId,
      status: stored.status,
      request: stored.detail,
      createdAt: stored.createdAt,
      expiresAt: stored.expiresAt,
      decidedAt: stored.decidedAt,
    };
    assert.equal(agentDecision(asApproval), "denied", "an expired approval is treated as denied");

    // End-to-end: the waiting agent's next `check_approval` returns a denial (a refusal).
    const tool = buildCheck(db, keyWrapper, fixedClock(AFTER_EXPIRY));
    const result = (await tool.handle(
      { approval_id: approvalId, wait_seconds: 0 },
      connFor(userId, agentId),
    )) as CheckResult;

    assert.equal(result.status, "refused", "the waiting agent's next check returns a refusal (a denial)");
    assert.ok((result.reason ?? "").length > 0, "the refusal carries a plain reason");
    assert.equal(result.result, undefined, "no held-call result is returned for an expired approval");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC1b — a pending approval still within its window is left pending: the timer only expires
// what is actually due, never a request that still has time to be decided.
// ===========================================================================

test("a pending approval still within its window is left pending (not yet due)", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const { userId, dek, agentId, approvalId } = await arrangePending(db, keyWrapper, "ac1b");

    // The job runs BEFORE the window ends.
    await runApprovalExpiry(
      { db, clock: fixedClock(BEFORE_EXPIRY), keyWrapper },
      { approvalId },
    );

    const stored = await read(db, userId, approvalId, dek);
    assert.equal(stored.status, "pending", "a not-yet-due approval is left pending");
    assert.equal(stored.decidedAt, undefined, "a not-yet-due approval is not stamped decided");

    // The waiting agent's check still comes back pending (no denial yet).
    const tool = buildCheck(db, keyWrapper, fixedClock(BEFORE_EXPIRY));
    const result = (await tool.handle(
      { approval_id: approvalId, wait_seconds: 0 },
      connFor(userId, agentId),
    )) as CheckResult;
    assert.equal(result.status, "pending", "the waiting agent's check is still pending before expiry");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC2 — an already-decided approval is left unchanged: the timer never overwrites a decision.
// ===========================================================================

test("an already-APPROVED approval is left unchanged (never expired out from under a decision)", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const { userId, dek, approvalId } = await arrangePending(db, keyWrapper, "ac2-approved");

    // Decided (approved) in time, within the window.
    const decided = await decide(
      db,
      { userId, id: approvalId, decision: { status: "approved" } },
      dek,
      fixedClock(NOW),
    );
    assert.equal(decided.status, "approved", "precondition: the approval was approved");
    const decidedAtMs = decided.decidedAt?.getTime();

    // The expiry timer later comes due for it anyway.
    await runApprovalExpiry(
      { db, clock: fixedClock(AFTER_EXPIRY), keyWrapper },
      { approvalId },
    );

    const stored = await read(db, userId, approvalId, dek);
    assert.equal(stored.status, "approved", "an already-approved approval is NOT turned into expired");
    assert.equal(
      stored.decidedAt?.getTime(),
      decidedAtMs,
      "the original decision time is left intact (not re-stamped by the timer)",
    );
  } finally {
    await db.close();
  }
});

test("an already-DENIED approval is left unchanged", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const { userId, dek, approvalId } = await arrangePending(db, keyWrapper, "ac2-denied");

    const decided = await decide(
      db,
      { userId, id: approvalId, decision: { status: "denied" } },
      dek,
      fixedClock(NOW),
    );
    assert.equal(decided.status, "denied", "precondition: the approval was denied");
    const decidedAtMs = decided.decidedAt?.getTime();

    await runApprovalExpiry(
      { db, clock: fixedClock(AFTER_EXPIRY), keyWrapper },
      { approvalId },
    );

    const stored = await read(db, userId, approvalId, dek);
    assert.equal(stored.status, "denied", "an already-denied approval stays denied");
    assert.equal(stored.decidedAt?.getTime(), decidedAtMs, "the original decision time is left intact");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC3 — idempotent: a second run over the already-expired approval changes nothing (the status
// stays `expired`, decided_at is NOT re-stamped to the later time), and the agent still gets a denial.
// ===========================================================================

test("idempotent: a second run over the already-expired approval changes nothing", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const { userId, dek, agentId, approvalId } = await arrangePending(db, keyWrapper, "ac3");

    // First run: expire it.
    await runApprovalExpiry(
      { db, clock: fixedClock(AFTER_EXPIRY), keyWrapper },
      { approvalId },
    );
    const afterFirst = await read(db, userId, approvalId, dek);
    assert.equal(afterFirst.status, "expired", "first run marks the overdue approval expired");
    const firstDecidedAtMs = afterFirst.decidedAt?.getTime();

    // Second run, at a LATER clock: the suppression must come from the approval already being
    // expired, not from the window — a non-idempotent job would re-stamp decided_at to EVEN_LATER.
    await runApprovalExpiry(
      { db, clock: fixedClock(EVEN_LATER), keyWrapper },
      { approvalId },
    );
    const afterSecond = await read(db, userId, approvalId, dek);
    assert.equal(afterSecond.status, "expired", "a second run leaves the status expired");
    assert.equal(
      afterSecond.decidedAt?.getTime(),
      firstDecidedAtMs,
      "a second run does NOT re-stamp decided_at (idempotent — the later clock is ignored)",
    );

    // And the waiting agent still gets a denial after the second run.
    const tool = buildCheck(db, keyWrapper, fixedClock(EVEN_LATER));
    const result = (await tool.handle(
      { approval_id: approvalId, wait_seconds: 0 },
      connFor(userId, agentId),
    )) as CheckResult;
    assert.equal(result.status, "refused", "the agent still gets a denial after a second run");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// OBL [validate-and-parameterize-input] — a malformed / oversized id is rejected with a 4xx
// before anything is touched; a SQL-injection-shaped id is rejected with a 4xx and the approvals
// table is intact (the id is shape-guarded, real values are bound — the probe cannot alter a query).
// ===========================================================================

test("rejects an empty approval id with a 4xx and changes nothing", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const { userId, dek, approvalId } = await arrangePending(db, keyWrapper, "obl-empty");

    await assert.rejects(
      () => runApprovalExpiry({ db, clock: fixedClock(AFTER_EXPIRY), keyWrapper }, { approvalId: "" }),
      (err: unknown) => {
        const status = (err as { status?: number }).status;
        assert.equal(typeof status, "number", "the rejection carries an HTTP status");
        assert.ok(status! >= 400 && status! < 500, `malformed input is a 4xx, got ${status}`);
        return true;
      },
    );

    // The real approval was never touched.
    const stored = await read(db, userId, approvalId, dek);
    assert.equal(stored.status, "pending", "an invalid id leaves the real approval pending");
  } finally {
    await db.close();
  }
});

test("rejects an oversized approval id with a 4xx and changes nothing", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const { userId, dek, approvalId } = await arrangePending(db, keyWrapper, "obl-oversized");
    const oversized = "x".repeat(100_000); // far beyond any id length

    await assert.rejects(
      () => runApprovalExpiry({ db, clock: fixedClock(AFTER_EXPIRY), keyWrapper }, { approvalId: oversized }),
      (err: unknown) => {
        const status = (err as { status?: number }).status;
        assert.equal(typeof status, "number", "the rejection carries an HTTP status");
        assert.ok(status! >= 400 && status! < 500, `oversized input is a 4xx, got ${status}`);
        return true;
      },
    );

    const stored = await read(db, userId, approvalId, dek);
    assert.equal(stored.status, "pending", "an oversized id leaves the real approval pending");
  } finally {
    await db.close();
  }
});

test("a SQL-injection-shaped approval id is rejected with a 4xx and cannot alter a query (tables intact)", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const { userId, dek, approvalId } = await arrangePending(db, keyWrapper, "obl-injection");

    // If this id were spliced into the SQL instead of bound (and shape-guarded at the boundary),
    // it would drop the approvals table; it cannot — the id column is uuid-typed, so a non-uuid is
    // refused with a 4xx before `WHERE id = $1` is ever reached (OBS-049).
    const probe = "'); DROP TABLE approvals; --";

    await assert.rejects(
      () => runApprovalExpiry({ db, clock: fixedClock(AFTER_EXPIRY), keyWrapper }, { approvalId: probe }),
      (err: unknown) => {
        const status = (err as { status?: number }).status;
        assert.equal(typeof status, "number", "the rejection carries an HTTP status");
        assert.ok(status! >= 400 && status! < 500, `an injection-shaped id is a 4xx, got ${status}`);
        return true;
      },
    );

    // The approvals table still exists and still holds the untouched row — the DROP never ran.
    const count = await db.query("SELECT count(*)::int AS n FROM approvals");
    assert.equal(Number(count.rows[0]!.n), 1, "approvals is intact; the DROP never ran");
    const stored = await read(db, userId, approvalId, dek);
    assert.equal(stored.status, "pending", "the real approval is left pending");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// OBL [secrets-from-env] — the job holds no secret and needs no ambient config: it works purely
// from its injected db / clock / keyWrapper + input (the KEK rides in the injected keyWrapper, never
// read from the environment inside this module, INV-103).
// ===========================================================================

test("runs from injected deps alone: no secret and no ambient configuration are needed", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const { userId, dek, approvalId } = await arrangePending(db, keyWrapper, "obl-secrets");

    // Only db / clock / keyWrapper + the input — no connection string, no KEK read from env.
    await runApprovalExpiry(
      { db, clock: fixedClock(AFTER_EXPIRY), keyWrapper },
      { approvalId },
    );

    const stored = await read(db, userId, approvalId, dek);
    assert.equal(stored.status, "expired", "the expiry happened with no secret or env handed to the job");
  } finally {
    await db.close();
  }
});
