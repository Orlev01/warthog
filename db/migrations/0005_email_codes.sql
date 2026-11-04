-- 0005_email_codes — email one-time codes (design §5).
--
-- Email codes begin sign-up, sign-in and new-device flows: a 6-digit code is
-- emailed to a person and must be presented back within ten minutes. The code is
-- never stored in the clear — only a keyed HMAC of it (`code_hmac`), per the
-- project rule that codes are stored only as an HMAC and appear in plain text
-- nowhere except the single email that delivers a person their own code — so a
-- leak of this table cannot reveal a live code. `email` is plaintext metadata (the
-- lookup key); the flow runs before an account may exist, so it is a plain column,
-- not a reference to `users`.
--
-- Expiry is clock-driven in application code (not SQL now()), so `expires_at` is
-- simply the stored instant the code lapses and `consumed_at` marks a code spent —
-- a verified code is single-use and cannot be replayed.

CREATE TABLE email_codes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email       text NOT NULL,
  code_hmac   text NOT NULL,
  created_at  timestamptz NOT NULL,
  expires_at  timestamptz NOT NULL,
  consumed_at timestamptz
);

-- Verify looks a presented code up by (email, code_hmac); this index keeps that
-- lookup cheap as spent codes accumulate.
CREATE INDEX email_codes_lookup_idx ON email_codes (email, code_hmac);

-- Failed verification attempts, one row each, so a rolling fifteen-minute window
-- of failures per email can be counted: after five failures further attempts back
-- off. A throttled refusal records nothing, so the window clears naturally fifteen
-- minutes after the last real failure.
CREATE TABLE email_code_attempts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email        text NOT NULL,
  attempted_at timestamptz NOT NULL
);

-- The window count filters by email and a time floor; this index serves it.
CREATE INDEX email_code_attempts_window_idx ON email_code_attempts (email, attempted_at);
