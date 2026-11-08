-- 0076_household_invites_household_idx — index invites by household (review fix W3.1).
--
-- Issuing an invite now counts the household's open invites and the invites it sent in the
-- last hour, inside the insert that adds the new one, and the Household page lists a
-- household's open invites. This index serves all three (and the household_id foreign key,
-- which had no index). Additive: it changes no rows.
CREATE INDEX IF NOT EXISTS household_invites_household_created_idx
  ON household_invites (household_id, created_at);
