-- 0006_passkeys — passkeys (WebAuthn credentials) and their issued challenges
-- (design §5, §4.2).
--
-- A passkey is the preferred second factor and vault-unlock method. Registration
-- and authentication run through SimpleWebAuthn with the RP ID warthog.com.au
-- (read from config, not hard-coded). This migration stores the two things the
-- server must keep between the browser round trips:
--
--   * `passkeys` — one row per registered credential. `public_key` is the
--     credential's COSE public key (base64url; a verification input, not a
--     secret) and `counter` is the signature counter the authenticator reports,
--     advanced on every authentication so a replayed (non-advancing) assertion is
--     rejected. `credential_id` is globally unique, so the same credential cannot
--     be registered twice. Every credential hangs off `user_id` (the account id a
--     session carries) and cascades on account deletion.
--
--   * `passkey_challenges` — the one outstanding challenge per person per purpose
--     (registration vs authentication). `begin` issues it; `finish` verifies the
--     attestation/assertion against the challenge the server itself issued, so a
--     response to a challenge we never sent cannot verify. A challenge is a public
--     nonce (it is handed to the browser in the options), so it is stored as-is;
--     the next `begin` overwrites it.

CREATE TABLE passkeys (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credential_id text NOT NULL UNIQUE,
  public_key    text NOT NULL,
  counter       bigint NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Authentication reads a credential back by (user_id, credential_id): the user_id
-- filter is the ownership check (a credential presented for the wrong person is
-- simply not found). This index serves that lookup.
CREATE INDEX passkeys_owner_idx ON passkeys (user_id, credential_id);

CREATE TABLE passkey_challenges (
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose    text NOT NULL,
  challenge  text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, purpose)
);
