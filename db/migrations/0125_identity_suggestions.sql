-- 0125_identity_suggestions — About you suggestions: low-tier details an agent suggests and the
-- person confirms one at a time (docs/adr/profile-build.md).
--
-- An agent reading the person's mail can spot a detail About you is missing: a new phone number,
-- the address they are moving to, the name they sign with. It is never written straight into
-- identity_fields, because agents read those through get_context and a detail one agent guessed
-- must not reach any agent before the person has said it is right. A suggestion waits here, in its
-- own table, so nothing that lists identity fields (get_context, About you, the per-agent detail
-- toggles, moving) can see it. When the person accepts it, it is saved as an identity field and
-- this row is deleted; when they decline it, the row stays only to stop it being suggested again.
--
-- * `kind`: one of the six low-tier kinds an agent may suggest (never a name or a general
--   preference, and never a high-tier detail, which lives in the device-held vault). Plaintext,
--   like identity_fields.kind.
-- * `value` (the detail) and `meta` (where the agent says it found it, and a postal address's
--   moving-on date, as JSON) are personal content, so each is stored only as a `v1:` envelope
--   under the person's data key, bound to (identity_suggestions, column, row id); the CHECKs
--   refuse anything that isn't an envelope.
-- * `source_agent_id`: the opaque id of the agent that suggested it. Plaintext metadata, NOT a
--   foreign key, as for memories and life_admin_records: the row needs no agents-table row.
-- * `match_key`: an HMAC, under the key Life admin's match keys use (derived from the person's data
--   key, so it differs per person), of the kind and the normalised value, so the same suggestion
--   is kept once, and one the person declined is never suggested again. Opaque without the data
--   key; never a plain hash of the value.
-- * `state`: `suggested` (waiting for the person) or `declined`. A declined suggestion keeps only
--   its match key: its value, provenance and agent are cleared, and the CHECK refuses a declined
--   row that still holds any of them (or a waiting one without its value and provenance).
--
-- `user_id` cascades on account deletion and purge; every read and write is member-scoped by the
-- session's user id. Suggestions are pending agent data, so they are not part of the data export.
CREATE TABLE identity_suggestions (
  id              uuid PRIMARY KEY,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind            text NOT NULL CHECK (kind IN ('preferred_name', 'email', 'phone', 'postal_address', 'language', 'time_zone')),
  value           text NULL CHECK (value IS NULL OR value LIKE 'v1:%'),
  meta            text NULL CHECK (meta IS NULL OR meta LIKE 'v1:%'),
  source_agent_id text NULL,
  match_key       text NOT NULL,
  state           text NOT NULL CHECK (state IN ('suggested', 'declined')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT identity_suggestions_declined_keeps_only_key CHECK (
    (state = 'suggested' AND value IS NOT NULL AND meta IS NOT NULL)
    OR (state = 'declined' AND value IS NULL AND meta IS NULL AND source_agent_id IS NULL)
  ),
  UNIQUE (user_id, match_key)
);

-- About you lists and counts the person's waiting suggestions (WHERE user_id = $1 AND state = ...).
CREATE INDEX identity_suggestions_user_state_idx ON identity_suggestions (user_id, state);

-- A new table needs its own grant (0094 covered the tables that existed then).
GRANT SELECT, INSERT, UPDATE, DELETE ON identity_suggestions TO warthog_app;
