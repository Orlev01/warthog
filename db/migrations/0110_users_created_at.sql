-- 0110_users_created_at — when each account was created (docs/design/admin-portal.md §4).
--
-- The brief's operations readiness asks for sign-up counts over time, and the users row
-- (0003) carried no creation instant: sign-ups per day could only be inferred from the
-- hourly users.total snapshot. The column is PLAINTEXT METADATA (an instant, no content),
-- like `email` and `role`, so the admin portal can count sign-ups without any path to
-- vault contents (constitution principle 19).
--
-- Additive and safe on existing data: the column is NULLABLE because an older account whose
-- factors were purged has nothing to backfill from. Existing rows are backfilled from the
-- earliest factor or recovery-code instant that account holds (passkeys 0006, totp_secrets
-- 0010, recovery_codes 0007 all default their created_at to the insert time, and every
-- sign-up writes at least one of them in the same transaction as the user row), so the
-- backfilled value is the sign-up instant within that transaction. LEAST ignores NULLs, so
-- an account with only one kind of factor still gets a value. New rows default to now():
-- createUser takes no clock, exactly like the factor tables this backfills from.
ALTER TABLE users ADD COLUMN created_at timestamptz;
UPDATE users u SET created_at = LEAST(
  (SELECT min(p.created_at) FROM passkeys p WHERE p.user_id = u.id),
  (SELECT min(t.created_at) FROM totp_secrets t WHERE t.user_id = u.id),
  (SELECT min(r.created_at) FROM recovery_codes r WHERE r.user_id = u.id))
WHERE created_at IS NULL;
ALTER TABLE users ALTER COLUMN created_at SET DEFAULT now();
-- Sign-ups per day and the accounts list read WHERE created_at >= $1 ORDER BY created_at.
CREATE INDEX users_created_idx ON users (created_at);
