-- 0042_imported_history — the imported-history archive (brief "Export and
-- portability"; design §4.1; constitution principle 14 "Warthog writes the
-- record, not the agents").
--
-- An import reads a Warthog export into a fresh account and keeps the old
-- activity history as a separate, read-only "Imported history" archive, clearly
-- labelled, OUTSIDE Warthog's own append-only, hash-chained activity record. So
-- an import never claims authorship of actions Warthog did not handle and never
-- perturbs the live integrity chain, the archive lives in THIS table, which is
-- NOT `activity_entries`: it has no seq, no prev_hash/entry_hash chain, and
-- nothing writes it into the activity record.
--
-- Each archived entry's CONTENT is PERSONAL CONTENT carried over from another
-- Warthog export, so it is stored only DEK-ENCRYPTED: `content` holds the `v1:`
-- envelope (AES-256-GCM under the person's data key) of the original exported
-- activity entry as one JSON blob — the plaintext content lands in no column.
-- The envelope's associated data binds the ciphertext to this exact (table,
-- column, row), so the row id is generated up front.
--
-- A little plaintext metadata stays readable so the archive can be LISTED and
-- CLEARLY LABELLED without decrypting another person's data: `occurred_at` is
-- when the ORIGINAL action happened (ordering), and `kind` and `source` are the
-- original entry's labels — exactly the activity feed's display metadata, but in
-- this separate, non-chained table.
--
-- `user_id` binds the row to its owner and cascades on account deletion; every
-- read/write is member-scoped by this id — the session's id, never an id from the
-- client — so one person can never read another's imported history.

CREATE TABLE imported_history (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content     text NOT NULL,
  occurred_at timestamptz NOT NULL,
  kind        text NOT NULL,
  source      text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- listImportedEntriesForUser reads a person's archive (WHERE user_id = $1), so
-- index the member-scope filter.
CREATE INDEX imported_history_user_idx ON imported_history (user_id);
