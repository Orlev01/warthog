// Job failure metrics (docs/design/admin-portal.md §4): every failed sweep or queue row is one
// `job.failure` event whose outcome is the sweep name or the job type — never the error
// message or payload. Successes record nothing; the seam is optional and best effort.
import { test } from "node:test";
import assert from "node:assert/strict";

import { createScheduler } from "./scheduler";
import { enqueue } from "../db/jobs";
import { freshDb } from "../../test/db";
import { fixedClock } from "../seams/clock";
import type { RecordMetricInput } from "../metrics/record";

const T0 = new Date("2026-11-13T01:00:00Z");

test("a failing sweep, a throwing handler and a row with no handler are each one job.failure named by sweep or type", async () => {
  const db = await freshDb();
  try {
    const metrics: RecordMetricInput[] = [];
    const scheduler = createScheduler({
      getDb: async () => db, clock: fixedClock(T0), log: () => {},
      sweeps: [
        { name: "fine-sweep", intervalMs: 60_000, run: async () => {} },
        { name: "broken-sweep", intervalMs: 60_000, run: async () => { throw new Error("card 4111 1111 1111 1111 leaked"); } },
      ],
      dispatch: { "job.ok": async () => {}, "job.bad": async () => { throw new Error("handler failed"); } },
      recordMetric: async (m) => { metrics.push(m); },
    });
    await enqueue(db, { type: "job.ok", runAt: new Date(T0.getTime() - 1000) });
    await enqueue(db, { type: "job.bad", runAt: new Date(T0.getTime() - 1000) });
    await enqueue(db, { type: "job.orphan", runAt: new Date(T0.getTime() - 1000) });
    await scheduler.tick();

    const outcomes = metrics.map((m) => [m.name, m.value, m.dimensions?.outcome]).sort((a, b) => String(a[2]).localeCompare(String(b[2])));
    assert.deepEqual(outcomes, [["job.failure", 1, "broken-sweep"], ["job.failure", 1, "job.bad"], ["job.failure", 1, "job.orphan"]]);
    assert.ok(!JSON.stringify(metrics).includes("4111") && !JSON.stringify(metrics).includes("failed"), "no message in metrics");
  } finally {
    await db.close();
  }
});

test("a throwing seam neither fails the tick nor changes the queue's outcome", async () => {
  const db = await freshDb();
  try {
    const scheduler = createScheduler({
      getDb: async () => db, clock: fixedClock(T0), log: () => {}, sweeps: [{ name: "broken", intervalMs: 60_000, run: async () => { throw new Error("x"); } }],
      dispatch: { "job.bad": async () => { throw new Error("y"); } }, recordMetric: async () => { throw new Error("metrics down"); },
    });
    const row = await enqueue(db, { type: "job.bad", runAt: new Date(T0.getTime() - 1000) });
    await scheduler.tick();
    const status = (await db.query("SELECT status FROM jobs WHERE id = $1", [row.id])).rows[0]!.status;
    assert.equal(status, "pending", "the row is re-queued for retry exactly as before");
  } finally {
    await db.close();
  }
});
