# Warthog production release: current engineering handoff

Updated 10 November 2026. **Local draft, not approved for deployment.** First release includes email, SMS, web push, Gmail, Google Calendar, Google Drive, Outlook Mail, Outlook Calendar and OneDrive. No required feature has been deferred. Google remains the previously agreed External/Testing early access; Microsoft supports personal and work/school accounts through `/common`. Warthog retains its own passkey/TOTP sign-in and public sign-up.

**Messaging decision approved 9 November:** the founder approved limited Twilio SMS + Resend email integration and overseas processing, explicitly for a global product. Azure Australia East remains primary hosting. [Accepted decision](adr/global-messaging.md) and [country/security launch review](global-messaging-launch.md) supersede the ACS contract and AU-only proposal. Purchases, real credentials, production configuration, deployment, DNS and expenditure still require separate approval.

Work is isolated in `warthog-production-release`, branch `codex/production-release`, based on `dddd4103c35d03465d2f293049222b7221988171`. These changes are local and uncommitted. Original checkout and bare main remain unchanged; there is no approved immutable image digest. Publishing, paid infrastructure, provider purchases, credentials and exact DNS additions require their separate approvals.

**Subsequent founder decisions:** public origin `https://app.warthog.com.au`, narrow passkey RP ID `app.warthog.com.au`, sending domain `mail.warthog.com.au`, From `notifications@mail.warthog.com.au` (display name Warthog), and public support/privacy/reply-to `oren@nava-co.com`. Resend **Free** is selected; paid overages/upgrades remain unapproved. SMS markets AU/US/CA/GB are approved for launch only after registration, delivery and STOP acceptance, with 200/month and 10/day application segment limits. SMS cash budget is **A$20/month**; the complete four-market/redaction quote has not been shown to fit it. Azure must use eligible sponsorship credits, with no cash fallback approved. Credits and budgets do not enforce an automatic spending stop. The earlier A$600 proposal is not approved. The founder agreed to proceed with this architecture after the Azure-native SMS recheck. Do not ask for these choices again.

The [public production settings](../deploy/production.env.example) contain the approved nonsecret values, deliberately omitting credentials, sender service IDs and unfinished settings. They are not a complete environment or deployment authorization. The [identity/email decision](adr/production-identity-and-email.md) supersedes the earlier parent RP proposal.

## Comprehensive audit follow-up

The founder requested a complete multi-agent review and local remediation. The
[findings register](audit/README.md) and four linked perspective reports contain
reproductions, fixes, decisions and outstanding acceptance gates. The older
verification counts below are pre-audit history, not evidence for the updated
working tree. The completed audit records 25 findings, with 23 application/product
fixes and source remediation for the two delivery gaps. Final suite: **5,068 tests,
5,050 passed, 11 socket-restricted failures and seven boot cancellations**. Final
TypeScript, production build and runtime packaging pass (70 migrations, 106 catalogue
files). The final deletion-copy follow-up passes 48 related checks. See the register
for exact evidence. That initial verification is now superseded by the resumed
10 November clean Node 22.23.4/Linux ARM64 run: **5,072/5,072 tests**, no failures,
cancellations or skips; TypeScript/build/staging and real PostgreSQL 16.15 pass.
Docker and Chrome are accessible. The public Docker test fixture and six Terraform
schema errors were corrected; provider lockfile/validation pass. AUD-026 adds the
PostCSS remediation, and the application dependency audit reports zero known
vulnerabilities. AUD-027 makes production initialization errors explicitly terminate
the process instead of relying on Next to propagate a rejected hook; the final
suite includes its two regressions. The independent runtime image, image advisory review and limited
local browser evidence are recorded in the audit register. Full browser/provider,
approved cloud/ARM, remote CI, image approval and restore gates remain. No external
services or DNS were changed by this local work.

## Implemented locally

- Approvals now have separate in-memory release keys. `collect_release` requires `approval_id`; disconnect discards every pending release for that connection.
- Passkey vault envelopes are now stored per registered credential with an ownership foreign key and deletion cascade (migration 0097). Possession proofs bind the credential ID; adding a second passkey preserves the first. Unlabelled legacy envelopes remain readable, without destructive migration or silent rekeying. Account reset clears the new envelopes; portable exports retain their existing device-decryption contract and do not export sign-in or wrapping credentials.
- Public `/terms` and expanded `/privacy` drafts identify the supplied operator/contact, describe connected-service data and international processing, and link both policies beside SMS choices. The opt-in copy includes frequency, carrier charges, STOP and HELP. The company/contact copy is prepared for founder review, not published or provider-approved.
- The isolated local Linux/PostgreSQL verification target and private-bootstrap runbook are in [local release validation](local-release-validation.md). Clean Linux execution, real PostgreSQL contention and role/migration checks now pass locally; production bootstrap remains separately gated.
- Household policy now uses the display's converted currency totals. Missing historical rates refuse relevant budget checks. Card release locks the household/member, then the agent/permissions, and rechecks current limits and spend in the same transaction as the ledger write. Regression checks cover multiple outstanding approvals, mixed currencies, missing rates, exact/zero/unset limits and account isolation. [Decision and remaining period semantics](adr/household-release-budgets.md).

