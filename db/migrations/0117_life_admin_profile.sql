-- 0117_life_admin_profile — typed life-admin records (docs/adr/life-admin-profile.md).
--
-- Life admin grows from three kinds into the categories of a person's admin (vehicles, home,
-- utilities, health, money & super, ID-document expiries, work, subscriptions, pets …), filled
-- in mostly by the person's own agent reading their email, and confirmed by the person.
--
-- * `kind` gains `item`: every new type is stored under it, so the plaintext column never
--   says which category a record is in. The type itself ("health.insurance") lives in `meta`.
-- * `meta` (a `v1:` envelope under the person's data key, bound to this row and column) holds
--   the record's type and where an agent says it found it (service, message, sender, date).
--   NULL for records saved before types existed, which read as their kind's type.
-- * `review_state`: `suggested` (an agent saved it and the person hasn't checked it),
--   `confirmed` (the person added or checked it), `dismissed` (the person said "not mine": the
--   row keeps only its match key, so the same suggestion is not added again). Records agents
--   saved before this migration were never checked, so they start as suggestions.
-- * `parent_id`: the vehicle, home or pet a record belongs to (same owner; checked by the
--   store). Removing the parent leaves the record unlinked.
-- * `match_key`: an HMAC, under a key derived from the person's data key, of the values that
--   identify one record of its type (insurer + policy number, a plate …), so saving the same
--   thing again updates it. Opaque to anyone without the data key.
-- * `pending`: an agent's proposed change to a confirmed record, encrypted like `meta`, until
--   the person accepts or keeps their own values. Agents never overwrite what the person checked.
-- * `updated_at` and `changed_by_*`: who last changed the record, so a record an agent rewrote
--   no longer reads as the person's.

ALTER TABLE life_admin_records DROP CONSTRAINT life_admin_records_kind_check;
ALTER TABLE life_admin_records ADD CONSTRAINT life_admin_records_kind_check
  CHECK (kind IN ('subscription', 'receipt_warranty', 'renewal_appointment', 'item'));

ALTER TABLE life_admin_records
  ADD COLUMN meta                text NULL,
  ADD COLUMN review_state        text NOT NULL DEFAULT 'confirmed'
    CHECK (review_state IN ('suggested', 'confirmed', 'dismissed')),
  ADD COLUMN parent_id           uuid NULL REFERENCES life_admin_records(id) ON DELETE SET NULL,
  ADD COLUMN match_key           text NULL,
  ADD COLUMN pending             text NULL,
  ADD COLUMN updated_at          timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN changed_by_kind     text NULL CHECK (changed_by_kind IN ('person', 'agent')),
  ADD COLUMN changed_by_agent_id text NULL;

UPDATE life_admin_records SET review_state = 'suggested' WHERE source_kind = 'agent';
UPDATE life_admin_records SET updated_at = created_at;

-- Saving looks a match up within one person's records.
CREATE INDEX life_admin_records_match_idx ON life_admin_records (user_id, match_key) WHERE match_key IS NOT NULL;
-- The hourly reminders sweep reads dated, live records across everyone.
CREATE INDEX life_admin_records_due_idx ON life_admin_records (due_date) WHERE due_date IS NOT NULL AND review_state <> 'dismissed';
CREATE INDEX life_admin_records_parent_idx ON life_admin_records (parent_id) WHERE parent_id IS NOT NULL;
