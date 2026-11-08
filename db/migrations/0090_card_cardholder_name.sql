-- 0090_card_cardholder_name — the name on the card (review fix W6; brief "Saved cards":
-- "add one or more cards (cardholder name, number, expiry, a nickname, a billing address
-- from the vault)").
--
-- A checkout needs the cardholder name alongside the number, security code, expiry and
-- billing address, so a card release hands it to the agent. The name is printed on the
-- card and is not secret — it is plaintext metadata, exactly like the expiry and the
-- nickname. The card NUMBER stays device ciphertext and the security code is still never
-- stored.
--
-- Additive and safe on existing rows: a nullable column with no default. Cards saved
-- before this migration have no name; a release falls back to the person's saved name
-- from About you. The runner applies this file inside its own transaction, with the
-- migration lock held.

ALTER TABLE cards ADD COLUMN cardholder_name text;
