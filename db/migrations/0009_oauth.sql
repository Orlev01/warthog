-- 0009_oauth — the authorization server's storage (design §6.1).
--
-- Warthog is its own OAuth 2.1 authorization server: every connected agent gets a
-- separate, revocable credential and tokens are kept only as hashes. This migration
-- stores the four things that outlive a single request:
--
--   * `oauth_clients` — the agent platform's registration, CIMD (`client_id` is an
--     https URL) or DCR (`client_id` is the issued id). A client is a SHARED
--     registration — one claude.ai registration serves every person who connects it
--     — so it is NOT connection-bound. `client_id` is stored verbatim as data (this
--     is the natural key); `redirect_uris` is the client's allowed redirect URIs,
--     kept structurally as jsonb.
--
--   * `oauth_auth_codes` — one-time authorization codes, bound to the consent's
--     connection and stored ONLY as a hash (constitution: codes are stored only as
--     hashes). A code carries its PKCE S256 challenge, the client it was issued to,
--     the redirect URI and the required `resource`, plus a hard expiry.
--
--   * `oauth_tokens` — opaque random bearer values (access 1 h, refresh 30 d) stored
--     ONLY as SHA-256 hashes, each bound to one agent connection; `kind` tells the
--     two apart.
--
--   * `oauth_access_keys` — per-agent static bearers (`wh_ak_…`) for platforms that
--     only send a static Bearer header, stored ONLY as a hash, same connection model,
--     no expiry.
--
-- `connection_id` is an opaque uuid here: the connections table is created by a later
-- migration (E09-S05), so 0009 binds by a plain `connection_id` column rather than a
-- foreign key to a table that does not exist yet. The hash is the natural key of each
-- credential table, so a hash lookup is a primary-key read; the raw bearer is never a
-- stored column, so it can never be looked up.

CREATE TABLE oauth_clients (
  client_id     text PRIMARY KEY,
  registration  text NOT NULL CHECK (registration IN ('cimd', 'dcr')),
  redirect_uris jsonb NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE oauth_auth_codes (
  code_hash      text PRIMARY KEY,
  connection_id  uuid NOT NULL,
  client_id      text NOT NULL,
  code_challenge text NOT NULL,
  redirect_uri   text NOT NULL,
  resource       text NOT NULL,
  expires_at     timestamptz NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE oauth_tokens (
  token_hash    text PRIMARY KEY,
  connection_id uuid NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('access', 'refresh')),
  expires_at    timestamptz NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE oauth_access_keys (
  key_hash      text PRIMARY KEY,
  connection_id uuid NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
