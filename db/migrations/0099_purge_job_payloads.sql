-- JSON job payloads have no user/approval foreign key. The dedicated purge login
-- must resolve ownership and remove these identifiers before cascading the user.
GRANT SELECT (id, user_id) ON approvals TO warthog_purge;
GRANT SELECT (payload) ON jobs TO warthog_purge;
GRANT DELETE ON jobs TO warthog_purge;

-- SELECT ... FOR NO KEY UPDATE requires UPDATE on at least one column. Purge
-- locks the user before its OAuth connections, matching deletion/re-enrolment
-- lock order. This role already deletes the entire account; narrowly allowing
-- its wrapped key column enables that lock without general user UPDATE access.
GRANT UPDATE (wrapped_dek) ON users TO warthog_purge;
