-- 0027_notification_prefs — the per-person notification preferences store (design
-- §10 Notifications / "Fallback job"; brief "Notification settings").
--
-- The approval SMS/email fallback fires at `created_at + fallback_delay` if the
-- approval is still unopened. The fallback job reads, per person, whether email
-- fallback is on (ON by default) and the fallback delay in minutes (default 2,
-- adjustable 1–30). When a person has set nothing, the brief's defaults apply — so
-- the column defaults below ARE the brief's defaults (email on, 2 minutes).
--
-- One row per person: `user_id` is the PRIMARY KEY (so a save upserts in place and
-- never duplicates) and REFERENCES users(id), cascading on account deletion. Every
-- read/write is member-scoped by this id — the session's `userId`, never an id from
-- the client. `email_fallback` and `fallback_delay_minutes` are plaintext metadata
-- (a boolean and a small integer the fallback job reads), so this table holds no
-- secret and nothing is DEK-encrypted. The CHECK keeps the stored delay inside the
-- brief's inclusive 1–30 range as a schema-level guard; the repo rejects an
-- out-of-range delay before it ever reaches a write.

CREATE TABLE notification_prefs (
  user_id                uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  email_fallback         boolean NOT NULL DEFAULT true,
  fallback_delay_minutes int NOT NULL DEFAULT 2 CHECK (fallback_delay_minutes BETWEEN 1 AND 30)
);
