# Warthog comprehensive engineering audit

**Design polish deployed, 10 November:** source `7e61d3d` is live with one healthy
replica and 100% traffic. The production workflow succeeded. Five contributor
design skills and responsive/accessibility improvements passed 5,105 CI tests,
72 local layout cases and 18 interaction/display checks. All 16 public acceptance
checks and three production sign-in layout checks pass. The immutable image,
retained OS findings and deployment evidence are in the
[current release record](design-polish-release-2026-11-10.md).
See [current state](../../state.md) for remaining acceptance boundaries.

## Historical checkpoints

**Acceptance fixes deployed, 10 November:** source `09e1360` is live with one
healthy replica and explicit 100% traffic. Publication CI passes 5,092 application
tests; all 16 public post-release checks pass. Fresh Authenticator sign-in and
approved Gmail connection/labels-only read pass. Production receipt uploads and
downloads preserve exact bytes up to just below 25 MiB; oversized files are
rejected and synthetic records/files are removed. The temporary runner and all
associated resources are independently verified removed. The
[current release record](acceptance-fixes-release-2026-11-10.md) documents the
Azure serialization guard failure, tested correction and successful operator
continuation of the same reviewed image; the GitHub release run remains failed.
Desktop push receipt and isolated coordinated recovery remain unconfirmed.
See [current state](../../state.md) for the authoritative status and boundaries.

**Live acceptance follow-up, 10 November:** Memory and Skill CRUD/cleanup, eleven
public security-boundary checks, approved temporary-agent OAuth/MCP, permission
reduction, refresh rotation and token revocation pass. Testing found a loopback
callback URL-normalization defect and missing Memory browser validation; both are
corrected in source with 45 focused Node 22/Linux checks passing. Full CI on
`0ef3239` passes all six jobs and 5,079 application tests. The source fixes
are not yet deployed. See the [acceptance record](live-acceptance-2026-11-10.md)
for evidence, cleanup and the remaining sign-in/provider/upload/recovery work.

