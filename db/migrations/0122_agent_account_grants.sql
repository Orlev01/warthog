-- 0122_agent_account_grants — one agent, several accounts of a service
-- (docs/adr/several-accounts-per-agent.md). An agent is now given ACCOUNTS, each with its own
-- read, change and tool settings; a service is granted when at least one of its accounts is.
--
-- A row means "this agent may use this account". Its settings are NULL when they are the same
-- as the agent's own. Both keys carry the person, so a grant can never point at another
-- person's agent or account, and disconnecting an account (or removing an agent's permissions)
-- removes its grants with it: there is no stale choice left behind.

-- The composite key the account foreign key needs (id alone is already unique).
ALTER TABLE connections ADD CONSTRAINT connections_user_id_id_key UNIQUE (user_id, id);

CREATE TABLE agent_account_grants (
  user_id             uuid NOT NULL,
  agent_connection_id uuid NOT NULL,
  account_id          uuid NOT NULL,
  read_tools          boolean NULL,
  change_tools        text NULL CHECK (change_tools IN ('off', 'allow', 'ask_first')),
  allowed_tools       jsonb NULL CHECK (allowed_tools IS NULL OR jsonb_typeof(allowed_tools) = 'array'),
  PRIMARY KEY (user_id, agent_connection_id, account_id),
  FOREIGN KEY (user_id, agent_connection_id) REFERENCES agent_permissions (user_id, connection_id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, account_id) REFERENCES connections (user_id, id) ON DELETE CASCADE
);

-- "Used by" on the Connectors page, and the disconnect cascade, look grants up by account.
CREATE INDEX agent_account_grants_account_idx ON agent_account_grants (user_id, account_id);

-- Carry today's access over exactly. A granted service gives its chosen account, or, with no
-- account chosen, its only account (what the agent could use before). A service with several
-- accounts and none chosen gave no access, and a choice that points at a missing account gave
-- none either, so neither gets a row. The service's own settings move to that account; values
-- of the wrong shape are left unset (the agent's own setting).
INSERT INTO agent_account_grants (user_id, agent_connection_id, account_id, read_tools, change_tools, allowed_tools)
SELECT p.user_id,
       p.connection_id,
       c.id,
       CASE WHEN jsonb_typeof(p.connector_policies -> s.service -> 'readTools') = 'boolean'
            THEN (p.connector_policies -> s.service ->> 'readTools')::boolean END,
       CASE WHEN p.connector_policies -> s.service ->> 'changeTools' IN ('off', 'allow', 'ask_first')
            THEN p.connector_policies -> s.service ->> 'changeTools' END,
       CASE WHEN jsonb_typeof(p.connector_policies -> s.service -> 'allowedTools') = 'array'
            THEN p.connector_policies -> s.service -> 'allowedTools' END
  FROM agent_permissions p
  CROSS JOIN LATERAL jsonb_array_elements_text(p.granted_connectors) AS s(service)
  JOIN connections c ON c.user_id = p.user_id AND c.connector_id = s.service
 WHERE CASE
         WHEN COALESCE(p.connector_accounts, '{}'::jsonb) ? s.service
           THEN c.id::text = p.connector_accounts ->> s.service
         ELSE (SELECT count(*) FROM connections o WHERE o.user_id = p.user_id AND o.connector_id = s.service) = 1
       END
ON CONFLICT DO NOTHING;

-- Several accounts of a service can now be on for new agents.
DROP INDEX connections_default_for_agents_idx;

-- A new table needs its own grant (0094 covered the tables that existed then). Deleting a
-- person, an agent's permissions or an account removes grants by cascade.
GRANT SELECT, INSERT, UPDATE, DELETE ON agent_account_grants TO warthog_app;
