-- 0060_household_single_membership — a person belongs to at most ONE household (brief
-- "Household sharing"; the code has always assumed it: getHouseholdForMember returns
-- "that one" household, and every household-scoped read — budgets, member limits, the
-- shared address, spending totals — is resolved through it).
--
-- Nothing enforced it: household_members' key is (household_id, user_id), so a person
-- (even a household's owner) could redeem another household's invite and end up in two,
-- making every household-scoped read pick one arbitrarily. The app now refuses that when
-- a join is redeemed; this unique index makes the database refuse it too, including for
-- two joins racing into different households.
--
-- Additive and safe on existing data: the index is created only when no person is
-- already in two households (a duplicate would make CREATE UNIQUE INDEX fail and stop
-- the app booting, and resolving one means choosing which membership to delete — a
-- human decision, not a migration's). In that case the app-level refusal still applies
-- and a notice is raised so an operator can resolve the duplicates and add the index.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM household_members GROUP BY user_id HAVING count(*) > 1
  ) THEN
    CREATE UNIQUE INDEX household_members_one_household_idx ON household_members (user_id);
  ELSE
    RAISE NOTICE 'household_members has people in more than one household; resolve them, then create the unique index household_members_one_household_idx ON household_members (user_id)';
  END IF;
END
$$;
