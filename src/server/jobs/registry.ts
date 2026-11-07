// E18-S09 — Background job registry.
//
// The single auditable ignition list of every in-process background job built across
// E09–E17. The scheduler (E18-S10) and instrumentation (E18-S11) read this registry to
// know which jobs to run and tick: each entry has a stable machine name (so it is
// loggable and auditable), its handler (the job module's run function) and the
// interval in milliseconds the scheduler ticks it on.
//
// The handler of each entry is the REAL job module's exported run function — no
// re-implementation, no wrapper. Seven jobs have a single dedicated run function; the
// two connector jobs (token-refresh and health) share one module whose dispatcher
// (`createConnectorJobHandler`) routes both kinds of connector work by job type.

import { runApprovalFallback } from "../notify/fallback-job";
import { runApprovalExpiry } from "../approvals/expiry-job";
import { runLifeAdminReminders } from "../life-admin/reminders-job";
import { runRatesJob } from "../currency/rates-job";
import { runAccountPurge } from "../account/purge-job";
import { runMetricsSnapshot } from "../metrics/snapshot-job";
import { runDailyIntegrityCheck } from "../activity/integrity-job";
import { createConnectorJobHandler } from "../connectors/jobs";

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

// One in-process background job: a stable machine name, the handler that runs it (the
// corresponding job module's run function / runnable export), and the interval in
// milliseconds the scheduler ticks it on.
export interface JobRegistryEntry {
  readonly name: string;
  readonly handler: (...args: never[]) => unknown;
  readonly intervalMs: number;
}

// The auditable enumeration of every background job, exactly once.
export const jobRegistry: readonly JobRegistryEntry[] = [
  // The two connector jobs share the connectors/jobs dispatcher, which routes a due
  // refresh or health job to its handler by type off the background-jobs queue.
  { name: "connector-token-refresh", handler: createConnectorJobHandler, intervalMs: 5 * MINUTE_MS },
  { name: "connector-health", handler: createConnectorJobHandler, intervalMs: HOUR_MS },
  { name: "approval-fallback", handler: runApprovalFallback, intervalMs: MINUTE_MS },
  { name: "approval-expiry", handler: runApprovalExpiry, intervalMs: MINUTE_MS },
  { name: "life-admin-reminders", handler: runLifeAdminReminders, intervalMs: HOUR_MS },
  { name: "exchange-rates", handler: runRatesJob, intervalMs: DAY_MS },
  { name: "account-purge", handler: runAccountPurge, intervalMs: HOUR_MS },
  { name: "metrics-snapshot", handler: runMetricsSnapshot, intervalMs: HOUR_MS },
  { name: "daily-integrity-check", handler: runDailyIntegrityCheck, intervalMs: DAY_MS },
];
