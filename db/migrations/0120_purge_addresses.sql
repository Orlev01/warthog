-- 0120_purge_addresses — the account purge also deletes the rows that hold the person's email
-- address outside the account cascade (review 2026-11-23, High).
--
-- The sign-in code tables (0005, 0046) and household invites (0040) are keyed by an address,
-- not a user id: the code flow runs before an account may exist, and an invite is bound to
-- the address it was sent to. Deleting the `users` row never reached them. The purge now
-- deletes them by the person's address, read from their row before it goes. The purge role
-- (0094) may read only the address column of these tables, to match on it, and delete rows;
-- it can't insert or change them. The hourly `email-address-retention` sweep runs as the
-- application role, which already holds DELETE on them.
GRANT SELECT (email) ON email_codes, email_code_attempts, email_code_alerts, household_invites TO warthog_purge;
GRANT DELETE ON email_codes, email_code_attempts, email_code_alerts, household_invites TO warthog_purge;
