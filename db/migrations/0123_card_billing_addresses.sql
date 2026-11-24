-- 0123_card_billing_addresses — a card can have its own billing address
-- (docs/adr/card-billing-addresses.md; brief "Saved cards", amended 24 November 2026).
--
-- A person reported that the only billing addresses a card could use were their About you
-- postal addresses, so a billing address that isn't where they live had to be saved as a
-- personal detail, which agents then read as an everyday detail. A card's billing address is
-- now either one of the person's About you postal addresses (as before) or an address kept with
-- their cards only.
--
-- Card-only billing addresses live in their own table, so nothing that lists identity fields
-- (get_context, About you, the per-agent detail toggles, moving) can see them. The value is
-- personal content, so it is stored only as a DEK envelope bound to (table, column, row id), the
-- same as identity_fields; the CHECK refuses anything that isn't an envelope. A card-only address
-- exists only while a card uses it: the app deletes it when its last card is removed or moves to
-- another address, and vault reset erases them with the cards.
--
-- cards.billing_address_id keeps meaning "one of the owner's postal identity fields" and becomes
-- nullable; cards.billing_entry_id points at a card-only address. A composite foreign key means
-- the database itself refuses a card that points at another person's billing address, and a card
-- never carries both. The foreign key is checked at commit, so an account purge that cascades
-- into both tables completes in either order.
--
-- billing_address_id was only ever shape-checked, so it may point at a row that is gone (made
-- protected), another person's row or a field that isn't an address. Those were already broken
-- (a release sent "no billing address", and the account could not import its own export); they
-- are cleared here so the card shows "No billing address yet" and can be given one.

CREATE TABLE card_billing_addresses (
  id         uuid PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  value      text NOT NULL CHECK (value LIKE 'v1:%'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, id)
);

ALTER TABLE cards ALTER COLUMN billing_address_id DROP NOT NULL;
ALTER TABLE cards ADD COLUMN billing_entry_id uuid NULL;
ALTER TABLE cards ADD CONSTRAINT cards_billing_entry_fk FOREIGN KEY (user_id, billing_entry_id)
  REFERENCES card_billing_addresses (user_id, id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE cards ADD CONSTRAINT cards_one_billing_ref
  CHECK (billing_address_id IS NULL OR billing_entry_id IS NULL);
CREATE INDEX cards_billing_entry_idx ON cards (user_id, billing_entry_id) WHERE billing_entry_id IS NOT NULL;

-- A reference is compared in the usual lowercase form (an id is stored as text), so an uppercase
-- form of the owner's own address is kept, written in that form.
UPDATE cards
   SET billing_address_id = lower(billing_address_id)
 WHERE billing_address_id IS NOT NULL
   AND billing_address_id <> lower(billing_address_id);

UPDATE cards c
   SET billing_address_id = NULL
 WHERE billing_address_id IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM identity_fields f
      WHERE f.id::text = c.billing_address_id
        AND f.user_id = c.user_id
        AND f.kind = 'postal_address');

-- A new table needs its own grant (0094 covered the tables that existed then).
GRANT SELECT, INSERT, UPDATE, DELETE ON card_billing_addresses TO warthog_app;
