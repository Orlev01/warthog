// check_approval hands back an approved hold's own stored outcome (src/server/mcp/pipeline.ts,
// docs/adr/approval-continuation.md). When that outcome is a failure or an unknown result,
// the agent must get the held change's own reason — never the plain read's "nothing changed",
// which would be wrong for a send that may have gone out.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";

import { freshDb } from "../../test/db";
import { createUser } from "../db/users";
import { createAgent } from "../db/agents";
import { localAesKeyWrapper } from "../crypto/key-wrapper";
import { fixedClock } from "../seams/clock";
import { createDbRecorder } from "../activity/writer";
import { createAgentCallPipeline } from "./pipeline";
import { createRateLimiter } from "./rate-limit";
import { createToolRegistry } from "./tools/registry";
import { grantServices } from "../../test/grants";

const NOW = new Date("2026-11-27T01:00:00Z");
const UNKNOWN = "The service did not confirm success. Check the activity record before retrying a change.";

async function setup() {
  const db = await freshDb();
  const clock = fixedClock(NOW);
  const keyWrapper = localAesKeyWrapper(randomBytes(32));
  const dek = randomBytes(32);
  const user = await createUser(db, { email: `held-${randomUUID()}@example.test`, wrappedDek: await keyWrapper.wrap(dek) });
  const agent = await createAgent(db, { userId: user.id, connectionId: randomUUID(), displayName: "ChatGPT", platform: "chatgpt" }, clock);
  const connection = { userId: user.id, connectionId: agent.connectionId, agentId: agent.id, active: true };
  await grantServices(db, { userId: user.id, connectionId: connection.connectionId, grantedConnectors: [], readTools: true, changeTools: "allow", identityAccess: false, highTierAccess: false, cardAccess: false, cardBudget: null, skillsScope: [], memoryRead: true, sharing: false, rulesScope: [], rateLimit: 120 });
  let result: unknown;
  const pipeline = createAgentCallPipeline({
    db, keyWrapper, clock,
    recorder: createDbRecorder({ db, clock, dekFor: async () => dek }),
    rateLimiter: createRateLimiter(clock),
    executeTool: async () => result,
    recordMetric: async () => {},
  });
  const checkApproval = createToolRegistry({ pipeline }).resolveTools(
    { readTools: true, changeTools: "allow", grantedConnectors: [] } as never, [],
  ).find((tool) => tool.name === "check_approval")!;
  return { db, connection, checkApproval, setResult: (value: unknown) => { result = value; } };
}

for (const status of ["unknown", "failed"] as const) {
  test(`check_approval passes an approved hold's ${status} reason through unchanged`, async () => {
    const { db, connection, checkApproval, setResult } = await setup();
    try {
      setResult({ status, reason: UNKNOWN });
      const outcome = await checkApproval.handle({ approval_id: randomUUID() }, connection);
      assert.equal(outcome.status, status);
      assert.equal(outcome.status === status ? outcome.reason : null, UNKNOWN);
      assert.doesNotMatch(JSON.stringify(outcome), /This was a read/);
    } finally { await db.close(); }
  });
}
