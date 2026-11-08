-- 0058_household_data_key — a household-scoped data key for shared household content
-- (brief "Household sharing"; design §4.1).
--
-- The household shared address used to be encrypted under the household OWNER's data
-- key. Ownership can move (transfer + accept) and the former owner can then delete their
-- account (crypto-shredding their key), so content held under one person's key became
-- unreadable for every member; and every member's read had to unwrap the owner's WHOLE
-- data key, which opens all of the owner's personal data.
--
-- Shared household content is now encrypted under the household's OWN random 256-bit
-- data key, stored here only WRAPPED by the KEK (exactly like users.wrapped_dek). It
-- belongs to no person, so a transfer needs no crypto work and no member ever unwraps
-- another member's key. Additive and safe on existing data: the column is nullable, and
-- a household created before this migration gets its key on its next shared-address
-- write or ownership acceptance, which re-encrypts any existing shared address from the
-- current owner's key to the new household key in the same transaction (the app does
-- this; SQL cannot, as it never holds the KEK).

ALTER TABLE households ADD COLUMN wrapped_dek text;
