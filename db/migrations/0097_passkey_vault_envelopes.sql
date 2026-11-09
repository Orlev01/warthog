-- Keep unlabelled legacy PRF envelopes intact. Only a successful device unlock
-- could establish which credential owns one; no automatic backfill can do that.
ALTER TABLE passkeys ADD CONSTRAINT passkeys_owner_credential_unique UNIQUE (user_id, credential_id);
CREATE TABLE vault_passkey_envelopes (
  user_id uuid NOT NULL,
  credential_id text NOT NULL,
  wrapped_key text NOT NULL,
  params jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, credential_id),
  FOREIGN KEY (user_id, credential_id) REFERENCES passkeys(user_id, credential_id) ON DELETE CASCADE
);
GRANT SELECT, INSERT, UPDATE, DELETE ON vault_passkey_envelopes TO warthog_app;
