# Current status — repository publication and Azure delivery, 10 November 2026

**Cost review and budget follow-up:** the founder requested a small, robust
production baseline, retaining premium features where they add value, using
available credits, and setting an alert at the expected usage cost. This replaces
the earlier unresolved cash-cap/usage-alert decision. The [cost model](docs/azure-costs.md)
estimates A$430.78/month (A$438.25 for 31 days); the **A$440 monthly budget** was
created and independently verified in Azure on 10 November. Actual alerts are
50/80/100% and forecast 100%, to the founder. It is an alert, not a spending stop.

The [launch profile](infra/profiles/launch.tfvars.example.json) keeps General
Purpose PostgreSQL and HSM-backed Key Vault protection, uses 32 GiB P4 storage,
Consumption hosting, ACR Basic, LRS blobs and a small log allowance. Terraform
pins disk type/performance and can import the existing budget without duplicate
creation. The [architecture decision](docs/adr/launch-infrastructure-cost.md)
explains upgrade triggers and availability limits. These are source changes, not
an applied foundation or production certification.

An isolated [bootstrap module](infra/bootstrap/README.md) now supplies executable
source for state/plan storage, retention, four environment-bound managed identities
and four container-scoped state grants. It uses a public Entra-authenticated HTTPS
endpoint for hosted foundation runners. Exact stage approval is still required;
no identity or storage has been created.

Personal Warthog owner access is verified. No Warthog resource groups exist;
provider registrations, delivery identities, state storage, secrets and the
private ephemeral runner are still required. Exact resource/credential/deployment
and DNS approvals remain in place. GitHub delivery remains disabled. The budget
is the only Azure configuration mutation so far. Private credit/support/budget
confirmation evidence is in `.delivery/activation-2026-11-10/` (ignored owner-only
files). Do not duplicate the billing inquiry or repeat the superseded cash-cap
question; verify actual eligible credit availability before each paid stage.

