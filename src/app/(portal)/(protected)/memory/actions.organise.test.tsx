// Memory page organisation (`./actions` load): the scope and saved-by filters are
// validated against known values and the person's OWN agents before they reach the store,
// the filter options carry counts, and every memory is placed under a date heading
// ("Today", "This week", "Earlier") computed in the account time zone.
//
// Drives the real factory against an isolated PGlite (src/test/db) with the real
// memories and agents stores, exactly as `actions.test.tsx` does.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";

import { createMemoryActions, memoryDateGroup } from "./actions";
import { createUser } from "@/server/db/users";
import { createAgent } from "@/server/db/agents";
import { createMemory, type MemoryScope } from "@/server/db/memories";
import { localAesKeyWrapper, type KeyWrapper } from "@/server/crypto/key-wrapper";
import { fixedClock, systemClock } from "@/server/seams/clock";
import { freshDb } from "@/test/db";
import type { Db } from "@/server/db/index";
import type { Session } from "@/server/auth/session";

// 10:00 on 1 June in Sydney (the account default zone; no preference is saved).
const NOW = new Date("2026-06-01T00:00:00.000Z");

async function setup(db: Db, keyWrapper: KeyWrapper, who: string) {
  const dek = randomBytes(32);
  const user = await createUser(db, {
    email: `${who}-${randomUUID()}@warthog.com.au`,
    wrappedDek: await keyWrapper.wrap(dek),
  });
  return { userId: user.id, dek };
}

async function agentFor(db: Db, userId: string, name: string): Promise<string> {
  const agent = await createAgent(
    db,
    { userId, connectionId: randomUUID(), displayName: name, platform: "claude" },
    systemClock,
  );
  return agent.id;
}

async function seed(
  db: Db,
  userId: string,
  dek: Uint8Array,
  content: string,
  sourceAgentId: string | null,
  scope: MemoryScope,
  at: string,
): Promise<void> {
  await createMemory(db, { userId, content, sourceAgentId, scope }, dek, fixedClock(new Date(at)));
}

function sessionFor(userId: string): Session {
  return { id: `sess-${userId}`, userId, createdAt: NOW, lastSeenAt: NOW, steppedUpAt: null };
}

test("memoryDateGroup buckets by the calendar day in the account time zone", () => {
  const zone = "Australia/Sydney";
  // 01:00 on 1 June in Sydney is still 31 May in UTC: it is today for the person.
  assert.equal(memoryDateGroup(new Date("2026-05-31T15:00:00.000Z"), NOW, zone), "today");
  // 23:00 on 31 May in Sydney: yesterday.
  assert.equal(memoryDateGroup(new Date("2026-05-31T13:00:00.000Z"), NOW, zone), "week");
  // 00:00 on 26 May in Sydney: six days ago, still this week.
  assert.equal(memoryDateGroup(new Date("2026-05-25T14:00:00.000Z"), NOW, zone), "week");
  // 23:59 on 25 May in Sydney: seven days ago, earlier.
  assert.equal(memoryDateGroup(new Date("2026-05-25T13:59:00.000Z"), NOW, zone), "earlier");
  // The same instants read in UTC fall differently, so the zone genuinely decides.
  assert.equal(memoryDateGroup(new Date("2026-05-31T15:00:00.000Z"), NOW, "UTC"), "week");
});

test("the loader places each memory under its date heading", async () => {
  const db = await freshDb();
  const keyWrapper = localAesKeyWrapper(randomBytes(32));
  try {
    const { userId, dek } = await setup(db, keyWrapper, "dates");
    await seed(db, userId, dek, "early today", null, "shared", "2026-05-31T15:00:00.000Z");
    await seed(db, userId, dek, "yesterday", null, "shared", "2026-05-31T13:00:00.000Z");
    await seed(db, userId, dek, "last month", null, "shared", "2026-05-01T00:00:00.000Z");

    const data = await createMemoryActions({ db, keyWrapper, clock: fixedClock(NOW) }).load(sessionFor(userId));
    assert.deepEqual(
      data.memories.map((m) => [m.content, m.dateGroup]),
      [
        ["early today", "today"],
        ["yesterday", "week"],
        ["last month", "earlier"],
      ],
    );
  } finally {
    await db.close();
  }
});