- Shared notification factory now uses Resend email and Twilio SMS/Basic Lookup through bounded HTTPS requests with sanitized errors and no transport retries. Generic push and expired-device cleanup remain. International phone normalization and provider-resolved ISO countries replace calling-code permissions; explicit country-to-Messaging-Service routes have no defaults. First-release pools require two-way SMS/STOP; China SMS is blocked because approval messages contain URLs. International email domains are supported, including IDNA conversion; SMTPUTF8 local parts remain unsupported.
- Persistent global month/day segments, recipient/hour segments, recipient/day messages and per-message caps count Unicode/GSM extensions and opt-out text conservatively. One persisted SMS attempt per approval prevents job retries repeating paid sends. SMS approval alerts require opt-in and can be withdrawn without losing email/in-app access; migration 0096 adds consent metadata and attempt claims. Verification text requests remain explicit separate actions.
- Public privacy/deletion copy describes overseas processing and provider/carrier/backup retention; arbitrary connector-request text is kept out of operator email. Credentials stay server-side. Provider account entitlement, tracking, suppression and actual country delivery still need live validation.
- Google/Microsoft credentials and live-code composition: session-bound, bounded, expiring, single-use OAuth state; PKCE; token exchange; connected-account labels; encrypted token storage; scheduled refresh; Google seven-day Testing lapse handling and revocation. Microsoft disconnect does not claim provider-wide consent removal. Drive now requests `drive.readonly`, matching its read tools; it remains a restricted Google scope.
- Purpose-bound email codes; recovery session revocation; passkey attempt limits/alerts; per-person household invitation quota that survives household recreation; hourly OAuth cleanup preserving refresh replay evidence; nonce CSP and ingress-IP auth/DCR rate limits.
- Vault-method saves prove possession of a separately derived verification key, with one-use session-bound challenges. The vault key stays on the device. Replacements also require recent step-up. First enrolment commits atomically with the envelope. Legacy vaults without a verifier stay readable but cannot silently enrol/change methods; migrating any existing user data needs review. Account reset removes the verifier. See [security rationale](adr/vault-unlock-proof.md).
- Separate migration/runtime/purge database connections and SQL grants; production requires three distinct logins on the same database with `sslmode=verify-full`. Normal requests cannot modify/delete activity history or delete a user to bypass that restriction. `db/bootstrap.psql` is a reviewed-input draft, not an executed bootstrap. See [database roles](adr/database-connection-roles.md).
- Production startup ownership guard using a dedicated PostgreSQL session advisory lock. Duplicate startup is refused and detected ownership loss terminates the process. Maintenance stop/wait/start is still mandatory; this is not a fully fenced distributed lease. See [singleton limits and procedure](adr/singleton-startup-and-maintenance.md).
- Node 22 multi-stage Dockerfile, non-root standalone runtime, explicit build-context allowlist and runtime staging. Static/public assets, migrations and catalogue are included and hashed in a generated manifest. Inter fonts are bundled locally with licence and checksums, removing the build-time Google Fonts dependency.
- Production boot and readiness validate required credentials/settings, matching VAPID keys, destination/segment controls, origin/RP relationship and database authority/TLS. This is configuration validation, not evidence of external service operation.
- The verified email domain is now configured independently of passkeys. From must match `RESEND_SENDING_DOMAIN` exactly; malformed/suffix/wildcard domains and invalid reply-to addresses fail before sending. Messages use the Warthog display name and configured `reply_to`. Quota errors stay visible and are not retried. No provider setting has been changed.

## Unresolved release gates

**Readiness recheck, 10 November 2026:** the release checkout remains local and
uncommitted. Docker Desktop and Chrome now work, and the local Linux/PG16 harness
has passed. These results supersede the 9 November access failures. The full
production validator still requires messaging, Google, Microsoft and VAPID;
no launch mode silently omits them. Local test success is not release approval.

