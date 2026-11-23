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
-- * `match_keys`: HMACs, under a key derived from the person's data key, of each set of values
--   that identifies one record of its kind (insurer + policy number; a plate; a booking's
--   provider + reference, or provider + start date), so saving the same thing again updates it —
--   even when a booking first saved without its reference gets one later. Opaque to anyone
--   without the data key.
-- * `pending`: an agent's proposed change to a confirmed record, encrypted like `meta`, until
--   the person accepts or keeps their own values. Agents never overwrite what the person checked.
-- * `updated_at` and `changed_by_*`: who last changed the record, so a record an agent rewrote
--   no longer reads as the person's.
-- * `remind_until`: the last day its reminders may go out (worked out from its kind, status and
--   due date when it is written), so the keyless reminders sweep needs no status list and never
--   learns that a record is a booking. NULL ⇒ no reminders (finished, paused or undated).
-- * `steward_*`: the agent handling a live item (docs/adr/life-admin-journal.md) — a label, never
--   a lock or a permission — who set it and since when.

ALTER TABLE life_admin_records DROP CONSTRAINT life_admin_records_kind_check;
ALTER TABLE life_admin_records ADD CONSTRAINT life_admin_records_kind_check
  CHECK (kind IN ('subscription', 'receipt_warranty', 'renewal_appointment', 'item'));

ALTER TABLE life_admin_records
  ADD COLUMN meta                text NULL,
  ADD COLUMN review_state        text NOT NULL DEFAULT 'confirmed'
    CHECK (review_state IN ('suggested', 'confirmed', 'dismissed')),
  ADD COLUMN parent_id           uuid NULL REFERENCES life_admin_records(id) ON DELETE SET NULL,
  ADD COLUMN match_keys          text[] NOT NULL DEFAULT '{}',
  ADD COLUMN pending             text NULL,
  ADD COLUMN updated_at          timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN changed_by_kind     text NULL CHECK (changed_by_kind IN ('person', 'agent')),
  ADD COLUMN changed_by_agent_id text NULL,
  ADD COLUMN remind_until        date NULL,
  ADD COLUMN steward_agent_id    text NULL,
  ADD COLUMN steward_set_by      text NULL CHECK (steward_set_by IN ('person', 'agent')),
  ADD COLUMN steward_since       timestamptz NULL,
  ADD CONSTRAINT life_admin_records_owner_id UNIQUE (user_id, id);

UPDATE life_admin_records SET review_state = 'suggested' WHERE source_kind = 'agent';
UPDATE life_admin_records SET updated_at = created_at;
UPDATE life_admin_records SET remind_until = due_date + 7
  WHERE due_date IS NOT NULL
    AND lower(status) NOT IN ('cancelled', 'canceled', 'expired', 'done', 'ended', 'closed', 'completed', 'finished', 'resolved', 'lapsed', 'paused', 'on_hold');

-- The hourly reminders sweep reads records that may still remind, across everyone.
CREATE INDEX life_admin_records_remind_idx ON life_admin_records (remind_until) WHERE remind_until IS NOT NULL;
CREATE INDEX life_admin_records_parent_idx ON life_admin_records (parent_id) WHERE parent_id IS NOT NULL;
