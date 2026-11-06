-- 0038_exchange_rates — the daily reference-rate store (brief "Currency": "a card
-- request in another currency is converted for the rule checks using the latest daily
-- reference exchange rate from a free official source, the approval shows both amounts
-- and the rate's date, and if no rate is available the request is refused with a plain
-- reason"; design §8 step 4: "currency converted with the latest daily ECB reference
-- rate … — no rate → deny").
--
-- One row per (rate date, base currency, quote currency): the composite PRIMARY KEY
-- makes an upsert of the same day's rate overwrite in place and never duplicate, and
-- lets the policy engine read the LATEST rate ON OR BEFORE a requested date for a pair
-- (ORDER BY rate_date DESC LIMIT 1). Direction matters — USD→AUD is a different pair
-- from AUD→USD — so both currencies are part of the key.
--
-- Daily reference rates are GLOBAL reference data (a short numeric scalar per (date,
-- pair)), NOT member-scoped personal content — so, like the account currency and unlike
-- vault fields, cards or released values, they are PLAINTEXT and NOT DEK-encrypted, and
-- no row is bound to a person. `rate` is numeric (exact; the quoted reference rate reads
-- back at its stored precision). The CHECKs keep the currencies to the ISO 4217 shape
-- (three uppercase letters) and the rate positive as schema-level guards; input is also
-- validated at the HTTP boundary and every value is bound as a parameter (INV-102).

CREATE TABLE exchange_rates (
  rate_date      date NOT NULL,
  base_currency  text NOT NULL CHECK (base_currency ~ '^[A-Z]{3}$'),
  quote_currency text NOT NULL CHECK (quote_currency ~ '^[A-Z]{3}$'),
  rate           numeric NOT NULL CHECK (rate > 0),
  PRIMARY KEY (rate_date, base_currency, quote_currency)
);

-- getRate reads the latest rate on or before a date for a pair
-- (WHERE base_currency = $1 AND quote_currency = $2 AND rate_date <= $3
--  ORDER BY rate_date DESC LIMIT 1), so index that pair + date lookup.
CREATE INDEX exchange_rates_pair_date_idx
  ON exchange_rates (base_currency, quote_currency, rate_date DESC);
