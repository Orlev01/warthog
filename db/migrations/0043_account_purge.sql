-- 0043_account_purge — the account-purge queue and the purge role (brief
-- §"Australian Privacy Act and GDPR-style rights"; design §4.1 "Account deletion =
-- crypto-shredding: deleting the wrapped DEK makes everything unreadable before the
-- confirmation is shown; a job deletes the rows within 24 hours"; design §9 "a
-- separate `warthog_purge` role is used only by the account-deletion job").
--
-- Crypto-shredding makes a deleted account's data unreadable IMMEDIATELY, but the
-- rows must still be REMOVED within 24 hours by a dedicated job. This queue records
-- which accounts await that purge: one row per account (`user_id` is the primary
-- key, so re-requesting a purge never creates a duplicate pending entry), and
-- `requested_at` is readable plaintext metadata — the 24-hour clock starts here and
-- an idempotent re-enqueue must NOT push it out. The row cascades on account
-- deletion so the purge job's own removal of the user cleans the queue behind it.
CREATE TABLE account_purge_queue (
  user_id      uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  requested_at timestamptz NOT NULL DEFAULT now()
);

-- The `warthog_purge` database role is used ONLY by the account-deletion job: it
-- scopes the one code path allowed to DELETE append-only activity rows. The
-- application role (`warthog_app`, migration 0016) is INSERT+SELECT only and can
-- never remove an entry; `warthog_purge` holds the DELETE the job needs. Like the
-- app role it is created WITHOUT LOGIN — a deployment binds its credentials out of
-- band (never a secret in a migration, INV-103). Guarded so a role an operator/infra
-- has already provisioned is reused rather than colliding.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'warthog_purge') THEN
    CREATE ROLE warthog_purge;
  END IF;
END
$$;

GRANT DELETE ON activity_entries TO warthog_purge;
