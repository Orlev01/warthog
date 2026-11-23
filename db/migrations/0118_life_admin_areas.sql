-- 0118_life_admin_areas — categories of a person's own, a journal on every item, and records
-- linked to the activity that touched them (docs/adr/life-admin-profile.md,
-- docs/adr/life-admin-journal.md).
--
-- `life_admin_categories` holds a person's own categories (one an agent suggested, or they made)
-- and their settings for built-in ones ("show", "not for me"). Its id (`slug`) is random, never
-- derived from the label, and everything that names a category — its label, its kinds, its fields,
-- or which built-in it is a setting for — is in `definition`, a `v1:` envelope under the person's
-- data key bound to this row. `state` and the origin are plain bookkeeping. Rows can be pruned.
CREATE TABLE life_admin_categories (
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id              uuid NOT NULL,
  slug            text NOT NULL,
  state           text NOT NULL CHECK (state IN ('suggested', 'active', 'setting', 'dismissed')),
  origin_kind     text NOT NULL CHECK (origin_kind IN ('person', 'agent')),
  origin_agent_id text NULL,
  definition      text NOT NULL,
  created_at      timestamptz NOT NULL,
  updated_at      timestamptz NOT NULL,
  PRIMARY KEY (user_id, id),
  UNIQUE (user_id, slug)
);

-- `life_admin_journal` is each item's log: Warthog's own record of what changed (`change`), and
-- the one- or two-line decisions, notes, next steps and hand-over notes agents and the person
-- write. One row per entry, append-only. Plain columns carry no content — the kind, who wrote it
-- (person, agent or imported), the conversation (run), the entry it refers to (a next step it
-- closes, a decision it replaces) and when — so open steps and current decisions are found
-- without decrypting; the text, due date and change detail are in `body`, a `v1:` envelope bound
-- to its row. An entry lives exactly as long as its record: deleting a record (or "not mine")
-- removes its log through the cascade.
CREATE TABLE life_admin_journal (
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id             uuid NOT NULL,
  record_id      uuid NOT NULL,
  seq            integer NOT NULL,
  kind           text NOT NULL CHECK (kind IN ('change', 'decision', 'note', 'next', 'next_done', 'handover')),
  actor_kind     text NOT NULL CHECK (actor_kind IN ('person', 'agent', 'imported')),
  actor_agent_id text NULL,
  run_id         uuid NULL,
  ref_id         uuid NULL,
  at             timestamptz NOT NULL,
  body           text NOT NULL,
  PRIMARY KEY (user_id, id),
  UNIQUE (user_id, record_id, seq),
  FOREIGN KEY (user_id, record_id) REFERENCES life_admin_records (user_id, id) ON DELETE CASCADE
);
-- A step is closed once, and a decision replaced once.
CREATE UNIQUE INDEX life_admin_journal_ref_once ON life_admin_journal (user_id, kind, ref_id) WHERE ref_id IS NOT NULL;

-- `activity_entry_records` links an activity entry to the records it touched, beside the
-- append-only, hash-chained record (as `activity_entry_runs` does), so Activity can show
-- everything that happened to one item. Plain ids only. The record id is kept without a foreign
-- key so the link outlives a deleted record (the entries do).
CREATE TABLE activity_entry_records (
  user_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  entry_seq bigint NOT NULL,
  record_id uuid NOT NULL,
  PRIMARY KEY (user_id, entry_seq, record_id),
  FOREIGN KEY (user_id, entry_seq) REFERENCES activity_entries (user_id, seq) ON DELETE CASCADE
);
CREATE INDEX activity_entry_records_record_idx ON activity_entry_records (user_id, record_id, entry_seq DESC);

-- A task can be about one record ("finalise the motorcycle insurance"): same person, and the link
-- is cleared when the record goes.
ALTER TABLE tasks ADD COLUMN record_id uuid NULL;
ALTER TABLE tasks ADD CONSTRAINT tasks_record_fk FOREIGN KEY (user_id, record_id)
  REFERENCES life_admin_records (user_id, id) ON DELETE SET NULL (record_id);

-- A new table needs its own grant (0094 covered the tables that existed then). Categories are
-- ordinary data; the journal and the activity links are append-only, like the activity record.
GRANT SELECT, INSERT, UPDATE, DELETE ON life_admin_categories TO warthog_app;
GRANT SELECT, INSERT ON life_admin_journal TO warthog_app;
GRANT SELECT, INSERT ON activity_entry_records TO warthog_app;
