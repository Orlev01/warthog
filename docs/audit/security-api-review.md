# Security and API audit

9 November 2026. Reviewed the local `codex/production-release` checkout, preserving its earlier release work. This report records confirmed bugs separately from protocol/design questions and external acceptance gates. No customer data, real credentials, outbound messages or cloud configuration were used. File references below describe the repaired checkout; the defect descriptions describe the code before these fixes.

## Confirmed findings and remediation

| ID | Severity | Finding | Status |
| --- | --- | --- | --- |
| AUD-001 | High | Successful bodyless provider responses became local transport errors | Fixed; 130 focused tests pass |
| AUD-005 | High | Public TOTP sign-in bypassed the required mailbox first factor | Fixed; 122 focused auth/UI tests pass |
| AUD-006 | High | Curated Google/Graph JSON writes omitted the JSON media type | Fixed; included in 97 passing connector tests |
| AUD-007 | High | Connector response truncation happened after unbounded buffering | Fixed; included in 97 passing connector tests |
| AUD-010 | High | Public CIMD lookups populated an unbounded process cache | Fixed by root, including peer-found DNS deadline; 49 focused checks reported |
| AUD-017 | High | Session verification could return a row deleted during verification | Fixed; 37 focused session/step-up/hardening tests pass |
| AUD-018 | High | OAuth refresh could recreate credentials after revocation; failed token minting consumed the only usable credential | Fixed; final OAuth/DCR group 58/58 pass |
| AUD-019 | High | Crypto-shredded accounts could mint new sessions before purge | Fixed; 134 focused auth/session checks pass |
| AUD-022 | Medium | DCR registration cap depended on unsynchronized PostgreSQL snapshots | Fixed; final OAuth/DCR group 58/58 pass |
| AUD-025 | High | Activity's process queue could deadlock an enclosing database transaction | Fixed; 69 focused activity/transaction/account tests and 3 marker checks pass |

### AUD-001: preserve bodyless HTTP semantics

References: `src/server/http/guarded-fetch.ts:220`, `src/server/connectors/provider-mcp.ts:111`.

The guarded HTTPS adapter constructed `Response(stream, {status})` for every result. Fetch rejects a non-null body for 204, 205 and 304. The provider wrapper independently reconstructed null bodies as an empty string. A Google/Microsoft calendar DELETE could succeed upstream and then appear to fail locally, inviting duplicate attempts or confusing the approval history. HEAD also lost its null-body semantics.

Both layers now preserve null bodies and response metadata. The Node adapter drains bodyless responses; neither layer adds retries or weakens redirect/SSRF restrictions. An offline HTTPS transport stub exercises DELETE 204, POST 205, GET 304, HEAD 200 and normal JSON through both actual adapters. RED: eight failures, one pass. GREEN: 130/130 across transport and provider tests. Evidence: `/tmp/warthog-audit-bodyless-{red,green}.log`.

### AUD-005: require the first factor for authenticator sign-in

References: `src/app/(auth)/signin/handler.ts:224`, `src/components/auth/signin-flow.tsx`, `src/app/api/auth/signin/[step]/handler.ts`. Decision: `docs/adr/audit-totp-signin.md`.

The public TOTP endpoint accepted `{email, totp}` and minted a session. An email address identifies an account; it does not prove mailbox possession. Any browser could call this endpoint directly, bypassing the separate new-device email flow. The remembered-device cookie is an alert marker and is not an authenticated session.

Unauthenticated TOTP sign-in now sends and verifies a purpose-bound `signin_totp` email OTP, returns a random account-bound ten-minute proof handle, and requires that handle plus the authenticator code. Existing address/account rate limits and atomic TOTP-step replay protection remain. The bounded handle is synchronously consumed before session minting. All email/sign-in steps retain exact-Origin validation and bounded bodies. Known and unknown addresses follow the same email-delivery response path. Authenticated step-up remains session plus TOTP, owned by the product reviewer.

The UI now has complete email-request, email-code and authenticator-code phases, explicit retry/restart states, busy guards and the existing safe return path. Existing tests that encoded the incomplete single-factor contract were updated to establish the first factor, preserving their independent failure, replay, ownership and alert assertions.

RED demonstrated a session created without email proof. Final 122/122 tests cover purpose isolation, mailbox-only denial, expired proof, replay, account binding, concurrent valid-code exchanges, cross-origin requests, TOTP throttling, route dispatch and the complete UI controller. Evidence: `/tmp/warthog-audit-totp-signin-{red,final}.log`.

