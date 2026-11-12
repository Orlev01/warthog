// Organisation pass — listAgentsForUser returns the person's agents in ONE deterministic
// order, so the Agents list (and every other screen that lists agents) reads the same
// way each time: agents that need reconnecting first, then the most recently active,
// then those never active by newest connection, with the agent id as the final
// tie-break. Member scope and parameter binding are pinned in agents.test.ts.
//
// Driven against an isolated PGlite with the real migrations. Behaviour only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { createAgent, listAgentsForUser, recordAgentActivity, type AgentStatus } from "./agents";
import { createUser } from "./users";
import { freshDb } from "../../test/db";
import { fixedClock } from "../seams/clock";
import type { Db } from "./index";

const T0 = new Date("2026-03-01T09:00:00.000Z");
const T1 = new Date("2026-03-02T09:00:00.000Z");
const T2 = new Date("2026-03-03T09:00:00.000Z");
const T3 = new Date("2026-03-04T09:00:00.000Z");

async function makeUser(db: Db, who: string): Promise<string> {
  const user = await createUser(db, {
    email: `${who}@warthog.com.au`,
    wrappedDek: Buffer.from(`wrapped-dek-${who}`).toString("base64"),
  });
  return user.id;
}

// One agent connected at `connectedAt`, optionally last active at `activeAt`.
async function makeAgent(
  db: Db,
  userId: string,
  displayName: string,
  { status = "connected", connectedAt, activeAt }: { status?: AgentStatus; connectedAt: Date; activeAt?: Date },
): Promise<string> {
  const agent = await createAgent(
    db,
    { userId, connectionId: randomUUID(), displayName, platform: "Claude", status },
    fixedClock(connectedAt),
  );
  if (activeAt) await recordAgentActivity(db, { userId, id: agent.id }, fixedClock(activeAt));
  return agent.id;
}

test("agents needing reconnection come first, then the most recently active, then the newest never-active", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "order");
    // Created in a scrambled order so insertion order cannot pass for the rule.
    await makeAgent(db, userId, "Connected, never active, older", { connectedAt: T1 });
    await makeAgent(db, userId, "Connected, active T1", { connectedAt: T2, activeAt: T1 });
    await makeAgent(db, userId, "Disconnected, never active", { status: "disconnected", connectedAt: T1 });
    await makeAgent(db, userId, "Connected, active T3", { connectedAt: T0, activeAt: T3 });
    await makeAgent(db, userId, "Connected, never active, newer", { connectedAt: T3 });
    await makeAgent(db, userId, "Disconnected, active T2", { status: "disconnected", connectedAt: T0, activeAt: T2 });

    const names = (await listAgentsForUser(db, userId)).map((agent) => agent.displayName);
    assert.deepEqual(names, [
      "Disconnected, active T2",
      "Disconnected, never active",
      "Connected, active T3",
      "Connected, active T1",
      "Connected, never active, newer",
      "Connected, never active, older",
    ]);
  } finally {
    await db.close();
  }
});

test("agents alike in every ordered field fall back to their id, so the order never varies", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ties");
    const ids: string[] = [];
    for (const name of ["Twin one", "Twin two", "Twin three"]) {
      ids.push(await makeAgent(db, userId, name, { connectedAt: T0 }));
    }
    const listed = (await listAgentsForUser(db, userId)).map((agent) => agent.id);
    assert.deepEqual(listed, [...ids].sort(), "ties are broken by agent id");
    assert.deepEqual((await listAgentsForUser(db, userId)).map((agent) => agent.id), listed, "and the order repeats");
  } finally {
    await db.close();
  }
});
