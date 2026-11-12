// Memory page filters pushed into SQL: `pageMemories` narrows by scope (kept / shared) and
// by who saved a memory (the person, or one agent) BEFORE the page limit applies, so a
// filtered page is a full page of matches and the next-page cursor walks only the filtered
// set. `countMemoryFacets` reports how many of the person's memories each filter option
// would show (each facet honouring the other facet's filter), for the filter links.
//
// Both reads are member-scoped by the user id the caller passes and bind every value as a
// parameter. Each test uses its own freshDb() and closes it in a `finally`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";

import { countMemoryFacets, createMemory, pageMemories, type MemoryScope } from "./memories";
import { createUser } from "./users";
import { freshDb } from "../../test/db";
import { fixedClock } from "../seams/clock";
import type { Db } from "./index";

async function makeUser(db: Db, who: string): Promise<string> {
  const user = await createUser(db, {
    email: `${who}-${randomUUID()}@warthog.com.au`,
    wrappedDek: Buffer.from(`wrapped-dek-${who}`).toString("base64"),
  });
  return user.id;
}

async function seed(
  db: Db,
  userId: string,
  dek: Uint8Array,
  content: string,
  sourceAgentId: string | null,
  scope: MemoryScope,
  minute: number,
): Promise<string> {
  const memory = await createMemory(
    db,
    { userId, content, sourceAgentId, scope },
    dek,
    fixedClock(new Date(Date.UTC(2026, 10, 1, 9, minute))),
  );
  return memory.id;
}

// One person with a spread of memories: two agents and the person, both scopes.
async function seedSpread(db: Db) {
  const userId = await makeUser(db, "filters");
  const dek = randomBytes(32);
  const claude = randomUUID();
  const chatgpt = randomUUID();
  await seed(db, userId, dek, "claude shared one", claude, "shared", 1);
  await seed(db, userId, dek, "claude kept one", claude, "kept", 2);
  await seed(db, userId, dek, "claude shared two", claude, "shared", 3);
  await seed(db, userId, dek, "chatgpt kept", chatgpt, "kept", 4);
  await seed(db, userId, dek, "person shared", null, "shared", 5);
  await seed(db, userId, dek, "person kept", null, "kept", 6);
  return { userId, dek, claude, chatgpt };
}

const contents = (page: { items: { content: string }[] }) => page.items.map((m) => m.content);

test("pageMemories narrows to one scope, newest first", async () => {
  const db = await freshDb();
  try {
    const { userId, dek } = await seedSpread(db);
    const kept = await pageMemories(db, userId, dek, { scope: "kept" });
    assert.deepEqual(contents(kept), ["person kept", "chatgpt kept", "claude kept one"]);
    const shared = await pageMemories(db, userId, dek, { scope: "shared" });
    assert.deepEqual(contents(shared), ["person shared", "claude shared two", "claude shared one"]);
  } finally {
    await db.close();
  }
});

test("pageMemories narrows to the memories the person added themselves", async () => {
  const db = await freshDb();
  try {
    const { userId, dek } = await seedSpread(db);
    const mine = await pageMemories(db, userId, dek, { source: { kind: "person" } });
    assert.deepEqual(contents(mine), ["person kept", "person shared"]);
  } finally {
    await db.close();
  }
});

test("pageMemories narrows to one agent's memories, and combines with scope", async () => {
  const db = await freshDb();
  try {
    const { userId, dek, claude } = await seedSpread(db);
    const all = await pageMemories(db, userId, dek, { source: { kind: "agent", agentId: claude } });
    assert.deepEqual(contents(all), ["claude shared two", "claude kept one", "claude shared one"]);
    const shared = await pageMemories(db, userId, dek, {
      scope: "shared",
      source: { kind: "agent", agentId: claude },
    });
    assert.deepEqual(contents(shared), ["claude shared two", "claude shared one"]);
  } finally {
    await db.close();
  }
});

