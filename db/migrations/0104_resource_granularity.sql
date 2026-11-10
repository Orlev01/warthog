ALTER TABLE agent_permissions ADD COLUMN identity_fields jsonb;
ALTER TABLE agent_permissions ADD COLUMN connector_policies jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE approvals ADD COLUMN released_field_id uuid;
CREATE TABLE agent_memory_access (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  memory_id uuid NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  allowed boolean NOT NULL,
  PRIMARY KEY (user_id, agent_id, memory_id)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON agent_memory_access TO warthog_app;
CREATE INDEX memories_owner_order ON memories(user_id, created_at, id);
CREATE INDEX skills_owner_order ON skills(user_id, created_at, id);
