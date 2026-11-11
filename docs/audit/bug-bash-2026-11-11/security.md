# Security review — 11 November 2026

Reviewed the shared bug-bash branch from `5882213b21fd7047f014596ef04ba027aa6f0ff6`. This perspective concentrated on authentication, recovery/revocation, OAuth, outbound HTTP, encrypted data and member isolation. Root separately owns framework headers, dependencies, images, delivery and infrastructure. All reproductions used synthetic inputs and isolated, migrated PGlite databases; no production data, credentials, provider sends or production mutations were used.

## Confirmed findings

### SEC-01 — High impact: a superseded reset job can bypass the new seven-day wait

**Status: fixed.** `src/server/auth/account-reset.ts:242` and `src/server/jobs/registry.ts:107`.

Before the fix, destructive completion claimed any `pending` reset using only its user ID. A new request replaced `requested_at` and removed older **pending** timer jobs, but an older job already marked `claimed` survived. That old worker could complete the new reset immediately, erasing the vault and revoking service/agent credentials before the renewed seven-day cancellation window elapsed. This is a scheduler race, not an unauthenticated direct HTTP reset bypass; requesting a reset still needs email verification.

Reproduction: start a reset; advance to its scheduled date and claim its job; request another reset; invoke completion from the previously claimed job at the same instant. Both new regression tests failed before the fix. A simpler diagnostic completed a seven-millisecond-old reset and invoked the erase executor.

Completion now atomically requires `requested_at <= now - RESET_WAIT_MS` in the same guarded update that claims the destructive transaction. The clock is required and comes from the job registry. Cancellation, one-time completion, transactional rollback and release-memory cleanup remain intact. No migration was needed.

Coverage: `src/server/auth/account-reset.deadline.test.ts` checks one millisecond before the deadline, the exact deadline, concurrent completion, and an actual claimed job surviving renewal. Existing reset/executor/deletion tests now model completion after the wait rather than immediately after request.

The independent correctness reviewer also reproduced and fixed adjacent alert-failure compensation: a delayed failure from an older request can no longer cancel a newer successful reset or remove its timer. See C8 in `correctness.md` for that separate reproduction and validation.

### SEC-02 — Medium: verified recovery grants survive recovery-code regeneration

**Status: fixed.** `src/app/(auth)/recover/handler.ts:282`, `src/app/(auth)/recover/handler.ts:320`, `src/server/auth/recovery.ts:143`.

The old flow stored only `recoveryVerified=true` for up to thirty minutes. Someone who had already proven both the email code and the previous recovery code could wait for the owner to regenerate that recovery code, then register a durable new passkey and replace the owner's newly generated recovery code. Regeneration stopped fresh verification of the old code but did not revoke its outstanding grants. This requires prior email **and** recovery-code proof; it does not allow recovery with only an email address or stolen session.

Reproduction: complete identify, email verification and recovery-code verification; generate a replacement code; submit a valid software-authenticator registration using the old pending handle. The old implementation returned 200 and created a passkey. Two already-verified flows using one generation also both succeeded and rotated the code twice.

The pending flow now retains only the existing random public salt as a nonsecret generation identifier. Passkey registration locks and rechecks that row, then creates the factor and replaces the recovery code in one transaction. A stale generation is refused without either mutation. A synchronous per-handle registration guard prevents duplicate submissions from invalidating the successful request's pending completion. Existing successful response shapes are unchanged; an expired/revoked proof returns the existing `not_verified` error.

Coverage: real WebAuthn registrations test old-generation rejection, concurrent competing recoveries, legitimate current-generation recovery, duplicate submission followed by successful finish, and rollback if replacement-code storage fails. A separate test verifies the retained generation is the public salt, not the plaintext code or auth hash, and changes on rotation. Misleading old comments that conflated account recovery with the distinct device-only vault recovery phrase were corrected.

### SEC-03 — Medium availability: Web Push requests have no send deadline

**Status: fixed by root; independently reviewed.** Baseline `src/server/notify/web-push.ts:123` and `src/server/notify/production.ts:47`.

