// Review fix W2 — the agents store's two new reads/writes for "agent identity in the product":
//
//   • countAgentRequest — the pipeline's per-call bump of an agent's request count and
//     last-active time (W2.2). Unlike recordAgentActivity it never throws for a missing
//     agent (the pipeline counts every call, and a call with nothing to count is still
//     handled); it reports whether it counted. ONE atomic UPDATE, member-scoped.
//   • agentNamesForUser — the person's own agents' display names, keyed by BOTH the agent
//     id and its connection id (W2.1). Activity entries carry the agent id; rule scopes and
//     grants carry the connection id; either resolves to the name the person gave it.
//
// Driven against an isolated PGlite with the real migrations. Behaviour only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { agentNamesForUser, countAgentRequest, createAgent, getAgentById } from "./agents";
import { createUser } from "./users";
import { freshDb } from "../../test/db";
import { fixedClock } from "../seams/clock";
import type { Db } from "./index";

const T0 = new Date("2026-03-01T09:00:00.000Z");
const T1 = new Date("2026-03-01T10:30:00.000Z");

async function makeUser(db: Db, who: string): Promise<string> {
  const user = await createUser(db, {
    email: `${who}@warthog.com.au`,
    wrappedDek: Buffer.from(`wrapped-dek-${who}`).toString("base64"),
  });
  return user.id;
}

async function makeAgent(db: Db, userId: string, displayName: string) {
  return createAgent(
    db,
    { userId, connectionId: randomUUID(), displayName, platform: "Claude" },
    fixedClock(T0),
  );
}

test("countAgentRequest adds one request and stamps last-active, reporting that it counted", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "alice");
    const agent = await makeAgent(db, userId, "Claude");

    assert.equal(await countAgentRequest(db, { userId, id: agent.id }, fixedClock(T1)), true);
    assert.equal(await countAgentRequest(db, { userId, id: agent.id }, fixedClock(T1)), true);

    const read = await getAgentById(db, userId, agent.id);
    assert.equal(read?.requestCount, 2);
    assert.equal(new Date(read!.lastActiveAt as Date).toISOString(), T1.toISOString());
  } finally {
    await db.close();
  }
});

test("countAgentRequest counts nothing (and never throws) for an unknown, malformed or other person's agent", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "alice");
    const bob = await makeUser(db, "bob");
    const alices = await makeAgent(db, alice, "Claude");

    assert.equal(await countAgentRequest(db, { userId: alice, id: randomUUID() }, fixedClock(T1)), false);
    assert.equal(await countAgentRequest(db, { userId: alice, id: "not-a-uuid" }, fixedClock(T1)), false);
    assert.equal(await countAgentRequest(db, { userId: bob, id: alices.id }, fixedClock(T1)), false);

    const read = await getAgentById(db, alice, alices.id);
    assert.equal(read?.requestCount, 0, "another person's call never bumps Alice's agent");
    assert.equal(read?.lastActiveAt, null);
  } finally {
    await db.close();
  }
});

test("agentNamesForUser resolves an agent's name from its agent id and from its connection id", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "alice");
    const claude = await makeAgent(db, userId, "Claude on my laptop");
    const chatgpt = await makeAgent(db, userId, "ChatGPT");

    const names = await agentNamesForUser(db, userId);
    assert.equal(names.get(claude.id), "Claude on my laptop");
    assert.equal(names.get(claude.connectionId), "Claude on my laptop");
    assert.equal(names.get(chatgpt.id), "ChatGPT");
    assert.equal(names.get(chatgpt.connectionId), "ChatGPT");
    assert.equal(names.get(randomUUID()), undefined, "an unknown id resolves to nothing");
  } finally {
    await db.close();
  }
});

test("agentNamesForUser is member-scoped: another person's agents are never named", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "alice");
    const bob = await makeUser(db, "bob");
    const bobs = await makeAgent(db, bob, "Bob's secret agent");

    const names = await agentNamesForUser(db, alice);
    assert.equal(names.size, 0);
    assert.equal(names.get(bobs.id), undefined);
    assert.equal(names.get(bobs.connectionId), undefined);
  } finally {
    await db.close();
  }
});
