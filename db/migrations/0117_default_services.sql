-- 0117_default_services — "On for new agents" (docs/adr/default-services.md). A person can mark
-- one account of a service on the Connectors page, and every agent connected afterwards starts
-- with that service ticked on its consent or access-key screen, set to that account. Agents
-- already connected are not changed.
--
-- At most one account per service per person, because an agent uses one account of each
-- service. Disconnecting an account deletes its row, so its mark goes with it.

ALTER TABLE connections ADD COLUMN default_for_agents boolean NOT NULL DEFAULT false;

CREATE UNIQUE INDEX connections_default_for_agents_idx
  ON connections (user_id, connector_id) WHERE default_for_agents;

-- 0094's table-wide grant to warthog_app already covers the new column.