### AUD-006/007: correct JSON writes and bound provider memory

References: `src/server/connectors/request-tool.ts:138`, `src/server/connectors/request-tool.ts:187`, `src/server/connectors/curated/google.ts:246`, `src/server/connectors/curated/microsoft.ts:210`.

Curated tools serialized JSON but supplied only authorization headers. The underlying `Request` treats a bare string body as text, whereas Graph's event/mail APIs require JSON. Curated Google/Graph tools now explicitly select `application/json` for their outgoing bodies. Generic raw requests retain their existing contract; no arbitrary caller header surface was added. The requirement is documented by [Microsoft Graph create event](https://learn.microsoft.com/en-us/graph/api/calendar-post-events?view=graph-rest-1.0) and [Google Calendar events insert](https://developers.google.com/workspace/calendar/api/v3/reference/events/insert).

The same shared tool called `response.text()` before truncating to 100 KiB. Production MCP composition uses the raw guarded transport, so the final truncation did not limit memory consumption. A large or endless authenticated provider response could exhaust the single application replica. The tool now stores at most 100 KiB while streaming, cancels upstream as soon as excess bytes are observed, and cancels/denies incomplete bodies at the existing 20-second deadline. A truncated UTF-8 character is omitted rather than fabricated. Bodyless results remain empty successful bodies. Existing member-owned credentials, host confinement and no-retry behavior remain.

RED: three curated JSON-header failures plus two streaming/deadline failures. GREEN: 97/97 connector tests. The synthetic 6.25 MiB stream is cancelled after two 64-KiB reads, rather than consumed and subsequently shortened. Evidence: `/tmp/warthog-audit-connector-transport-{red,green}.log`.

### AUD-017: atomic session verification

Reference: `src/server/auth/session.ts:123`.

Verification SELECTed a valid session, then separately UPDATEd its idle timestamp. If logout/recovery deleted the row between statements, the code returned the stale SELECT result when UPDATE returned nothing. A request therefore remained authenticated despite revocation winning before the renewal write. Similarly, expiry changes between statements were not rechecked.

Verification is now a single parameterized UPDATE with idle and absolute expiry guards and RETURNING. A missing/deleted/expired row returns null. `GREATEST(last_seen_at, request_time)` prevents concurrent requests from moving activity backwards. The existing 14-day idle/30-day absolute boundary convention remains.

Three RED tests use real PGlite rows with deterministic revocation/expiry interleavings before the refresh write. All now fail closed. GREEN: 37/37 session/step-up/hardening tests. This proves the SQL behavior under the forced interleaving, not multi-connection PostgreSQL contention. Evidence: `/tmp/warthog-audit-session-revocation-{red,green}.log`.

### AUD-018: transactional OAuth credential lifecycle

References: `src/server/oauth/token.ts:149`, `src/app/oauth/revoke/handler.ts:50`, `src/server/oauth/connection-lock.ts:6`, `src/server/agents/disconnect.ts:108`, `src/server/db/index.ts:146`.

Refresh previously expired its token, then separately inserted the new access and refresh rows. `/oauth/revoke` independently deleted the connection's rows. A revoke between the claim and insertion could return 200 before the refresh recreated usable credentials. A failed second INSERT also left a consumed code/refresh and an orphan access token, preventing a safe retry.

Authorization-code exchange and refresh rotation now acquire a transaction-scoped per-connection advisory lock, re-resolve/consume credentials under that lock, and commit the claim and complete pair together. Revocation takes the same lock and removes pending codes as well as tokens. Disconnect uses that lock before credential deletion and removes pending authorization codes. Account-wide reset/deletion/purge now use the shared sorted connection-lock helper; the infrastructure reviewer owns those callsites. Issuance does not take users or agents row locks, avoiding a reverse dependency on account operations that already hold their account row lock. Cleanup does not mint credentials and keeps its existing expiry rules.

