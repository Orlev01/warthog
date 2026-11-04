-- 0010_totp_secrets — the authenticator-app (TOTP) secret store (design §4, §5).
--
-- A returning person's authenticator-app second factor is a single base32 secret
-- the sign-in handler reads to verify a TOTP code. Per the project rule that
-- personal content is stored only DEK-encrypted, the secret is never stored in the
-- clear: `secret_enc` holds the `v1:` DEK-envelope ciphertext (AES-256-GCM under the
-- person's own 256-bit data key, src/server/crypto/envelope.ts), so a leak of this
-- row reveals no usable secret. Only metadata is plaintext.
--
-- There is exactly ONE current secret per person, so the table hangs off `users(id)`
-- as its PRIMARY KEY: a re-enrol (set again) REPLACES the row in place, which is why
-- the old secret stops working and the fresh one takes over. `user_id` is the
-- account id the session carries; every read/write is filtered by it (member-scoped
-- — a secret never crosses accounts). ON DELETE CASCADE drops the secret with the
-- account.

CREATE TABLE totp_secrets (
  user_id    uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  secret_enc text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