Production passed `createGuardedFetch()` directly to the push sender, which supplied no abort signal/deadline and did not cancel the response body. A registered user controls their HTTPS push endpoint. A public endpoint that never sends headers can therefore retain awaited notification work indefinitely; a body that stays open can retain the connection after headers. The SSRF guard correctly blocks private destinations but does not itself provide a time limit. This can delay fallback and job processing, including security alerts.

Root added a 15-second AbortSignal deadline and unconditional response-body cancellation/transport abort in `finally`, on success and failure. Independent review confirmed the production guarded transport honors that signal, the timer is cleared, and disposal does not await an untrusted body before allowing fallback. Fake-transport tests cover stalled headers and success/error cleanup. Check the integrated report for root's final validation.

### SEC-04 — Medium protocol hardening: refresh tokens lose their OAuth client binding

**Status: fixed, including additive migration `0105_oauth_token_client_binding.sql`.** `src/server/oauth/token.ts:165`, `src/server/oauth/store.ts:203`.

The authorization-code exchange checks the original client ID, exact redirect URI and PKCE challenge. However, `mintTokenPair` retains only the connection on token rows, and refresh exchange ignores `client_id`. A local full code exchange for client A followed by refresh with an unrelated client B returned success. Omitting the client ID is likewise unchecked. The fresh token remains scoped to the original connection; this does not reveal another member's data without first possessing the refresh bearer.