All source and the existing 718-commit history are now published to the public
[Orlev01/warthog](https://github.com/Orlev01/warthog) repository, as authorized by
the founder. Only the verified personal `Orlev01` GitHub credential was used;
new commits use the personal author and SSH signing identity. Eucalyptus
authentication was not used, and global Git settings are unchanged. The existing
local `origin` remains intact; `github` is the new remote. This supersedes the
earlier publication hold below.

Added manual Azure foundation plan/apply, image publication and application release
workflows, plus the [complete setup/release guide](docs/azure-delivery.md). GitHub's
four environments require `Orlev01` review, allow only the `main` branch and forbid
administrator bypass. `AZURE_DELIVERY_ENABLED=false` keeps all cloud steps disabled.
All external contributors' fork workflow runs require maintainer approval; any
future private deployment runner must be ephemeral and reserved for an approved
production run, as detailed in the delivery guide.
No Azure identity/federation, secret, resource, provider registration, deployment,
spend or DNS change has been made. Actual cloud execution still needs the existing
specific approvals, private state/plan storage, OIDC identities and private runner.

Plans are private, short-lived and bound to source/input hashes; apply requires the
reviewed saved-plan SHA-256. Image publication runs the clean Linux/PG suite against
a reviewed immutable base. App updates preserve configuration and custom domains,
prove zero old replicas/free database ownership before start, verify health and
traffic, and retain an outage on failure without automatic rollback. First creation
uses the existing complete workload template with approved Key Vault references.

The [remote CI run](https://github.com/Orlev01/warthog/actions/runs/42715858437)
passed all six jobs on source commit
`bcc5b6907488eee004509b5760b7d5f761decb56`: four complete-suite shards on standard
Ubuntu/Linux AMD64 runners (**5,072 passed, zero failures/cancellations/skips**),
18 delivery regression tests and Terraform schema checks. Real PostgreSQL checks,
types, production builds and non-root runtime packaging also pass. Local Actionlint
and the workload guard pass. Publication scans
covered 718 existing commits and the complete source tree; findings were
individually reviewed synthetic fixtures/public development values, with no
detected live credential. The audit records detailed CI evidence. The following
local image/browser evidence predates publication and retains its stated limits.

## Resumed local validation

Docker Desktop and Chrome access now work. The isolated clean Node 22.23.4/Linux
ARM64 run passes **5,072 tests, zero failures/cancellations/skips**, TypeScript,
production build and runtime staging (70 migrations, 106 catalogue files). Real
PostgreSQL 16.15 passes bootstrap, migrations/idempotence, role boundaries, purge,
ownership and household/OAuth/DCR/session/activity contention. An additional real-
process check verifies duplicate refusal, exit on lost DB ownership and replacement
after connection loss/SIGKILL. This is not full production/ACA lifecycle acceptance.

The first Linux run exposed a missing public `.env.example` fixture in the Docker
context; it is now included for tests while real environment files stay excluded.
Terraform initialization/provider validation now pass after six draft schema errors
were fixed, and a provider lockfile covers Darwin ARM64 and Linux AMD64/ARM64.
The workload guard still rejects unapproved example parameters. No backend or Azure
plan was opened. AUD-026 records a scoped PostCSS 8.5.32 override; the application
lockfile audit now reports zero known vulnerabilities, with Next still at 15.5.29.
AUD-027 fixes Next retaining a live process after rejected production
instrumentation: startup now terminates explicitly with fixed nonsecret logging,
while development diagnostics remain. Both new regressions pass in the final
suite. The original 25 findings and both additions (27 total) are recorded in
`docs/audit/README.md`; final Linux evidence is
`/tmp/warthog-resume-linux-validated-20261110.log`.

The final `warthog-local-release` image builds for Linux AMD64, runs as UID 1000,
contains the expected 70/106 runtime assets and lockfile hash, excludes environment/
test/bootstrap files, and explicitly exits 1 when production configuration is
missing. Image ID and source fingerprint are in the audit register. Unused global
npm/npx were removed from the runtime stage; the final offline scan reports zero
Node-package findings. Debian OS findings still require applicability/remediation
review before image approval. The ordinary Dockerfile default remains a mutable
base tag; the new release workflow requires an explicitly reviewed immutable base.
No image has been pushed to a registry.

Chrome local smoke checks cover signup keyboard navigation, disabled pending
controls, invalid-code feedback, synthetic email verification, authenticator
fallback and a 390×844 layout. Full passkey/TOTP/vault/transfer/rules and assistive-
technology acceptance remain open. The preview, disposable DB and browser tabs
were cleaned up. No live provider message or real credential was created.

Image advisory applicability/remediation and immutable release approval remain
gates, alongside approved Terraform plan/live ARM checks, provider/full
browser acceptance, 26 MiB ingress, credit-only funding and coordinated restore/
deletion reconciliation. Purchases, credentials, deployment and exact DNS changes
retain their existing separate approvals. Source is published; no cloud release
has run. Earlier socket/Docker/browser failures below are historical, not the
current result.

Founder approval is recorded in `docs/adr/global-messaging.md`: Twilio + Resend local
integration and disclosed overseas processing approved; Warthog is global, Azure
Australia East remains primary. No approval for purchases, real credentials,
deployment, DNS or ongoing expenditure. Earlier pending-exception/AU-only notes
below are historical and superseded.

Subsequent founder approvals: production hostname and passkey RP ID are both `app.warthog.com.au`; sending domain `mail.warthog.com.au` and From `notifications@mail.warthog.com.au`; public replies/support/privacy contact `oren@nava-co.com`. Initial SMS markets AU/US/CA/GB are approved only after registration and delivery/STOP acceptance, with application caps of 200 outbound segments/month and 10/day in total. Exact DNS mutations, credentials, purchases and deployment still need separate approval. The founder confirmed sending the technical questions in response to Twilio sales; entitlement/pricing remain pending.

Latest budget direction: use available Azure sponsorship credits and retain premium features where they add value. The founder explicitly requested cost-focused infrastructure, a calculated monthly estimate and a usage alert when cost exceeds that estimate; the A$440 alert is now created. This supersedes the previous zero-cash and unresolved A$100 cash-cap/alert deliberation. Verify eligibility and shared credit availability before paid provisioning; this is not unlimited cash-fallback permission or an approval of unreviewed resources. Resend Free is selected (3,000 emails/month, 100/day), with paid upgrades/overages unapproved. Twilio allowance remains A$20/month; its complete price including sender rentals, redaction and other fees is unresolved. Earlier A$550/A$600/A$675 proposals are historical, not the current Azure estimate or approved purchases.

The founder prefers an Azure-native SMS solution if viable, including using sponsorship. Rechecked official sources: the [Twilio connector](https://learn.microsoft.com/en-us/connectors/twilio/) requires a separate Twilio account; [MCA Azure credits](https://learn.microsoft.com/en-us/azure/cost-management-billing/benefits/credits/mca-check-azure-credits-balance) generally exclude partner/third-party Marketplace services. The current [ACS retirement FAQ](https://learn.microsoft.com/en-us/azure/communication-services/acs-retirement-and-breaking-changes-guide#acs-sms) still retires SMS on 30 September 2028 and restricts number acquisition to existing customers with existing ACS phone numbers. Earlier account inspection found none. No eligible isolated Warthog ACS SMS path has been demonstrated. Marketplace procurement/MACC eligibility is not sponsorship-credit coverage. This investigation does not change providers or authorize provisioning; await the actual Twilio redaction/price response.

Approved-domain compatibility is implemented locally: `RESEND_SENDING_DOMAIN` validates the exact From domain independently of the passkey RP ID, allowing `mail.warthog.com.au` with RP `app.warthog.com.au`. `RESEND_REPLY_TO_ADDRESS` sends customer replies to the approved public contact, and the From display name is Warthog. See `deploy/production.env.example` for approved public settings; it is deliberately incomplete without the separately approved credentials and provider routes. Three regressions failed first, then all 51 affected checks passed. Current full-suite/build evidence is recorded below.

Implemented local adapters, ISO-country routing, international phone formatting,
IDNA email domains, persistent SMS segment/message/attempt limits, opt-in/out and
privacy/security copy. See `docs/production-release.md` and
`docs/global-messaging-launch.md` for current configuration and country limitations.
Google/Microsoft and push remain required. Real provider acceptance and release
image/PostgreSQL/browser checks are still outstanding. The founder authorized
the one no-cost Twilio redaction/price inquiry in `../warthog-browser-checkpoint-7.md`
and supplied all requested contact fields, including phone/job title, on 9 November.
The corrected sales-contact form was submitted once and confirmed at about
09:32 UTC / 20:32 AEDT on 9 November. Twilio's thank-you page estimates 1–2 days
for a response; no ticket ID was displayed. Marketing opt-ins stayed unchecked.
The initial form had no message/company field. The founder subsequently confirmed
sending the prepared technical questions in reply to Twilio sales. Await that
reply; do not resubmit the form or duplicate the outreach. Do not request the
inquiry authorization or supplied contact facts again.
Checkpoint 6 is complete; see `../warthog-checkpoint-6-engineering-review.md`.
Local follow-up now fixes concurrent approval collection and per-credential passkey envelopes (0097), adds draft public Terms and adjacent SMS disclosures, and prepares an isolated Linux/PostgreSQL harness. Final policy review/publication, country quiet-hour/use-case assessment (no scheduler), processor/account review and actual body-redaction entitlement/cost remain external gates. Current English code/approval
texts fit one/two conservative segments with the candidate hostname; no live send.

Household follow-up is now implemented locally: policy uses converted display totals, missing required rates fail closed, and release locks/rechecks household/member/agent budgets and current permissions in the ledger transaction. A fixed ledger instant prevents a month-end wait from checking the wrong month. Existing personal period buckets/time-zone cut-over semantics remain. A real PostgreSQL lock-contention test is prepared in the isolated harness but unexecuted.

Pre-audit baseline verification after the approved-domain changes: full run 4,966 tests, 4,948 passed, 11 socket-restricted failures and seven boot cancellations. This includes the final household timing changes and approved-domain/reply-to regressions. Earlier focused release-handler checks pass all 42 tests; household checks pass 163 tests, with a separate 35-test boundary/UI run (counts overlap). Final production build, TypeScript, runtime staging and whitespace checks pass; staging contains 68 migrations and 106 catalogue files. Docker Desktop's socket is absent and macOS could not launch it; an existing OrbStack socket was found but this session is denied access. Compose configuration and harness syntax/type checks pass, but Linux/real-PostgreSQL execution remains unverified. The read-only browser retry also failed: browser-access host unavailable, then native Chrome timeout. No account state was refreshed, and no production credential or cloud setting changed. See the detailed handoff for remaining external, validation and product-review gates.

Evidence and release gates: `docs/production-release.md`. Local Linux procedure: `docs/local-release-validation.md`.

---

# Historical production release preparation (superseded by current status)

Status: local draft, 9 November 2026; not approved to provision or launch. Work is on `codex/production-release`, based on `dddd410`; local changes remain uncommitted. Original checkout and bare main remain unchanged. Nothing published or deployed.

Confirmed scope: real email, SMS, push, Gmail/Google Calendar/Google Drive, Outlook Mail/Outlook Calendar/OneDrive. No silent deferral. Google retains its existing early-access restriction; Warthog retains public sign-up and strong sign-in.

Completed locally: notification and OAuth composition, SMS destination/segment controls, authentication and vault-possession hardening, invite quota and OAuth cleanup, nonce middleware, separate database roles/connections, ownership guard, Node 22 container packaging and local licensed fonts. Production build, TypeScript and runtime staging pass; staging includes 66 migrations and 106 catalogue entries. Focused tests pass. The full suite plus targeted fixes is documented precisely in `docs/production-release.md`; local socket restrictions prevent a green full run, real PostgreSQL and final-image/browser certification.

Checkpoint 5 is complete by founder-supplied browser report; see `../warthog-checkpoint-5-findings.md`. No isolated eligible Warthog ACS SMS path was demonstrated; the older GameHub communication resource has no numbers and disabled acquisition controls. No accessible Warthog Google project or Entra application was found. Nothing was changed. Next gate: founder decision on `docs/adr/messaging-provider-exception-proposal.md` for a limited Twilio/Resend policy exception and local integration only. Approval is pending; do not repeat checkpoint 5 or start provider setup.

Remaining engineering gates: provider decision and any adapter replacement; authorized clean Linux image/real PostgreSQL/security/browser verification; reviewed private bootstrap execution client/procedure; immutable release commit and image digest. The SQL bootstrap file exists but is not an unattended job or proof of execution. Singleton replacement still requires maintenance and real acceptance; advisory ownership is not distributed fencing.

Remaining founder approvals: final host/RP/sending domain, operator/test identities, SMS destinations/limits, gross AUD spend envelope and treatment of the older automatic-stop/US$150 requirement. A$550 remains a proposal; budgets do not stop spending. No Azure/GoDaddy mutations or purchases are authorized by this local work.

SMS proposal reconciliation: current counters measure segments/month, segments/day and segments/recipient-hour. Three messages/recipient-day, a two-segment message maximum and Australian-mobile-only validation are proposed additions, not implemented protections. The proposed A$600 envelope is not spending authorization and does not supersede the original automatic-stop requirement.
