// Review fix W2.2 — the agent card's "last active" and "requests" counters
// (`src/server/mcp/pipeline.ts` → `countAgentRequest` in `src/server/db/agents.ts`; brief
// "Agent list": each agent shows its last-active time and request count).
//
// The agents table has carried `last_active_at` and `request_count` since 0020, and the agent
// list renders them, but nothing on the call path ever bumped them: every agent read "Never
// active · 0 requests" however much it did. The pipeline is the one place every agent call
// passes through, so it counts each call there, in ONE atomic UPDATE (request_count =
// request_count + 1), never a read-then-write that loses a bump under parallel calls.
//
// These tests drive the REAL pipeline over an isolated PGlite with the real migrations and a
// real agents row, and read the counters back through the agents store. Behaviour only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";

import { createAgentCallPipeline } from "./pipeline";
import { createRateLimiter } from "./rate-limit";
import { createInMemoryRecorder } from "../activity/recorder";
import { createUser } from "../db/users";
import { createAgent, getAgentById } from "../db/agents";
import { upsertPermissions } from "../db/agent-permissions";
import { freshDb } from "../../test/db";
import { localAesKeyWrapper, type KeyWrapper } from "../crypto/key-wrapper";
import { fixedClock } from "../seams/clock";
import type { Db } from "../db/index";

type Grants = Parameters<typeof upsertPermissions>[1];
type Pipeline = ReturnType<typeof createAgentCallPipeline>;

const CONNECTED_AT = new Date("2026-11-01T09:00:00.000Z");
const NOW = new Date("2026-11-15T12:00:00.000Z");

function keyWrapperFor(): KeyWrapper {
  return localAesKeyWrapper(randomBytes(32));
}

// A person whose wrapped DEK really unwraps under `keyWrapper`, with one connected agent
// whose connection id differs from its agent id (as in production) and a permissions row.
async function personWithAgent(
  db: Db,
  keyWrapper: KeyWrapper,
  who: string,
  grants: Partial<Grants> = {},
): Promise<{ userId: string; agentId: string; connectionId: string }> {
  const user = await createUser(db, {
    email: `${who}-${randomUUID()}@warthog.com.au`,
    wrappedDek: await keyWrapper.wrap(randomBytes(32)),
  });
  const connectionId = randomUUID();
  const agent = await createAgent(
    db,
    { userId: user.id, connectionId, displayName: `${who}'s Claude`, platform: "Claude" },
    fixedClock(CONNECTED_AT),
  );
  await upsertPermissions(db, {
    userId: user.id,
    connectionId,
    grantedConnectors: [],
    readTools: false,
    changeTools: "off",
    identityAccess: false,
    highTierAccess: false,
    cardAccess: false,
    cardBudget: null,
    skillsScope: [],
    memoryRead: true,
    sharing: false,
    rulesScope: [],
    rateLimit: 120,
    ...grants,
  } as Grants);
  return { userId: user.id, agentId: agent.id, connectionId };
}

function buildPipeline(db: Db, keyWrapper: KeyWrapper, rateLimit?: ReturnType<typeof createRateLimiter>): Pipeline {
  const clock = fixedClock(NOW);
  return createAgentCallPipeline({
    db,
    keyWrapper,
    clock,
    rateLimiter: rateLimit ?? createRateLimiter(clock),
    recorder: createInMemoryRecorder({ clock }),
    executeTool: async () => ({ ok: true }),
  });
}

// A core read, allowed by policy with a bare permissions row.
const READ = { connector: null, tool: "search_memory", makesChange: false, params: { query: "milk" } };

test("an allowed call stamps the agent's last-active time and adds one to its request count", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const alice = await personWithAgent(db, keyWrapper, "alice");
    const pipeline = buildPipeline(db, keyWrapper);

    const result = await pipeline.handleAgentCall(
      { userId: alice.userId, connectionId: alice.connectionId, agentId: alice.agentId, active: true },
      READ,
    );
    assert.equal(result.status, "executed");

    const agent = await getAgentById(db, alice.userId, alice.agentId);
    assert.equal(agent?.requestCount, 1, "one call ⇒ one request");
    assert.equal(new Date(agent!.lastActiveAt as Date).toISOString(), NOW.toISOString(), "last active = now");
  } finally {
    await db.close();
  }
});

test("a refused call (denied by policy, or on a disconnected connection) still counts as a request", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const alice = await personWithAgent(db, keyWrapper, "alice");
    const pipeline = buildPipeline(db, keyWrapper);
    const connection = { userId: alice.userId, connectionId: alice.connectionId, agentId: alice.agentId };

    // Not granted: a connector tool on a service the agent was never given.
    const denied = await pipeline.handleAgentCall(
      { ...connection, active: true },
      { connector: "gmail", tool: "gmail__send", makesChange: true },
    );
    assert.equal(denied.status, "refused");
    const disconnected = await pipeline.handleAgentCall({ ...connection, active: false }, READ);
    assert.equal(disconnected.status, "refused");

    const agent = await getAgentById(db, alice.userId, alice.agentId);
    assert.equal(agent?.requestCount, 2, "both calls reached the pipeline, so both count");
  } finally {
    await db.close();
  }
});

test("parallel calls are each counted: the bump is one atomic update, never read-then-write", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const alice = await personWithAgent(db, keyWrapper, "alice");
    const pipeline = buildPipeline(db, keyWrapper);
    const connection = { userId: alice.userId, connectionId: alice.connectionId, agentId: alice.agentId, active: true };

    const CALLS = 8;
    const results = await Promise.all(Array.from({ length: CALLS }, () => pipeline.handleAgentCall(connection, READ)));
    assert.equal(results.filter((r) => r.status === "executed").length, CALLS);

    const agent = await getAgentById(db, alice.userId, alice.agentId);
    assert.equal(agent?.requestCount, CALLS, "every parallel call is counted exactly once");
  } finally {
    await db.close();
  }
});

test("the bump is member-scoped: a connection naming another person's agent id never touches that agent", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const alice = await personWithAgent(db, keyWrapper, "alice");
    const bob = await personWithAgent(db, keyWrapper, "bob");
    const pipeline = buildPipeline(db, keyWrapper);

    // Bob's connection, carrying Alice's agent id: Bob's member scope finds no such agent.
    await pipeline.handleAgentCall(
      { userId: bob.userId, connectionId: bob.connectionId, agentId: alice.agentId, active: true },
      READ,
    );

    const aliceAgent = await getAgentById(db, alice.userId, alice.agentId);
    assert.equal(aliceAgent?.requestCount, 0, "Alice's agent is untouched");
    assert.equal(aliceAgent?.lastActiveAt, null);
  } finally {
    await db.close();
  }
});

test("a connection with no agents row behind it is still handled (nothing to count, nothing thrown)", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const alice = await personWithAgent(db, keyWrapper, "alice");
    const pipeline = buildPipeline(db, keyWrapper);

    // An id that names no agent (and is not even uuid-shaped) must not fail the call.
    const result = await pipeline.handleAgentCall(
      { userId: alice.userId, connectionId: alice.connectionId, agentId: "not-an-agent", active: true },
      READ,
    );
    assert.equal(result.status, "executed");
  } finally {
    await db.close();
  }
});
