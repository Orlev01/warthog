// Metric retention (docs/design/admin-portal.md §4): the hourly snapshots and per-minute
// traffic rows add about a thousand rows a day, which is fine for a year but not forever on
// a credit-funded database. The daily `metrics-retention` sweep deletes events older than
// 400 days — long enough for a year-on-year comparison. The cut-off comes from the injected
// clock and travels bound (INV-102); the application role already holds DELETE on the table.

import type { Db } from "../db/index";
import type { Clock } from "../seams/clock";

const DAY_MS = 24 * 60 * 60 * 1000;
export const METRIC_RETENTION_DAYS = 400;

/** Delete metric events recorded before the retention window; returns how many went. */
export async function pruneMetricEvents(db: Db, clock: Clock): Promise<number> {
  const cutoff = new Date(clock.now().getTime() - METRIC_RETENTION_DAYS * DAY_MS).toISOString();
  const result = await db.query("DELETE FROM metric_events WHERE recorded_at < $1::timestamptz RETURNING id", [cutoff]);
  return result.rows.length;
}
