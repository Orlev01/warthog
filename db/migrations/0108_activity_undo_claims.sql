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
-- refused, failed or threw, so the person can try again.
--
-- A held undo is the common path (agents default to "Changes: ask me first"), so its
-- claim records the approval it waits on in `approval_id`. While that approval is
-- pending or asked for more detail the entry reads "Undo waiting for your approval";
-- once approved it reads "Undone". A claim whose approval was denied, expired or no
-- longer exists for this person is STALE: it undid nothing, so it counts as no claim —
-- the Activity page offers Undo again, and the next undo deletes exactly that claim
-- (matched on its approval_id, so a fresh concurrent claim is never removed) and claims
-- afresh. There is deliberately no foreign key to approvals: a missing approval must read
-- as stale, never cascade away or null out a claim that still stands.
--
-- Plaintext metadata only — which of the person's own entries has been claimed, when
-- (`claimed_at` from the application clock, never SQL now()) and which approval holds
-- it — no content. Every read and write is member-scoped by `user_id`, the session's id.
-- There is no foreign key to the entry either: entries are only ever removed with their
-- account, and the account's deletion cascades here (users → activity_undo_claims) in
-- the same purge.
CREATE TABLE activity_undo_claims (
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  entry_seq   bigint NOT NULL,
  claimed_at  timestamptz NOT NULL,
  approval_id uuid NULL,
  PRIMARY KEY (user_id, entry_seq)
);

-- The runtime role claims, reads and releases a claim, and records the approval a held
-- undo waits on. It never rewrites who or which entry a claim is for, or when it was made.
GRANT SELECT, INSERT, DELETE ON activity_undo_claims TO warthog_app;
GRANT UPDATE (approval_id) ON activity_undo_claims TO warthog_app;
