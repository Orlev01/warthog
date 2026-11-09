-- The migration login owns the dedicated database/schema. Request and purge
-- logins are non-owner members of these groups, provisioned out of band.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO warthog_app, warthog_purge;

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM warthog_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO warthog_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO warthog_app;
REVOKE UPDATE, DELETE ON activity_entries, activity_disputes FROM warthog_app;
REVOKE DELETE ON users FROM warthog_app;
REVOKE INSERT, UPDATE, DELETE ON schema_migrations FROM warthog_app;

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM warthog_purge;
GRANT SELECT ON users, agents, receipt_files, account_purge_queue TO warthog_purge;
GRANT DELETE ON users, activity_entries, activity_disputes TO warthog_purge;
GRANT SELECT, DELETE ON oauth_tokens, oauth_auth_codes, oauth_access_keys TO warthog_purge;
