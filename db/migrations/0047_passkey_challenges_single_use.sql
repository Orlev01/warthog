-- 0047_passkey_challenges_single_use — several outstanding challenges per person and
-- purpose (review fix B4; design §5).
--
-- A challenge is now single-use and short-lived: finish deletes the exact challenge
-- carried in the browser's response (DELETE ... RETURNING, so one assertion can be
-- finished once) and refuses one older than five minutes. With the old
-- (user_id, purpose) key, any unauthenticated begin for a person's email overwrote
-- their outstanding challenge and broke a sign-in or step-up already in progress.
-- Keying by the challenge itself lets each ceremony keep its own row; begin purges the
-- person's expired rows and caps how many stay outstanding.
--
-- Safe on existing data: every existing (user_id, purpose) row is unique, so it is
-- also unique under the wider key. No row is changed or removed.

ALTER TABLE passkey_challenges DROP CONSTRAINT passkey_challenges_pkey;
ALTER TABLE passkey_challenges ADD PRIMARY KEY (user_id, purpose, challenge);
