-- 0012_held_requests — the held-request store (design §6.2, brief "Agents wait
-- safely").
--
-- On an `ask` decision the pipeline HOLDS the exact agent call here and creates a
-- linked approval; the agent is told `pending_approval`. On approval Warthog
-- executes the held call exactly once and returns the result via `check_approval`.
-- The call's `args` carry PERSONAL CONTENT (recipient, amount, the field asked
-- for), so they are stored only DEK-ENCRYPTED (design §4.1): the column holds a
-- `v1:` envelope (AES-256-GCM under the person's data key), never the plaintext.
--
-- `user_id` binds the row to its person and cascades on account deletion — every
-- read/write is member-scoped by this id (never an id from the client).
-- `approval_id` is the approval this call is parked behind (approvals exist from
-- 0011, so this is a real foreign key, cascading when the approval is removed).
-- `agent_id` is the requesting agent connection: an opaque uuid here (the
-- connections table is created by a later migration, so like 0011 this binds by a
-- plain column rather than a foreign key to a table that does not exist yet).
-- `status` is constrained to the two lifecycle values ('held' on create,
-- 'executed' once Warthog runs the call). Time is clock-driven in application code
-- (not SQL now()), so `created_at` is set at create time and `executed_at` is
-- stamped the one time the held call executes.

CREATE TABLE held_requests (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  agent_id    uuid NOT NULL,
  approval_id uuid NOT NULL REFERENCES approvals(id) ON DELETE CASCADE,
  status      text NOT NULL CHECK (status IN ('held', 'executed')),
  args        text NOT NULL,
  created_at  timestamptz NOT NULL,
  executed_at timestamptz
);

-- getByApproval reads the one held call parked behind an approval for a person
-- (WHERE approval_id = $1 AND user_id = $2), so index both columns of that filter.
CREATE INDEX held_requests_approval_user_idx ON held_requests (approval_id, user_id);
