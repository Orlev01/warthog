-- 0039_households — the household + membership store (brief "Household sharing";
-- design §4.1).
--
-- A household is the shared container for an address, a budget and per-member
-- limits. Its owner invites members (capped at 8, incl. the owner); the owner sets
-- a shared monthly household budget and a monthly limit per member, both in the
-- household currency (chosen by the owner, defaulting to the owner's account
-- currency). Members see the shared figures and the member list; only the owner may
-- set budgets/limits, remove a member, transfer ownership or close the household.
--
-- These are PLAINTEXT METADATA (ids, roles, budgets, limits, an ISO 4217 code —
-- needed for the budget maths, design §4.1), so — unlike vault fields — they are NOT
-- DEK-encrypted and this store holds no key. Every member-scoped read/write is
-- scoped to the SESSION's user id (never a value from the client).
--
-- `owner_id` is the current owner (changes only on an accepted transfer) and
-- REFERENCES users(id), cascading on account deletion. `pending_owner_id` names a
-- pending ownership-transfer target (NULL when none) — ownership does NOT move until
-- that member accepts. `monthly_budget` is the shared monthly household budget (NULL
-- until set); amounts are numeric (exact money arithmetic).
CREATE TABLE households (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  currency         text NOT NULL,
  monthly_budget   numeric,
  pending_owner_id uuid
);

-- One membership row per (household, person). `role` is the owner's row ('owner') or
-- a plain member's ('member'); `monthly_limit` is that member's per-member monthly
-- limit (NULL until set). `household_id` cascades on close (DELETE households) so the
-- shared container is removed with every membership; `user_id` cascades on account
-- deletion. Removing a membership row leaves the person's own account intact.
CREATE TABLE household_members (
  household_id  uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role          text NOT NULL CHECK (role IN ('owner', 'member')),
  monthly_limit numeric,
  PRIMARY KEY (household_id, user_id)
);

-- getHouseholdForMember and isHouseholdMember read a person's membership
-- (WHERE user_id), so index that member-scoped filter.
CREATE INDEX household_members_user_idx ON household_members (user_id);
