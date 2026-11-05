-- 0015_card_spend_ledger — the card spend ledger (design §8 policy step 4 "card
-- requests", §4.1, brief "Card requests" + "Spending view").
--
-- On an approved card release Warthog records the approved amount, currency and
-- merchant against the connection's budget. The Spending page and the budget checks
-- in the policy engine (§8 step 4) read approved-release TOTALS for the current
-- period — per connection (an agent's budget), per member (the member's own limit)
-- and per household (the shared household budget).
--
-- `user_id` binds the row to its person and cascades on account deletion — every
-- read/write is member-scoped by this id (never an id from the client).
-- `connection_id` is the agent connection the release counts against and
-- `household_id` the household it counts toward (NULL when solo): both are opaque
-- uuids here (the connections and household-membership tables are created by later
-- migrations, so — like 0011/0012/0013/0014 bind agent_id/connection_id/
-- scope_agent_id — this binds a plain column rather than a foreign key to a table
-- that does not exist yet).
--
-- The amount, currency and merchant are PLAINTEXT METADATA (design §4.1: explicitly
-- allowed plaintext for budgets) — needed to sum spend — so, unlike vault values,
-- held-request args or rule conditions, they are NOT DEK-encrypted. `amount` is
-- numeric (exact money arithmetic; the sums are exact). The three period columns
-- (`period_day` / `period_week` / `period_month`) hold the opaque day/week/month
-- buckets the release falls in, one per granularity, matched verbatim — the store
-- does no date math.

CREATE TABLE card_spend_ledger (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL,
  household_id  uuid,
  amount        numeric NOT NULL,
  currency      text NOT NULL,
  merchant      text NOT NULL,
  period_day    text NOT NULL,
  period_week   text NOT NULL,
  period_month  text NOT NULL
);

-- sumForConnectionPeriod and sumForMemberPeriod read a person's releases
-- (WHERE user_id [AND connection_id]), so index that member-scoped filter.
CREATE INDEX card_spend_ledger_user_conn_idx ON card_spend_ledger (user_id, connection_id);

-- sumForHouseholdPeriod aggregates a household's releases (WHERE household_id) and
-- checks the caller's participation in it, so index the household column.
CREATE INDEX card_spend_ledger_household_idx ON card_spend_ledger (household_id);
