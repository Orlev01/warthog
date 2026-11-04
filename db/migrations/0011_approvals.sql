-- 0011_approvals — the approval store (design §6, brief "Approval inbox" /
-- "Agents wait safely").
--
-- The pipeline creates an approval on every `ask` decision; the inbox and
-- notifications read and decide them. An approval holds the exact details the
-- person sees — the recipient, amount and field the agent asked for — which is
-- PERSONAL CONTENT, so `detail` is stored only DEK-ENCRYPTED (design §4.1): the
-- column holds a `v1:` envelope (AES-256-GCM under the person's data key), never
-- the plaintext. The lifecycle itself is the pure state machine
-- (src/domain/approvals/state-machine.ts); this table is its storage skin.
--
-- `user_id` binds the row to its person and cascades on account deletion — every
-- read/write is member-scoped by this id (never an id from the client). `agent_id`
-- is the requesting agent connection: an opaque uuid here (the connections table is
-- created by a later migration, so like 0009 this binds by a plain column rather
-- than a foreign key to a table that does not exist yet). `status` is constrained
-- to the five lifecycle values the state machine knows. Time is clock-driven in
-- application code (not SQL now()), so `created_at` / `expires_at` are set at create
-- time, making the expiry window deterministic and testable; `decided_at` is stamped
-- on approve / deny / expire and `question` records a `more_detail` request.

CREATE TABLE approvals (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  agent_id   uuid NOT NULL,
  status     text NOT NULL
             CHECK (status IN ('pending', 'approved', 'denied', 'expired', 'more_detail')),
  detail     text NOT NULL,
  question   text,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  decided_at timestamptz
);

-- The inbox hot path reads one person's pending approvals
-- (WHERE user_id = $1 AND status = 'pending'), so index both columns of that filter.
CREATE INDEX approvals_user_status_idx ON approvals (user_id, status);
