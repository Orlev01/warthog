-- 0022_identity_fields — the low-tier identity store (brief "Identity vault";
-- design §4.1).
--
-- Low-tier identity is "name, preferred name, email addresses, phone numbers,
-- postal addresses with a 'moving on' date, language, time zone and general
-- preferences" — personal content shared freely with permitted agents via
-- get_context. Each field's `value` is PERSONAL CONTENT, so it is stored only
-- DEK-ENCRYPTED (design §4.1): the column holds a `v1:` envelope (AES-256-GCM
-- under the person's data key) whose associated data binds the ciphertext to its
-- exact (table, column, row id), never the plaintext. High-tier details live in
-- the device-held vault (design §4.2), NOT here.
--
-- A person may hold SEVERAL fields of the same kind (the brief's "email
-- addresses" / "phone numbers" / "postal addresses" are plural), so each saved
-- field is its own row keyed by a generated `id` — not an upsert keyed on kind.
-- `kind` is constrained to the eight low-tier field kinds.
--
-- `moving_on` is the optional "moving on" date a postal address may carry — a
-- bare calendar date (metadata, not the address itself), stored alongside the
-- encrypted value and null for every other kind or an address with no move
-- planned.
--
-- `user_id` binds the row to its person and cascades on account deletion; every
-- read/write is member-scoped by this id (never an id from the client).

CREATE TABLE identity_fields (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       text NOT NULL CHECK (kind IN (
               'name', 'preferred_name', 'email', 'phone',
               'postal_address', 'language', 'time_zone', 'preference')),
  value      text NOT NULL,
  moving_on  date,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- listIdentityFields reads all of a person's fields (WHERE user_id = $1), so
-- index the member-scope filter.
CREATE INDEX identity_fields_user_idx ON identity_fields (user_id);
