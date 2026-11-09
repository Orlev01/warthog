# Separate database connections for migration, requests and account purge

Status: implementation draft, 9 November 2026; real PostgreSQL/Azure verification remains required.

Keep automatic first-use migrations, but run them over a separate `MIGRATION_DATABASE_URL` connection and close it before opening the shared `DATABASE_URL` runtime pool. The account purge sweep obtains a separate `PURGE_DATABASE_URL` pool. Production requires three different login roles for the same server/database; development keeps its single PGlite database.

Provision the existing `warthog_app` and `warthog_purge` groups plus dedicated migration/runtime/purge logins before first boot. The migration login owns the dedicated database/schema and can apply DDL. The runtime login may manipulate ordinary application rows but cannot update/delete/truncate activity, modify migration bookkeeping, create schema objects or delete a user to bypass the activity restrictions through cascading foreign keys. The purge login can read its queue and delete queued accounts and their OAuth credentials. Neither runtime nor purge may be a database/schema owner, superuser or member of the migration role.

This is SQL connection privilege separation, not isolation from a compromise of the entire Node process: the same application still receives startup and purge credentials because the existing design runs migrations and the purge scheduler in that process. Stronger isolation requires separate migration/purge jobs and a revised runtime contract. Do not advertise the current design as preventing a fully compromised server from obtaining privileged credentials. No admin password is baked into an image or printed in reports.

New table migrations must explicitly grant their required role privileges; do not grant blanket default privileges to future append-only tables. Verify roles with real PostgreSQL 16 before deployment, including migration idempotence, application writes, forbidden activity mutation/user deletion and a queued purge.
