-- 0059_job_claim_lease — a claim on a queue row is a LEASE, not a forever lock.
--
-- claim() used to mark a row 'claimed' and nothing ever looked at a claimed row again,
-- so a restart, deploy or crash while its handler ran stranded the job for good (an
-- account reset never completed, an approval fallback was never sent). `claimed_at`
-- records when the current claim was taken; once it is older than the lease the row is
-- claimable again (src/server/db/jobs.ts). Additive and safe on existing data: rows
-- already stranded in 'claimed' have no claimed_at, and claim() treats that as a lapsed
-- lease, so they are recovered on the first tick after this migration.

ALTER TABLE jobs ADD COLUMN claimed_at timestamptz;

CREATE INDEX jobs_claimed_idx ON jobs (claimed_at) WHERE status = 'claimed';
