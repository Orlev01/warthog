// A Google early-access lapse is one `connector.refresh` event with outcome `lapsed` for
// its connector (docs/design/admin-portal.md §4); a reminder records nothing; a failed
// renewal is recorded by the renewal itself, so the job handler records nothing for it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

import { createConnectorJobHandler, scheduleGoogleLapse } from "./jobs";
import { run } from "../db/jobs";
import { createConnection } from "../db/connections";
import { createUser } from "../db/users";
import { freshDb } from "../../test/db";
import type { RecordMetricInput } from "../metrics/record";

test("the lapse job records the connector's lapse; the reminder and a failed renewal record nothing here", async () => {
  const db = await freshDb();
  try {
    let current = new Date("2026-11-01T00:00:00Z").getTime();
    const clock = { now: () => new Date(current) };
    const dek = randomBytes(32);
    const user = await createUser(db, { email: "lapse@example.test", wrappedDek: "wrapped" });
    const connection = await createConnection(db, { userId: user.id, connectorId: "google-gmail", accountLabel: "person@gmail.test", credentials: { access_token: "a", refresh_token: "r" }, status: "connected" }, dek, clock);
    await scheduleGoogleLapse(db, { userId: user.id, connectionId: connection.id, connectedAt: clock.now() });
    const metrics: RecordMetricInput[] = [];
    const handler = createConnectorJobHandler({ db, clock, push: { sendPush: async () => {} }, refresh: async () => { throw new Error("provider down"); }, recordMetric: async (m) => { metrics.push(m); } });

    current += 8 * 24 * 60 * 60 * 1000; // past the reminder and the lapse
    while ((await run(db, clock, handler)) !== null) { /* drain */ }

    assert.deepEqual(metrics.map((m) => [m.name, m.value, m.dimensions?.connectorId, m.dimensions?.outcome]), [["connector.refresh", 1, "google-gmail", "lapsed"]]);
    assert.ok(!JSON.stringify(metrics).includes("gmail.test"), "no account label in metrics");
  } finally {
    await db.close();
  }
});
