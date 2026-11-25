-- 0127_run_status — an agent can update what a conversation is working on, and the Now view
-- lists the person's recent conversations across all their agents (docs/adr/agent-runs.md,
-- amendment of 25 November 2026).
--
-- `get_context` with a run and a new `working_on` replaces the run's description. The
-- description is still the agent's own words, encrypted under the person's data key; the
-- history of changes lives in the hash-chained activity record, where each change is its own
-- agent-reported entry and every entry carries the description it was recorded under.
-- `label_changed_at` is when the description last changed: it shows on the Now view and
-- spaces changes out (at most one a minute per run).
ALTER TABLE agent_runs ADD COLUMN label_changed_at timestamptz NULL;

-- The person's recent conversations across all their agents, newest activity first (the Now
-- view). The per-agent index from 0113 serves one agent's list.
CREATE INDEX agent_runs_recent_idx ON agent_runs (user_id, last_seen_at DESC);

-- The runtime role may now also change the description and when it changed. It still never
-- rewrites whose a run is (`user_id`, `agent_id`), when it started or how it came in (`via`).
GRANT UPDATE (label_ct, label_changed_at) ON agent_runs TO warthog_app;
