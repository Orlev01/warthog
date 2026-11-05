// E07-S14 — the `check_approval` core tool, the obligation acceptance criteria
// (`src/server/mcp/tools/check-approval.ts` + its validation / parameter-binding /
// config boundaries, design §6.2; INV-102 validate-and-parameterize-input, INV-103
// secrets-from-env).
//
// RED-first: `./check-approval` does not exist yet, so importing
// `createCheckApprovalTool` throws and every test here fails until the builder writes
// the module. That absence IS the point of test-first; do NOT implement anything to
// make these pass.
//
// These tests pin BEHAVIOUR, never source text. The pinned tool contract is documented
// in the sibling `check-approval.test.ts`; this file depends on the same
// `createCheckApprovalTool(deps)` factory and `handle(input, connection)` surface.
//
//   AC [obligation:validate-and-parameterize-input] (INV-102) —
//     • the handler rejects a malformed / oversized / mis-shaped input with a 4xx
//       HttpError BEFORE anything is read or run (the db, the sleeper and
//       executeApprovedHold are never touched); and
//     • a SQL-injection probe in the `approval_id` field travels to the database as a
//       BOUND value — the approvals table and its rows are intact afterwards and the
//       probe matches nothing, so it cannot alter a query (parameter binding is used).
//   AC [obligation:secrets-from-env] (INV-103) — the tool runs purely from its injected
//     seams and reads no `process.env`, so a decoy env secret never lands in the
//     returned result; config flows in, never baked in.
//
// Every db handle is closed in a `finally`; the db-backed tests use their own
// `freshDb()` (an isolated in-memory PGlite with the real migrations). Tests never
// touch the network or Azure.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

import { createCheckApprovalTool } from "./check-approval";
import { createUser } from "../../db/users";
import { createApproval } from "../../db/approvals";
import { freshDb } from "../../../test/db";
import { localAesKeyWrapper, type KeyWrapper } from "../../crypto/key-wrapper";
import { fixedClock, type Clock } from "../../seams/clock";
import { HttpError } from "../../http/validate";
import type { AgentConnection } from "../context";
import type { Db } from "../../db/index";

const DEK_BYTES = 32;
const KEK_BYTES = 32;
const NOW = new Date("2026-11-15T12:00:00.000Z");
const CONN = "11111111-1111-1111-1111-111111111111";

type ApprovedHoldResult =
  | { status: "executed"; result: unknown }
  | { status: "refused"; reason: string };

interface CheckResult {
  readonly status: string;
  readonly result?: unknown;
  readonly reason?: string;
}

function keyWrapperFor(): KeyWrapper {
  return localAesKeyWrapper(randomBytes(KEK_BYTES));
}

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

function connectionFor(userId: string, agentId = CONN): AgentConnection {
  return { userId, connectionId: CONN, agentId, active: true };
}

// A fake clock + sleep that advances it, so a pending long-poll never delays the suite.
function sleeper(startMs: number) {
  let nowMs = startMs;
  const slept: number[] = [];
  const clock: Clock = { now: () => new Date(nowMs) };
  const sleep = async (ms: number): Promise<void> => {
    slept.push(ms);
    if (slept.length > 100_000) throw new Error("check_approval slept too many times");
    nowMs += ms;
  };
  return { clock, sleep, slept };
}

const is4xx = (err: unknown): boolean =>
  err instanceof HttpError && err.status >= 400 && err.status < 500;

// ===========================================================================
// AC [validate-and-parameterize-input] — a mis-shaped input is rejected with a 4xx
// BEFORE anything is read or run. The db, the sleeper and executeApprovedHold are all
// LANDMINES: if the handler reaches any of them before validating, the rejection is no
// longer a 4xx HttpError and the test fails.
// ===========================================================================

