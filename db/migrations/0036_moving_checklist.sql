-- 0036_moving_checklist — the moving-house helper's checklist store (brief
-- "Moving-house helper"; design §4.1 "every personal-content column").
--
-- When the person adds a new address with a moving date, Warthog builds a
-- checklist of places that hold the OLD address — their connected services, the
-- subscriptions and renewal records on file, and the person's own additions — so
-- each can be ticked off or handed to an agent as a task. A checklist item's
-- LABEL is PERSONAL CONTENT, so it is stored only DEK-ENCRYPTED: `label` holds a
-- `v1:` envelope (AES-256-GCM under the person's data key) — the plaintext label
-- never lands in a column. The envelope's associated data binds the ciphertext to
-- this exact (table, column, row), so the row id is generated up front.
--
-- The SOURCE KIND, the SOURCE REFERENCE, the DONE flag and the optional LINKED
-- TASK id stay PLAINTEXT metadata, so the owner list and the idempotent seed can
-- filter / dedupe WITHOUT decrypting another person's data:
--   * `source_kind` is one of connection | subscription | renewal | own (a CHECK
--     guards it) — where the item came from.
--   * `source_reference` is an opaque ref to the source row/service.
--   * `done` records whether the person has ticked the item off (defaults false).
--   * `linked_task_id` is the task the item was handed off as, or NULL; it clears
--     if that task is deleted.
--
-- Seeding is IDEMPOTENT on (user, source kind, source reference): the UNIQUE
-- constraint lets `INSERT … ON CONFLICT DO NOTHING` re-run the helper without
-- duplicating items (and without resetting an item the person already ticked off).
-- The key is scoped to `user_id`, so the same source for two people does not
-- collide.
--
-- `user_id` binds the row to its owner and cascades on account deletion; every
-- read/write is member-scoped by this id — the session's / connection's id, never
-- an id from the client — so one person can never read or write another's
-- checklist.

CREATE TABLE moving_checklist (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label            text NOT NULL,
  source_kind      text NOT NULL
                     CHECK (source_kind IN ('connection', 'subscription', 'renewal', 'own')),
  source_reference text NOT NULL,
  done             boolean NOT NULL DEFAULT false,
  linked_task_id   uuid REFERENCES tasks(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, source_kind, source_reference)
);

-- listForUser reads a person's checklist (WHERE user_id = $1), so index the
-- member-scope filter (the UNIQUE constraint already covers dedupe lookups).
CREATE INDEX moving_checklist_user_idx ON moving_checklist (user_id);
