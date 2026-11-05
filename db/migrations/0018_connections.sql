-- 0018_connections — the connection aggregate (CLAUDE.md vocabulary: a *connection*
-- is a person's connected service; a *connector* is a catalogue entry; design §6.1,
-- §7 — "Agents reach connected services only through Warthog").
--
-- A connection holds the provider CREDENTIALS and the live STATUS for one connected
-- service. Every agent use of a service resolves through one connection, and
-- management must see ALL of a person's connections regardless of status. The
-- credentials carry PERSONAL CONTENT (provider OAuth tokens / API keys), so they are
-- stored only DEK-ENCRYPTED (design §4.1, §7 — "Credentials are stored DEK-encrypted
-- per connection"): the `credentials` column holds a `v1:` envelope (AES-256-GCM
-- under the person's data key), never the plaintext.
--
-- `user_id` binds the row to its person and cascades on account deletion — every
-- read/write is member-scoped by this id (never an id from the client).
-- `connector_id` is the catalogue slug of the connected service (design §7 —
-- `catalogue/connectors/<id>.yaml`: "google", "microsoft", "gmail", …): a TEXT value,
-- not a uuid, bound by value with ownership enforced by `user_id`, never a foreign key
-- to the catalogue (which is a data file, not a table). `account_label` is the account
-- shown in the UI (e.g. an address). `status` is constrained to the three values a
-- connection can hold — 'connected' on a fresh connect, 'needs_reconnect' after a
-- failed refresh (design §7), 'error'. Time is clock-driven in application code (not
-- SQL now()), so `connected_at` is set at create time.

CREATE TABLE connections (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  connector_id  text NOT NULL,
  account_label text NOT NULL,
  status        text NOT NULL CHECK (status IN ('connected', 'needs_reconnect', 'error')),
  credentials   text NOT NULL,
  connected_at  timestamptz NOT NULL
);

-- listConnectionsForUser reads every connection for a person (WHERE user_id = $1) and
-- getConnectionById / getConnectionCredentials / updateConnectionStatus filter the
-- same column, so index user_id.
CREATE INDEX connections_user_idx ON connections (user_id);
