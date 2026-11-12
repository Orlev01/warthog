// Whether an agent connects with a Warthog access key, and whether that key still works
// (`./access-key-state`). The agent's Settings section shows its "Access key" panel only
// for an agent that connected with an access key (`wh_ak_…`); an agent connected over
// OAuth has no access key, so it gets no panel.
//
// These tests drive the REAL access-key actions and stores against an isolated PGlite with
// the real migrations, and assert only on what the helper returns.

import { randomUUID } from "node:crypto";
import { test } from "node:test";
import assert from "node:assert/strict";

import { accessKeyState } from "./access-key-state";
import { createAccessKeyActions } from "@/app/(portal)/(protected)/agents/access-key/actions";
import { auditedOwnerChange } from "../activity/owner-change";
import { createAgent, getAgentById } from "../db/agents";
import { createUser } from "../db/users";
import { fixedClock } from "../seams/clock";
import { systemRandom } from "../seams/random";
import { freshDb } from "../../test/db";
import type { Db } from "../db/index";
import type { Session } from "../auth/session";

const NOW = new Date("2026-06-01T00:00:00.000Z");
const DEK = new Uint8Array(32).fill(7);
const keyWrapper = { wrap: async () => "test-wrapped", unwrap: async () => DEK };
const dek = async () => DEK;

function session(userId: string): Session {
  return { id: `sess-${userId}`, userId, createdAt: NOW, lastSeenAt: NOW, steppedUpAt: null };
}

async function makeUser(db: Db, who: string): Promise<string> {
  return (await createUser(db, { email: `${who}@warthog.com.au`, wrappedDek: Buffer.from(who).toString("base64") })).id;
}

function actions(db: Db) {
  return createAccessKeyActions({ db, keyWrapper, clock: fixedClock(NOW), random: systemRandom });
}

// An agent connected through the OAuth consent flow, recorded as that flow records it.
async function oauthAgent(db: Db, userId: string) {
  return auditedOwnerChange({ db, clock: fixedClock(NOW), keyWrapper }, userId, async (tx, record) => {
    const agent = await createAgent(tx, { userId, connectionId: randomUUID(), displayName: "Claude", platform: "Claude", status: "connected" }, fixedClock(NOW));
    await record("agent_connected", { credentialKind: "oauth", clientId: "https://claude.ai/oauth", grants: {} }, agent.id);
    return agent;
  });
}

test("an access-key agent's key reads as active, then revoked once it is revoked", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "state-key");
    const created = await actions(db).create(session(userId), { name: "My Grok", platform: "Grok", template: "minimal" });
    assert.ok(created.ok);
    const agent = (await getAgentById(db, userId, created.agentId))!;
    assert.equal(await accessKeyState(db, userId, agent, dek), "active");
    assert.equal((await actions(db).revoke(session(userId), agent.id)).ok, true);
    assert.equal(await accessKeyState(db, userId, agent, dek), "revoked", "still an access-key agent, with no working key");
    assert.equal((await actions(db).replace(session(userId), agent.id)).ok, true);
    assert.equal(await accessKeyState(db, userId, agent, dek), "active");
  } finally {
    await db.close();
  }
});

test("an agent connected over OAuth has no access key, so it has no access-key state", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "state-oauth");
    const agent = await oauthAgent(db, userId);
    assert.equal(await accessKeyState(db, userId, agent, dek), null);
  } finally {
    await db.close();
  }
});

test("an agent with neither a key nor a record of how it connected has no access-key state", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "state-unknown");
    const agent = await createAgent(db, { userId, connectionId: randomUUID(), displayName: "Old", platform: "Other", status: "connected" }, fixedClock(NOW));
    assert.equal(await accessKeyState(db, userId, agent, dek), null);
  } finally {
    await db.close();
  }
});

test("another person's agent has no access-key state for this person", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "state-alice");
    const bob = await makeUser(db, "state-bob");
    const created = await actions(db).create(session(alice), { name: "Alice Grok", platform: "Grok", template: "minimal" });
    assert.ok(created.ok);
    const agent = (await getAgentById(db, alice, created.agentId))!;
    assert.equal(await accessKeyState(db, bob, agent, dek), null);
  } finally {
    await db.close();
  }
});