**Checkpoint 6 received:** [engineering review](../../warthog-checkpoint-6-engineering-review.md).
Twilio body-redaction entitlement and complete cost remain unknown; an accepted
`ContentRetention` parameter is not proof of entitlement. Local public Terms and adjacent Terms/Privacy links/program disclosures are now
implemented; publication, final policy/account review and North American toll-free
acceptance remain outstanding. No destination quiet-hour scheduling or
localized HELP/START policy is implemented. Review each market before enabling it.
Current English verification/approval templates fit the proposed two-segment cap
at the approved hostname (one and two segments respectively); no live send occurred.

1. **Messaging account/market acceptance:** providers and local integration are approved; do not re-request that exception. Real accounts, keys, sender registrations, country routes, redaction entitlement, STOP/START and inbox/handset delivery are not established. Complete the [global launch review](global-messaging-launch.md). Existing GameHub ACS resources must not be reused.
2. **Architecture/payment:** Australia East primary hosting with approved overseas messaging, Azure credit-only funding, Resend Free and an A$20/month SMS allowance. Confirm eligible Azure consumption and shared credit availability before creating chargeable resources; no automated protection against cash fallback has been verified. The complete SMS quote, including rentals, replies, tax/fees and body-redaction entitlement, must fit the allowance or return for a specific decision. Interest in a fixed paid tier does not identify or approve an unquoted tier. Budgets and segment limits do not impose a whole-stack currency cap.
3. **Real release validation:** local clean Linux install/full suite and PostgreSQL bootstrap/roles/migrations/purge/contention now pass, as does component-level ownership process failure/replacement. Remaining work includes remote CI, image-advisory applicability/remediation, a reviewed pinned base/release digest, full production startup and browser/ingress/ACA lifecycle acceptance. Do not describe the development/PGlite boot smoke test or a missing-config startup refusal as positive production-mode certification.
4. **Private DB execution route:** `db/bootstrap.psql` uses psql and interactive private password commands. The application image does not include psql. A browser agent needs a separately approved private-network client/tool image or engineer-operated route. It cannot run this file as an unattended ACA Job without further implementation/review, and default Cloud Shell access is not assumed. No temporary public firewall workaround.
5. **Provider configuration:** host/RP/sending domain/From/public contact and initial SMS markets/month/day limits are now approved above. Remaining inputs include Google named test identities, final provider sender pools and per-recipient/message limits, account/credential approval and exact new DNS records. Preserve the apex website and every existing record. Resend Free's 100/day and 3,000/month quota can interrupt sign-up/recovery email; live quota/account settings and the launch traffic plan need acceptance. No automatic paid upgrade.
6. **Live acceptance after approved provisioning:** actual email/SMS delivery; all six connector consent/refresh/tool/disconnect flows; Key Vault managed identity/HSM operations; private Blob encryption; real passkey/TOTP/recovery/vault flows; web push; CSP nonce behavior; upload sizes; exactly one process across revisions; backup/restore evidence. Test synthetic identities/data only. Microsoft tenant consent policies and Google restricted-scope verification remain external constraints.
7. **Remaining product review before real customer use:** approval isolation, per-credential vault envelopes and household currency/release-limit fixes are implemented and regression-tested locally. Household transaction contention now passes against real PostgreSQL; existing personal period buckets/time-zone cut-over behavior is retained. The remaining [product follow-ups](../../warthog-review-followups.md) need disposition, including per-purchase/merchant settings, receipt controls and provider-hosted MCP helpers. The six required curated connectors still need their separate live acceptance. These local fixes are not a production certification.


## Draft environment contract

This contract matches the approved local Twilio/Resend integration. It is not permission to create accounts or real credentials. Legacy ACS configuration/test code is unused by production; do not provision ACS or inject its keys. All secret values go directly into Key Vault/ACA secret references, never reports, build arguments, source or client-side variables.

