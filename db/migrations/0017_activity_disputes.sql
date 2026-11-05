-- 0017_activity_disputes — a dispute attached ALONGSIDE an activity entry (design
-- §9 "activity hash chain", constitution principle 14 "Warthog writes the record").
--
-- A person can dispute an activity entry. The record is APPEND-ONLY and hash-chained
-- over ciphertext, so the ORIGINAL entry is NEVER changed: the dispute is added as its
-- own row referencing the disputed entry by (user_id, entry_seq) → activity_entries
-- (user_id, seq). Filing a dispute inserts one row here and leaves the entry — and its
-- entry_hash — byte-for-byte unchanged.
--
-- `user_id` binds the row to its person and is the member scope every read/write is
-- filtered by (never an id from the client). The composite reference to the entry
-- cascades on account deletion (users → activity_entries → activity_disputes), so the
-- account-purge job is the ONLY code path that removes a dispute. `dispute_seq` is a
-- contiguous per-(user, entry) counter (1, 2, 3, …) assigned in application code; it
-- gives each dispute its own identity so the note's envelope can be bound to the exact
-- row.
--
-- The dispute note is PERSONAL CONTENT, so it lives only in `note_ct`, a `v1:` envelope
-- (AES-256-GCM under the person's data key, bound to this table/column/row) — the
-- readable note never lands in a column. `created_at` is clock-driven in application
-- code (not SQL now()), stamped when the dispute is filed.

CREATE TABLE activity_disputes (
  user_id     uuid NOT NULL,
  entry_seq   bigint NOT NULL,
  dispute_seq bigint NOT NULL,
  note_ct     text NOT NULL,
  created_at  timestamptz NOT NULL,
  PRIMARY KEY (user_id, entry_seq, dispute_seq),
  FOREIGN KEY (user_id, entry_seq) REFERENCES activity_entries (user_id, seq) ON DELETE CASCADE
);

-- The application database role is APPEND-ONLY on activity_disputes, exactly as on
-- activity_entries (0016): INSERT and SELECT only, UPDATE and DELETE revoked (design
-- §9). No application code path can alter or remove a dispute; only the privileged
-- purge/migration role can, via the entry cascade above. The role is created by 0016
-- (which runs first); guarded so it is reused rather than colliding.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'warthog_app') THEN
    CREATE ROLE warthog_app;
  END IF;
END
$$;

GRANT SELECT, INSERT ON activity_disputes TO warthog_app;
REVOKE UPDATE, DELETE ON activity_disputes FROM warthog_app;
