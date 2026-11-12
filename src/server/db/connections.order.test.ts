// listConnectionsForUser returns the person's connections in a DETERMINISTIC order
// (oldest connection first, ties broken by id), so every page and tool that lists them —
// the Connectors page, the agent workspace's account chooser, the export — shows the same
// order on every load instead of whatever order the database happens to return.
//
// Each test uses its own freshDb() (an isolated in-memory PGlite with the real
// migrations) and closes it in a `finally`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

import { createConnection, listConnectionsForUser } from "./connections";
import { createUser } from "./users";
import { freshDb } from "../../test/db";
import { fixedClock } from "../seams/clock";
import type { Db } from "./index";

async function makeUser(db: Db, who: string): Promise<string> {
  const user = await createUser(db, {
    email: `${who}@warthog.com.au`,
    wrappedDek: Buffer.from(`wrapped-dek-${who}`).toString("base64"),
  });
  return user.id;
}

async function connectAt(db: Db, userId: string, label: string, at: string): Promise<string> {
  const created = await createConnection(
    db,
    { userId, connectorId: "fastmail", accountLabel: label, credentials: { token: label } },
    randomBytes(32),
    fixedClock(new Date(at)),
  );
  return created.id;
}

test("listConnectionsForUser lists the oldest connection first, whatever order they were created in", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "order");
    // Created out of chronological order.
    await connectAt(db, userId, "middle", "2026-05-02T00:00:00.000Z");
    await connectAt(db, userId, "newest", "2026-05-03T00:00:00.000Z");
    await connectAt(db, userId, "oldest", "2026-05-01T00:00:00.000Z");

    const labels = (await listConnectionsForUser(db, userId)).map((c) => c.accountLabel);
    assert.deepEqual(labels, ["oldest", "middle", "newest"]);
  } finally {
    await db.close();
  }
});

test("connections made at the same instant keep a stable order (by id)", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ties");
    const same = "2026-05-01T00:00:00.000Z";
    const ids = [
      await connectAt(db, userId, "a", same),
      await connectAt(db, userId, "b", same),
      await connectAt(db, userId, "c", same),
    ];
    const first = (await listConnectionsForUser(db, userId)).map((c) => c.id);
    const second = (await listConnectionsForUser(db, userId)).map((c) => c.id);
    assert.deepEqual(first, [...ids].sort(), "ties fall back to the id order");
    assert.deepEqual(second, first, "the same order on every read");
  } finally {
    await db.close();
  }
});
