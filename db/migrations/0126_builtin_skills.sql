-- 0126_builtin_skills — the person's own settings for Warthog's skills (docs/adr/editable-builtin-skills.md).
--
-- Warthog's skills ("Using Warthog", "Life admin records", "Building a profile" and the default
-- skills such as "What needs me this week") are written by Warthog and served to agents. The
-- person may switch one off, remove it, choose which agents get it, and edit its guidance. A
-- row exists only once they've changed something: no row means Warthog's version, in Warthog's
-- default state, for all agents.
--
-- * `builtin_key`: which Warthog skill (a stable key, never the title). Checked against Warthog's
--   own list in the application, so a key a newer release retires is simply ignored.
-- * `state`: `on`, `off` (kept on the Skills page, not given to agents) or `removed` (taken off
--   the Skills page too, until the person restores it).
-- * `scope` and `scoped_agent_ids`: all agents, or the chosen agents only (their opaque ids,
--   as for skills).
-- * `use_this_when` and `guidance`: the person's own wording, or NULL for Warthog's. Personal
--   content, so each is stored only as a `v1:` envelope under the person's data key, bound to
--   (builtin_skills, column, row id). Warthog's fixed ground rules and the parts it generates
--   (record kinds, searches, what the agent can read) are never stored here: they can't be edited.
-- * `based_on_version`: the version of Warthog's text an edit started from, so when Warthog
--   updates that skill the person is offered the new text instead of losing it silently.
--
-- `user_id` cascades on account deletion; every read and write is member-scoped by the
-- session's user id. The person's edits are part of the data export.
CREATE TABLE builtin_skills (
  id               uuid PRIMARY KEY,
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  builtin_key      text NOT NULL CHECK (builtin_key ~ '^[a-z][a-z0-9_]{1,39}$'),
  state            text NOT NULL CHECK (state IN ('on', 'off', 'removed')),
  scope            text NOT NULL DEFAULT 'all' CHECK (scope IN ('all', 'chosen')),
  scoped_agent_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  use_this_when    text NULL CHECK (use_this_when IS NULL OR use_this_when LIKE 'v1:%'),
  guidance         text NULL CHECK (guidance IS NULL OR guidance LIKE 'v1:%'),
  based_on_version integer NULL CHECK (based_on_version IS NULL OR based_on_version > 0),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT builtin_skills_edit_has_version CHECK ((use_this_when IS NULL AND guidance IS NULL) OR based_on_version IS NOT NULL),
  UNIQUE (user_id, builtin_key)
);

-- A new table needs its own grant (0094 covered the tables that existed then).
GRANT SELECT, INSERT, UPDATE, DELETE ON builtin_skills TO warthog_app;
