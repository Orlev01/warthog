-- 0021_vault_unlock_methods — the device-held vault's server-side unlock store
-- (design §4.2 "Device-held vault").
--
-- The browser creates a random 256-bit VAULT KEY (VK) at first use; high-tier
-- values and card data are encrypted in the browser with VK and the server stores
-- only ciphertext. VK itself is stored server-side ONLY WRAPPED, once per unlock
-- method — the server never holds VK, the passphrase, the PRF output or the
-- recovery code in clear. A leak of these tables therefore reveals no vault key,
-- passphrase or recovery code.
--
-- Three concerns, three tables (one source of truth per fact):
--
-- * `vault_unlock_methods` — one WRAPPED VK per (person, unlock method). `method`
--   is one of the three unlock methods (passkey PRF, passphrase, recovery).
--   `wrapped_key` is the opaque ciphertext (VK wrapped by that method's wrapping
--   key) — the server cannot unwrap it. `params` is the method's PUBLIC
--   verification inputs as jsonb (e.g. a passphrase's PBKDF2 salt + iterations);
--   it is metadata, never a secret, and round-trips verbatim. The composite
--   primary key (user_id, method) makes a re-save overwrite in place (one wrapped
--   key per method) and serves the member-scoped lookup from its own index.
--
-- * `vault_prf_salts` — the person's FIXED 32-byte passkey-PRF salt (`salt_v1`),
--   created once and returned stably thereafter. It is a per-person prerequisite
--   the browser feeds to the authenticator's PRF eval — NOT itself an unlock
--   method — so it lives apart from `vault_unlock_methods` and never appears in a
--   method listing. The salt is public metadata (a verification input), not a key.
--
-- * `vault_recovery_auth` — the one-way verifier that lets the server authenticate
--   a recovery unlock WITHOUT learning the recovery code or the wrapping key it
--   derives: scrypt(HKDF(code, info), salt). Only the digest and its per-row scrypt
--   salt are stored (both hex metadata); the plaintext code is written to no
--   column (project rule: codes are stored only as a hash). One current verifier
--   per person, so the table hangs off users(id) as its primary key — regenerating
--   replaces the row in place, which is why an old code stops verifying.
--
-- Every row binds to its person via `user_id` and cascades on account deletion;
-- every read/write is member-scoped by this id (never an id from the client).

CREATE TABLE vault_unlock_methods (
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  method      text NOT NULL CHECK (method IN ('passkey_prf', 'passphrase', 'recovery')),
  wrapped_key text NOT NULL,
  params      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, method)
);

CREATE TABLE vault_prf_salts (
  user_id    uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  salt       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE vault_recovery_auth (
  user_id    uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  auth_hash  text NOT NULL,
  salt       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
