-- 0040_household_invites — the single-use household-invite store (brief "Household
-- sharing"; design §4.1).
--
-- The owner invites members by an emailed link valid 7 days (up to 8 members, the cap
-- shared with 0039's household store). That link carries a 256-bit token — a CREDENTIAL
-- — so (project rule: tokens and link tokens are stored only as hashes, SHA-256 or HMAC;
-- the design fixes this one at a 256-bit value stored as a SHA-256 hash, like every other
-- opaque Warthog token) this table holds ONLY the token's SHA-256 hash (`token_hash`),
-- never the raw value. The raw token is returned once to the issuer, for the single
-- message that delivers it, and appears in clear nowhere else.
--
-- Like the approval-link store (0028) this one is CREDENTIAL-KEYED: a row is addressed by
-- its token hash and bound to ONE household + the invited email, not a user_id. The person
-- who clicks the link signs in first; the member ADDED on redemption is the SESSION's user
-- id (passed by the caller), never a value smuggled from the client, so there is no
-- invited-user column.
--
-- `household_id` is the one household the invite joins; it cascades when that household is
-- closed (DELETE households). `email` is the invited person's email, bound to the invite.
-- Time is clock-driven in application code (not SQL now()), so `created_at` and
-- `expires_at` (created_at + 7 days) are the injected clock's instants; `used_at` is
-- stamped on the single redemption, enforcing single use.
CREATE TABLE household_invites (
  token_hash   text PRIMARY KEY,
  household_id uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  email        text NOT NULL,
  created_at   timestamptz NOT NULL,
  expires_at   timestamptz NOT NULL,
  used_at      timestamptz
);
