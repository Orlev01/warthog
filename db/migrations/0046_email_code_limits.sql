-- 0046_email_code_limits — one live email code per address, and one throttle alert
-- per window (review fix B1; design §5 "max 5 attempts, then backoff"; brief: "IF
-- sign-in or code entry fails 5 times in 15 minutes for one account or address, THEN
-- THE SYSTEM SHALL slow further attempts ... and email the account holder").
--
-- Verify now judges a presented code against the address's NEWEST live code only
-- (issuing a new code retires the earlier ones), so the lookup is by email over the
-- unconsumed rows, newest first. This partial index serves it as spent codes pile up.
--
-- `email_code_alerts` records when the holder of an address was last told about a
-- throttled run of attempts. Sending is claimed with one atomic upsert that only
-- succeeds once per fifteen-minute window, so a burst of refused attempts (even in
-- parallel) yields exactly one alert rather than one per refusal. It holds no code and
-- no personal content beyond the address the alert went to.
--
-- Additive only: a new index and a new table; existing rows are untouched.

CREATE INDEX IF NOT EXISTS email_codes_live_idx
  ON email_codes (email, created_at DESC)
  WHERE consumed_at IS NULL;

CREATE TABLE IF NOT EXISTS email_code_alerts (
  email   text PRIMARY KEY,
  sent_at timestamptz NOT NULL
);