test("the loader filters by scope and by who saved it, with counts on each option", async () => {
  const db = await freshDb();
  const keyWrapper = localAesKeyWrapper(randomBytes(32));
  try {
    const { userId, dek } = await setup(db, keyWrapper, "filters");
    const claude = await agentFor(db, userId, "Claude");
    await agentFor(db, userId, "Quiet agent"); // saved nothing: offered no filter link
    await seed(db, userId, dek, "claude shared", claude, "shared", "2026-05-30T00:00:00.000Z");
    await seed(db, userId, dek, "claude kept", claude, "kept", "2026-05-29T00:00:00.000Z");
    await seed(db, userId, dek, "my own kept", null, "kept", "2026-05-28T00:00:00.000Z");

    const actions = createMemoryActions({ db, keyWrapper, clock: fixedClock(NOW) });

    const kept = await actions.load(sessionFor(userId), undefined, undefined, { scope: "kept" });
    assert.deepEqual(kept.memories.map((m) => m.content), ["claude kept", "my own kept"]);
    assert.equal(kept.filters.scope, "kept");
    assert.deepEqual(
      kept.filters.scopeOptions.map((o) => [o.value, o.label, o.count]),
      [
        [null, "All", 3],
        ["shared", "Shared", 1],
        ["kept", "Private", 2],
      ],
    );
    assert.deepEqual(
      kept.filters.sourceOptions.map((o) => [o.value, o.label, o.count]),
      [
        [null, "Anyone", 2],
        ["you", "You", 1],
        [claude, "Claude", 1],
      ],
      "source counts are within the chosen scope; an agent that saved nothing is not offered",
    );

    const mine = await actions.load(sessionFor(userId), undefined, undefined, { source: "you" });
    assert.deepEqual(mine.memories.map((m) => m.content), ["my own kept"]);
    assert.equal(mine.filters.source, "you");

    const byClaude = await actions.load(sessionFor(userId), undefined, undefined, { source: claude, scope: "shared" });
    assert.deepEqual(byClaude.memories.map((m) => m.content), ["claude shared"]);
    assert.equal(byClaude.filters.source, claude);
    assert.equal(byClaude.filters.scope, "shared");
  } finally {
    await db.close();
  }
});

test("unknown filter values, and another person's agent, are ignored rather than trusted", async () => {
  const db = await freshDb();
  const keyWrapper = localAesKeyWrapper(randomBytes(32));
  try {
    const alice = await setup(db, keyWrapper, "alice");
    const bob = await setup(db, keyWrapper, "bob");
    const bobsAgent = await agentFor(db, bob.userId, "Bob's agent");
    await seed(db, alice.userId, alice.dek, "alice note", null, "shared", "2026-05-30T00:00:00.000Z");
    await seed(db, alice.userId, alice.dek, "alice tagged with bob's agent", bobsAgent, "shared", "2026-05-29T00:00:00.000Z");

    const actions = createMemoryActions({ db, keyWrapper, clock: fixedClock(NOW) });
    const data = await actions.load(sessionFor(alice.userId), undefined, undefined, {
      scope: "everything",
      source: bobsAgent,
    });
    assert.equal(data.filters.scope, null, "an unknown scope is ignored");
    assert.equal(data.filters.source, null, "another person's agent id is not a filter option for Alice");
    assert.equal(data.memories.length, 2, "with the filters ignored, every one of Alice's memories shows");
    assert.ok(
      !data.filters.sourceOptions.some((o) => o.label === "Bob's agent"),
      "another person's agent is never offered or named",
    );
  } finally {
    await db.close();
  }
});

test("counts are left off while a search narrows the list (they would not match it)", async () => {
  const db = await freshDb();
  const keyWrapper = localAesKeyWrapper(randomBytes(32));
  try {
    const { userId, dek } = await setup(db, keyWrapper, "search");
    await seed(db, userId, dek, "aisle seat", null, "shared", "2026-05-30T00:00:00.000Z");
    await seed(db, userId, dek, "window seat", null, "kept", "2026-05-29T00:00:00.000Z");
    const data = await createMemoryActions({ db, keyWrapper, clock: fixedClock(NOW) }).load(
      sessionFor(userId),
      "aisle",
    );
    assert.deepEqual(data.memories.map((m) => m.content), ["aisle seat"]);
    assert.ok(data.filters.scopeOptions.every((o) => o.count === undefined));
    assert.ok(data.filters.sourceOptions.every((o) => o.count === undefined));
  } finally {
    await db.close();
  }
});
