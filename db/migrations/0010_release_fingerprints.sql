-- 0010_release_fingerprints — the released-value fingerprint store (design §4.2/§4.3).
--
-- On a release, after step-up, the server holds the handed-over value only in the
-- in-memory release store and NEVER writes it to the database. What it persists
-- here instead is a keyed, one-way FINGERPRINT of that value —
-- HMAC-SHA256(HKDF(DEK, `warthog/fp/v1`), normalised value) — kept 90 days, so a
-- later redaction pass can mask any tool call that contains a previously released
-- value by looking the token's fingerprint up here, without the value itself ever
-- being stored (project rule: no high-tier value in plaintext anywhere).
--
-- `fingerprint` is a hex HMAC digest (opaque to this table, one-way by
-- construction); the plaintext value is never a column. `user_id` binds the row to
-- its person and cascades on account deletion — every lookup is member-scoped by
-- this id (never an id from the client). Expiry is clock-driven in application code
-- (not SQL now()), so `expires_at` is set to now + 90 days at store time, making the
-- 90-day window deterministic and testable.

CREATE TABLE release_fingerprints (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  fingerprint text NOT NULL,
  expires_at  timestamptz NOT NULL
);

-- The lookup hot path reads one person's still-live fingerprints
-- (WHERE user_id = $1 AND expires_at > now), so index both columns of that filter.
CREATE INDEX release_fingerprints_lookup_idx ON release_fingerprints (user_id, expires_at);