test("check_approval rejects a mis-shaped input with a 4xx, before any read or run", async () => {
  const landmineDb: Db = {
    async query(): Promise<never> {
      throw new Error("db.query must not run for invalid input");
    },
    async close(): Promise<void> {},
  };
  const landmineExecute = async (): Promise<ApprovedHoldResult> => {
    throw new Error("executeApprovedHold must not run for invalid input");
  };
  const landmineSleep = async (): Promise<void> => {
    throw new Error("sleep must not run for invalid input");
  };

  const tool = createCheckApprovalTool({
    db: landmineDb,
    keyWrapper: keyWrapperFor(),
    clock: fixedClock(NOW),
    sleep: landmineSleep,
    executeApprovedHold: landmineExecute,
  });
  const conn = connectionFor("validate-person");

  // A bare scalar is not the tool's object input.
  await assert.rejects(() => tool.handle(42, conn), (err: unknown) => is4xx(err), "a non-object input is a 4xx");
  // A missing approval_id (it is required).
  await assert.rejects(
    () => tool.handle({ wait_seconds: 5 }, conn),
    (err: unknown) => is4xx(err),
    "a missing approval_id is a 4xx",
  );
  // A wrong-typed approval_id (it is a string field).
  await assert.rejects(
    () => tool.handle({ approval_id: 999 }, conn),
    (err: unknown) => is4xx(err),
    "a non-string approval_id is a 4xx",
  );
  // A wrong-typed wait_seconds (it is a number field).
  await assert.rejects(
    () => tool.handle({ approval_id: "appr-1", wait_seconds: "soon" }, conn),
    (err: unknown) => is4xx(err),
    "a non-numeric wait_seconds is a 4xx",
  );
});

// ===========================================================================
// AC [validate-and-parameterize-input] — a grossly OVERSIZED approval_id is refused with
// a 4xx before anything is read (the field is capped at the boundary). A small, well-
// formed approval_id is accepted (it is read and returns a status, not a 4xx).
// ===========================================================================

test("check_approval rejects an OVERSIZED approval_id with a 4xx before any read", async () => {
  const landmineDb: Db = {
    async query(): Promise<never> {
      throw new Error("db.query must not run for an oversized input");
    },
    async close(): Promise<void> {},
  };
  const tool = createCheckApprovalTool({
    db: landmineDb,
    keyWrapper: keyWrapperFor(),
    clock: fixedClock(NOW),
    sleep: async () => {
      throw new Error("sleep must not run for an oversized input");
    },
    executeApprovedHold: async () => {
      throw new Error("executeApprovedHold must not run for an oversized input");
    },
  });

  await assert.rejects(
    () => tool.handle({ approval_id: "x".repeat(100_000) }, connectionFor("oversize-person")),
    (err: unknown) => is4xx(err),
    "an oversized approval_id must be rejected with a 4xx HttpError",
  );
});

