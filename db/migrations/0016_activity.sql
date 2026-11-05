-- 0016_activity — the activity record (design §9 "activity hash chain",
-- constitution principle 14 "Warthog writes the record").
--
-- Warthog records every tool call, approval, release, connection change and
-- memory write ITSELF at the moment it handles it. The record is APPEND-ONLY and
-- HASH-CHAINED over CIPHERTEXT: each entry carries a contiguous per-user `seq` and
-- a `prev_hash` equal to the previous entry's `entry_hash`, where
-- `entry_hash = SHA-256(prev_hash ‖ canonical(all other fields incl. payload_ct))`.
-- The daily integrity check recomputes that chain from the stored row alone, over
-- the ciphertext, with NO decryption — so an operator can detect tampering without
-- any path to the vault contents (INV-19).
--
-- `user_id` binds the row to its person and is the member scope every read/write is
-- filtered by (never an id from the client); it cascades on account deletion — the
-- account-purge job is the ONLY code path that removes an entry.
--
-- Plaintext metadata (design §4.1) is kept readable so the activity feed and the
-- integrity check can filter and chain without decryption: the kind, source, the
-- agent/connector/tool/outcome/merchant labels, the money amount and currency, and
-- the two chain hashes. PERSONAL CONTENT lives only in `payload_ct`, a `v1:`
-- envelope (AES-256-GCM under the person's data key) written AFTER redaction — the
-- readable payload never lands in a column.

CREATE TABLE activity_entries (
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  seq          bigint NOT NULL,
  occurred_at  timestamptz NOT NULL,
  kind         text NOT NULL,
  source       text NOT NULL CHECK (source IN ('warthog', 'agent_reported')),
  agent_id     text,
  connector_id text,
  tool         text,
  outcome      text,
  amount       numeric,
  currency     text,
  merchant     text,
  payload_ct   text NOT NULL,
  prev_hash    text NOT NULL,
  entry_hash   text NOT NULL,
  PRIMARY KEY (user_id, seq)
);

-- The application database role is APPEND-ONLY on activity_entries: INSERT and
-- SELECT only, UPDATE and DELETE revoked (design §9). No application code path can
-- alter or remove an entry; only a privileged purge/migration role can (the account
-- purge, via the user cascade above). The role is created without LOGIN — a
-- deployment binds its credentials out of band (never a secret in a migration,
-- INV-103). Guarded so a role an operator/infra has already provisioned is reused
-- rather than colliding.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'warthog_app') THEN
    CREATE ROLE warthog_app;
  END IF;
END
$$;

GRANT SELECT, INSERT ON activity_entries TO warthog_app;
REVOKE UPDATE, DELETE ON activity_entries FROM warthog_app;
