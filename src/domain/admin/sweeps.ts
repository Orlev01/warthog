// The periodic sweeps' intervals, as the admin portal judges staleness (docs/design/admin-portal.md §5).
// A local copy of the registry's names and intervals (src/server/jobs/registry.ts), pinned
// by a test that builds the real registry and compares, so the portal needs none of the
// registry's runtime seams to say whether a sweep is overdue.

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

export const SWEEP_INTERVALS: Readonly<Record<string, number>> = {
  "approval-expiry": MINUTE_MS,
  "life-admin-reminders": HOUR_MS,
  "exchange-rates": DAY_MS,
  "account-purge": HOUR_MS,
  "metrics-snapshot": HOUR_MS,
  "oauth-cleanup": HOUR_MS,
  "daily-integrity-check": DAY_MS,
  "traffic-flush": MINUTE_MS,
  "operator-role": HOUR_MS,
  "metrics-retention": DAY_MS,
};

/** A sweep is overdue once its last run is older than twice its interval (or it has never run
 * while others have: the scheduler is ticking but this sweep is not). */
export function sweepOverdue(name: string, lastRunAt: Date | null, now: Date, schedulerTicked: boolean): boolean {
  const interval = SWEEP_INTERVALS[name];
  if (interval === undefined) return false;
  if (lastRunAt === null) return schedulerTicked;
  return now.getTime() - lastRunAt.getTime() > 2 * interval;
}
