-- 0035_tasks — the shared tasks store (brief "Tasks and hand-offs"; design §4.1
-- "every personal-content column … tasks").
--
-- A task is how the person and their agents hand work off to each other: the
-- person (or an agent) creates a task, assigns it to a specific agent or to "any
-- agent", and agents pick it up, add notes and mark it done. A task's TITLE and
-- NOTES are PERSONAL CONTENT, so they are stored only DEK-ENCRYPTED: `title` and
-- `notes` each hold a `v1:` envelope (AES-256-GCM under the person's data key) —
-- the plaintext title never lands in a column and the notes are one encrypted
-- JSON blob (an array of { author, text }). The envelope's associated data binds
-- each ciphertext to this exact (table, column, row), so the row id is generated
-- up front.
--
-- The ASSIGNEE, the STATUS and the CREATED-BY stay PLAINTEXT metadata, so the
-- owner list and the agent-scoped read can filter WITHOUT decrypting another
-- person's data:
--   * `assignee` is 'any' OR a specific agent id (an opaque string).
--   * `status` is one of open | in_progress | done (a CHECK guards it), defaulting
--     to 'open'.
--   * `created_by_kind` records who created the task (the person or an agent);
--     `created_by_agent_id` is the opaque agent id when an agent did, else NULL.
--
-- `user_id` binds the row to its owner and cascades on account deletion; every
-- read/write is member-scoped by this id — the session's / connection's id, never
-- an id from the client — so one person can never read or write another's tasks.

CREATE TABLE tasks (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title               text NOT NULL,
  notes               text NOT NULL,
  assignee            text NOT NULL,
  status              text NOT NULL DEFAULT 'open'
                        CHECK (status IN ('open', 'in_progress', 'done')),
  created_by_kind     text NOT NULL CHECK (created_by_kind IN ('person', 'agent')),
  created_by_agent_id text,
  created_at          timestamptz NOT NULL DEFAULT now()
);

-- listTasksForUser and tasksForAgent both read a person's tasks (WHERE user_id =
-- $1), so index the member-scope filter.
CREATE INDEX tasks_user_idx ON tasks (user_id);
