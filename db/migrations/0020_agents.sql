-- 0020_agents — the agent aggregate (CLAUDE.md vocabulary: an *agent* is a
-- connected AI client, `agentId`, ONE ROW PER CONNECTION; design §6.1 — the agent
-- is born from its OAuth connection).
--
-- The agent list, Home and the spending view read an agent's identity (display
-- name, platform, status, connected date) and its activity (last-active time,
-- request count). These fields are PLAINTEXT METADATA (design §4.1) — needed for
-- the list and for filtering — so, unlike held-request args or approval detail,
-- they are NOT DEK-encrypted; the row carries them readably.
--
-- `user_id` binds the row to its person and cascades on account deletion — every
-- read/write is member-scoped by this id (never an id from the client).
-- `connection_id` is the OAuth connection this agent IS (one row per connection):
-- an opaque uuid here (the connections table is created by a later migration, so
-- like 0012 this binds by a plain column rather than a foreign key to a table that
-- does not exist yet). `status` is constrained to the two values a connected agent
-- vs. a disconnected (revoked) one can hold. Time is clock-driven in application
-- code (not SQL now()), so `connected_at` is set at create time and `last_active_at`
-- is stamped the first time the agent calls a tool; `request_count` counts those
-- calls and starts at 0.

CREATE TABLE agents (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  connection_id  uuid NOT NULL,
  display_name   text NOT NULL,
  platform       text NOT NULL,
  status         text NOT NULL CHECK (status IN ('connected', 'disconnected')),
  connected_at   timestamptz NOT NULL,
  last_active_at timestamptz,
  request_count  integer NOT NULL DEFAULT 0
);

-- listAgentsForUser reads every agent for a person (WHERE user_id = $1) and
-- getAgentById / recordAgentActivity filter the same column, so index user_id.
CREATE INDEX agents_user_idx ON agents (user_id);
