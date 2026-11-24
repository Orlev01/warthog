-- 0124_read_settings — the per-person "what agents see" level (docs/adr/read-side-protection.md,
-- amendment 24 November 2026; brief "Checked reads"): how much Warthog hides from what agents
-- read through connected services. "private" also hides identifying numbers, "standard" is the
-- default, "open" hides nothing (invisible characters are still removed).
--
-- PLAINTEXT METADATA: one of three words the pipeline reads before it checks a result, so, like
-- the approval expiry, it is not DEK-encrypted and holds no secret. One row per person
-- (`user_id` is the PRIMARY KEY, so a save upserts in place), cascading on account deletion and
-- purge. Every read/write is member-scoped by the session's (or the connection owner's) user id.
-- No row means the person has chosen nothing and the standard default is assembled in code; the
-- CHECK is a schema-level backstop for the levels the store validates before any write. A change
-- applies from the agent's next request, and to approved requests that run after it.
CREATE TABLE read_settings (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  level text NOT NULL CHECK (level IN ('private', 'standard', 'open')),
  updated_at timestamptz NOT NULL
);
GRANT SELECT, INSERT, UPDATE, DELETE ON read_settings TO warthog_app;
