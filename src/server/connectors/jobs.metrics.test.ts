// The connector job handler records no metric itself: a failed renewal is recorded by the
// renewal (runtime.ts), and Google connections no longer lapse on Warthog's own 7-day clock
// (docs/adr/google-published-and-accounts.md), so a lapse queued before that records nothing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

import { createConnectorJobHandler, GOOGLE_LAPSE_TYPE, GOOGLE_REMINDER_TYPE } from "./jobs";
import { enqueue, run } from "../db/jobs";
import { createConnection, getConnectionById } from "../db/connections";
import { createUser } from "../db/users";
import { freshDb } from "../../test/db";

test("a queued Google reminder or lapse records nothing and leaves the connection connected", async () => {
  const db = await freshDb();
  try {
    let current = new Date("2026-11-01T00:00:00Z").getTime();
    const clock = { now: () => new Date(current) };
    const dek = randomBytes(32);
    const user = await createUser(db, { email: "lapse@example.test", wrappedDek: "wrapped" });
    const connection = await createConnection(db, { userId: user.id, connectorId: "google-gmail", accountLabel: "person@gmail.test", credentials: { access_token: "a", refresh_token: "r" }, status: "connected" }, dek, clock);
    await enqueue(db, { type: GOOGLE_REMINDER_TYPE, payload: { userId: user.id, connectionId: connection.id }, runAt: new Date(current + 6 * 86_400_000) });
    await enqueue(db, { type: GOOGLE_LAPSE_TYPE, payload: { userId: user.id, connectionId: connection.id }, runAt: new Date(current + 7 * 86_400_000) });
    const handler = createConnectorJobHandler({ db, clock, push: { sendPush: async () => { throw new Error("no push expected"); } }, refresh: async () => { throw new Error("provider down"); } });

    current += 8 * 24 * 60 * 60 * 1000; // past both
    while ((await run(db, clock, handler)) !== null) { /* drain */ }

    assert.equal((await getConnectionById(db, user.id, connection.id))?.status, "connected");
  } finally {
    await db.close();
  }
});
