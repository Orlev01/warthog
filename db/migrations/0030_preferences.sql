-- 0030_preferences — the per-person communication-style and preferences profile
-- (brief "Skills, preferences and shared memory"; design §4.1).
--
-- The profile — tone, preferred length, language, units, time zone and how the
-- person likes to be taught or briefed — is PERSONAL CONTENT shared freely with
-- permitted agents via get_context, so every field is stored only DEK-ENCRYPTED
-- (design §4.1 — "every personal-content column — low-tier vault fields,
-- preferences, …"): each column holds a `v1:` envelope (AES-256-GCM under the
-- person's data key) whose associated data binds the ciphertext to its exact
-- (table, column, row), never the plaintext.
--
-- One row per person: `user_id` is the PRIMARY KEY (so a save upserts in place
-- and never duplicates) and REFERENCES users(id), cascading on account deletion.
-- Every read/write is member-scoped by this id — the session's `userId`, never an
-- id from the client — so one person can never read or change another's profile.

CREATE TABLE preferences (
  user_id   uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  tone      text NOT NULL,
  length    text NOT NULL,
  language  text NOT NULL,
  units     text NOT NULL,
  time_zone text NOT NULL,
  briefing  text NOT NULL
);
