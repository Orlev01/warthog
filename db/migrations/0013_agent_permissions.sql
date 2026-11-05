-- 0013_agent_permissions — a connection's permission grants (design §7 connector
-- engine, §8 policy step 2, brief "Per-agent permissions page").
--
-- One connection's grants live in exactly one row here (constitution:
-- one-source-of-truth): the consent screen and the per-agent permissions page read
-- and write them, and the policy pipeline (§8 step 2) reads them on every agent
-- call. The grants are PLAINTEXT METADATA (design §4.1: connector ids, tool-class
-- settings, booleans, budget amount+currency+period, the request limit) — needed
-- for the per-call permission check and for filtering — so, unlike held-request
-- args or approval detail, they are NOT DEK-encrypted.
--
-- `user_id` binds the row to its person and cascades on account deletion — every
-- read/write is member-scoped by this id (never an id from the client).
-- `connection_id` is the connection these grants belong to: an opaque uuid here
-- (the connections table is created by a later migration, so — like 0011/0012 bind
-- agent_id/connection_id — this binds a plain column rather than a foreign key to a
-- table that does not exist yet). One row per (person, connection): the composite
-- primary key makes a second upsert for the same pair overwrite in place rather
-- than duplicate, and serves the member-scoped lookup (WHERE user_id AND
-- connection_id) from its own index.
--
-- The collection and structured fields (granted connectors, skills scope, rules
-- scope, the card budget) are kept structurally as jsonb; the rest are scalar
-- metadata columns. `change_tools` is constrained to its three settings. The
-- card-access-needs-a-budget rule is enforced in application code (the upsert
-- refuses card access with no budget) so a half-write never lands.

CREATE TABLE agent_permissions (
  user_id            uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  connection_id      uuid NOT NULL,
  granted_connectors jsonb NOT NULL,
  read_tools         boolean NOT NULL,
  change_tools       text NOT NULL CHECK (change_tools IN ('off', 'allow', 'ask_first')),
  identity_access    boolean NOT NULL,
  high_tier_access   boolean NOT NULL,
  card_access        boolean NOT NULL,
  card_budget        jsonb,
  skills_scope       jsonb NOT NULL,
  memory_read        boolean NOT NULL,
  sharing            boolean NOT NULL,
  rules_scope        jsonb NOT NULL,
  rate_limit         integer NOT NULL,
  PRIMARY KEY (user_id, connection_id)
);
