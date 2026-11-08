-- 0048_users_email_lower — one account per address, whatever its case (review fix B8).
--
-- `users.email` was UNIQUE on the exact text, so 'Oren@x.com' and 'oren@x.com' were two
-- accounts and lookups were case-sensitive. The app now stores and looks up addresses
-- trimmed and lower-cased (users.normaliseEmail), and looks rows up by lower(email), so
-- an address written before this change is still found. This index serves that lookup
-- and makes the database itself refuse a case variant of an existing address.
--
-- Safe on existing data: if case-variant duplicates already exist, a UNIQUE index cannot
-- be built, so the lookup index is created without uniqueness instead (and a notice is
-- raised for the operator to merge the duplicates). No row is changed or removed.

DO $$
BEGIN
  IF EXISTS (SELECT lower(email) FROM users GROUP BY lower(email) HAVING count(*) > 1) THEN
    RAISE NOTICE 'users: case-variant duplicate emails exist; lower(email) index created without UNIQUE';
    CREATE INDEX IF NOT EXISTS users_email_lower_idx ON users (lower(email));
  ELSE
    CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_idx ON users (lower(email));
  END IF;
END
$$;
