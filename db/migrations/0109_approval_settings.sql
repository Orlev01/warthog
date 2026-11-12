-- 0109_approval_settings — the per-person approval expiry (brief "Rules and approvals":
-- rules include "an approval expiry time"; "approvals expire after the configured time
-- (default 15 minutes, adjustable from 2 minutes to 24 hours) and an expired request is
-- denied").
--
-- PLAINTEXT METADATA: a whole number of minutes the pipeline reads when it holds a call,
-- so, like the account currency, it is not DEK-encrypted and holds no secret. One row per
-- person (`user_id` is the PRIMARY KEY, so a set upserts in place), cascading on account
-- deletion and purge. Every read/write is member-scoped by the session's user id. No row
-- means the person has set nothing and the 15-minute default is assembled in code; the
-- CHECK is a schema-level backstop for the range the store validates before any write.
-- A change applies to requests held from then on; approvals already waiting keep theirs.
CREATE TABLE approval_settings (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  expiry_minutes integer NOT NULL CHECK (expiry_minutes BETWEEN 2 AND 1440),
  updated_at timestamptz NOT NULL
);
GRANT SELECT, INSERT, UPDATE, DELETE ON approval_settings TO warthog_app;
