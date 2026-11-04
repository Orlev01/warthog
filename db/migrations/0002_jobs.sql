-- 0002_jobs — the background jobs queue.
--
-- Background work (connection refresh, reminders, provider fallback, integrity
-- checks, account purge) runs in-process off this one table. Each unit of work
-- is a row: `claim` hands out one DUE row at a time with FOR UPDATE SKIP LOCKED
-- so two concurrent workers never take the same job, and `run` marks a job done
-- on success (never re-run — idempotent) or returns it to the queue on failure
-- (retried on a later run).
--
-- Due time (`run_at`) is driven by the application's injected clock, not SQL
-- now(), so "due" is deterministic and testable. `status` moves pending →
-- claimed → done, and back to pending on a retry; `attempts` records how many
-- times the job has been handed out.

CREATE TABLE jobs (
  id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type     text NOT NULL,
  payload  jsonb,
  run_at   timestamptz NOT NULL,
  status   text NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0
);

-- The claim hot path probes for the oldest still-pending, now-due job. A partial
-- index over just the pending rows keeps that probe cheap as finished jobs pile up.
CREATE INDEX jobs_claimable_idx ON jobs (run_at) WHERE status = 'pending';
