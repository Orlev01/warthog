-- 0023_high_tier_fields — the high-tier identity store (brief "Identity vault" +
-- "Device-held protection"; design §4.2 "Device-held vault").
--
-- High-tier identity details — date of birth, passport, driver licence, car
-- registration and any custom field the person marks high — are PERSONAL CONTENT
-- at the top sensitivity tier, released only after an approved, stepped-up
-- request. Unlike the LOW-tier store (0022_identity_fields), which the server
-- DEK-encrypts itself, high-tier values are encrypted IN THE BROWSER with the
-- device-held vault key (VK) BEFORE they leave the device. THE SERVER STORES
-- CIPHERTEXT ONLY: `ciphertext` is the opaque device-produced blob (metadata, not
-- a key), stored verbatim and never decrypted — the server holds no vault key.
-- The plaintext value lands in no column.
--
-- `label` and `type` are the plaintext metadata a list read hands back (never the
-- value). `type` is constrained to the five high-tier field types (the four
-- defaults plus `custom`). Every row in this store is high tier, so the tier is
-- the table itself — no tier column.
--
-- A person may hold SEVERAL fields of the same type (two passports, several
-- custom fields), so each saved field is its own row keyed by a generated `id` —
-- not an upsert keyed on type.
--
-- `user_id` binds the row to its person and cascades on account deletion; every
-- read/write is member-scoped by this id (never an id from the client).

CREATE TABLE high_tier_fields (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type       text NOT NULL CHECK (type IN (
               'date_of_birth', 'passport', 'driver_licence',
               'car_registration', 'custom')),
  label      text NOT NULL,
  ciphertext text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- listHighTierFields reads all of a person's fields (WHERE user_id = $1), so
-- index the member-scope filter.
CREATE INDEX high_tier_fields_user_idx ON high_tier_fields (user_id);
