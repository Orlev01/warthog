-- Client observations are assertions, encrypted under the owner's key; never authentication.
ALTER TABLE agents ADD COLUMN client_observation_ct text;
ALTER TABLE agent_permissions ADD COLUMN resource_controls jsonb NOT NULL DEFAULT '{}'::jsonb;
