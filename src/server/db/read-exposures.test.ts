// The "recently read" window store (`src/server/db/read-exposures.ts`,
// db/migrations/0114_agent_read_exposures.sql, docs/adr/read-side-protection.md).
//
// Pins BEHAVIOUR: a read opens a 60-minute window that remembers the last three senders
// (newest first, no repeats); a later read extends it; it is member-scoped and encrypted
// (no sender in the row's plain columns); and a passed window reads as closed and is cleared.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";

import { freshDb } from "../../test/db";
import { createUser } from "./users";
import { createAgent } from "./agents";
import { fixedClock } from "../seams/clock";
import { activeReadExposure, recordReadExposure, READ_WINDOW_MS } from "./read-exposures";

test("a read opens a window that remembers recent senders, encrypted and per person", async () => {
  const db = await freshDb();
  try {
    const at = new Date("2026-11-16T01:00:00Z");
    const dek = randomBytes(32);
    const user = await createUser(db, { email: `w-${randomUUID()}@example.test`, wrappedDek: "x" });
    const other = await createUser(db, { email: `o-${randomUUID()}@example.test`, wrappedDek: "y" });
    const agent = await createAgent(db, { userId: user.id, connectionId: randomUUID(), displayName: "Claude", platform: "claude" }, fixedClock(at));
    for (const [n, sender] of ["a@x.co", "b@x.co", "a@x.co", "c@x.co", "d@x.co"].entries()) {
      await recordReadExposure(db, { userId: user.id, agentId: agent.id, source: { service: "Gmail", kind: "email", sender }, at: new Date(at.getTime() + n * 1000) }, dek);
    }
    const open = await activeReadExposure(db, user.id, agent.id, new Date(at.getTime() + 10 * 60_000), dek);
    assert.deepEqual(open?.sources.map((s) => s.sender), ["d@x.co", "c@x.co", "a@x.co"]);
    assert.equal(open?.untilAt.getTime(), at.getTime() + 4000 + READ_WINDOW_MS);
    const raw = await db.query("SELECT * FROM agent_read_exposures WHERE user_id = $1", [user.id]);
    assert.doesNotMatch(JSON.stringify(raw.rows), /x\.co/, "senders are encrypted");
    assert.equal(await activeReadExposure(db, other.id, agent.id, at, dek), null, "another person never sees it");

    const later = new Date(at.getTime() + READ_WINDOW_MS + 5000);
    assert.equal(await activeReadExposure(db, user.id, agent.id, later, dek), null, "the window closes after an hour");
    assert.equal((await db.query("SELECT count(*)::int AS n FROM agent_read_exposures")).rows[0]!.n, 0, "and is cleared");
  } finally {
    await db.close();
  }
});
