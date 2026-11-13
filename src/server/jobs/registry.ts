// The background job registry, in two explicit parts (E18-S21):
//
//   1. PERIODIC SWEEPS the scheduler runs directly on their interval — no job rows: the
//      approvals expire-due sweep, life-admin reminders, exchange rates, account purge,
//      metrics snapshot and the daily integrity check.
//   2. A DISPATCH TABLE for payload-driven queue rows, keyed on the EXACT type strings
//      production code enqueues, imported from the modules that enqueue them (never
//      retyped): approval.fallback, connection.refresh / google_reminder / google_lapse,
//      account_reset.complete.
//
// Each builder takes the superset of seams (`JobSeams`) and closes every handler or sweep
// over the subset it needs, so the composition root (src/server/jobs/compose.ts) supplies
// the real ones once and tests supply fakes. This module reads no process.env.

import { z } from "zod";

import { FALLBACK_JOB_TYPE } from "../notify/approval-notifier";
import { runApprovalFallback } from "../notify/fallback-job";
import { runApprovalExpiry } from "../approvals/expiry-job";
import { runLifeAdminReminders } from "../life-admin/reminders-job";
import { runRatesJob } from "../currency/rates-job";
import { runAccountPurge } from "../account/purge-job";
import type { DeletionJournal } from "../account/deletion-journal";
import { runMetricsSnapshot } from "../metrics/snapshot-job";
import { flushTraffic } from "../http/traffic";
import { reconcileOperatorRole } from "../admin/role";
import { pruneMetricEvents } from "../metrics/retention";
import { runDailyIntegrityCheck } from "../activity/integrity-job";
import { cleanupOAuth } from "../oauth/cleanup";
import {
  createConnectorJobHandler,
  GOOGLE_LAPSE_TYPE,
  GOOGLE_REMINDER_TYPE,
  REFRESH_TYPE,
  type RefreshConnection,
} from "../connectors/jobs";
import { COMPLETE_JOB_TYPE, completeAccountReset, type ResetExecutor } from "../auth/account-reset";
import type { Job, JobHandler } from "../db/jobs";
import type { Db } from "../db/index";
import type { Clock } from "../seams/clock";
import type { Random } from "../seams/random";
import type { KeyWrapper } from "../crypto/key-wrapper";
import type { PushSender, Senders } from "../notify/senders";
import type { RateSource } from "../currency/rate-source";
import type { BlobStore } from "../storage/blob";

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

// One periodic background job the scheduler runs directly on its interval.
export interface PeriodicSweep {
  readonly name: string;
  readonly intervalMs: number;
  readonly run: () => void | Promise<void>;
}

// The superset of seams every handler and sweep is wired from.
export interface JobSeams {
  readonly db: Db;
  readonly getPurgeDb?: () => Promise<Db>;
  readonly clock: Clock;
  readonly keyWrapper: KeyWrapper;
  readonly random: Random;
  readonly senders: Senders;
  readonly push: PushSender;
  readonly refresh: RefreshConnection;
  readonly resetExecutor: ResetExecutor;
  readonly rateSource: RateSource;
  readonly blobStore: BlobStore; // receipt ciphertext, deleted by the account purge
  readonly deletionJournal?: DeletionJournal;
  readonly publicBaseUrl: string;
  // The configured operator address the `operator-role` sweep promotes to admin
  // (docs/design/admin-portal.md §2); absent outside production when unset.
  readonly operatorEmail?: string;
}

// A payload that names one approval (approval.fallback rows carry it).
const approvalPayload = z.object({ approvalId: z.string() });
// A payload that names one person (account_reset.complete rows carry it).
const userPayload = z.object({ userId: z.string() });

function payloadOf<T>(schema: z.ZodType<T>, job: Job): T {
  const parsed = schema.safeParse(job.payload);
  if (!parsed.success) throw new Error(`job ${job.type} has a malformed payload`);
  return parsed.data;
}

