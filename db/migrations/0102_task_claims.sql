-- A shared task has one renewable ten-minute claim. The owner can always
-- reassign, reopen or complete it. Claims do not survive account portability.
ALTER TABLE tasks ADD COLUMN claimed_by uuid;
ALTER TABLE tasks ADD COLUMN claim_expires_at timestamptz;
ALTER TABLE tasks ADD CONSTRAINT task_claim_pair CHECK ((claimed_by IS NULL) = (claim_expires_at IS NULL));
CREATE INDEX tasks_owner_assignee ON tasks (user_id, assignee);
