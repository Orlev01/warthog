import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { freshDb } from "../../test/db";
import { createUser } from "../db/users";
import { createAgent } from "../db/agents";
import { upsertPermissions } from "../db/agent-permissions";
import { localAesKeyWrapper } from "../crypto/key-wrapper";
import { fixedClock } from "../seams/clock";
import { createDbRecorder, readActivity } from "../activity/writer";
import { createAgentCallPipeline } from "./pipeline";
import { createRateLimiter } from "./rate-limit";

import { grantServices } from "../../test/grants";
test("upstream failures and ambiguous writes have durable, correlated and content-minimal evidence", async () => {
  const db = await freshDb();
  try {
    const clock = fixedClock(new Date("2026-11-12T01:30:00Z"));
    const keyWrapper = localAesKeyWrapper(randomBytes(32)), dek = randomBytes(32);
    const user = await createUser(db, { email: "outcomes@example.test", wrappedDek: await keyWrapper.wrap(dek) });
    const agent = await createAgent(db, { userId: user.id, connectionId: randomUUID(), displayName: "Evidence", platform: "other" }, clock);
    const connection = { userId: user.id, connectionId: agent.connectionId, agentId: agent.id, active: true };
    await grantServices(db, { userId: user.id, connectionId: connection.connectionId, grantedConnectors: ["google-gmail"], readTools: true, changeTools: "allow", identityAccess: true, highTierAccess: false, cardAccess: false, cardBudget: null, skillsScope: [], memoryRead: true, sharing: false, rulesScope: [], rateLimit: 120 });
    const recorder = createDbRecorder({ db, clock, dekFor: async () => dek });
    let result: unknown = {};
    let throws = false;
    let executions = 0;
    const pipeline = createAgentCallPipeline({ db, keyWrapper, clock, recorder, rateLimiter: createRateLimiter(clock), executeTool: async () => { executions++; if (throws) throw new Error("PRIVATE FAILURE CONTENT"); return result; } });
    const call = { connector: "google-gmail", tool: "google-gmail__read", makesChange: false, params: { query: { id: "message-1" } } };
    for (const status of [401, 403, 404, 429, 500]) {
      result = { status, body: '{"error":"PRIVATE RESPONSE"}', truncated: false };
      assert.equal((await pipeline.handleAgentCall(connection, call)).status, "failed");
    }
    result = { isError: true, content: [{ type: "text", text: "PRIVATE RESPONSE" }] };
    assert.equal((await pipeline.handleAgentCall(connection, call)).status, "failed");
    result = { status: 200, body: '{"ok":false,"error":"PRIVATE BUSINESS ERROR"}', truncated: false };
    assert.equal((await pipeline.handleAgentCall(connection, call)).status, "failed", "an explicit business failure is not a successful HTTP 200 tool execution");
    result = { status: "not_available", reason: "Skill unavailable" };
    assert.equal((await pipeline.handleAgentCall(connection, call)).status, "refused");
    result = { status: 200, body: '{"messages":[{"id":"m1"},{"id":"m2"}],"secret":"PRIVATE RESPONSE"}', truncated: true };
    assert.equal((await pipeline.handleAgentCall(connection, call)).status, "executed");
    const success = (await readActivity(db, user.id, dek)).at(-1)!;
    const payload = success.payload as { requestId: string; durationMs: number; resultEvidence: { status: number; counts: Record<string, number>; truncated: boolean } };
    assert.ok(payload.requestId);
    assert.equal(payload.durationMs, 0);
    assert.equal(payload.resultEvidence.status, 200);
    assert.equal(payload.resultEvidence.counts.messages, 2);
    assert.equal(payload.resultEvidence.truncated, true);
    assert.doesNotMatch(JSON.stringify(success), /PRIVATE RESPONSE/);
    throws = true;
    await assert.rejects(() => pipeline.handleAgentCall(connection, { ...call, makesChange: true }));
    const entries = await readActivity(db, user.id, dek);
    assert.deepEqual(entries.slice(-2).map(e => e.outcome), ["attempted", "unknown"]);
    assert.equal((entries.at(-1)!.payload as any).requestId, (entries.at(-2)!.payload as any).requestId);
    assert.doesNotMatch(JSON.stringify(entries), /PRIVATE FAILURE CONTENT/);
    const before = executions;
    const failedRecords: string[] = [];
    const unavailableAudit = createAgentCallPipeline({ db, keyWrapper, clock, recorder: { record: async input => { failedRecords.push(input.outcome ?? ""); throw new Error("audit unavailable"); } }, rateLimiter: createRateLimiter(clock), executeTool: async () => { executions++; } });
    await assert.rejects(() => unavailableAudit.handleAgentCall(connection, { ...call, makesChange: true }));
    assert.equal(executions, before, "a mutation cannot run without its persisted intent");
    await grantServices(db, { userId: user.id, connectionId: connection.connectionId, grantedConnectors: ["google-gmail"], readTools: true, changeTools: "ask_first", identityAccess: true, highTierAccess: false, cardAccess: false, cardBudget: null, skillsScope: [], memoryRead: true, sharing: false, rulesScope: [], rateLimit: 120 });
    await assert.rejects(() => unavailableAudit.handleAgentCall(connection, { ...call, makesChange: true }));
    assert.equal(Number((await db.query("SELECT count(*) AS n FROM approvals WHERE user_id=$1", [user.id])).rows[0]!.n), 0, "an audit outage must roll back the pending approval");
    assert.ok(failedRecords.includes("pending_approval"), "the failure is at the audit append, after creating the approval inside the transaction");
  } finally { await db.close(); }
});
