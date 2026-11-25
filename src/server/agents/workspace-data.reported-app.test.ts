// The agent workspace says what an agent's app reported about itself ("Gemini CLI") when the
// apps Warthog knows agree, beside the platform Warthog recorded from the connection
// (docs/adr/agent-names-and-providers.md). The report is the app's claim: the platform and
// name stay as they were.

import { randomUUID } from "node:crypto";
import { test } from "node:test";
import assert from "node:assert/strict";

import { agentWorkspaceData } from "./workspace-data";
import { createAgent } from "../db/agents";
import { upsertPermissions } from "../db/agent-permissions";
import { initialGrants } from "./initial-grants";
import { createUser } from "../db/users";
import { encrypt } from "../crypto/envelope";
import { fixedClock } from "../seams/clock";
import { freshDb } from "../../test/db";
import type { Db } from "../db/index";

const NOW = new Date("2026-06-01T00:00:00.000Z");
const DEK = new Uint8Array(32).fill(9);
const clock = fixedClock(NOW);

async function agentWithApps(db: Db, userId: string, names: readonly string[]) {
  const connectionId = randomUUID();
  const agent = await createAgent(db, { userId, connectionId, displayName: "Research helper", platform: "localhost", status: "connected" }, clock);
  await upsertPermissions(db, { ...initialGrants(userId, connectionId, { template: "minimal" }), rateLimit: 120 });
  if (names.length > 0) {
    const seen = names.map((name) => ({ name, version: "1.0.0", source: "client_reported", observedAt: NOW.toISOString() }));
    const ct = await encrypt(DEK, "agents", "client_observation_ct", agent.id, JSON.stringify({ ...seen[0], seen }));
    await db.query("UPDATE agents SET client_observation_ct = $3 WHERE user_id = $1 AND id = $2", [userId, agent.id, ct]);
  }
  return agent;
}

test("the workspace carries what the agent's apps reported, and leaves the platform as recorded", async () => {
  const db = await freshDb();
  try {
    const userId = (await createUser(db, { email: "ws-app@warthog.com.au", wrappedDek: "d3M=" })).id;
    const gemini = await agentWithApps(db, userId, ["gemini-cli-mcp-client"]);
    const data = await agentWorkspaceData(db, userId, gemini.id, DEK, clock, "overview");
    assert.equal(data?.reportedApp, "Gemini CLI");
    assert.equal(data?.agent.platform, "localhost", "the app's report never changes the platform");

    const mixed = await agentWithApps(db, userId, ["claude-code", "gemini-cli-mcp-client"]);
    assert.equal((await agentWorkspaceData(db, userId, mixed.id, DEK, clock, "overview"))?.reportedApp, null, "apps from two makers give nothing");

    const none = await agentWithApps(db, userId, []);
    assert.equal((await agentWorkspaceData(db, userId, none.id, DEK, clock, "overview"))?.reportedApp, null);
  } finally {
    await db.close();
  }
});
