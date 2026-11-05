-- 0029_approval_opened — opened-tracking on approvals (design §10 Notifications,
-- brief "SMS fallback").
--
-- The SMS/email fallback job sends ONLY while an approval is still unopened. This
-- column is the primitive both the inbox (which marks an approval opened when the
-- person views it) and the fallback job (which checks whether it is still unopened
-- before firing) depend on: once the person has viewed the approval, `opened_at` is
-- set and the fallback is suppressed.
--
-- `opened_at` is NULL until the owner first views the approval; it is then set to the
-- injected clock's instant in application code (not SQL now()), like the other
-- timestamps on this table, so the view moment is deterministic and testable. Reads
-- and the view write stay member-scoped by `user_id` in application code (never an id
-- from the client).

ALTER TABLE approvals ADD COLUMN opened_at timestamptz;
