-- 0111_admin_sessions — the admin portal's handoff and session (docs/design/admin-portal.md §2).
--
-- The portal at admin.warthog.com.au never authenticates anyone itself: passkeys are scoped
-- to the app's RP ID, and `__Host-` cookies never cross hosts. Instead the app host, for a
-- signed-in ADMIN with a FRESH step-up, mints a single-use HANDOFF token; the admin host
-- exchanges it once for its own `__Host-wh_admin` session. Both live in this one row:
--
--   handoff_hash / handoff_expires_at — the 60-second, single-use proof (SHA-256 of the
--                                       token, never the token); NULL handoff_hash once used.
--   token_hash                        — the admin session token's SHA-256, set by the
--                                       exchange; NULL until then.
--   created_at / last_seen_at         — the 12-hour absolute and 60-minute idle windows,
--                                       clock-driven in application code (not SQL now()).
--   exchanged_at                      — when the proof became a session (NULL until then).
--
-- `session_id` REFERENCES sessions(id) ON DELETE CASCADE is the revocation mechanism: every
-- existing path that ends the app session (sign-out, "sign out this session", recovery,
-- account reset, deletion and purge) ends admin access with no new code. `user_id` cascades
-- on account deletion too and lets the verify re-check the person's role and tombstone on
-- every request. Plaintext metadata only: hashes and instants, no content.
CREATE TABLE admin_sessions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id         uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  user_id            uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  handoff_hash       text UNIQUE,
  handoff_expires_at timestamptz NOT NULL,
  token_hash         text UNIQUE,
  created_at         timestamptz NOT NULL,
  exchanged_at       timestamptz,
  last_seen_at       timestamptz NOT NULL
);
-- Minting replaces a session's unexchanged handoff; verify and sign-out look up by token.
CREATE INDEX admin_sessions_session_idx ON admin_sessions (session_id);
-- 0094 granted on the tables that existed then; a new table needs its own grant.
GRANT SELECT, INSERT, UPDATE, DELETE ON admin_sessions TO warthog_app;