test("a filtered page is full of matches and its cursor walks only the filtered set", async () => {
  const db = await freshDb();
  try {
    const { userId, dek } = await seedSpread(db);
    const first = await pageMemories(db, userId, dek, { scope: "kept", limit: 2 });
    assert.deepEqual(contents(first), ["person kept", "chatgpt kept"], "two kept memories, none skipped for shared ones");
    assert.ok(first.nextCursor, "a third kept memory remains, so there is a next page");
    const second = await pageMemories(db, userId, dek, { scope: "kept", limit: 2, cursor: first.nextCursor! });
    assert.deepEqual(contents(second), ["claude kept one"]);
    assert.equal(second.nextCursor, null, "the filtered set is exhausted");
  } finally {
    await db.close();
  }
});

test("filters never reach another person's memories, even with the same agent id", async () => {
  const db = await freshDb();
  try {
    const { userId, dek, claude } = await seedSpread(db);
    const otherId = await makeUser(db, "other");
    const otherDek = randomBytes(32);
    await seed(db, otherId, otherDek, "other person's claude note", claude, "shared", 7);

    const page = await pageMemories(db, userId, dek, { source: { kind: "agent", agentId: claude } });
    assert.ok(!contents(page).includes("other person's claude note"));
    const facets = await countMemoryFacets(db, userId, {});
    assert.equal(facets.source.agents.get(claude), 3, "only this person's three Claude memories are counted");
  } finally {
    await db.close();
  }
});

test("countMemoryFacets counts each option, each facet honouring the other facet's filter", async () => {
  const db = await freshDb();
  try {
    const { userId, claude, chatgpt } = await seedSpread(db);

    const none = await countMemoryFacets(db, userId, {});
    assert.deepEqual(none.scope, { kept: 3, shared: 3 });
    assert.equal(none.source.person, 2);
    assert.equal(none.source.agents.get(claude), 3);
    assert.equal(none.source.agents.get(chatgpt), 1);

    // With a scope chosen, the source counts are within that scope; the scope counts are not
    // narrowed by their own filter (so the other scope's count still shows).
    const kept = await countMemoryFacets(db, userId, { scope: "kept" });
    assert.deepEqual(kept.scope, { kept: 3, shared: 3 });
    assert.equal(kept.source.person, 1);
    assert.equal(kept.source.agents.get(claude), 1);

    // With a source chosen, the scope counts are within that source.
    const claudeOnly = await countMemoryFacets(db, userId, { source: { kind: "agent", agentId: claude } });
    assert.deepEqual(claudeOnly.scope, { kept: 1, shared: 2 });
    const personOnly = await countMemoryFacets(db, userId, { source: { kind: "person" } });
    assert.deepEqual(personOnly.scope, { kept: 1, shared: 1 });
  } finally {
    await db.close();
  }
});

test("the filter values travel as bound parameters, never as SQL text", async () => {
  const calls: { text: string; values: unknown[] }[] = [];
  const recording: Db = {
    query(text: string, values: unknown[] = []) {
      calls.push({ text, values });
      return Promise.resolve({ rows: [] as Record<string, unknown>[] });
    },
    close: () => Promise.resolve(),
  } as Db;
  const probe = "x'; DROP TABLE memories; --";
  await pageMemories(recording, "user-1", randomBytes(32), {
    scope: "kept",
    source: { kind: "agent", agentId: probe },
  });
  await countMemoryFacets(recording, "user-1", { scope: "shared", source: { kind: "agent", agentId: probe } });
  assert.ok(calls.length >= 3);
  for (const call of calls) {
    assert.ok(!call.text.includes(probe), "the agent id is bound, never spliced");
    assert.ok(!call.text.includes("DROP TABLE"));
    assert.ok(call.values.includes("user-1"), "every read is bound to the caller's user id");
  }
  assert.ok(calls.some((call) => call.values.includes(probe)));
});
