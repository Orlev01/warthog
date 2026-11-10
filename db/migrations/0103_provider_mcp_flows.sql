-- Pending outbound OAuth state survives a restart, but is single-use, scoped to
-- the browser session, and short-lived. PKCE/discovery/client state is encrypted.
CREATE TABLE provider_mcp_flows (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id uuid NOT NULL,
  state_hash text NOT NULL UNIQUE,
  payload text NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX provider_mcp_flows_expiry ON provider_mcp_flows(expires_at);
CREATE INDEX provider_mcp_flows_owner ON provider_mcp_flows(user_id);
GRANT SELECT, INSERT, UPDATE, DELETE ON provider_mcp_flows TO warthog_app;
