# Serialize OAuth issuance and revocation

Accepted for the founder-authorized local audit, 9 November 2026 (AUD-018).

A refresh claim and its new token pair must commit together. Revocation must linearize before or after issuance, never delete the old credentials and then permit an in-flight exchange to recreate them.

Use a transaction-scoped PostgreSQL advisory lock keyed by the OAuth connection. Both grant exchanges resolve the connection, open a real transaction, take the lock, and re-resolve/consume the credential inside it before minting the complete pair. Revocation, disconnect and account reset/purge take the same lock before deleting credentials. Account-wide operations take connection locks in sorted order. Issuance does not take users or agents row locks; account operations can hold their own account lock without an inverse OAuth-to-account lock dependency. Pending authorization codes are removed on revocation/disconnect as well as tokens.

Keep the existing deterministic refresh-successor grace contract and replay handling. No transport retry, stored raw bearer or new credential scope is introduced. Pair insertion failure rolls back the claim and both inserts, permitting a valid retry.

PGlite must use its native transaction callback to serialize access to its one connection. Raw BEGIN/COMMIT on concurrent callbacks can commit another callback's writes. Transaction handles reject a nested transaction boundary; callers pass the active handle through instead. The production pg pool still pins one connection for the complete callback. Offline tests exercise rollback, deterministic revoke races and PGlite isolation; real PostgreSQL concurrency remains a deployment validation gate.

The related account tombstone fix (AUD-019) only creates sessions for users retaining a wrapped DEK. Session creation uses an account SHARE lock; replacement/re-enrollment take it before sessions/factors. Deletion/purge use account-first ordering before OAuth locks, so a winning deletion either removes a prior session or prevents a later mint. DCR registration capacity separately uses one transaction advisory lock before its count snapshot (AUD-022); the prior single-statement COUNT was not sufficient under PostgreSQL MVCC.

The activity writer also uses a transaction-scoped per-user database advisory lock (AUD-025), replacing a process queue that could wait on a database transaction while that transaction waited on the queue. Scoped `Db` handles explicitly expose `inTransaction`, allowing the writer to join an existing transaction without opening or committing another boundary. Native drivers and the raw injected seam all mark their scoped handles. Account and OAuth locks precede the activity lock; no account/OAuth mutation lock is acquired inside the activity writer. Concurrent rollback and commit tests preserve the hash chain, and real PostgreSQL contention is included in the local certification harness but remains unexecuted in this session.
