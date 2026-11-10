-- Agent settings are metadata; personal content remains encrypted in its source table.
CREATE TABLE agent_defaults (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  template text NOT NULL DEFAULT 'standard' CHECK (template IN ('minimal', 'standard')),
  rate_limit integer NOT NULL DEFAULT 120 CHECK (rate_limit BETWEEN 1 AND 10000)
);

-- Preserve current access when splitting the previously coupled memory permission.
ALTER TABLE agent_permissions ADD COLUMN memory_write boolean NOT NULL DEFAULT false;
UPDATE agent_permissions SET memory_write = memory_read;

-- An explicit agent decision overrides a skill's shared/chosen default, but can
-- never enable a disabled skill. Removing either resource removes the override.
CREATE TABLE agent_skill_access (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  skill_id uuid NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  allowed boolean NOT NULL,
  PRIMARY KEY (user_id, agent_id, skill_id)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON agent_defaults, agent_skill_access TO warthog_app;

-- Connector grants name the service; this optional map pins the service account
-- to use. Older single-account grants keep working, ambiguous accounts fail closed.
ALTER TABLE agent_permissions ADD COLUMN connector_accounts jsonb NOT NULL DEFAULT '{}'::jsonb;
-- Older permission forms stored this display label as a currency code.
UPDATE agent_permissions SET card_budget = jsonb_set(card_budget, '{currency}', '"AUD"'::jsonb)
WHERE card_budget->>'currency' = 'A$';
