-- 0063_sweep_runs — when each periodic sweep last ran, shared by every scheduler instance
-- and kept across restarts (src/server/jobs/scheduler.ts).
--
-- The in-process scheduler kept "when did this sweep last run" in memory, so every deploy
-- or restart re-ran every sweep on its first tick (re-sending integrity alerts,
-- duplicating metric snapshots), and two revisions overlapping during a deploy both ran
-- every sweep. A sweep run is now CLAIMED here first with one conditional upsert: only the
-- instance whose claim moves `last_run_at` forward — because the sweep's interval has
-- passed — runs it. Additive (a new table); safe on existing data: no row means "never
-- ran", so each sweep runs once on the first tick after this migration, as before.

CREATE TABLE sweep_runs (
  name        text PRIMARY KEY,
  last_run_at timestamptz NOT NULL
);
