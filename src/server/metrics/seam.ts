// The optional, best-effort metric seam instrumented code paths take (docs/design/admin-portal.md §4).
// A handler built without one records nothing (tests inject a collecting fake); the
// production composition roots supply `metricSeamFor(db, clock)`. `tryRecord` swallows a
// metrics failure: a dashboard number can never fail a person's sign-in, connection or
// job. The guarded recorder still enforces the dimension allowlist, so nothing personal
// can pass through here either.

import type { Db } from "../db/index";
import type { Clock } from "../seams/clock";
import { recordMetricEvent, type RecordMetricInput } from "./record";

export type MetricSeam = (input: RecordMetricInput) => Promise<void>;

export function metricSeamFor(db: Db, clock: Clock): MetricSeam {
  return (input) => recordMetricEvent(db, clock, input);
}

export async function tryRecord(seam: MetricSeam | undefined, input: RecordMetricInput): Promise<void> {
  if (!seam) return;
  try {
    await seam(input);
  } catch {
    // Best effort by design: the caller's own outcome is never changed by a metrics write.
  }
}