| Setting | Required production meaning |
| --- | --- |
| `NODE_ENV`, `PORT`, `HOSTNAME` | `production`, `3000`, `0.0.0.0`; one `node server.js` process |
| `PUBLIC_BASE_URL`, `WEBAUTHN_RP_ID` | `https://app.warthog.com.au` and `app.warthog.com.au`; exact app origin for verification; passkeys require final-domain browser testing |
| `DATABASE_URL` | `warthog_runtime` login on the dedicated database |
| `MIGRATION_DATABASE_URL` | Separate `warthog_migrate` login, owning the dedicated DB/schema; closed after first-use migrations |
| `PURGE_DATABASE_URL` | Separate `warthog_purger` login, used by the scheduled account-purge sweep |
| All three DB URLs | Same server/database; distinct URL-encoded credentials; exactly `sslmode=verify-full`; no query-parameter host/user/TLS overrides |
| `WARTHOG_HMAC_KEY` | Independent random key, canonical base64, at least 32 bytes; never the published development value |
| `KEY_VAULT_URL`, `KEY_VAULT_KEY_NAME` | Approved Premium vault and versioned RSA-HSM key; user-assigned identity gets only required secret/key permissions |
| `AZURE_CLIENT_ID` | User-assigned managed identity selector for Azure SDK authentication; not a client secret |
| `STORAGE_ACCOUNT`, `STORAGE_CONTAINER` | Private encrypted-receipt Blob destination; identity scoped to required blob operations |
| `RESEND_API_KEY`, `RESEND_FROM_ADDRESS` | Sending-only key restricted to verified `mail.warthog.com.au`; From `notifications@mail.warthog.com.au` |
| `RESEND_SENDING_DOMAIN` | `mail.warthog.com.au`; From domain must match exactly, independently of the passkey RP ID |
| `RESEND_REPLY_TO_ADDRESS` | `oren@nava-co.com`; validated plain mailbox for customer replies; not restricted to the sending domain |
| `TWILIO_ACCOUNT_SID`, `TWILIO_API_KEY_SID`, `TWILIO_API_KEY_SECRET` | Dedicated Warthog account/subaccount and scoped API key; no master auth token |
| `TWILIO_REGION` | Explicit `us1` for this adapter; no silent region default or untested endpoint substitution |
| `SMS_COUNTRY_ROUTES_JSON` | JSON object mapping approved ISO alpha-2 countries to `MG...` Messaging Service SIDs. Require confirmed two-way SMS/STOP pools; no wildcard/default, China refused. Never configure real routes before market/sender/spend approval |
| `SMS_MONTHLY_SEGMENT_LIMIT`, `SMS_DAILY_SEGMENT_LIMIT`, `SMS_RECIPIENT_HOURLY_SEGMENT_LIMIT` | Mandatory positive integers, hourly ≤ daily ≤ monthly; UTC buckets; conservative reservations retained after ambiguity |
| `SMS_RECIPIENT_DAILY_MESSAGE_LIMIT` | Mandatory positive integer, number of attempts per recipient per UTC day, not segments |
| `SMS_MAX_SEGMENTS_PER_MESSAGE` | Mandatory positive integer ≤ recipient-hour cap, includes link/STOP text and conservative Unicode/GSM segmentation |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_EARLY_ACCESS` | Web OAuth client and Warthog-account email allowlist. Google console separately allowlists actual Google accounts, which may differ |
| `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET` | Web OAuth client for the agreed personal/multitenant audience |
| `VAPID_SUBJECT`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | Approved `mailto:` contact, matching uncompressed P-256 public key in base64url, serialized private P-256 JWK JSON |
| `OPERATOR_EMAIL`, `EXCHANGE_RATE_BASE_URL` | Approved operator address and free official reference-rate endpoint |
| Development settings | `WARTHOG_DEV_TOOLS` unset/0; `WARTHOG_DEV_KEK` absent; no PGlite or development outbox in production |

SMS controls cover this application's outbound reservations, not inbound messages, number rental, unrelated senders, retries outside this code, tax or total Azure costs. Account/number eligibility, transport acknowledgement and handset delivery are distinct. Provider-generated delivery evidence is required later.

OAuth callbacks are exactly `https://<approved-host>/connect/callback`, server-side Web clients, no wildcard/implicit flow. Google uses `gmail.modify`, `calendar`, `drive.readonly` plus `userinfo.email` for the account label. Microsoft requests connector-specific `Mail.ReadWrite`/`Mail.Send`, `Calendars.ReadWrite` or `Files.ReadWrite`, plus `User.Read` and `offline_access`. Do not grant application permissions or tenant-wide admin consent by default.

