-- 0014_rules — the rules store (design §8 policy engine, brief "Rules and
-- approvals").
--
-- A rule is a plain-language `ask_first` or `never_allow` instruction, scoped to
-- all agents or a chosen agent, over one of the brief's actions, with an optional
-- condition. The policy engine (§8 steps 3 & 6) reads the rules APPLICABLE to a
-- connection and action on every agent call; the rules screen manages them.
--
-- `user_id` binds the row to its person and cascades on account deletion — every
-- read/write is member-scoped by this id (never an id from the client).
--
-- The kind, scope and action are PLAINTEXT METADATA (design §4.1) — needed to
-- filter the applicable set — so, like a connection's grants, they are NOT
-- encrypted. The scope is decomposed into its filterable parts: `scope_type`
-- ('any_agent' or 'agent'), and for a chosen agent its `scope_agent_id` (an opaque
-- uuid — the connections table is created by a later migration, so like 0011/0012/
-- 0013 this binds a plain column rather than a foreign key to a table that does not
-- exist yet) and its `scope_agent_name`. The action is kept structurally as jsonb,
-- so the applicable lookup matches it by canonical equality.
--
-- The `condition` carries PERSONAL CONTENT (a recipient address, a merchant list),
-- so it is stored only DEK-ENCRYPTED (design §4.1): the column holds a `v1:`
-- envelope (AES-256-GCM under the person's data key), never the plaintext, and is
-- NULL when the rule has no condition. `status` is constrained to its two values
-- ('active' on create, 'paused' after a pause) — a paused rule persists but is
-- excluded from the applicable set.

CREATE TABLE rules (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind             text NOT NULL CHECK (kind IN ('ask_first', 'never_allow')),
  scope_type       text NOT NULL CHECK (scope_type IN ('any_agent', 'agent')),
  scope_agent_id   uuid,
  scope_agent_name text,
  action           jsonb NOT NULL,
  condition        text,
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused'))
);

-- listRules and applicableRules both read a person's active rules (WHERE user_id
-- AND status = 'active'), so index both columns of that filter.
CREATE INDEX rules_user_status_idx ON rules (user_id, status);