This exposed a test/development database defect: PGlite's shared connection used independent raw BEGIN/COMMIT sequences for concurrent callbacks, allowing one request to commit or roll back another's work. The driver now uses its [native transaction callback](https://pglite.dev/docs/api#transaction). Nested transaction boundaries are explicitly refused on transaction handles instead of silently committing an outer transaction. Helpers must receive the existing transaction handle directly.

RED: three OAuth regressions (code-pair rollback, refresh-pair rollback, refresh/revoke race) and two database regressions (concurrent isolation, nested commit). Combined focused run: 44 pass, one pre-existing sandbox socket-listener EPERM in `db/index.test.ts`; all new cases pass. Evidence: `/tmp/warthog-audit-oauth-atomicity-{red,green}.log`, `/tmp/warthog-audit-pglite-transactions-red.log`. Real PostgreSQL lock/contention acceptance remains required. The transaction callsite audit found and fixed three outer-Db key getters: vault proof now passes the active transaction to its key lookup, and agent/service disconnect recorders reuse keys obtained before their transaction. All 46 related vault/disconnect tests pass (`/tmp/warthog-audit-transaction-getters-final.log`). The root coordinates broader validation.

### AUD-019: keep deleted accounts closed until purge

References: `src/server/auth/session.ts` (`createSession`, `verifySession`, `lockActiveAccount`), `src/server/auth/recover-session.ts`, `src/server/auth/account-reset.ts` (`reenrolAfterReset`).

The infrastructure reviewer identified that deletion retains a user row with an empty wrapped DEK until the purge job runs. Existing passkeys or a previously verified email/TOTP handle could still create a session against that row. Central session creation now INSERTs only from an active user and takes FOR SHARE; it returns a generic 401 if the account is tombstoned or missing. Verification also requires an active user. This covers sign-in, new-device, recovery and reset re-enrollment instead of relying on each handler remembering a tombstone check.

Session replacement/re-enrollment take the active-user lock before factors/sessions, matching deletion's account-first order. The purge owner also corrected user-before-OAuth order to avoid inversion with deletion. Two RED regressions cover direct create/verify and the actual email-verified TOTP sign-in endpoint. Final 134/134 focused auth/session/device/recovery/reset tests pass. Evidence: `/tmp/warthog-audit-tombstoned-session-{red,final}.log`. Real PostgreSQL lock contention still requires its deployment harness.

### AUD-022: serialize dynamic-client registration capacity

Reference: `src/server/oauth/store.ts` (`createClientWithinCap`).

The capped INSERT used a COUNT subquery with no shared lock. The comment claimed that one statement prevented concurrent overshoot, but PostgreSQL READ COMMITTED statements have independent snapshots and do not see another transaction's uncommitted insert. This is documented in [PostgreSQL transaction isolation](https://www.postgresql.org/docs/current/transaction-iso.html). At the final slot, both inserts can see capacity and commit distinct clients.

The cap now runs inside a real transaction under one shared registration advisory lock before taking its count snapshot. A deterministic offline Db model of independent statement snapshots reproduces two accepted registrations for one slot before the fix and one after. Existing actual-PGlite parallel/cap/window tests remain. The final OAuth/DCR group passes 58/58. This model validates ordering but does not masquerade as two-connection PostgreSQL execution. Evidence: `/tmp/warthog-audit-dcr-red.log`, `/tmp/warthog-audit-oauth-final.log`.

### AUD-025: remove the activity queue/database lock inversion

References: `src/server/activity/writer.ts:66`, `src/server/db/index.ts:36`, `src/server/activity/writer.test.ts:916`.

The activity writer held a process-wide per-user queue while awaiting SQL. When an outside append acquired that queue while an enclosing transaction owned the database connection, an append inside the transaction waited for the queue and the outside append waited for the transaction. Native PGlite isolation exposed this as three full-suite cancellations; the same mixed application/database lock ordering is unsafe with real PostgreSQL lock dependencies.

Activity appends now serialize through a shared per-user transaction-scoped PostgreSQL advisory lock. An append joins an explicitly marked transaction handle or opens its own transaction. Native PostgreSQL/PGlite and raw injected transaction seams all mark scoped handles; nested boundaries remain rejected. The head read and append share the lock and commit boundary. Existing conflict retry remains for noncooperating writers. Activity is taken after account/OAuth locks; the writer does not acquire an account/OAuth mutation lock while holding the activity lock.

RED: the existing concurrent enclosing-transaction/standalone append and a new rollback interleaving both remained pending and were cancelled. GREEN: all 69 activity, transaction, disconnect and account deletion/reset/purge checks pass with zero cancellations. The rollback case proves the discarded entry does not contaminate the surviving chain; the committed case checks distinct contiguous sequences and chain integrity. Three explicit transaction checks also pass, including native/fallback scope markers and nested-boundary rejection. Evidence: `/tmp/warthog-audit-activity-deadlock-{red,green}.log`, `/tmp/warthog-audit-activity-transaction-marker.log`.

## Cross-review and scope observations

- Product reviewer owns missing authenticated TOTP step-up, TOTP signup and device-local import/export. The peer review traced strict ciphertext-only import, member-scoped export, browser resealing, fresh step-up and address remapping. No new plaintext-upload or cross-account bypass was found. Temporary-key cleanup and explicit ambiguous-import retry handling were sent to the product reviewer as follow-ups; sign-in test counts do not certify those independent features.
- Root's CIMD fix caps the cache at 128 entries, uses LRU/expiry eviction, bounds client URLs and limits outbound lookup concurrency. Peer review found DNS lookup started before the five-second deadline; root fixed the deadline to encompass DNS, fetch and body consumption and reported 49 passing focused checks. SSRF defenses still resolve and check every address and recheck at connection time.
- Connector callback reads a session, consumes a session/user/state-bound pending flow, and uses server-selected redirect/client configuration. Google/Graph credential lookup is member scoped; callers cannot supply an outbound host. Live Google/Microsoft consent and token renewal are external acceptance gates, not proven by injected fetch tests.
- Session cookies retain Secure, HttpOnly, SameSite and `__Host-` restrictions. Middleware supplies per-request CSP nonces and POST authentication throttling. Exact-Origin checks were traced for changed auth/API handlers. Public OAuth flows use registered exact redirect matches, PKCE S256 and the configured single MCP resource. These observations are boundary checks, not a claim of exhaustive penetration testing.
- Vault possession proof binds the operation transcript and separates the verifier from the decrypting vault key. Existing nonempty/legacy vaults do not silently enroll a replacement verifier. Device plaintext/ciphertext handling is receiving an additional product-change peer review.

## Explicit unresolved design concerns and limits

1. **Refresh-client binding (review concern, no exploit established):** `exchangeRefreshToken` uses possession of the refresh token and its connection binding; refresh storage has no client-id field. Authorization-code redemption does check client/redirect/PKCE. The current registrations are public clients and the server exposes one MCP audience, so a supplied public client id would not itself be a second secret. Do not label this cross-account compromise without a demonstrated boundary violation. A future multi-audience/confidential-client extension must persist and validate the original client/audience contract.
2. **Real PostgreSQL concurrency acceptance:** DCR capacity is now guarded (AUD-022), as are OAuth issuance/revocation and session creation/deletion. Their deterministic offline regressions pass; a two-connection PostgreSQL test must still exercise lock ordering and contention in the production engine.
3. **Generic request payload format (product/API limitation):** the curated fix deliberately leaves generic raw-body requests unchanged. Supporting caller-selected form/text/JSON media types needs an explicit bounded schema and tool documentation, not unrestricted headers.
4. **Real environment gates:** this work does not certify Linux container startup, real PostgreSQL role/bootstrap/locking behavior, Key Vault/blob access, final-domain passkeys/CSP, international SMS/STOP, real provider redaction/quotas, email inbox/bounce handling, push subscription delivery or all six live connectors. Those gates remain in the release handoff; no payment/credential/deployment/DNS approval is inferred from local audit authorization.
5. **Review coverage:** findings are based on traced call paths and targeted regressions. No static review or finite test suite proves absence of vulnerabilities. Full-suite/type/build coordination belongs to the root agent; this reviewer has not run or claimed that certification.

## Prepared production-engine contention harness

`scripts/verify-local-postgres-security.ts` is now invoked by the existing isolated `scripts/verify-local-postgres.ts` certification entry and included in the Docker build allowlist. It refuses execution outside the Linux/local-check flag and verifies the disposable cluster name. It uses only generated synthetic identities and tokens, cleans its rows, and reports no credentials.

The harness obtains actual backend PIDs and checks `pg_blocking_pids` through a separate pool connection. It requires revocation to wait for an in-flight refresh transaction, requires the second DCR request to wait for the final registration slot, and requires session creation to wait for an account deletion before refusing the tombstone. It also injects pair-insertion failures and verifies rollback leaves both authorization codes and refresh tokens usable. Activity cases require a standalone append to wait for an enclosing append's transaction, then verify the resulting contiguous chain after both commit and rollback scenarios.

Status: module import/syntax checked only. **Not executed against PostgreSQL or Docker in this session.** It must run in the approved local container environment before asserting production-engine concurrency acceptance. The root's existing household UTC-budget contention check remains intact.

Root AUD-023 peer review: amount-rule conversion uses the owner's account currency independently of agent/household budgets, normalizes only the comparison call, and leaves original card amount/currency intact. Missing/mismatched rates fail closed only for applicable scope/action amount rules. No new bypass found in the changed path; production card requests supply an explicit currency.
