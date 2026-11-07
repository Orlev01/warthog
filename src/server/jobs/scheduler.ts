// E18-S10 — In-process job scheduler.
//
// Background work runs in-process from a SINGLE per-process scheduler. On each tick it
// does two things, in order:
//   1. enqueues every periodic job that has come due (one row per due job, keyed on the
//      job's name as the row `type`), and
//   2. drains the runnable rows out of the `jobs` table through the claim/run library
//      (`../db/jobs`), dispatching each claimed row to the handler registered for its
//      `type` — exactly as the connector dispatcher routes work by `job.type`.
//
// Using `run()` (FOR UPDATE SKIP LOCKED under the hood) keeps every run idempotent: a
// row is claimed and marked done inside the claim statement, so a row already claimed by
// another tick is skipped and a processed row is never run a second time.
//
// Time comes from the injected Clock (never `Date.now()` / SQL `now()`), so "due" is
// deterministic and tests move time forward without touching the wall clock. The scheduler
// reads no `process.env` and holds no secret (INV-103): `createScheduler` runs purely from
// its injected db source, clock and job set, and the memoised `getScheduler()` reads the
// database URL only through config (via `getServerDb()`), never arbitrary environment.

import { enqueue, run, type Job } from "../db/jobs";
import { getServerDb } from "../db/server";
import { systemClock, type Clock } from "../seams/clock";
import { processSingleton } from "../seams/process-singleton";
import type { Db } from "../db/index";

// One periodic background job the scheduler ticks. `name` is matched against a claimed
// row's `type` to dispatch it; `intervalMs` is the schedule it is enqueued on; `handler`
// is run for a claimed row of that type.
export interface SchedulerJob {
  readonly name: string;
  readonly intervalMs: number;
  readonly handler: (job: Job) => void | Promise<void>;
}

export interface SchedulerDeps {
  // Resolved per tick (a lazy db source), so the memoised per-process instance can be
  // constructed without opening a database.
  readonly getDb: () => Promise<Db>;
  readonly clock: Clock;
  readonly jobs: readonly SchedulerJob[];
}

export interface Scheduler {
  tick(): Promise<unknown>;
}

// Build a scheduler over an injected db source, clock and job set. The periodic schedule
// is per-instance in-memory state: `nextEnqueueAt` records, per job name, the instant it
// is next due to be enqueued (absent means "due now", so a job is enqueued on the first
// tick that sees it).
export function createScheduler(deps: SchedulerDeps): Scheduler {
  const { getDb, clock, jobs } = deps;
  const nextEnqueueAt = new Map<string, number>();

  // Dispatch a claimed row to the handler registered for its type. An unregistered type
  // is an anomaly, surfaced rather than silently swallowed (run() returns it to the queue
  // with a backoff when a handler throws).
  async function dispatch(job: Job): Promise<void> {
    const registered = jobs.find((entry) => entry.name === job.type);
    if (!registered) {
      throw new Error(`No job registered for type "${job.type}"`);
    }
    await registered.handler(job);
  }

  return {
    async tick(): Promise<void> {
      const db = await getDb();
      const nowMs = clock.now().getTime();

      // Enqueue every periodic job that is due, scheduling the next run one interval out
      // from now so a slow tick never floods the queue with catch-up rows.
      for (const job of jobs) {
        const dueAt = nextEnqueueAt.get(job.name) ?? nowMs;
        if (nowMs >= dueAt) {
          await enqueue(db, { type: job.name, runAt: new Date(nowMs) });
          nextEnqueueAt.set(job.name, nowMs + job.intervalMs);
        }
      }

      // Drain every runnable row through the claim/run library. Each run() claims one due
      // row and, on success, marks it done, so the queue strictly shrinks and the loop
      // ends when nothing is due.
      while ((await run(db, clock, dispatch)) !== null) {
        // keep draining
      }
    },
  };
}

// The single per-process scheduler. Memoised on globalThis (via processSingleton) so it
// is never re-instantiated per call and one instance survives Next's module duplication.
// It stays lazy: the database is opened only when a tick calls `getServerDb()`, which
// reads the database URL from config and selects the in-process PGlite Queryable for a
// `pglite:` URL (the in-memory dev seam) or the real pool for a `postgres://` one.
//
// The real job registry (E18-S09) is adapted into runnable `SchedulerJob`s — each job's
// handler closed over its own seams (push/refresh/fetch/…) — at the composition root; that
// wiring is out of this task's scope (`scheduler.ts`, config), so the per-process instance
// is delivered as the memoised tick engine with no jobs wired yet.
export function getScheduler(): Scheduler {
  return processSingleton("jobs.scheduler", () =>
    createScheduler({ getDb: getServerDb, clock: systemClock, jobs: [] }),
  );
}
