# Production messaging and connector composition

Status: local draft, 9 November 2026. Provider selection and production approval pending. No new runtime dependency.

The existing release leaves production notification senders and provider OAuth composition unwired. First-release scope now requires SMS and all six Google/Microsoft connectors alongside email/push. Centralize notification construction in `notify/production.ts`; retain injectable transport seams and dev outbox behavior. The initial adapters use the pinned ACS Email SDK and signed ACS SMS REST requests. The external checkpoint 5 messaging review can change the provider without changing callers' sender interfaces. No adapter test establishes service eligibility or actual delivery.

Reserve SMS segments atomically in PostgreSQL before contacting the provider, with monthly, daily and recipient-hour caps. Hash recipient bucket identifiers with the existing server HMAC key. Count GSM escape pairs and UTF-16 surrogate pairs conservatively across multipart boundaries. Do not retry ambiguous paid sends automatically or refund their reservations. Destination policy and final provider validation remain open.

Use the pinned oauth4webapi library for PKCE exchanges and refresh. Keep single-use pending flows in the existing process-singleton mechanism, bound to user and session, hashed by state, capped and expiring after ten minutes. This retains the strict singleton requirement and drops unfinished consent on restart. Store tokens through the existing DEK-encrypted connection store; resolve the account label using provider-owned profile endpoints. Keep secrets and provider error bodies out of responses and error causes. A failed connection/scheduling transaction rolls back locally; it cannot undo an external grant already issued.

Google stays early access with server-side admission checks, seven-day lapse handling and provider revocation. Microsoft uses the existing /common account audience, per-connector delegated scopes and offline refresh. Microsoft local disconnect does not claim provider-wide consent revocation; the UI directs the person to remove account consent separately. Do not request broad Graph permissions to implement revocation. Review Google's Drive scope against actual tools before final provider registration.

Authentication changes in the draft purpose-bind email codes, revoke sessions on recovery and limit failed passkey sign-ins with an alert. Nonce CSP/IP-limiting middleware is drafted but needs real framework/browser verification. Remaining security follow-ups and infrastructure gates are listed in `docs/production-release.md`; this ADR does not accept them as production-safe.

## 9 November implementation follow-up

The Drive review narrowed consent to `drive.readonly`; its tools only search/read. It remains a restricted Google scope. SMS now requires an explicit calling-code allowlist; no destination is enabled by default. Production boot/readiness validate the complete current ACS/OAuth/push/storage/DB configuration, but no validation implies provider eligibility or actual delivery. An alternative messaging provider also needs an explicit exception to the existing Azure/no-billable-third-party rules, not merely payment authorization.

Household invitation sends are counted per owner as well as per household, with a per-owner transaction lock so recreating a household cannot reset the quota. The hourly OAuth sweep deletes expired authorization/access tokens and old never-used DCR clients; used registrations survive. Refresh-token rows remain while their family has an active successor, retaining replay-detection evidence and grace retries; abandoned expired families have a 30-day retention tail. Existing clients are conservatively marked used because historical code consumption cannot prove non-use.

The separate vault-proof, database-role, container and singleton ADRs record the additional decisions. None certifies live production readiness.
