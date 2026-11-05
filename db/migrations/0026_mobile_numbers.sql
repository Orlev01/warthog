-- 0026_mobile_numbers — the verified mobile-number store (design §10 Notifications,
-- brief "SMS fallback").
--
-- The approval SMS fallback delivers only to a VERIFIED number. A person adds a
-- mobile number; Warthog draws a 6-digit code, stores ONLY a keyed HMAC of it
-- (`code_hmac`) with an expiry (`code_expires_at`), and sends the code by SMS. The
-- code is a credential, so — per the project rule that codes are stored only as an
-- HMAC and appear in plain text nowhere except the single message that delivers a
-- person their own code (here that message is the SMS) — this table never holds the
-- raw code. The person presents the code back; a correct, unexpired code sets
-- `verified` and `verified_at`.
--
-- `user_id` binds the row to its person and cascades on account deletion — every
-- read/write is member-scoped by this id (never an id from the client). `number` is
-- plaintext metadata (the destination the SMS fallback dials). Time is clock-driven
-- in application code (not SQL now()), so `created_at`, `code_expires_at` and
-- `verified_at` are the injected clock's instants.

CREATE TABLE mobile_numbers (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  number          text NOT NULL,
  verified        boolean NOT NULL DEFAULT false,
  code_hmac       text NOT NULL,
  code_expires_at timestamptz NOT NULL,
  created_at      timestamptz NOT NULL,
  verified_at     timestamptz
);

-- listMobileNumbers and verifyMobileNumber both filter by the member-scope user id
-- (WHERE user_id = $1), so index the column every read scopes on.
CREATE INDEX mobile_numbers_user_idx ON mobile_numbers (user_id);
