-- 0114_agent_read_exposures — remember, for a short window, that an agent has just read
-- content written by someone else (docs/adr/read-side-protection.md, "Recently read").
--
-- After an agent reads an email, an event or a file from someone else, the person's
-- approvals say so ("Claude recently read an email from billing@…, 3 min ago"), and an agent
-- the person lets act without asking is asked first before it emails an address the person
-- has never emailed or sends an invitation. Agents send no conversation id that can't be
-- dropped, so this is kept per AGENT, never per run: one row per agent, overwritten on each
-- read, so storage stays bounded and nothing needs pruning.
--
-- `until_at` is when the window ends (the application clock). `detail_ct` names the last few
-- senders the agent read (service, kind, sender address — never a subject or any text). It is
-- personal content, so it is encrypted under the person's data key (a `v1:` envelope bound to
-- the row) and cleared when the window has passed.
CREATE TABLE agent_read_exposures (
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  agent_id     uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  last_read_at timestamptz NOT NULL,
  until_at     timestamptz NOT NULL,
  detail_ct    text NULL,
  PRIMARY KEY (user_id, agent_id)
);

-- 0094 granted on the tables that existed then; a new table needs its own grant. The runtime
-- role records and reads a window and clears it; it never moves a window to another person
-- or agent. Account and agent deletion remove rows through the cascades.
GRANT SELECT, INSERT, DELETE ON agent_read_exposures TO warthog_app;
GRANT UPDATE (last_read_at, until_at, detail_ct) ON agent_read_exposures TO warthog_app;
