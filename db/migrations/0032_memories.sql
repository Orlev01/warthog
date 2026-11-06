-- 0032_memories — the shared-memory store (brief "Skills, preferences and shared
-- memory"; design §4.1).
--
-- A memory is a short fact or note an agent (with permission) or the person saves,
-- carrying the source agent and the time it was saved. Each memory is either KEPT to
-- the agent that saved it or SHARED with the person's other permitted agents; the
-- person owns, views, searches, edits, re-scopes and deletes them, and may add their
-- own.
--
-- PERSONAL CONTENT, SO DEK-ENCRYPTED. A memory's `content` is a short fact or note —
-- personal content a person or their agent authored, NOT filterable metadata: design
-- §4.1 lists the only plaintext columns (ids, timestamps, kinds, agent id, …) and
-- names "memories" as an encrypted personal-content column, and constitution
-- principle 19 forbids any operator path to decrypt or display a person's memory
-- contents. So `content` holds a `v1:` envelope (AES-256-GCM under the person's data
-- key) whose associated data binds the ciphertext to its exact (table, column, row),
-- never the plaintext.
--
-- The `source_agent_id` (an "agent id" is explicitly §4.1 metadata), the `scope`
-- ('kept' | 'shared') and the `created_at` timestamp are PLAINTEXT METADATA — needed
-- to attribute, order and filter the set an agent may read — so they are NOT
-- encrypted. The source agent is an OPAQUE plaintext id, NOT a foreign key: a memory
-- saved by an agent needs no agents-table row, and a person-authored memory has no
-- source agent (`source_agent_id` is NULL).
--
-- A person may hold MANY memories, so each is its own row keyed by a generated `id`
-- (not an upsert). `user_id` binds the row to its person and cascades on account
-- deletion; every read/write is member-scoped by this id — the session's `userId`,
-- never an id from the client — so one person can never read or change another's
-- memories.

CREATE TABLE memories (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content         text NOT NULL,
  source_agent_id text,
  scope           text NOT NULL CHECK (scope IN ('kept', 'shared')),
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- listMemoriesForUser / memoriesForAgent both read a person's memories
-- (WHERE user_id = $1), so index the member-scope filter.
CREATE INDEX memories_user_idx ON memories (user_id);
