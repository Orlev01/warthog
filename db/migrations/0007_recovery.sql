-- 0007_recovery — the one-time recovery code (design §4.2, §5).
--
-- A recovery code is shown once at sign-up and restores access / unlocks the vault
-- if every passkey is lost. The server authenticates a recovery sign-in WITHOUT
-- ever holding the code: it stores only a slow one-way auth hash,
-- scrypt(HKDF(code, info `warthog/recovery-auth/v1`)) — per the project rule that
-- recovery codes are stored only as a hash and appear in plain text nowhere except
-- the single message that hands a person their own code. A leak of this table
-- cannot reveal a live code (nor the vault wrapping key the same code separately
-- derives).
--
-- There is exactly ONE current recovery code per person, so the table hangs off
-- `users(id)` as its PRIMARY KEY: regenerating replaces the row in place, which is
-- why the old code stops verifying and the fresh one takes over. `salt` is the
-- per-row scrypt salt (public, a verification input, not a secret); `auth_hash` is
-- the stored scrypt digest. Both are hex metadata; neither holds the plaintext.

CREATE TABLE recovery_codes (
  user_id    uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  auth_hash  text NOT NULL,
  salt       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