Maintaining and checking refresh-token client binding is part of the OAuth security baseline. Public client identifiers are not secrets or proof of sender identity, so this should not be described as fixing bearer theft by itself. [RFC 9700 §4.14.1](https://www.rfc-editor.org/rfc/rfc9700.html#section-4.14.1), [RFC 6749 §6](https://www.rfc-editor.org/rfc/rfc6749.html#section-6).

New tokens retain the validated authorization code's client ID through every rotation and retry. A missing client is an invalid request; mismatched/unbound tokens return `invalid_grant` before any mutation or replay action. Replay revocation and retention are scoped to connection plus client, so another client sharing the connection is unaffected. Explicit connection revocation/disconnection remains connection-wide.

Compatibility investigation found no reliable original association for historical token rows: consumed codes are deleted, pending consent is transient and agent platform/name are display metadata. No backfill is guessed, including from an outstanding code on the same connection. Historical refresh tokens remain `NULL` and require one fresh authorization; access tokens keep their existing expiry/verification behavior. Static keys and outbound service-provider OAuth credentials are unaffected. Validated CIMD clients need not have a DCR registry row, so the binding copies the validated code's identity without an incorrect registry foreign key.

The migration adds only a nullable column and preserves historical rows/expiries. Previous-runtime rollback is schema compatible with the column retained, but restores the old missing-binding behavior and may issue more unbound refresh tokens. Full compatibility, rollback and validation details are recorded in `docs/adr/oauth-refresh-client-binding.md`.

## Coverage and observations without a newly confirmed exploit

| Area | Review evidence / outcome |
| --- | --- |
| Sessions and step-up | Host-prefixed Secure/HttpOnly/SameSite cookies, hashed random session tokens, active-account checks, guarded renewal, purpose-separated WebAuthn and shared TOTP replay/attempt checks reviewed. No session forgery or new cross-member escalation established. |
| Email and passkeys | Purpose-bound HMAC email codes, throttled attempts, atomic consumption, user-scoped credential lookup and one-use challenge consumption reviewed. Sign-in TOTP requires the email factor first. |
| OAuth authorization server | Exact registered redirects, mandatory S256, resource binding, short-lived hashed codes, connection-lock serialization, refresh rotation and bounded retry grace reviewed. SEC-04 closes the confirmed client-binding gap. |
| Provider OAuth | Pending state is user/session-bound, short-lived and single-use; provider credentials/PKCE state are encrypted. Provider metadata and MCP calls use bounded, guarded HTTPS transports. Regular catalogue OAuth uses fixed endpoints and the OAuth library. No callback state or credential-isolation bypass established. |
| SSRF and outbound HTTP | DNS is checked at connection time and the vetted address is used for the socket. Mixed public/private results, private literals, cloud metadata addresses and IPv4-embedded IPv6 ranges are rejected. Redirects are not followed. Generic connector requests cannot override the catalogue host. Push's missing timeout is SEC-03. |
| Vault crypto and proof | AES-256-GCM envelopes bind table/column/row through unambiguous AAD and require canonical encoding/full authentication tags. Vault method mutations require a session-bound, method-bound one-use possession challenge; replacements also require step-up. Account recovery and vault recovery are deliberately separate. |
| High-tier releases | Release requires same origin, session, step-up, owned approval, active agent and current permissions. Durable release marking/spending/fingerprint bookkeeping is transactional. Plaintext is held in a scoped in-memory one-use store with scheduled eviction. Agent collection rechecks permission through its composed guard. |
| Member isolation and untrusted files | Receipt download resolves the session, checks ownership before blob access, and forces octet-stream attachment/no-store/nosniff. Connector credential queries include user ID. Audited handlers derive identity from verified sessions or authenticated connection context rather than caller IDs. |
| Redaction | Structured secret-name redaction, card masking, bounded released-value fingerprint scans and encrypted activity storage reviewed. These are defense in depth, not a promise to recognize arbitrary unlabelled secret strings. No unredacted production secret was retrieved or printed. |
| Resource bounds | JSON/stream caps, bounded/expiring pending stores, CIMD deadline/body cap, provider timeout/tool limits and no-retry MCP transport reviewed. No live load or denial-of-service test was run. |

## Rejected hypotheses and limits

- Account recovery does **not** need to rewrap the vault under the replacement account code: the device-only vault recovery phrase is a distinct secret (`docs/adr/device-local-portability.md`). Old comments suggested otherwise; implementation and current ADR agree.
- Starting a passkey challenge does not overwrite a single global pending challenge. Challenges are individually keyed, purpose-bound and one-use, with a bounded number per account.
- No SSRF bypass was demonstrated through redirects, DNS rebinding or embedded IPv4 forms. Existing negative transport tests were rerun; no production network probing was performed.
- Recovery identify sends mail only for existing accounts, so response timing can differ even though status/body match. This is a privacy hardening follow-up, not a demonstrated account takeover; no real-address enumeration was performed.
- Process-memory recovery/release state is an intentional single-process design constraint. A restart can discard pending work. Multi-replica operation would require a reviewed replacement for that coordination model.
- This review does not establish absence of all vulnerabilities. It combines code tracing with targeted tests; dependencies/infrastructure and interactive UI are covered by other perspectives.

## Validation

Used Node `v22.23.2`, no external provider credentials or network sends.

- Reset group: **47 passed**, including new red-before-green deadline/claimed-job regressions, real reset executor, deletion atomicity and job registry.
- Initial recovery/reset-reenrol group: **40 passed**. After adding generation secrecy, storage rollback and duplicate-submission coverage, recovery handler plus recovery primitive group: **36 passed**. The reset-reenrol suite had already passed and its code did not change afterward.
- Outbound/crypto/isolation group: **181 passed** across guarded-fetch classification/responses, guarded CIMD, provider-client/MCP transport, vault possession proof, redaction, receipt download and envelope hardening.
- OAuth binding follow-up: **71 passed**, including the new migration/legacy behavior and client-binding cases, store, rotation, replay/grace, revoke, bearer, cleanup and consent-to-MCP end-to-end suites. The seven initial binding regressions failed before implementation. A missing test-only RP-ID configuration was corrected during validation.
- Software authenticator helper: **10 passed** after preserving accurate `Uint8Array<ArrayBuffer>` types and copying arbitrary PRF views into owned buffers. This helper is now imported by the PostgreSQL certification script, so it is checked by the production TypeScript project as well.
- `tsc --noEmit --incremental false`: **passed** after the harness/helper additions, without mutating shared build metadata.
- Added real PostgreSQL16 checks for both recovery rotation/registration lock orders, bound refresh versus a mismatched-client waiter, replay isolation, grace retries and legacy-token compatibility through the runtime role. The integration owner executes the isolated Linux/PostgreSQL harness; this agent did not run it.
- `git diff --check` passed for all security-owned files.
- Full application build and the complete test suite remain root-owned to avoid concurrent `.next` mutations.
