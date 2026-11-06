-- 0031_skills — the skills store (brief "Skills, preferences and shared memory";
-- design §4.1).
--
-- A skill is an INSTRUCTION DOCUMENT a person writes for specific tasks — a title,
-- a one-line "use this when" description and the full instruction text — scoped to
-- all of their agents or to chosen ones. An agent's context lists only the titles
-- and "use this when" lines of the skills it may use; it fetches a skill's full
-- text by title when it decides the skill is relevant.
--
-- PERSONAL CONTENT, SO DEK-ENCRYPTED. A skill's title, "use this when" line and
-- full text are all personal content a person authored, NOT filterable metadata:
-- design §4.1 lists the only plaintext columns (ids, timestamps, kinds, agent id,
-- …) and skill text is not among them, and constitution principle 19 forbids any
-- operator path to decrypt or display a person's skills contents. So `title`,
-- `use_this_when` and `full_text` each hold a `v1:` envelope (AES-256-GCM under the
-- person's data key) whose associated data binds the ciphertext to its exact
-- (table, column, row), never the plaintext.
--
-- The `enabled` flag, the `scope` ('all' | 'chosen') and the chosen `scoped_agent_ids`
-- are PLAINTEXT METADATA (an "agent id" is explicitly §4.1 metadata) — needed to
-- filter the set of skills that applies to a given agent — so they are NOT encrypted.
--
-- A person may hold MANY skills, so each is its own row keyed by a generated `id`
-- (not an upsert). `user_id` binds the row to its person and cascades on account
-- deletion; every read/write is member-scoped by this id — the session's `userId`,
-- never an id from the client — so one person can never read or change another's
-- skills.

CREATE TABLE skills (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title            text NOT NULL,
  use_this_when    text NOT NULL,
  full_text        text NOT NULL,
  scope            text NOT NULL CHECK (scope IN ('all', 'chosen')),
  scoped_agent_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  enabled          boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- listSkillsForUser / skillsForAgent / getSkillText all read a person's skills
-- (WHERE user_id = $1), so index the member-scope filter.
CREATE INDEX skills_user_idx ON skills (user_id);
