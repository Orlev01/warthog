// The in-process job scheduler (E18-S21). A tick does two things:
//
//   1. Runs every periodic sweep whose interval has elapsed, DIRECTLY — no job row is
//      ever enqueued for a sweep. A sweep that throws is logged (redacted) and stops
//      neither the other sweeps nor the drain. "Elapsed" is decided in the database
//      (`sweep_runs`, 0063): a run is claimed with one conditional upsert that moves the
//      sweep's last-run instant forward only once its interval has passed, so a restart
//      does not re-run every sweep, and two instances (overlapping revisions during a
//      deploy) never both run the same sweep in one interval.
//   2. Drains the runnable queue rows through the claim/run library, which dispatches
//      each claimed row by its enqueued `type`. A row whose type has no handler is
//      dead-lettered and a throwing handler is retried with backoff then failed (both by
//      the library); either way the failure is logged (redacted) and the drain carries on
//      with the other due rows.
//
// Ticks never overlap: the interval timer keeps firing while a long tick (a slow sweep, a
// big drain) is still running, and a tick that fires then does nothing — so a sweep never
// runs concurrently with itself and a queue row's claim is never reclaimed by this same
// process while its handler is still running.
//
// Every failure reaches `log` only after redaction, so a card number or token in an error
// message never lands in a log. `getScheduler()` is the process-wide instance built from
// the real seams (src/server/jobs/compose.ts); `createScheduler()` takes injected deps.

import { run, UnknownJobTypeError, type DispatchTable } from "../db/jobs";
import { tryRecord, type MetricSeam } from "../metrics/seam";
import { JOB_FAILURE } from "../metrics/names";
import { redact } from "../../domain/redaction/redact";
import { processSingleton } from "../seams/process-singleton";
import type { Clock } from "../seams/clock";
import type { Db } from "../db/index";
import type { PeriodicSweep } from "./registry";

export type { PeriodicSweep } from "./registry";

export interface SchedulerDeps {
  // Resolved per tick, so constructing a scheduler touches no database.
  readonly getDb: () => Promise<Db>;
  readonly clock: Clock;
  readonly sweeps: readonly PeriodicSweep[];
  readonly dispatch: DispatchTable;
  // Receives every failure, already redacted.
  readonly log: (entry: unknown) => void;
  // Optional, best-effort: every failed sweep or queue row is one `job.failure` event whose
  // outcome is the sweep name or job type (docs/design/admin-portal.md §4) — never the
  // error message or payload.
  readonly recordMetric?: MetricSeam;
}

export interface Scheduler {
  tick(): Promise<unknown>;
}

// A drain processes at most this many rows per tick, so a misbehaving queue can never
// pin a tick in an endless loop.
const MAX_ROWS_PER_TICK = 500;

// A failure as a plain, redacted log entry. Released-value matching is not available
// here, so only the pattern rules apply (card numbers, codes, tokens, secret fields).
function failureEntry(where: string, name: string, error: unknown): unknown {
  const message = error instanceof Error ? error.message : String(error);
  return redact({ level: "error", where, name, error: message }, () => false);
}

// Claim this interval's run of `sweep` at `now`: record `now` as its last run if it has
// never run or last ran at least one interval ago, and report whether this caller won. A
// single statement, so concurrent claimers (two instances) cannot both win, and the state
// lives in the database, so it survives a restart. Bound values only (INV-102).
async function claimSweepRun(db: Db, sweep: PeriodicSweep, now: Date): Promise<boolean> {
  const result = await db.query(
    `INSERT INTO sweep_runs (name, last_run_at) VALUES ($1, $2::timestamptz)
     ON CONFLICT (name) DO UPDATE SET last_run_at = EXCLUDED.last_run_at
      WHERE sweep_runs.last_run_at <= $3::timestamptz
     RETURNING name`,
    [sweep.name, now.toISOString(), new Date(now.getTime() - sweep.intervalMs).toISOString()],
  );
  return result.rows.length > 0;
}

export function createScheduler(deps: SchedulerDeps): Scheduler {
  const { getDb, clock, sweeps, dispatch, log, recordMetric } = deps;
  const recordFailure = (name: string): Promise<void> =>
    tryRecord(recordMetric, { name: JOB_FAILURE, value: 1, dimensions: { outcome: name } });

  // The dispatch table with every handler counting its own failure by job type (the
  // library rethrows a handler's error without the row), so the drain can stay generic.
  const countedDispatch: DispatchTable = Object.fromEntries(
    Object.entries(dispatch).map(([type, handler]) => [type, async (job: Parameters<typeof handler>[0]) => {
      try {
        await handler(job);
      } catch (error) {
        await recordFailure(job.type);
        throw error;
      }
    }]),
  );

  async function runDueSweeps(db: Db): Promise<void> {
    const now = clock.now();
    for (const sweep of sweeps) {
      try {
        if (!(await claimSweepRun(db, sweep, now))) continue;
        await sweep.run();
      } catch (error) {
        log(failureEntry("sweep", sweep.name, error));
        await recordFailure(sweep.name);
      }
    }
  }

  async function drain(db: Db): Promise<void> {
    for (let processed = 0; processed < MAX_ROWS_PER_TICK; processed++) {
      try {
        if ((await run(db, clock, countedDispatch)) === null) return;
      } catch (error) {
        // The library has already dead-lettered or re-queued the row; log and carry on. A
        // row with no handler is counted here by its type (its handler never ran).
        log(failureEntry("drain", "job", error));
        if (error instanceof UnknownJobTypeError) await recordFailure(error.jobType);
      }
    }
  }

  let inFlight = false;
  return {
    async tick(): Promise<void> {
      if (inFlight) return;
      inFlight = true;
      try {
        const db = await getDb();
        await runDueSweeps(db);
        await drain(db);
      } finally {
        inFlight = false;
      }
    },
  };
}

// The process-wide scheduler over the real seams (kept on globalThis, so every module
// graph Next builds shares one). Its seams are composed lazily on the first tick.
export function getScheduler(): Scheduler {
  return processSingleton("jobs.scheduler", () => {
    let inner: Scheduler | undefined;
    return {
      async tick(): Promise<unknown> {
        if (!inner) {
          const { composeScheduler } = await import("./compose");
          inner = await composeScheduler();
        }
        return inner.tick();
      },
    };
  });
}
