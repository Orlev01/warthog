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
//     after a short backoff, so a later run retries it.
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

// Claim the next due job and run `handler` on it. On success the job is marked done
// so it is never claimed again (idempotent). On failure the job is returned to the
// queue — due again after a backoff — and the error is surfaced, never swallowed.
// Returns the processed job, or null when nothing was due.
export async function run(
  db: Db,
  clock: Clock,
  handler: (job: Job) => Promise<void>,
): Promise<Job | null> {
  const job = await claim(db, clock);
  if (job == null) return null;

  try {
    await handler(job);
  } catch (error) {
    const retryAt = new Date(clock.now().getTime() + RETRY_BACKOFF_MS).toISOString();
    await db.query("UPDATE jobs SET status = 'pending', run_at = $2::timestamptz WHERE id = $1", [
      job.id,
      retryAt,
    ]);
    throw error;
  }

  await db.query("UPDATE jobs SET status = 'done' WHERE id = $1", [job.id]);
  return job;
}
