-- Persist reservations before paid sends. A transport failure is not proof that
-- ACS did not bill the message, so reservations are intentionally not refunded.
CREATE TABLE sms_usage_buckets (
  bucket text PRIMARY KEY,
  used integer NOT NULL CHECK (used >= 0),
  expires_at timestamptz NOT NULL
);
CREATE INDEX sms_usage_expiry ON sms_usage_buckets (expires_at);
