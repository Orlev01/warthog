// Home's agent review after an account recovery (./recovery-review). The notice is derived
// from the recovery's "account_recovered" activity entry: shown for two weeks after the
// newest one, naming the agents connected at the time that still are, hidden on a browser
// that dismissed that recovery's notice, and only ever the session account's own.
// Real PGlite with the real migrations and the real activity writer.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";

import {
  ACCOUNT_RECOVERED_KIND,
  RECOVERY_REVIEW_WINDOW_MS,
  connectedAgentNames,
  getRecoveryReview,
} from "./recovery-review";
import { createRedactingRecorder } from "../mcp/recorder";
import { createAgent } from "../db/agents";
import { createUser, type User } from "../db/users";
import { fixedClock } from "../seams/clock";
import { freshDb } from "../../test/db";
import type { Db } from "../db/index";

const DAY_MS = 24 * 60 * 60 * 1000;
const T0 = new Date("2026-11-01T00:00:00.000Z");
const RECOVERED_AT = new Date(T0.getTime() + DAY_MS);

async function person(db: Db, label: string): Promise<User> {
  return createUser(db, { email: `${label}@warthog.com.au`, wrappedDek: "opaque" });
}

async function recordRecovery(db: Db, userId: string, at: Date): Promise<string> {
  const dek = randomBytes(32);
  const entry = await createRedactingRecorder({ db, clock: fixedClock(at), dekFor: async () => dek }).record({
    userId,
    kind: ACCOUNT_RECOVERED_KIND,
    source: "warthog",
    outcome: "saved",
    payload: { summary: "Recovered" },
  });
  return entry.entryHash;
}

async function agent(db: Db, userId: string, name: string, at: Date, status: "connected" | "disconnected" = "connected") {
  return createAgent(db, { userId, connectionId: randomUUID(), displayName: name, platform: "claude", status }, fixedClock(at));
}

test("no recovery, no review", async () => {
  const db = await freshDb();
  try {
    const alice = await person(db, "review-none");
    await agent(db, alice.id, "Claude", T0);
    assert.equal(await getRecoveryReview(db, { userId: alice.id }, { clock: fixedClock(RECOVERED_AT) }), null);
  } finally {
    await db.close();
  }
});

test("after a recovery, the review names the agents connected at the time that still are", async () => {
  const db = await freshDb();
  try {
    const alice = await person(db, "review-agents");
    const kept = await agent(db, alice.id, "Claude", T0);
    const other = await agent(db, alice.id, "ChatGPT", T0);
    await agent(db, alice.id, "Old Gemini", T0, "disconnected");
    const id = await recordRecovery(db, alice.id, RECOVERED_AT);
    await agent(db, alice.id, "Connected later", new Date(RECOVERED_AT.getTime() + 60_000));

    const review = await getRecoveryReview(db, { userId: alice.id }, { clock: fixedClock(new Date(RECOVERED_AT.getTime() + DAY_MS)) });
    assert.ok(review);
    assert.equal(review.id, id);
    assert.equal(review.recoveredAt.toISOString(), RECOVERED_AT.toISOString());
    assert.deepEqual(
      review.agents.map((a) => a.id).sort(),
      [kept.id, other.id].sort(),
      "only the agents kept through the recovery, still connected",
    );
    assert.deepEqual((await connectedAgentNames(db, alice.id)).sort(), ["ChatGPT", "Claude", "Connected later"]);
  } finally {
    await db.close();
  }
});

test("the review disappears after two weeks", async () => {
  const db = await freshDb();
  try {
    const alice = await person(db, "review-window");
    await agent(db, alice.id, "Claude", T0);
    await recordRecovery(db, alice.id, RECOVERED_AT);
    const justInside = new Date(RECOVERED_AT.getTime() + RECOVERY_REVIEW_WINDOW_MS - 1);
    const after = new Date(RECOVERED_AT.getTime() + RECOVERY_REVIEW_WINDOW_MS);
    assert.ok(await getRecoveryReview(db, { userId: alice.id }, { clock: fixedClock(justInside) }));
    assert.equal(await getRecoveryReview(db, { userId: alice.id }, { clock: fixedClock(after) }), null);
    assert.equal(RECOVERY_REVIEW_WINDOW_MS, 14 * DAY_MS);
  } finally {
    await db.close();
  }
});

test("a dismissed review stays hidden, and a later recovery shows a fresh one", async () => {
  const db = await freshDb();
  try {
    const alice = await person(db, "review-dismiss");
    await agent(db, alice.id, "Claude", T0);
    const first = await recordRecovery(db, alice.id, RECOVERED_AT);
    const clock = fixedClock(new Date(RECOVERED_AT.getTime() + 2 * DAY_MS));
    assert.equal(await getRecoveryReview(db, { userId: alice.id }, { clock, dismissed: first }), null);
    assert.ok(await getRecoveryReview(db, { userId: alice.id }, { clock, dismissed: "something-else" }));

    const second = await recordRecovery(db, alice.id, new Date(RECOVERED_AT.getTime() + DAY_MS));
    const review = await getRecoveryReview(db, { userId: alice.id }, { clock, dismissed: first });
    assert.equal(review?.id, second, "the newer recovery's notice shows despite the old dismissal");
  } finally {
    await db.close();
  }
});

test("the review is the session account's own, and absent with no connected agents", async () => {
  const db = await freshDb();
  try {
    const alice = await person(db, "review-alice");
    const bob = await person(db, "review-bob");
    await agent(db, bob.id, "Bob's agent", T0);
    await recordRecovery(db, alice.id, RECOVERED_AT);
    const clock = fixedClock(new Date(RECOVERED_AT.getTime() + DAY_MS));
    assert.equal(await getRecoveryReview(db, { userId: alice.id }, { clock }), null, "Alice has no agents to review");
    assert.equal(await getRecoveryReview(db, { userId: bob.id }, { clock }), null, "Bob was never recovered");
  } finally {
    await db.close();
  }
});
