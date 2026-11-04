-- 0004_sessions — a signed-in person's session (design §5).
--
-- A session gates the whole portal and carries the step-up timestamp. Its id is a
-- random 256-bit value handed to the browser in a `__Host-wh_session` cookie; the
-- server keeps only a one-way hash of it (`token_hash`), never the raw value, so a
-- leak of this table cannot reconstruct a live cookie (project rule: session ids
-- are stored only as hashes).
--
-- The row id (`id`, a uuid) is distinct from the cookie token: it is what later
-- member-scoped code references (the session's own identity) and what recordStepUp
-- addresses, while the token is what the client presents. `user_id` binds the
-- session to its person and cascades on account deletion.
--
-- Expiry is clock-driven in application code (not SQL now()), so both windows are
-- deterministic and testable: `created_at` anchors the 30-day absolute cap and
-- `last_seen_at` the 14-day idle cap, slid forward on every successful verify.
-- `stepped_up_at` is NULL until the person re-authenticates (step-up).

CREATE TABLE sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash    text NOT NULL UNIQUE,
  created_at    timestamptz NOT NULL,
  last_seen_at  timestamptz NOT NULL,
  stepped_up_at timestamptz
);
