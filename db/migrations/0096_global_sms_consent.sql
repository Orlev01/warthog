-- Explicit, withdrawable consent for optional approval SMS. No existing user is
-- opted in by migrating. A verification-code request is a separate user action.
ALTER TABLE notification_prefs ADD COLUMN sms_fallback boolean NOT NULL DEFAULT false;
ALTER TABLE notification_prefs ADD COLUMN sms_consent_updated_at timestamptz;

-- At most one paid SMS attempt per approval, even across job retries/crashes.
-- Claim before the provider call. A crash may lose an alert; email/in-app remain.
CREATE TABLE approval_sms_attempts (
  approval_id uuid PRIMARY KEY REFERENCES approvals(id) ON DELETE CASCADE,
  attempted_at timestamptz NOT NULL
);
GRANT SELECT, INSERT ON approval_sms_attempts TO warthog_app;
