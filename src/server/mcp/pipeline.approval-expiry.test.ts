// The pipeline holds a call behind an approval that expires after the PERSON'S configured
// approval expiry (brief "Agents wait safely": "approvals expire after the configured time
// (default 15 minutes, adjustable from 2 minutes to 24 hours) and an expired request is
// denied").
//
// The setting is read for the connection's OWNING person (`connection.userId`), never a
// value from the call. Behaviour only: a real PGlite with the real migrations, the real
// stores and policy engine; the tool executor is a spy that must never run for a hold.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

import { createAgentCallPipeline } from "./pipeline";
import { createRateLimiter } from "./rate-limit";
import { createInMemoryRecorder } from "../activity/recorder";
import { createUser } from "../db/users";
import { upsertPermissions } from "../db/agent-permissions";
import { getApproval } from "../db/approvals";
import { setApprovalExpiryMinutes } from "../db/approval-settings";
import { freshDb } from "../../test/db";
import { localAesKeyWrapper, type KeyWrapper } from "../crypto/key-wrapper";
import { fixedClock } from "../seams/clock";
import type { Db } from "../db/index";

type Grants = Parameters<typeof upsertPermissions>[1];
type Pipeline = ReturnType<typeof createAgentCallPipeline>;
type Result = Awaited<ReturnType<Pipeline["handleAgentCall"]>>;

const NOW = new Date("2026-11-15T12:00:00.000Z");
const MINUTE = 60_000;
const ALICE_CONN = "11111111-1111-4111-8111-111111111111";
const BOB_CONN = "22222222-2222-4222-8222-222222222222";

const toMs = (value: unknown): number => new Date(value as never).getTime();

async function makePerson(db: Db, who: string, keyWrapper: KeyWrapper): Promise<{ userId: string; dek: Uint8Array }> {
  const dek = randomBytes(32);
  const user = await createUser(db, { email: `${who}@warthog.com.au`, wrappedDek: await keyWrapper.wrap(dek) });
  return { userId: user.id, dek };
}

// Card access with a budget that covers the request, so the policy engine reaches "ask"
// (a card request always needs the person) rather than "deny".
function cardGrants(userId: string, connectionId: string): Grants {
  return {
    userId,
    connectionId,
    grantedConnectors: [],
    readTools: true,
    changeTools: "ask_first",
    identityAccess: false,
    highTierAccess: false,
    cardAccess: true,
    cardBudget: { amount: 200, currency: "AUD", period: "month" },
    skillsScope: [],
    memoryRead: false,
    sharing: false,
    rulesScope: [],
    rateLimit: 120,
  };
}

const CARD_CALL = {
  connector: null,
  tool: "request_card",
  makesChange: true,
  request: "card" as const,
  amount: 42,
  currency: "AUD",
  merchant: "BoxCo",
  params: { amount: 42, currency: "AUD", merchant: "BoxCo" },
};

function pipelineFor(db: Db, keyWrapper: KeyWrapper, executed: unknown[]): Pipeline {
  const clock = fixedClock(NOW);
  return createAgentCallPipeline({
    db,
    keyWrapper,
    clock,
    rateLimiter: createRateLimiter(clock),
    recorder: createInMemoryRecorder({ clock }),
    executeTool: async (call) => {
      executed.push(call);
      return { ok: true };
    },
  });
}

function expectPending(result: Result) {
  if (result.status !== "pending_approval") assert.fail(`expected pending_approval, got ${JSON.stringify(result)}`);
  return result;
}

function connectionFor(userId: string, connectionId: string) {
  return { userId, connectionId, agentId: connectionId, active: true };
}

test("a held call's approval expires 15 minutes after it was held when the person has set nothing", async () => {
  const db = await freshDb();
  const keyWrapper = localAesKeyWrapper(randomBytes(32));
  try {
    const alice = await makePerson(db, "expiry-default", keyWrapper);
    await upsertPermissions(db, cardGrants(alice.userId, ALICE_CONN));
    const executed: unknown[] = [];

    const result = expectPending(await pipelineFor(db, keyWrapper, executed).handleAgentCall(connectionFor(alice.userId, ALICE_CONN), CARD_CALL));

    assert.equal(toMs(result.expires_at), NOW.getTime() + 15 * MINUTE, "the default window is 15 minutes");
    const approval = await getApproval(db, alice.userId, result.approval_id, alice.dek);
    assert.equal(toMs(approval!.expiresAt), NOW.getTime() + 15 * MINUTE, "the stored approval carries the same expiry");
    assert.equal(executed.length, 0, "a held call is never executed");
  } finally {
    await db.close();
  }
});

test("a held call's approval expires after the person's configured time", async () => {
  const db = await freshDb();
  const keyWrapper = localAesKeyWrapper(randomBytes(32));
  try {
    const alice = await makePerson(db, "expiry-configured", keyWrapper);
    await upsertPermissions(db, cardGrants(alice.userId, ALICE_CONN));
    const executed: unknown[] = [];
    const pipeline = pipelineFor(db, keyWrapper, executed);

    for (const minutes of [2, 120, 1440]) {
      assert.equal((await setApprovalExpiryMinutes(db, { userId: alice.userId, minutes, now: NOW })).ok, true);
      const result = expectPending(await pipeline.handleAgentCall(connectionFor(alice.userId, ALICE_CONN), CARD_CALL));
      assert.equal(toMs(result.expires_at), NOW.getTime() + minutes * MINUTE, `the agent is told it expires in ${minutes} minutes`);
      const approval = await getApproval(db, alice.userId, result.approval_id, alice.dek);
      assert.equal(toMs(approval!.expiresAt), NOW.getTime() + minutes * MINUTE, `the stored approval expires in ${minutes} minutes`);
    }
    assert.equal(executed.length, 0, "no held call is executed");
  } finally {
    await db.close();
  }
});

test("only the connection owner's setting applies, and a change never moves an approval already waiting", async () => {
  const db = await freshDb();
  const keyWrapper = localAesKeyWrapper(randomBytes(32));
  try {
    const alice = await makePerson(db, "expiry-owner", keyWrapper);
    const bob = await makePerson(db, "expiry-other", keyWrapper);
    await upsertPermissions(db, cardGrants(alice.userId, ALICE_CONN));
    await upsertPermissions(db, cardGrants(bob.userId, BOB_CONN));
    await setApprovalExpiryMinutes(db, { userId: bob.userId, minutes: 1440, now: NOW });
    await setApprovalExpiryMinutes(db, { userId: alice.userId, minutes: 30, now: NOW });
    const pipeline = pipelineFor(db, keyWrapper, []);

    const aliceHold = expectPending(await pipeline.handleAgentCall(connectionFor(alice.userId, ALICE_CONN), CARD_CALL));
    assert.equal(toMs(aliceHold.expires_at), NOW.getTime() + 30 * MINUTE, "Alice's hold uses Alice's setting, not Bob's");
    const bobHold = expectPending(await pipeline.handleAgentCall(connectionFor(bob.userId, BOB_CONN), CARD_CALL));
    assert.equal(toMs(bobHold.expires_at), NOW.getTime() + 1440 * MINUTE, "Bob's hold uses Bob's setting");

    await setApprovalExpiryMinutes(db, { userId: alice.userId, minutes: 5, now: NOW });
    const waiting = await getApproval(db, alice.userId, aliceHold.approval_id, alice.dek);
    assert.equal(toMs(waiting!.expiresAt), NOW.getTime() + 30 * MINUTE, "a request already waiting keeps its time");
  } finally {
    await db.close();
  }
});
