ALTER TABLE email_codes ADD COLUMN purpose text NOT NULL DEFAULT 'legacy';
CREATE INDEX email_codes_purpose ON email_codes (email, purpose, created_at DESC);
CREATE TABLE passkey_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  attempted_at timestamptz NOT NULL
);
CREATE INDEX passkey_attempts_user_time ON passkey_attempts (user_id, attempted_at);
CREATE TABLE passkey_alerts (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  sent_at timestamptz NOT NULL
);
CREATE TABLE household_invite_sends (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sent_at timestamptz NOT NULL
);
CREATE INDEX household_invite_sends_user_time ON household_invite_sends (user_id, sent_at);
