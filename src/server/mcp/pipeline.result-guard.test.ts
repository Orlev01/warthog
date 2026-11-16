// Read-side protection — the pipeline's result-guard seam (`resultGuard` in
// `src/server/mcp/pipeline.ts`, docs/adr/read-side-protection.md).
//
// Pins BEHAVIOUR: an executed connector result is checked before the agent reads it, on a
// live call AND on an approved hold (whose stored outcome — what check_approval and the inbox
// hand back — is the checked one); the activity record keeps content-minimal evidence of the
// service's own reply plus counts of what was hidden, never the content; core tools and
// failed calls are untouched; and a pipeline built without the guard behaves as before.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";

import { freshDb } from "../../test/db";
import { createUser } from "../db/users";
import { createAgent } from "../db/agents";
import { upsertPermissions } from "../db/agent-permissions";
import { decide } from "../db/approvals";
import { getByApproval } from "../db/held-requests";
import { localAesKeyWrapper } from "../crypto/key-wrapper";
import { fixedClock } from "../seams/clock";
import { createDbRecorder, readActivity } from "../activity/writer";
import { createResultGuard } from "../connectors/result-guard";
import { createAgentCallPipeline, type AgentCall } from "./pipeline";
import { createRateLimiter } from "./rate-limit";

const NOW = new Date("2026-11-16T01:00:00Z");
const b64url = (text: string) => Buffer.from(text, "utf8").toString("base64url");
const HOSTILE = {
  status: 200,
  truncated: false,
  body: JSON.stringify({
    id: "18c1f2a3b4c5d6e7", threadId: "18c1f2a3b4c5d6e0",
    payload: {
      mimeType: "text/plain",
      headers: [{ name: "Subject", value: "Invoice" }, { name: "From", value: "billing@example.com" }],
      body: { data: b64url("PRIVATE BODY. Your verification code is 482913.​ Card 4111 1111 1111 1111.") },
    },
  }),
};

async function setup(changeTools: "allow" | "ask_first", withGuard = true) {
  const db = await freshDb();
  const clock = fixedClock(NOW);
  const keyWrapper = localAesKeyWrapper(randomBytes(32));
  const dek = randomBytes(32);
  const user = await createUser(db, { email: `guard-${randomUUID()}@example.test`, wrappedDek: await keyWrapper.wrap(dek) });
  const agent = await createAgent(db, { userId: user.id, connectionId: randomUUID(), displayName: "Claude", platform: "claude" }, clock);
  const connection = { userId: user.id, connectionId: agent.connectionId, agentId: agent.id, active: true };
  await upsertPermissions(db, { userId: user.id, connectionId: connection.connectionId, grantedConnectors: ["google-gmail", "provider-x"], readTools: true, changeTools, identityAccess: true, highTierAccess: false, cardAccess: false, cardBudget: null, skillsScope: [], memoryRead: true, sharing: false, rulesScope: [], rateLimit: 120 });
  const metrics: { name: string; dimensions?: Record<string, unknown> }[] = [];
  let result: unknown = HOSTILE;
  const pipeline = createAgentCallPipeline({
    db, keyWrapper, clock,
    recorder: createDbRecorder({ db, clock, dekFor: async () => dek }),
    rateLimiter: createRateLimiter(clock),
    executeTool: async () => result,
    recordMetric: async (input) => { metrics.push(input); },
    ...(withGuard ? { resultGuard: createResultGuard({ serviceName: () => "Gmail" }) } : {}),
  });
  return { db, dek, user, connection, pipeline, metrics, setResult: (value: unknown) => { result = value; } };
}

const read: AgentCall = { connector: "google-gmail", tool: "google-gmail__read", makesChange: false, params: { query: { id: "18c1f2a3b4c5d6e7" } } };

test("a live connector read is checked before the agent reads it, and the record keeps counts, not content", async () => {
  const { db, dek, user, connection, pipeline, metrics } = await setup("allow");
  try {
    const outcome = await pipeline.handleAgentCall(connection, read);
    assert.equal(outcome.status, "executed");
    const text = JSON.stringify(outcome.status === "executed" ? outcome.result : null);
    assert.match(text, /^\{"notice":"Checked by Warthog/);
    assert.ok(!text.includes("482913") && !text.includes("4111 1111") && !text.includes("\\u200b"), text);
    assert.match(text, /PRIVATE BODY/, "the agent reads the message text");

    const entry = (await readActivity(db, user.id, dek)).at(-1)!;
    const evidence = (entry.payload as { resultEvidence: Record<string, unknown> }).resultEvidence;
    assert.equal(evidence.status, 200);
    assert.deepEqual(evidence.guard, { outcome: "masked", counts: { hiddenCharacters: 1, codes: 1, cards: 1 } });
    assert.doesNotMatch(JSON.stringify(entry), /PRIVATE BODY/);
    assert.ok(metrics.some((m) => m.name === "agent.read_guard" && m.dimensions?.outcome === "masked" && m.dimensions?.connectorId === "google-gmail"));
  } finally { await db.close(); }
});

test("an approved hold's stored outcome is the checked result", async () => {
  const { db, dek, user, connection, pipeline } = await setup("ask_first");
  try {
    const held = await pipeline.handleAgentCall(connection, { ...read, tool: "google-gmail__draft", makesChange: true });
    assert.equal(held.status, "pending_approval");
    const approvalId = held.status === "pending_approval" ? held.approval_id : "";
    await decide(db, { userId: user.id, id: approvalId, decision: { status: "approved" } }, dek, fixedClock(NOW));
    const ran = await pipeline.executeApprovedHold(user.id, approvalId);
    assert.equal(ran.status, "executed");
    const stored = await getByApproval(db, user.id, approvalId, dek);
    const storedText = JSON.stringify(stored?.outcome);
    assert.match(storedText, /Checked by Warthog/);
    assert.ok(!storedText.includes("482913"), "a later check_approval hands back only the checked result");
    assert.deepEqual(await pipeline.executeApprovedHold(user.id, approvalId), stored?.outcome);
  } finally { await db.close(); }
});

test("core tools, failed calls and a pipeline without the guard are untouched", async () => {
  const { db, connection, pipeline, setResult } = await setup("allow");
  try {
    setResult({ memories: ["remember this 482913 verification"] });
    const core = await pipeline.handleAgentCall(connection, { connector: null, tool: "search_memory", makesChange: false });
    assert.deepEqual(core.status === "executed" ? core.result : null, { memories: ["remember this 482913 verification"] });
    setResult({ status: 500, body: "{}", truncated: false });
    assert.equal((await pipeline.handleAgentCall(connection, read)).status, "failed");
  } finally { await db.close(); }

  const bare = await setup("allow", false);
  try {
    const outcome = await bare.pipeline.handleAgentCall(bare.connection, read);
    assert.equal(outcome.status === "executed" ? outcome.result : null, HOSTILE);
  } finally { await bare.db.close(); }
});
