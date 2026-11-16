-- 0113_agent_runs — tell one agent's conversations apart (docs/adr/agent-runs.md).
--
-- One agent connection is one credential, and every conversation a person has with that
-- agent shares it: many Claude Code sessions, or many claude.ai chats, all arrive as one
-- agent. The MCP protocol and the clients send nothing that identifies a conversation, so
-- Warthog hands one out itself. `get_context` starts a RUN and returns its id; the agent
-- passes it back on later calls; Warthog links each entry it records to that run.
--
-- `agent_runs` holds the runs Warthog issued. A run belongs to exactly one person and one
-- of their agents, and a call can only use a run issued to its own connection's agent (the
-- application checks this on every call). The agent's own description of what it is
-- working on is personal content, so it is encrypted under the person's data key
-- (`label_ct`, a `v1:` envelope bound to its row). `via` is the product the request came
-- through as the client reported it (for example "Claude Code"), plain metadata like a
-- tool name. `started_at`/`last_seen_at` come from the application clock.
CREATE TABLE agent_runs (
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id           uuid NOT NULL,
  agent_id     uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  started_at   timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  via          text NULL,
  label_ct     text NULL,
  PRIMARY KEY (user_id, id)
);

-- An agent's most recent runs, newest activity first (the agent workspace's run list).
CREATE INDEX agent_runs_agent_idx ON agent_runs (user_id, agent_id, last_seen_at DESC);

-- `activity_entry_runs` links an activity entry to the run it was recorded under. The
-- activity record itself is append-only and hash-chained, so the link lives beside it
-- (as `activity_undo_claims` does) and the entry's own encrypted payload also names the
-- run, inside the chain. Plain ids only, no content. The composite foreign key means an
-- entry can only be linked to a run of the same person.
CREATE TABLE activity_entry_runs (
  user_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  entry_seq bigint NOT NULL,
  run_id    uuid NOT NULL,
  PRIMARY KEY (user_id, entry_seq),
  FOREIGN KEY (user_id, run_id) REFERENCES agent_runs (user_id, id) ON DELETE CASCADE
);

-- One run's entries, newest first (Activity filtered to one run, and the run list counts).
CREATE INDEX activity_entry_runs_run_idx ON activity_entry_runs (user_id, run_id, entry_seq DESC);

-- 0094 granted on the tables that existed then; a new table needs its own grant. The
-- runtime role starts runs, reads them and marks one as seen; it never rewrites who a run
-- belongs to, when it started or what the agent said it was for. Entry links are
-- append-only, like the entries they describe. Account deletion removes both through the
-- users cascade.
GRANT SELECT, INSERT ON agent_runs TO warthog_app;
GRANT UPDATE (last_seen_at) ON agent_runs TO warthog_app;
GRANT SELECT, INSERT ON activity_entry_runs TO warthog_app;
