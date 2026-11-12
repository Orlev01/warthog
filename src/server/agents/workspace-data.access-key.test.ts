// The agent workspace's Settings section learns whether the agent connects with an access
// key, so the page can show its "Access key" panel (`./workspace-data`). Only an agent that
// is connected and connected with an access key gets a state; other sections don't load it.

import { randomUUID } from "node:crypto";
import { test } from "node:test";
import assert from "node:assert/strict";

import { agentWorkspaceData } from "./workspace-data";
import { createAccessKeyActions } from "@/app/(portal)/(protected)/agents/access-key/actions";
import { disconnectAgent } from "./disconnect";
import { createAgent } from "../db/agents";
import { upsertPermissions } from "../db/agent-permissions";
import { initialGrants } from "./initial-grants";
import { createUser } from "../db/users";
import { createReleaseStore } from "../crypto/release-store";
import { fixedClock } from "../seams/clock";
import { systemRandom } from "../seams/random";
import { freshDb } from "../../test/db";
import type { Session } from "../auth/session";

const NOW = new Date("2026-06-01T00:00:00.000Z");
const DEK = new Uint8Array(32).fill(7);
const clock = fixedClock(NOW);

test("the Settings section carries the agent's access-key state; other sections and other agents don't", async () => {
  const db = await freshDb();
  try {
    const userId = (await createUser(db, { email: "ws-key@warthog.com.au", wrappedDek: "d3M=" })).id;
    const session: Session = { id: "s", userId, createdAt: NOW, lastSeenAt: NOW, steppedUpAt: NOW };
    const actions = createAccessKeyActions({ db, clock, random: systemRandom, keyWrapper: { wrap: async () => "w", unwrap: async () => DEK }, alerts: { emailSender: { sendEmail: async () => {} } } });
    const created = await actions.create(session, { name: "My Grok", platform: "Grok", template: "minimal" });
    if (!created.ok) throw new Error("create failed");

    assert.equal((await agentWorkspaceData(db, userId, created.agentId, DEK, clock, "settings"))?.accessKey, "active");
    assert.equal((await agentWorkspaceData(db, userId, created.agentId, DEK, clock, "overview"))?.accessKey, null);
    assert.equal((await actions.revoke(session, created.agentId)).ok, true);
    assert.equal((await agentWorkspaceData(db, userId, created.agentId, DEK, clock, "settings"))?.accessKey, "revoked");

    // An agent with no access key (no record of one either) has no state.
    const connectionId = randomUUID();
    const other = await createAgent(db, { userId, connectionId, displayName: "Claude", platform: "Claude", status: "connected" }, clock);
    await upsertPermissions(db, { ...initialGrants(userId, connectionId, { template: "minimal" }), rateLimit: 120 });
    assert.equal((await agentWorkspaceData(db, userId, other.id, DEK, clock, "settings"))?.accessKey, null);

    // A disconnected agent's key went with the disconnect: no panel.
    await disconnectAgent({ db, clock, releaseStore: createReleaseStore(clock), dekFor: async () => DEK }, session, created.agentId);
    assert.equal((await agentWorkspaceData(db, userId, created.agentId, DEK, clock, "settings"))?.accessKey, null);
  } finally {
    await db.close();
  }
});