The middleware trusts only the rightmost client IP appended by direct ACA ingress, as [Microsoft documents](https://learn.microsoft.com/en-us/azure/container-apps/ingress-overview). Adding a CDN/reverse proxy changes that trust boundary and needs review. No Dapr is required. Validate a near-25-MiB upload through the actual ingress; Next's 26-MB setting alone is not proof.

## Pre-audit verification history

9 November 2026, Node 22.23.2. Current changes remain local and uncommitted; dependencies were copied from the original checkout, so this is not clean-install evidence. No dependency was added. Original checkout and bare main remain untouched.

- **Pre-audit baseline full suite: 4,966 tests; 4,948 passed, 11 failed, seven cancelled.** All eleven failures are the existing socket restrictions: nine HTTP transport listener checks, one PostgreSQL timeout listener check and one PostgreSQL connection assertion receiving `EPERM` instead of `ECONNREFUSED`. The boot suite's setup also hits listener `EPERM`, cancelling its seven checks. No tests were disabled. This run includes the final household timing changes and the approved-domain/reply-to changes. This is not a fully green suite or production boot certification.
- Approved-domain regressions were observed failing first (three failures), then all **51 focused checks passed**. These cover independent sender/passkey domains, exact sender-domain validation, malformed reply-to rejection, outbound display name/reply-to normalization, and single-attempt failure on email quota errors. Provider DNS ownership and actual inbox delivery were not tested.
- Household regressions were observed failing first: seven initial policy/release cases, plus the later month-end case. The focused policy/context/release/UI run passed **163 tests**; boundary/UI checks passed **35 tests**. The final release-handler run passed **42 tests**, including permission revocation, disconnect and budget changes between preliminary reads and the transaction, plus a transaction crossing month-end. Counts overlap and must not be added together. A real PostgreSQL contention check is prepared in the local harness but remains unexecuted.
- New approval and passkey regression tests were observed failing before implementation and now pass. These cover independent collection, missing/wrong approval IDs, disconnect cleanup, two-credential unlock, credential ownership/proof binding, reset and legacy preservation. Existing release HTTP tests and 31 vault HTTP boundary tests also pass. A final three-test passkey rerun additionally verifies the database ownership constraint, rejection of missing credential IDs and preservation of the remaining passkey after another is removed.
- Earlier final public-policy checks: **10 passed** after the last copy update, and the same files are included in the current full run. After the approved-domain changes, production build (including TypeScript), separate TypeScript check, runtime staging and whitespace checks pass. The runtime contains **68 SQL migrations and 106 catalogue files**.
- Compose configuration, local harness JavaScript syntax and TypeScript compile checks pass. Docker execution, clean Linux installation and real PostgreSQL remain **unverified**: the Desktop socket is absent, macOS could not launch Docker, and access to the existing OrbStack socket is denied in this session. No real messages, provider credentials or live provider calls were used.

Current evidence: `/tmp/warthog-approved-domains-red.log`, `/tmp/warthog-approved-domains-focused.log`, `/tmp/warthog-approved-domains-full.log`, `/tmp/warthog-approved-domains-typecheck.log`, `/tmp/warthog-approved-domains-build.log`, `/tmp/warthog-approved-domains-runtime.log`. Earlier household regression evidence: `/tmp/warthog-household-red.log`, `/tmp/warthog-household-month-red.log`, `/tmp/warthog-household-focused.log`, `/tmp/warthog-household-edge.log`, `/tmp/warthog-household-permission-race.log`, `/tmp/warthog-household-release-final.log`. Earlier regression evidence: `/tmp/warthog-readiness-policy.log`, `/tmp/warthog-readiness-passkeys-final.log`, `/tmp/warthog-isolation-release.log`, `/tmp/warthog-passkeys-green.log`, `/tmp/warthog-http-passkeys-final.log`. Logs are local temporary evidence, not a published release attestation. The runtime manifest is build evidence, not an approved image digest.

## Next handoff

Checkpoint 6 is complete; read [the engineering reconciliation](../../warthog-checkpoint-6-engineering-review.md).
The founder authorized one no-cost Twilio redaction/price clarification and supplied
all requested contact fields, including phone/job title.
[Checkpoint 7](../../warthog-browser-checkpoint-7.md) records the confirmed
sales-contact submission at about 09:32 UTC on 9 November; do not repeat it.
Twilio estimates a response within 1–2 days. Marketing opt-ins remained unchecked.
The initial form had no company/message field. The founder subsequently confirmed
sending the prepared redaction/STOP/pricing questions in reply to Twilio sales.
Await that response; no entitlement or price has been established by the contact
confirmation, and the inquiry must not be sent again.
Do not re-request supplied contact facts or inquiry permission, or reopen the
settled Twilio/Resend overseas-processing exception, repeat checkpoint 6, create
accounts or resume historical ACS provisioning. Operator/program facts, policy and
final policy review, clean image/real-PostgreSQL validation and the private bootstrap
procedure remain release gates. Local Terms/opt-in, approval/passkey and household-budget fixes are now implemented. Preserve every existing GoDaddy record and wait for
separate approval before credentials, purchases, deployment, DNS or expenditure.

Earlier read-only account inspection could not connect. Chrome control now works
for the 10 November local development checks, but external account state was not
refreshed and no external setting changed. Resume any authorized account inspection
from that checkpoint; do not repeat settled founder decisions or infer account
settings from public documentation.