test("check_approval accepts a small, well-formed input and reads it (not a 4xx)", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const { userId, dek } = await makePerson(db, "accepted", keyWrapper);
    // A real PENDING approval owned by this person's connection (agent id == CONN).
    const approval = await createApproval(
      db,
      { userId, agentId: CONN, detail: { tool: "request_card" } },
      dek,
      fixedClock(NOW),
    );

    const s = sleeper(NOW.getTime());
    const tool = createCheckApprovalTool({
      db,
      keyWrapper,
      clock: s.clock,
      sleep: s.sleep,
      executeApprovedHold: async () => {
        throw new Error("a pending approval must not execute a hold");
      },
    });

    // A short wait; the approval is pending, so this returns `pending` — the point is it
    // is ACCEPTED (read) rather than rejected as a 4xx.
    const result = (await tool.handle(
      { approval_id: approval.id, wait_seconds: 1 },
      connectionFor(userId),
    )) as CheckResult;

    assert.equal(result.status, "pending", "a well-formed, still-pending approval is read and returns pending");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC [validate-and-parameterize-input] — a SQL-injection probe in `approval_id` is
// BOUND, never executed: the approvals table and its rows survive and the probe matches
// nothing (so it cannot read another row or drop a table).
// ===========================================================================

test("a SQL-injection probe in approval_id travels as a BOUND value and cannot alter a query", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const { userId, dek } = await makePerson(db, "sql-probe", keyWrapper);

    // A sentinel PENDING approval that must remain readable and intact afterwards.
    const sentinel = await createApproval(
      db,
      { userId, agentId: CONN, detail: { tool: "request_card", merchant: "BoxCo" } },
      dek,
      fixedClock(NOW),
    );
    const before = await db.query("SELECT count(*)::int AS n FROM approvals WHERE user_id = $1", [userId]);
    assert.equal(before.rows[0]!.n, 1, "precondition: exactly one approval exists for this person");

    // An advancing sleeper, so even a mistaken "poll a missing approval" loop would
    // reach its deadline and terminate rather than hang.
    const s = sleeper(NOW.getTime());
    const tool = createCheckApprovalTool({
      db,
      keyWrapper,
      clock: s.clock,
      sleep: s.sleep,
      executeApprovedHold: async () => {
        throw new Error("a SQL-probe id must match no approval, so no hold is executed");
      },
    });
    const conn = connectionFor(userId);

    // (a) A DROP probe that would destroy the table if concatenated into SQL.
    const dropProbe = "x'); DROP TABLE approvals; --";
    const dropped = (await tool.handle({ approval_id: dropProbe, wait_seconds: 1 }, conn)) as CheckResult;
    assert.equal(dropped.status, "refused", "a probe id matches no approval → refused");

    // (b) A classic OR-injection that would match every row if concatenated.
    const orProbe = "' OR '1'='1";
    const ored = (await tool.handle({ approval_id: orProbe, wait_seconds: 1 }, conn)) as CheckResult;
    assert.equal(ored.status, "refused", "an OR-injection id matches no approval → refused (bound, not interpreted)");

    // The approvals table still exists and the sentinel row is intact — nothing dropped,
    // nothing altered, no extra statement ran.
    const after = await db.query("SELECT count(*)::int AS n FROM approvals WHERE user_id = $1", [userId]);
    assert.equal(after.rows[0]!.n, 1, "the probe could not drop or alter the approvals table");

    // The sentinel is still readable at its real id (the probe did not disturb it).
    const stillThere = await db.query("SELECT id FROM approvals WHERE id = $1 AND user_id = $2", [
      sentinel.id,
      userId,
    ]);
    assert.equal(stillThere.rows.length, 1, "the sentinel approval survived the injection probes");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC [secrets-from-env] — the tool reads no process.env: a decoy env secret never
// appears in the returned result. The tool runs purely from its injected seams.
// ===========================================================================

test("check_approval reads no process.env: a decoy env secret never appears in the result", async () => {
  const DECOY = "sk_live_DECOY_must_never_appear_in_warthog";
  const prev = process.env.WARTHOG_DECOY_SECRET;
  process.env.WARTHOG_DECOY_SECRET = DECOY;
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const { userId, dek } = await makePerson(db, "secrets-env", keyWrapper);
    // An APPROVED approval so check_approval runs the hold and returns an executed
    // result — the richest result shape to scan for a leaked env value.
    const approval = await createApproval(
      db,
      { userId, agentId: CONN, detail: { tool: "request_card" } },
      dek,
      fixedClock(NOW),
    );

    const tool = createCheckApprovalTool({
      db,
      keyWrapper,
      clock: fixedClock(NOW),
      sleep: async () => {},
      // A stub executor result that carries no env value; the tool must not fold one in.
      executeApprovedHold: async (): Promise<ApprovedHoldResult> => ({
        status: "executed",
        result: { ok: true },
      }),
    });

    // Drive it down a path that reads the approval and returns a result. (Whether the
    // stub approval is treated as approved or still pending, the result must not carry
    // the decoy.)
    await decideApprovedIfPossible(db, userId, approval.id, dek);
    const result = await tool.handle({ approval_id: approval.id, wait_seconds: 1 }, connectionFor(userId));

    assert.ok(
      !JSON.stringify(result ?? {}).includes(DECOY),
      "no ambient env value is folded into the returned result",
    );
  } finally {
    await db.close();
    if (prev === undefined) delete process.env.WARTHOG_DECOY_SECRET;
    else process.env.WARTHOG_DECOY_SECRET = prev;
  }
});

// Move the approval to `approved` so check_approval reaches its executed path. Imported
// lazily here (not at module top) to keep the secrets test self-contained.
async function decideApprovedIfPossible(
  db: Db,
  userId: string,
  approvalId: string,
  dek: Uint8Array,
): Promise<void> {
  const { decide } = await import("../../db/approvals");
  await decide(db, { userId, id: approvalId, decision: { status: "approved" } }, dek, fixedClock(NOW));
}
