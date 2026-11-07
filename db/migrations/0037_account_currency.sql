-- 0037_account_currency — the per-person account-currency setting store (brief
-- "Currency": "the person sets their account currency in Settings (default AUD), and
-- their own agent budgets and limits are in that currency"; a new household's currency
-- defaults to the owner's account currency — design §4.1).
--
-- A person's account currency is a known ISO 4217 code they choose in Settings; it is
-- the currency their own agent budgets and limits are expressed in, and it seeds a new
-- household's currency. Like the notification preferences, the stored code is PLAINTEXT
-- METADATA (a short scalar the budget/limit maths reads) — so, unlike vault fields,
-- cards or released values, it is NOT DEK-encrypted and this table holds no secret.
--
-- One row per person: `user_id` is the PRIMARY KEY (so a set upserts in place and never
-- duplicates) and REFERENCES users(id), cascading on account deletion. Every read/write
-- is member-scoped by this id — the session's `userId`, never an id from the client —
-- so one person can never read or change another's account currency. When a person has
-- set nothing, NO row exists and the brief's default ("AUD") is assembled in code, never
-- read from a column default. The CHECK keeps the stored code to the ISO 4217 shape
-- (three uppercase letters) as a schema-level guard; the repo is the one source of truth
-- for WHICH codes are known and rejects an unknown code before it ever reaches a write.

CREATE TABLE account_currency (
  user_id  uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$')
);