**First app release completed, 10 November:** the founder-approved
[release](../first-app-release-2026-11-10.md) succeeds on f406b2b, with one healthy
replica, explicit 100% traffic, 70 applied migrations and PostgreSQL TLS 1.3.
SMS is off and no Twilio configuration is injected. All four Resend DNS records
are provider-verified; the separately approved app DNS and managed certificate
are verified at [app.warthog.com.au](https://app.warthog.com.au). Live acceptance
remains pending. The temporary runner and all associated resources are verified deleted.
Pinned-base publication CI passes 5,078 application, 27 delivery and five cost
checks; the subsequent live-response delivery correction passes 28 regressions
and Actionlint. The [image review](runtime-image-review-2026-11-10.md) records
accepted residual OS findings. A subsequently approved single signup email was
delivered; the founder supplied its code and email verification passed. The founder
then completed Authenticator signup. Authenticated home/settings/security and the
SMS-disabled UI pass read-only checks. No SMS or Twilio purchase occurred.
See [state](../../state.md) for the current gates; earlier checkpoints below retain
their historical scope.

**Delivery setup follow-up, 10 November:** the explicitly authorized foundation,
scoped permissions, private database and production credentials are now applied
and live-verified. Internal database DNS was explicitly allowed; public DNS and
app release remain separate. See the [current setup record](../delivery-setup-2026-11-10.md)
for exact evidence, completed runner/cleanup verification and remaining provider/
release work. This supersedes
older statements below that no foundation or credentials exist. Full CI on
`cd344e5` passes all six jobs: 5,072 application, 24 delivery and five cost checks;
see [run 42756304600](https://github.com/Orlev01/warthog/actions/runs/42756304600).

**Publication and delivery follow-up, 10 November:** all source and existing history
are published to [Orlev01/warthog](https://github.com/Orlev01/warthog) using the
verified personal account and personal signing identity. The founder also requested
Azure CI/CD. The [delivery guide](../azure-delivery.md) records the new manual
Terraform plan/apply, ACR publication and singleton-release workflows. Four GitHub
environments require founder approval and main-only dispatch; Azure delivery is
disabled until existing funding/credential/deployment gates are met. All six jobs in
[remote CI](https://github.com/Orlev01/warthog/actions/runs/42715858437) passed on
source commit `bcc5b6907488eee004509b5760b7d5f761decb56`; evidence is recorded below.
That initial publication performed no cloud or DNS operation. Historical statements about uncommitted work
and pending publication describe their original checkpoints.

**Cost-focused infrastructure follow-up, 10 November:** the founder requested
an affordable production baseline and an alert at expected usage. The launch
profile, explicit PostgreSQL disk tier, repeatable cost model and existing-budget
import are implemented; [details and limits](../azure-costs.md). An A$440/month
subscription alert is created and independently verified. The subsequently
approved state/identity bootstrap is applied: storage protections, exact OIDC
subjects and four scoped grants were verified; anonymous container lists are
denied; Terraform reports no drift. A real apply caught the generated default
blob-service create/update distinction, which was corrected and verified live.
No production database, app, secrets, runner or DNS was deployed. The prior
custom-cash-cap decision is superseded by the explicit usage-alert direction.

The final cost/bootstrap source at `bda2dec3364a502f7b971332a948ed4e3586191b`
passes [CI run 42734554563](https://github.com/Orlev01/warthog/actions/runs/42734554563):
all six jobs, 5,072 application checks, 18 delivery and five cost-model checks,
provider schemas for both Terraform roots, real PG16 and runtime builds. The later
bootstrap-only generated-service correction is additionally verified by real Azure
plan/apply and a zero-change follow-up plan; application source is unchanged.

Started 9 November 2026. Scope: the complete current `codex/production-release`
working tree, including the existing uncommitted production work. Baseline commit
`dddd4103c35d03465d2f293049222b7221988171` is a reference, not the reviewed release.
This is a local review and remediation exercise, not launch certification.

**Initial local review/remediation completed 10 November (Australia/Sydney).** Three specialist agents and the
coordinator recorded 25 findings: 23 application/product defects fixed locally and
two delivery gaps addressed with CI/infrastructure source and explicit external
validation gates. Sensitive fixes received cross-review. No deployment, purchase,
credential creation, external message or DNS change occurred. Changes remain local
and uncommitted; there is no approved release image.

**Resumed local validation, 10 November:** Docker and Chrome access are working.
The clean Node 22/Linux ARM64 harness passes **5,072/5,072 tests**, TypeScript,
build/runtime staging and real PostgreSQL 16 checks. The follow-up corrected the
missing public Docker test fixture and six Terraform schema errors, and added
AUD-026 for the patched PostCSS dependency and AUD-027 for a subsequently reproduced
production startup-termination defect. There are now 27 registered findings. The
final integrated run includes both new startup regressions; its evidence is in
`/tmp/warthog-resume-linux-validated-20261110.log`.
Image advisories, full browser/provider acceptance and the external release gates
below remain open. No production release is approved.

## Review directive

Review Warthog as a product that will hold sensitive personal data and mediate
real actions by agents. Read requirements and trace the actual implementation
across UI, boundary, domain, persistence, asynchronous work and deployment. Look
for incorrect results, authorization failures, races, lost or duplicated actions,
data disclosure/loss, broken recovery paths, misleading product promises,
inaccessible interactions and unmaintainable boundaries. Assess CI/CD, repeatable
infrastructure, network isolation, supply chain, operational recovery and testing.

For every finding, record a stable ID, severity, affected files and call path,
concrete trigger, observed or reasoned impact, proposed smallest sound correction,
and verification. Separate demonstrated bugs from hypotheses, optional design
improvements and external acceptance gates. A large test count is not proof that
the application works. Do not report stylistic preferences as critical defects.

Reproduce confirmed defects with a meaningful failing regression before changing
behavior. Fix within the module that owns the responsibility; preserve existing
work, public compatibility where safe, security properties and the founder's
decisions. Record structural choices in an ADR. Have a second perspective review
sensitive changes. Run affected checks after each batch, then the full suite,
TypeScript, production build and runtime packaging after integration. Do not
disable tests to hide environmental failures. Report all remaining limits honestly.

## Perspectives and coverage

| Reviewer | Primary scope | Evidence report |
| --- | --- | --- |
| Security and API agent | Authentication, recovery, vault, OAuth/MCP, connectors, SSRF, authorization, replay and data disclosure | [Security/API report](security-api-review.md) |
| Delivery and infrastructure agent | CI/CD, IaC/Terraform, container/runtime, dependencies, networking, singleton lifecycle, migrations, monitoring/recovery | [Delivery report](delivery-infrastructure-review.md) |
| Product and UI agent | User journeys, UI wiring, failure states, accessibility, mobile/global behavior, copy and component design | [Product/UI report](product-ui-review.md) |
| Coordinating engineer | Data consistency, policy/budgets, jobs/messaging, cross-cutting design, reproduction, triage and integration | [Coordinator report](coordinator-review.md) and this register |

Follow-up reviews will cover gaps and independently check sensitive fixes. Agents
initially own only their report files; implementation ownership is assigned after
triage to prevent conflicting edits. Full-suite and build work is serialized.

## Authority and constraints

Current founder decisions in `../production-release.md` and
`../../deploy/production.env.example` supersede historical ACS/Australia-only,
parent-domain RP and unapproved budget proposals in the original brief/design.
Local review, implementation, tests and documentation are authorized. Purchases,
credentials, cloud deployment, external communications and exact DNS changes
retain their existing approval boundaries. No automatic deployment is authorized.
Preserve every existing GoDaddy record. Never put secrets or customer data in
reports, tests, source or logs.

The initial session could not access Docker/Desktop, OrbStack or browser control.
On resuming 10 November, Docker Desktop and Chrome control were available without
permission changes. Local checks below supersede that access blocker; production
and provider acceptance remain explicit gates. Provider purchases and live messaging tests are
outside this audit. Twilio redaction/complete A$20 pricing remains unresolved.

## Findings register

Statuses: **investigating**, **confirmed**, **fixing**, **fixed locally**,
**external gate**, **not a defect**. Fixed locally means regression evidence exists;
it does not imply cloud or real-browser acceptance.

| ID | Severity | Finding | Status | Fix and verification |
| --- | --- | --- | --- | --- |
| AUD-001 | High | HTTP transports mishandle successful bodyless responses, reporting successful connector changes as failures | Fixed locally | Two transport layers corrected; eight failing regressions observed, 130 focused checks pass |
| AUD-002 | High | Authenticator-only accounts cannot complete in-session security confirmation | Fixed locally | Session-bound, rate-limited TOTP step-up and shared UI; eight failing regressions observed, 51 focused checks pass |
| AUD-003 | High | No automated CI/clean Linux and real PostgreSQL gate | Fixed; local and remote CI verified | Workflow and Linux harness added; clean local ARM64 and remote AMD64 suites, real PG16 migration/role/contention checks, runtime builds and packaging pass. Remote CI runs the entire suite in four required shards; evidence below. |
| AUD-004 | High | Infrastructure described as implemented but no IaC exists | External validation gate | Foundation Terraform, separate ACA workload template, offline guard and singleton runbook added. Provider initialization, lockfile and schema validation now pass after six schema errors were corrected; ARM validation and an approved plan remain outstanding. |
| AUD-005 | High | Unauthenticated TOTP sign-in bypasses the required email ownership check | Fixed locally | Purpose-bound mailbox code before one-use TOTP challenge; 122 focused auth/UI checks pass |
| AUD-006 | High | Curated connector JSON writes omit JSON content type | Fixed locally | Curated JSON transport corrected; included in 97 passing connector checks |
| AUD-007 | High | Connector response is fully buffered before the nominal size limit | Fixed locally | Bounded streaming read, cancellation and body deadline; included in 97 passing connector checks |
| AUD-008 | High | Earlier releases in another currency are summed at face value after agent budget currency changes | Fixed locally | Shared converted-spending read, incomplete totals fail closed in policy and locked release; five failing regressions observed, 89 affected checks pass |
| AUD-009 | Medium | Home labels every agent budget as AUD and incomplete spend appears complete | Fixed locally | Currency propagation and explicit unavailable totals; three failing render regressions, 39 focused checks pass |
| AUD-010 | High | Public OAuth metadata cache retains unbounded distinct client URLs and DNS can outlive its timeout | Fixed locally | LRU/TTL, URL/body/in-flight bounds, DNS-through-body deadline; 49 focused checks pass |
| AUD-011 | High | Signup cannot use the advertised authenticator fallback on devices without passkeys | Fixed locally | Email-verified TOTP enrollment, confirmation and recovery path; 135 focused checks pass |
| AUD-012 | High | Household monthly spending uses different writers/readers' time zones | Fixed locally | Canonical UTC month, migration 0098 backfills only evidenced instants, unresolved history fails closed; 92 focused checks pass |
| AUD-013 | High | Protected-data portability is unwired and raw imports could cross the server boundary | Fixed locally | Device-local export/reseal, strict ciphertext-only import endpoint and atomic owned-record restore; security cross-review and 121 focused checks pass |
| AUD-014 | Medium | Signin/signup submissions can overlap and race client state | Fixed locally | In-flight guards included in corrected auth flow regressions |
| AUD-015 | Medium | Account-deletion copy overstates erasure from external processors | Fixed locally | Confirmation explains processor/back-up retention rather than promising immediate universal erasure |
| AUD-016 | High | Account deletion can commit partial irreversible changes and retain orphaned job payloads | Fixed locally | Pinned atomic transaction, post-commit release invalidation, purge cleanup and narrow migration 0099 role grants; 94 focused checks plus 14 atomicity checks pass |
| AUD-017 | High | Session verification can return a concurrently revoked session | Fixed locally | Atomic guarded UPDATE RETURNING and monotonic last-seen; 37 focused checks pass |
| AUD-018 | High | OAuth mint/refresh/revoke operations can lose or recreate credentials across races | Fixed locally | Transactional issuance and shared revocation locks; native PGlite transactions and transaction-aware key reads; 58 OAuth/DCR checks pass |
| AUD-019 | High | Deleted accounts can mint sessions before delayed purge | Fixed locally | Active-account guard and compatible row locks at session/recovery/reset boundaries; 134 focused checks pass |
| AUD-020 | Medium | User-facing timestamps use inconsistent unlabelled time zones | Fixed locally | Shared validated account-zone formatter, explicit UTC filters/reset notices and cross-page encrypted-preference checks; 110 related checks and 53 final combined checks pass |
| AUD-021 | High | Fresh non-PRF/TOTP-only users cannot create their protected vault | Fixed locally | Explicit fresh passphrase enrollment, recovery display and nonempty-vault safeguards; security cross-review and 121 portability/vault checks pass |
| AUD-022 | Medium | Dynamic-client registration count cap races under PostgreSQL snapshots | Fixed locally | Shared transactional advisory lock; deterministic interleaving regression; real PostgreSQL contention pending |
| AUD-023 | High | Amount rules compare foreign-currency numbers without conversion | Fixed locally | Owner-account rule currency separated from agent budget currency, conversion before rule matching and missing-rate refusal; three failing regressions, 95 focused checks pass |
| AUD-024 | High | Rule builder controls do not update dependent fields or preview | Fixed locally | Controlled draft state, dependent fields, live preview, currency label and submission guard; 26 focused checks pass |
| AUD-025 | High | Activity writer process queue can deadlock against an open database transaction | Fixed locally | Transaction-scoped activity locking joins marked transaction handles; original deadlock and new rollback regression pass, 69 affected checks plus 3 marker/nesting checks pass |
| AUD-026 | High dependency advisory | Next's pinned PostCSS 8.4.31 has published CSS/source-map advisories; Warthog route exploitability is not established | Fixed locally | Scoped PostCSS 8.5.32 override, regenerated lockfile and clean dependency audit (zero reported vulnerabilities); production build and integrated Linux rerun verify compatibility. See delivery report for sources and image-scan limits. |
| AUD-027 | Medium | Next catches rejected production instrumentation and leaves the container alive after configuration/startup validation fails | Fixed locally | Final-image reproduction and failing process regression; production startup now explicitly exits 1 with a fixed nonsecret error message, while development errors remain inspectable. Sixteen focused checks and TypeScript pass; integrated/image recheck recorded below. |
| AUD-028 | Medium | Azure returns `dapr: null`, causing the live configuration validator to abort inspection and later updates | Fixed; live response verified | Accept absent/null Dapr, retain the enabled-Dapr rejection; failing real-response regression reproduced, all 28 delivery checks pass, and the actual deployed app contract validates. See the [first release record](../first-app-release-2026-11-10.md). |

The specialist reports retain detailed reproductions, review coverage and
non-blocking design concerns. Every confirmed local finding from this review has
a disposition above; external acceptance is separate.

## Initial integrated verification (superseded by the resumed local checks)

Node 22.23.2 on the available macOS environment. Dependencies were inherited from
the existing checkout; this is not evidence of a clean Linux install.

| Check | Result |
| --- | --- |
| Final full suite | **5,068 tests: 5,050 passed, 11 failed, 7 cancelled, 0 skipped.** All 11 failures are known socket restrictions: 9 transport listener checks, 1 PostgreSQL timeout listener and 1 expected ECONNREFUSED assertion receiving EPERM. Boot setup also receives EPERM and cancels 7 checks. No tests were disabled. |
| TypeScript | Passed after integration; production build also type-checks the final source. |
| Production build | Passed after the final deletion-copy clarification. |
| Runtime packaging | Passed; manifest contains 70 migrations and 106 connector catalogue files, including 0098/0099. This is not an image digest or production boot test. |
| Final narrow copy follow-up | 48/48 related checks passed after distinguishing live key-reference removal from retained backups. |
| CI/IaC/workload source | YAML/Compose/script checks, Terraform formatting, offline workload structure/parameter checks and whitespace checks passed. Provider-schema and live ARM validation remain unrun. |

The first integrated run exposed three obsolete transaction-interception fixtures
and the real AUD-025 activity deadlock. Both were corrected; the final full run
contains no remaining application failure beyond the specified environment errors.
Focused counts elsewhere overlap and must not be added together.

Temporary local evidence: `/tmp/warthog-audit-full-final.log`,
`/tmp/warthog-audit-typecheck-integrated.log`, `/tmp/warthog-audit-build-final.log`,
`/tmp/warthog-audit-runtime-final.log`, `/tmp/warthog-audit-deletion-copy.log`.
These logs are not a published release attestation.

## Resumed local verification — 10 November 2026

These final results include AUD-027 and supersede the earlier socket-restricted
run and the intermediate 5,070-test pass. The checkout is
still the uncommitted `codex/production-release` tree; the baseline Git commit is
not a release attestation. Docker Desktop 29.9.3 was used without changing its
permissions. No production credentials, paid resources, DNS or external messaging
were used. The Compose network had no published host ports, and its disposable
containers/network were removed after each run.

| Check | Result |
| --- | --- |
| Clean Linux install/full suite | Node **22.23.4**, Linux **ARM64**: **5,072 passed, 0 failed, 0 cancelled, 0 skipped**. First run reproduced three missing-`.env.example` failures; the allowlist fix is covered by the existing config and client-bundle tests. Final run includes both AUD-027 startup regressions. |
| TypeScript/build/runtime staging | Passed in the clean Linux harness; 70 migrations and 106 connector files. The build/boot suite retains its documented development/PGlite runtime seam. |
| PostgreSQL 16.15 | Actual bootstrap, 70 migrations, idempotence, runtime/purge permissions, cascade purge, exclusive ownership and independent-backend household/OAuth/DCR/session/activity contention passed. |
| Ownership process failure/replacement | A duplicate process was refused; terminating the owning PG backend exited its process with code 1; replacement worked after connection loss and SIGKILL. Component-level evidence, not full application/ACA lifecycle certification. |
| Terraform | `init -backend=false`, formatting and provider-schema validation pass; provider lockfile verified for Darwin ARM64 and Linux AMD64/ARM64. No plan/backend/Azure login. |
| Workload guard | Offline structure passes; the unapproved parameter example is correctly rejected at `deploymentApproved`. Live ARM validation remains outstanding. |
| Application dependency advisories | Scoped Next→PostCSS 8.5.32 override; regenerated lockfile audit reports **0 known vulnerabilities**. Next remains 15.5.29. Image/base advisories are separate. |
| Browser access/local smoke | Real Chrome, loopback-only dev server, synthetic email/outbox, keyboard navigation/submission, invalid-code feedback, email verification, authenticator fallback and 390×844 layout checks passed. No complete enrollment/passkey, protected transfer/rules or screen-reader acceptance claim. Preview stopped and tabs/viewport cleaned up. |
| Final Linux AMD64 runtime | Clean platform-specific build passed. Node 22.23.4, non-root UID 1000, 70 migrations, 106 connectors, expected lockfile hash; no `.env*`, credential directories, test source or DB bootstrap in `/app`, and no global npm/npx. |
| Final-image startup rejection | With network disabled, read-only filesystem and no production configuration, the rebuilt AMD64 image exits **1** with fixed nonsecret logging. This closes AUD-027; positive full production startup still requires approved configuration and external acceptance. |
| Final image advisories | Trivy 0.76.2 offline scan: **0 findings across 117 Node packages** after removing global npm; **215 Debian package/advisory pairs** remain across 88 OS packages. Applicability/remediation review remains a release gate. |

The independent Linux AMD64 runtime build and final image inventory are recorded
with the image evidence below. Linux ARM64 test execution is not claimed as an
AMD64 full-suite run. The later remote CI checkpoint below supplies that evidence.

Current logs: `/tmp/warthog-resume-linux-validated-20261110.log`,
`/tmp/warthog-resume-ownership-lifecycle-20261110.log`,
`/tmp/warthog-resume-terraform-fixed-20261110.log`,
`/tmp/warthog-resume-provider-lock-20261110.log`,
`/tmp/warthog-resume-npm-audit-fixed-20261110.json` and
`/tmp/warthog-resume-workload-approval-guard-20261110.log`.
The [delivery follow-up](delivery-infrastructure-review.md#local-execution-follow-up--10-november-2026)
records reproductions, dependency sources and the raw base-image scan; the
[UI report](product-ui-review.md#remaining-acceptance-work) records exact browser
coverage. Screenshot: `/tmp/warthog-local-mobile-signin-20261110.jpg`.

## Published source and remote CI — 10 November 2026

The personal account published the existing 718-commit ancestry and all current
source to `main` in `Orlev01/warthog`. New commits use the personal author/signing
identity; no Eucalyptus credential or global Git change was used. The local bare
`origin` remains unchanged. Gitleaks examined the history and complete source tree;
all reported findings were reviewed synthetic fixtures/public development values,
with no detected live credential. Private environment/configuration files and
local generated artifacts were excluded.

[CI run 42715858437](https://github.com/Orlev01/warthog/actions/runs/42715858437)
passed all six jobs on `bcc5b6907488eee004509b5760b7d5f761decb56`.
This is the published source checkpoint; the subsequent documentation-only commit
records its evidence without rerunning unchanged code. Earlier monolithic runs
were cancelled/superseded after observing slow hosted database tests; their
cancellation is not reported as a pass. Node's four test-file shards cover the
same complete suite, and every shard is required. Standard public-repository
Ubuntu runners were used, without larger paid runners.

| Linux AMD64 shard | Passed | Failed / cancelled / skipped |
| --- | --- | --- |
| 1/4 | 1,309 | 0 / 0 / 0 |
| 2/4 | 1,363 | 0 / 0 / 0 |
| 3/4 | 1,312 | 0 / 0 / 0 |
| 4/4 | 1,088 | 0 / 0 / 0 |
| **Total** | **5,072** | **0 / 0 / 0** |

Each shard also passed TypeScript, real PostgreSQL 16 migration/idempotence,
role/purge/ownership and security/household contention checks, and runtime staging
with 70 migrations and 106 connectors. All four separate Linux AMD64 runtime builds
completed as user `node` and recorded this source revision in their labels. Clean
production builds completed during verification-image construction; the boot
tests retain the documented development/PGlite seam. These images were neither
pushed nor started with production credentials. Downloaded evidence is retained at
`/tmp/warthog-ci-final-20261110.log` and `/tmp/warthog-ci-final-20261110.zip`.

The delivery guard job passes 18 offline regressions. They cover repository/main/
manual/approval/scope checks, saved-plan integrity/age/input binding, separate plan
and apply identities, configuration preservation/drift, zero-replica and ownership
ordering, explicit private libpq connection settings, and failed-start cleanup
without automatic rollback. Terraform formatting, offline workload checks,
provider initialization without a backend and schema validation pass. Local
Actionlint also passes. A separate local AMD64 build using the immutable Node base
completed successfully; it is not an approved registry release digest.

Four configured GitHub environments require founder review, allow only main and
disable administrator bypass. All external fork workflow runs require maintainer
approval. `AZURE_DELIVERY_ENABLED=false`; no Azure workflow has run. OIDC identities,
private backend/plan storage, the ephemeral private runner and approved secrets
remain setup requirements. Cloud CLI behavior and actual deployment remain
unexecuted. See the [delivery guide](../azure-delivery.md) for exact settings and
the preserved spending, credentials, deployment and DNS approval boundaries.

## Final local image evidence

Local tag: `warthog-local-release`, platform `linux/amd64`, user `node` (UID 1000).
Image ID:
`sha256:3551adab37b3552b95adc1d1794bfedeefc316e0bf5b84bac959e8f8b8227cb8`.
This is a local image ID, not an approved published registry digest. No image was
pushed or deployed. The Dockerfile's base tag remains unpinned pending advisory
review and explicit release approval; its observed multi-platform base index was
`sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d`.

Build-input contents (1,044 allowlisted files) have SHA-256
`1e8eb88ff1dd47cb6f343f38165418e75399b0866537083fc6c1828696a8b93a`.
The input manifest is `/tmp/warthog-resume-source-manifest-final-20261110.json`;
this identifies uncommitted inputs without pretending the baseline Git commit
contains them. Package lock SHA-256 is
`10362adeea165e0d7b0317b3fc75cb89ac97f464c248a1a6eabec9a2b1f895d8`.
Provider lock SHA-256 is
`d72f4944f5052cfba908c38a1ddde6c089e1aaff0efb6649a8f813af73d180fc`.

The final offline scan matches this exact image ID and reports 215 Debian
package/advisory pairs: 1 critical, 34 high, 95 medium and 85 low, representing
100 distinct CVEs. It lists no available Debian fixed version. These are scanner
matches, not demonstrated Warthog exploits; the critical zlib/MiniZip match has
the Debian applicability explanation in the delivery report. The 23 findings in
the base's global npm CLI are absent from the final runtime. The scan used the
downloaded database updated 9 November at 19:03 UTC; the application archive was
scanned locally with API dependency lookups, telemetry and DB updates disabled.

Final evidence:
`/tmp/warthog-resume-runtime-build-final-20261110.log`,
`/tmp/warthog-resume-runtime-image-final-20261110.json`,
`/tmp/warthog-resume-runtime-manifest-final-20261110.json`,
`/tmp/warthog-resume-runtime-check-final-20261110.log`,
`/tmp/warthog-resume-runtime-startup-final-20261110.log` and
`/tmp/warthog-resume-runtime-trivy-final-20261110.json`.
All inspection/startup containers were removed. The local image and evidence
remain available; no production process is running.

## Remaining acceptance and operational work

1. The [isolated Linux/PostgreSQL 16 checks](../local-release-validation.md)
   have passed locally and in remote CI on the published source commit. Resolve the
   remaining image-advisory applicability/remediation review, refresh scan evidence, and pin
   and approve an immutable release/base image. A local image tag is not approval.
2. Provider/schema/lockfile checks for [foundation Terraform](../../infra/README.md)
   now pass. Validate an approved account-specific plan and
   the [ACA workload template](../../infra/workload/README.md) in the approved scope.
   Verify quota, singleton lifecycle, managed identity/private networking, health
   probes and the full 26 MiB envelope through real ingress. No documented ingress
   size knob was invented. Credit-only funding protection and exact expenditure
   approval remain unresolved; notification budgets do not stop charges.
3. Complete real-browser/mobile/keyboard/passkey acceptance and actual email,
   SMS/STOP/redaction, push and all six Google/Microsoft connectors. Provider
   credentials, country registration, entitlement/pricing, approved DNS additions
   and the complete A$20 SMS quote retain their existing approval gates.
4. Prove coordinated database/blob/key recovery and deletion reconciliation.
   Old backups can retain wrapped keys still decryptable by the shared wrapping
   key. An independent post-restore-point deletion reconciliation process is not
   implemented or verified; the purge queue is not a permanent deletion journal.
   Do not reopen restored accounts without that process. The
   [release/restore runbook](../singleton-release-runbook.md) records this gate.

The specialist reports separately label future design concerns such as refresh
client binding, immutable migration checksums and generic request media types.
They are not presented as demonstrated cross-account exploits or silently counted
as completed features. This audit does not establish absence of all possible bugs.

## Completion criteria

Every review report is incorporated; each confirmed actionable local defect has a
tested fix or a specific reason it cannot safely be resolved here. Delivery gaps
have usable local artifacts where appropriate, without automatic spending or
publishing. Final verification covers the integrated tree. Remaining external
gates and product limitations are listed separately, with no claim of exhaustive
security assurance or production readiness.
