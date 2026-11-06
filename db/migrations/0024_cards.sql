-- 0024_cards — the saved-cards store (brief "Identity vault" + §17 "No readable
-- card numbers or security codes"; design §4.2 "Device-held vault (high-tier
-- details and cards)").
--
-- Cards are DEVICE-HELD, exactly like high-tier identity values
-- (0023_high_tier_fields): the card NUMBER is encrypted IN THE BROWSER with the
-- device-held vault key (VK) BEFORE it leaves the device. THE SERVER STORES
-- CIPHERTEXT ONLY: `number_ciphertext` is the opaque device-produced blob
-- (metadata, not a key), stored verbatim and never decrypted — the server holds
-- no vault key. The plaintext card number lands in no column.
--
-- The only PLAINTEXT a card row carries is the metadata the interface shows and
-- budgets need: the card `brand`, the `last_four` digits, the expiry month/year,
-- a `nickname`, and a `billing_address_id` reference. The billing-address
-- reference is an OPAQUE reference to one of the person's postal-address identity
-- fields — NOT a foreign key (the card store enforces no referential integrity to
-- the identity store), so it is plain `text`.
--
-- The card SECURITY CODE (CVV) is NEVER stored in any form (constitution §17;
-- design §4.2 — the CVV is needed from the person at release time, never
-- persisted). There is deliberately NO security-code column.
--
-- A person may hold SEVERAL cards, so each saved card is its own row keyed by a
-- generated `id` — not an upsert. `user_id` binds the row to its person and
-- cascades on account deletion; every read/write is member-scoped by this id
-- (never an id from the client).

CREATE TABLE cards (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  brand              text NOT NULL,
  last_four          text NOT NULL,
  expiry_month       integer NOT NULL,
  expiry_year        integer NOT NULL,
  nickname           text NOT NULL,
  billing_address_id text NOT NULL,
  number_ciphertext  text NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now()
);

-- listCards reads all of a person's cards (WHERE user_id = $1), so index the
-- member-scope filter.
CREATE INDEX cards_user_idx ON cards (user_id);
