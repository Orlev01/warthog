// Background jobs: the queue table's data access plus the claim/run library.
//
// Background work (connection refresh, reminders, provider fallback, integrity
// checks, account purge) runs in-process off the `jobs` table. This module makes
// two guarantees:
//   • claim() hands out ONE due job at a time with FOR UPDATE SKIP LOCKED, so two
//     concurrent (or serial) claimers never take the same job — the row is marked
//     claimed inside the very statement that selects it.
//   • run() is idempotent: a job whose handler SUCCEEDS is marked done and is never
//     claimed again; a job whose handler THROWS is returned to the queue, due again
//     after a backoff, until MAX_ATTEMPTS, then failed; a job whose type has no
//     handler is failed at once (dead-lettered).
//
// Time comes from the injected Clock, never SQL now(), so "due" is deterministic
// and tests can move time forward without touching the wall clock. Every statement
// is parameterized (INV-102); jsonb payloads round-trip structurally.

import type { Clock } from "../seams/clock";
import type { Db, Row } from "./index";

// A background job row, as handed to callers of claim/run.
export interface Job {
  readonly id: string;
  readonly type: string;
  readonly payload?: unknown;
  readonly runAt: Date;
  readonly attempts: number;
}

// What enqueue() needs to schedule a job. `payload` is optional — a job may carry
// no data of its own.
export interface NewJob {
  readonly type: string;
  readonly payload?: unknown;
  readonly runAt: Date;
}

// A failed job is retried, but not instantly: it becomes due again a short while
// later, so a transient fault has time to clear and a hot loop cannot spin on it.
const RETRY_BACKOFF_MS = 60_000;

// The columns every read returns, kept in one place so claim and enqueue hand back
// the same shape.
const RETURNING = "id, type, payload, run_at, attempts";

// Map a raw row to a Job. jsonb comes back already parsed; a NULL payload (a job
// with no data) is surfaced as undefined rather than null.
function toJob(row: Row): Job {
  return {
    id: row.id as string,
    type: row.type as string,
    payload: row.payload ?? undefined,
    runAt: new Date(row.run_at as string | number | Date),
    attempts: Number(row.attempts),
  };
}

// Schedule a background job due at `runAt`; returns the created row (with its id).
export async function enqueue(db: Db, job: NewJob): Promise<Job> {
  const result = await db.query(
    `INSERT INTO jobs (type, payload, run_at)
     VALUES ($1, $2::jsonb, $3::timestamptz)
     RETURNING ${RETURNING}`,
    [
      job.type,
      job.payload === undefined ? null : JSON.stringify(job.payload),
      job.runAt.toISOString(),
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error("enqueue: INSERT returned no row");
  return toJob(row);
}

// Claim ONE due job (run_at <= now), marking it claimed in the same statement so a
// later or concurrent claim never hands out the same job. FOR UPDATE SKIP LOCKED
// makes a concurrent claimer skip a row another is already taking. Returns the
// claimed job, or null when nothing is due.
export async function claim(db: Db, clock: Clock): Promise<Job | null> {
  const result = await db.query(
    `UPDATE jobs
        SET status = 'claimed', attempts = attempts + 1
      WHERE id = (
              SELECT id FROM jobs
               WHERE status = 'pending' AND run_at <= $1::timestamptz
               ORDER BY run_at
               FOR UPDATE SKIP LOCKED
               LIMIT 1
            )
      RETURNING ${RETURNING}`,
    [clock.now().toISOString()],
  );
  const row = result.rows[0];
  return row ? toJob(row) : null;
}

// A handler for one claimed row, and the dispatch table the runner routes rows through:
// the row's enqueued `type` names its handler.
export type JobHandler = (job: Job) => void | Promise<void>;
export type DispatchTable = Readonly<Record<string, JobHandler>>;

// A row whose handler keeps throwing is retried with an exponential backoff (1, 2, 4, 8 …
// minutes) and, once it has used this many attempts, marked failed rather than re-queued
// for ever.
export const MAX_ATTEMPTS = 5;

// Raised (after the row is dead-lettered) when a claimed row's type has no handler.
export class UnknownJobTypeError extends Error {
  constructor(readonly jobType: string) {
    super(`No handler for job type "${jobType}"; the row was marked failed`);
    this.name = "UnknownJobTypeError";
  }
}

// Claim the next due job and run the handler its type names in `dispatch`. On success the
// job is marked done so it is never claimed again (idempotent). A type with no handler is
// dead-lettered (marked failed, never retried). A handler that throws returns the row to
// the queue after a backoff, until MAX_ATTEMPTS, then marks it failed. Every failure is
// surfaced to the caller (thrown), never swallowed. Returns the processed job, or null
// when nothing was due.
// `dispatch` may also be a single handler that takes every type (callers that run one
// queue of their own, e.g. the connector jobs' tests).
export async function run(
  db: Db,
  clock: Clock,
  dispatch: DispatchTable | JobHandler,
): Promise<Job | null> {
  const job = await claim(db, clock);
  if (job == null) return null;

  const handler =
    typeof dispatch === "function"
      ? dispatch
      : Object.hasOwn(dispatch, job.type)
        ? dispatch[job.type]
        : undefined;
  if (!handler) {
    await db.query("UPDATE jobs SET status = 'failed' WHERE id = $1", [job.id]);
    throw new UnknownJobTypeError(job.type);
  }

  try {
    await handler(job);
  } catch (error) {
    if (job.attempts >= MAX_ATTEMPTS) {
      await db.query("UPDATE jobs SET status = 'failed' WHERE id = $1", [job.id]);
    } else {
      const backoff = RETRY_BACKOFF_MS * 2 ** Math.max(0, job.attempts - 1);
      const retryAt = new Date(clock.now().getTime() + backoff).toISOString();
      await db.query("UPDATE jobs SET status = 'pending', run_at = $2::timestamptz WHERE id = $1", [
        job.id,
        retryAt,
      ]);
    }
    throw error;
  }

  await db.query("UPDATE jobs SET status = 'done' WHERE id = $1", [job.id]);
  return job;
}
