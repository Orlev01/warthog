import { test } from "node:test";
import assert from "node:assert/strict";

import { buildPeriodicSweeps, type JobSeams } from "../../server/jobs/registry";
import { SWEEP_INTERVALS, sweepOverdue } from "./sweeps";

test("the portal's sweep interval table matches the registry exactly", () => {
  // The builders only assemble closures, so a structural placeholder is enough to read them.
  const sweeps = buildPeriodicSweeps({} as unknown as JobSeams);
  assert.deepEqual(
    Object.fromEntries(sweeps.map((s) => [s.name, s.intervalMs])),
    SWEEP_INTERVALS,
  );
});

test("a sweep is overdue after twice its interval, or when it never ran while the scheduler ticks", () => {
  const now = new Date("2026-11-13T10:00:00Z");
  assert.equal(sweepOverdue("exchange-rates", new Date("2026-11-12T09:00:00Z"), now, true), false, "25 hours, within 2 days");
  assert.equal(sweepOverdue("exchange-rates", new Date("2026-11-10T09:00:00Z"), now, true), true, "over 2 days");
  assert.equal(sweepOverdue("traffic-flush", null, now, false), false, "nothing has run yet: the scheduler may be starting");
  assert.equal(sweepOverdue("traffic-flush", null, now, true), true);
  assert.equal(sweepOverdue("unknown-sweep", null, now, true), false);
});
