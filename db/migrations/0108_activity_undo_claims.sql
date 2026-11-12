-- 0108_activity_undo_claims — an activity entry is undone at most once (design §9
-- "Undo writes a new entry").
--
-- Undo runs an entry's declared reversal and appends a NEW entry recording it; the
-- original entry is never changed (append-only, hash-chained), so nothing on the entry
-- itself can say it has been undone. Without a guard, a double-click or a later second
-- Undo ran the reversal twice: the second calendar delete failed, or a duplicate
-- approval request was created.
--
-- The undo service CLAIMS (user_id, entry_seq) here with one atomic
-- INSERT … ON CONFLICT DO NOTHING before it runs the reversal; whoever does not win the
-- claim is refused and runs nothing. The claim is kept once the reversal has executed
-- or is held for the person's approval, and released (deleted) when the reversal was
-- refused, failed or threw, so the person can try again. The Activity page reads the
-- claim to stop offering Undo and to show "Undone" instead.
--
-- Plaintext metadata only — which of the person's own entries has been claimed, and
-- when (`claimed_at` from the application clock, never SQL now()) — no content. Every
-- read and write is member-scoped by `user_id`, the session's id. There is no foreign
-- key to the entry: entries are only ever removed with their account, and the
-- account's deletion cascades here (users → activity_undo_claims) in the same purge.
CREATE TABLE activity_undo_claims (
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  entry_seq  bigint NOT NULL,
  claimed_at timestamptz NOT NULL,
  PRIMARY KEY (user_id, entry_seq)
);

-- The runtime role claims, reads and releases a claim; it never rewrites one.
GRANT SELECT, INSERT, DELETE ON activity_undo_claims TO warthog_app;
