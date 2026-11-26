-- 0128_agent_saved_skills — skills an agent saves for the person to check, and the changes an
-- agent suggests to a skill they already have (docs/adr/agent-saved-skills.md).
--
-- A person who wrote a skill with ChatGPT, Claude or Gemini can ask that agent to save it to
-- Warthog with save_skill. It is saved switched off, like a SKILL.md the person imports, so it
-- reaches no agent until the person has read it and turned it on.
--
-- * skill_packages.saved_by_agent_id: the opaque id of the agent that saved the package, or NULL
--   when the person did. Plaintext metadata, NOT a foreign key, as for memories: the package
--   outlives the agent.
-- * skill_packages.awaiting_check: true from an agent's save until the person turns its skill on,
--   changes who gets it, or saves the package themselves. While it is true, the agent that saved
--   it may replace it; afterwards that agent's revision waits in skill_suggestions instead. The
--   CHECK refuses a package waiting for the person that no agent saved.
-- * skill_suggestions: at most one waiting change per skill — the SKILL.md an agent suggests, as a
--   `v1:` envelope under the person's data key, bound to (skill_suggestions, content, row id).
--   The skill as it is keeps working until the person uses the suggestion or keeps theirs; either
--   way the row is deleted. `agent_id` is opaque plaintext metadata like saved_by_agent_id. It
--   cascades with its skill and on account deletion. Pending agent data, so not part of the export.
ALTER TABLE skill_packages ADD COLUMN saved_by_agent_id text NULL;
ALTER TABLE skill_packages ADD COLUMN awaiting_check boolean NOT NULL DEFAULT false;
ALTER TABLE skill_packages ADD CONSTRAINT skill_packages_awaiting_check_has_agent
  CHECK (NOT awaiting_check OR saved_by_agent_id IS NOT NULL);

CREATE TABLE skill_suggestions (
  id         uuid PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  skill_id   uuid NOT NULL,
  agent_id   text NOT NULL,
  content    text NOT NULL CHECK (content LIKE 'v1:%'),
  created_at timestamptz NOT NULL,
  FOREIGN KEY (skill_id, user_id) REFERENCES skills(id, user_id) ON DELETE CASCADE,
  UNIQUE (user_id, skill_id)
);

-- A new table needs its own grant (0094 covered the tables that existed then).
GRANT SELECT, INSERT, UPDATE, DELETE ON skill_suggestions TO warthog_app;