// The dispatch table: enqueued `type` → the handler that runs a claimed row of that type.
export function buildDispatchTable(seams: JobSeams): Record<string, JobHandler> {
  const connector = createConnectorJobHandler({
    db: seams.db,
    clock: seams.clock,
    push: seams.push,
    refresh: seams.refresh,
  });
  return {
    [FALLBACK_JOB_TYPE]: (job) =>
      runApprovalFallback(
        {
          db: seams.db,
          clock: seams.clock,
          random: seams.random,
          senders: seams.senders,
          publicBaseUrl: seams.publicBaseUrl,
        },
        payloadOf(approvalPayload, job),
      ),
    [REFRESH_TYPE]: connector,
    [GOOGLE_REMINDER_TYPE]: connector,
    [GOOGLE_LAPSE_TYPE]: connector,
    // A reset cancelled in its waiting week is no longer pending: completion reports
    // ok:false and there is nothing to do, so that is not a failure.
    [COMPLETE_JOB_TYPE]: async (job) => {
      await completeAccountReset(seams.db, payloadOf(userPayload, job), { executor: seams.resetExecutor, clock: seams.clock });
    },
  };
}

// Expire every pending approval whose expiry has passed. One approval that fails to
// expire does not stop the rest; the failures are reported together afterwards.
async function expireDueApprovals(seams: JobSeams): Promise<void> {
  const due = await seams.db.query(
    "SELECT id FROM approvals WHERE status = 'pending' AND expires_at <= $1::timestamptz",
    [seams.clock.now().toISOString()],
  );
  const failures: unknown[] = [];
  for (const row of due.rows) {
    try {
      await runApprovalExpiry(
        { db: seams.db, clock: seams.clock, keyWrapper: seams.keyWrapper },
        { approvalId: row.id as string },
      );
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, `approval-expiry: ${failures.length} approval(s) failed to expire`);
  }
}

// The periodic sweeps, run directly by the scheduler on their interval.
export function buildPeriodicSweeps(seams: JobSeams): readonly PeriodicSweep[] {
  return [
    { name: "approval-expiry", intervalMs: MINUTE_MS, run: () => expireDueApprovals(seams) },
    {
      name: "life-admin-reminders",
      intervalMs: HOUR_MS,
      run: () => runLifeAdminReminders({ db: seams.db, clock: seams.clock, push: seams.push }),
    },
    {
      name: "exchange-rates",
      intervalMs: DAY_MS,
      run: async () => {
        await runRatesJob({ db: seams.db, source: seams.rateSource });
      },
    },
    {
      name: "account-purge",
      intervalMs: HOUR_MS,
      run: async () => {
        await runAccountPurge(seams.getPurgeDb ? await seams.getPurgeDb() : seams.db,
          { blobStore: seams.blobStore, journal: seams.deletionJournal });
      },
    },
    { name: "metrics-snapshot", intervalMs: HOUR_MS, run: () => runMetricsSnapshot(seams.db, seams.clock) },
    { name: "oauth-cleanup", intervalMs: HOUR_MS, run: async () => {
      await cleanupOAuth(seams.db, seams.clock.now());
      await seams.db.query("DELETE FROM data_imports WHERE created_at < $1", [new Date(seams.clock.now().getTime() - DAY_MS).toISOString()]);
    } },
    {
      name: "daily-integrity-check",
      intervalMs: DAY_MS,
      run: () => runDailyIntegrityCheck({ db: seams.db, clock: seams.clock, senders: seams.senders }),
    },
    // The admin portal's sweeps (docs/design/admin-portal.md §4): the proxy's traffic counts
    // become metric rows once a minute; the configured operator is promoted to admin hourly
    // (the first tick after boot included); metric rows older than 400 days are pruned daily.
    { name: "traffic-flush", intervalMs: MINUTE_MS, run: async () => { await flushTraffic(seams.db, seams.clock); } },
    { name: "operator-role", intervalMs: HOUR_MS, run: async () => { await reconcileOperatorRole(seams.db, seams.operatorEmail); } },
    { name: "metrics-retention", intervalMs: DAY_MS, run: async () => { await pruneMetricEvents(seams.db, seams.clock); } },
  ];
}
