# Delivery and infrastructure audit

Reviewed 9 November 2026 against the local `codex/production-release` checkout,
baseline `dddd410` plus its pre-existing engineering changes. Perspective:
deployability, repeatability, single-process safety, networking, schema/bootstrap,
credentials, supply chain and recovery. Review is source-based; no live Azure,
Docker, browser, provider or production credential operation occurred.

## Findings and disposition

| ID | Severity | Evidence / scenario | Impact and disposition |
| --- | --- | --- | --- |
| AUD-003 | High delivery gap | At review start there was no `.github/` workflow. `package.json` exposed tests/typecheck/build but no repeatable Linux/real-PostgreSQL release gate. Existing macOS suite had socket failures, and dependencies came from a copied local install. | Manual green unit tests could be mistaken for a clean deployable release. Added `.github/workflows/ci.yml`: clean Node22 Linux build, full suite/typecheck/runtime/PG16 checks, non-root runtime image build and source/image evidence; separate Terraform schema job. No cloud login/push/apply. YAML, Compose and script checks passed. Actual CI/Linux execution remains blocked, so this is source remediation, not passing remote CI evidence. |
| AUD-004 | High delivery gap | Original `docs/design/technical-design.md` §2 claimed Terraform/OpenTofu in `infra/`, `dns_records` output, an automatic spending stop and obsolete ACS/public-DB/B1ms architecture. No infrastructure source existed. | A browser operator could build the wrong network/provider/authentication setup or assume billing protection exists. Reconciled design and added ADR, a narrowly scoped Terraform foundation and a separate singleton rollout runbook. HCL formatting parses. Provider downloads fail in this environment, so provider schemas/plan/apply/lockfile are unverified. Workload/bootstrap/DNS and credit-only billing protection remain explicit gates. |
| AUD-016 | High correctness | `src/server/account/delete.ts:83` originally cleared wrapped DEK, revoked connections, deleted sessions and enqueued purge in separate writes. A failure between writes left an irreversible partial deletion. `jobs.payload` has no user/approval FK, so purge retained job identifiers. | Fixed: one pinned transaction covers ownership check, executor revocation, sessions/jobs, DEK and durable purge request. Reset/deletion discard in-memory releases only after commit. Revocation deletes unexchanged OAuth codes and shares the credential lock with issuance. Purge removes JSON job payloads before ownership rows disappear; migration 0099 adds only the required purge permissions. Fourteen new focused checks cover mutation/commit rollback, pinned-handle use, release invalidation, reset preservation and the real purge role. |
| AUD-020 / UI-004 | Medium product correctness | `home/actions.ts`, `activity/actions.ts`, inbox history, agent/connector/memory dates used UTC; notification registration forced Sydney; security used the server zone; reset notices forced Sydney. None labelled its zone. | Fixed with one pure `domain/display-time.ts` formatter and shared zone validation/default. Loaders resolve the encrypted account preference, pass it to presentation and show its IANA label. Signed-in reset banners use that preference; unauthenticated reset notices explicitly use UTC. Activity date filters retain their existing semantics and are explicitly labelled UTC. Calendar-only due dates and all financial period calculations are unchanged. Product agent integrated the shared formatter into its owned imported-history loader. |

## What the new delivery source does

- Official action references are pinned to verified commit links:
  [checkout v7.0.1](https://github.com/actions/checkout/commit/3d3c42e5aac5ba805825da76410c181273ba90b1)
  and [setup-terraform v4.0.1](https://github.com/hashicorp/setup-terraform/releases/tag/v4.0.1).
  Repository token permissions are read-only, checkout credentials are not persisted,
  no untrusted `pull_request_target` execution is used, and no secret/context value
  is interpolated into a shell program. Dependabot proposes npm/action/Docker
  updates; it neither merges nor deploys them.
- The Compose check builds with `npm ci` on Node22/Linux and runs the existing
  complete test suite, including its development/PGlite framework boot test.
  It separately bootstraps real PostgreSQL16 roles, migrations, privilege checks,
  purge cascades, ownership and cross-member transaction contention on an internal
  network with synthetic data and tmpfs. Cleanup runs even when CI fails.
- A distinct non-root linux/amd64 runtime image is built and its ID/platform/source
  label and release manifest logged. It is not published or booted with production
  credentials. Approved base digest and registry digest remain release gates.
- Terraform source requires the dedicated subscription/tenant, paid-provisioning
  approval and caller-selected names/CIDRs/SKU/zone/storage/budget/log quota.
  PostgreSQL is private; app and bootstrap subnets have the necessary endpoints;
  the identity gets only scoped image/secret/wrapping/receipt access.
- PostgreSQL admin password uses an ephemeral input/write-only argument. Storage
  and log workspace resources use ARM-only AzAPI properties to avoid materializing
  account/shared keys as computed state. Secrets/login URLs are provisioned privately
  after approval. Neither provider auto-registers namespaces.

The follow-up [application workload artifact](../../infra/workload/README.md) is
separate from the Terraform foundation: one ARM app resource, required nonsecret
parameters and version-pinned Key Vault references, existing environment/identity,
external HTTPS/3000, explicit HTTP probes, min=max=1 and manual Multiple mode.
It preserves existing domain bindings and requires stop/wait/ownership evidence;
the new explicit traffic target is approved as part of starting the sole revision.
No automatic deployment, live credentials, DNS, paid optional service or runtime
code change was introduced. Offline structure and synthetic parameter guards
passed; Azure ARM schema/expression validation and live behavior remain unverified.
The previously proposed startup threshold of 120 was corrected to ten attempts
at 60-second intervals, within the referenced API's declared custom range.
The Next bytes parser confirms `26mb` = 27,262,976 bytes. Current official ingress
documentation does not establish that body ceiling or a body-size setting, so
actual near-limit ingress acceptance remains a release gate; Dapr's similarly
named limit and paid premium ingress are not assumed solutions.

## Operational conclusions

**Exactly one replica is an application correctness constraint.** The code correctly
adds a database session advisory lock, fails initial ownership and exits on detected
connection loss. The guard is not evidence of an exercised Azure rollout. Azure
single revision mode provisions a replacement before retiring the previous one;
min=max=1 therefore cannot be treated as a global no-overlap guarantee. The new
runbook uses manual multiple mode, deactivates every previous revision, checks all
old replica lists and database lock availability, then starts one reviewed digest.
It explicitly includes downtime and migration-aware rollback. [Azure lifecycle](https://learn.microsoft.com/en-us/azure/container-apps/revisions).

**Health endpoints are present but must be configured as HTTP probes.** Readiness
validates required production settings and checks the migrated database. Liveness
does not depend on a database round trip. Default TCP probes are not equivalent;
startup needs enough time for migrations. The configured proof still needs actual
private networking and production-mode startup. [Probe behavior](https://learn.microsoft.com/en-us/azure/container-apps/health-probes).

**Observability is only partly implemented.** Fixed readiness responses, error-code
logging, redacted job logs and operational database metrics exist. The foundation
adds console/system routing and a log cap, but app/DB/job/backups alerts and their
delivery are not configured or tested. Log collection must not be described as a
working incident-response system. Ingestion delay makes it unsuitable for proving
instant termination. [Azure log options](https://learn.microsoft.com/en-us/azure/container-apps/log-options).

**Restore is a launch gate.** PostgreSQL PITR does not restore receipt blobs or key
material. Versioned wrapped DEKs require retained Key Vault key versions. A tested
restore must preserve role boundaries, inspect blob references, handle accounts
deleted after the backup and avoid resurrecting their access/data. No RPO/RTO,
coordinated restore test or approved temporary restore-resource cost is established.
The runbook now records this rather than presenting seven-day backup retention as
recovery proof.

**Budget notifications are not a hard cap.** A stopped app leaves registry, storage,
database/storage/backups, logs and managed networking costs. No verified mechanism
enforces founder credit-only hosting or a whole-stack cash ceiling. Terraform
drafts do not remove this previously reported gate or authorize paid resources.

## Local execution follow-up — 10 November 2026

Docker Desktop (`desktop-linux`, engine 29.9.3) and Chrome are accessible in the
resumed session. The previously blocked operations were retried without changing
permissions or creating credentials. No external resources or DNS were changed.

- **AUD-003:** the first clean Linux run reported 5,070 tests: 5,067 passed and
  three failed, with no cancellations/skips. All three failures were `ENOENT` for
  `.env.example`, excluded by the Docker context. The allowlist now includes only
  that committed public development fixture. Real `.env*` files remain excluded;
  runtime staging still rejects environment files. Existing config and client-
  bundle tests reproduce the issue; no test was disabled.
- Real PostgreSQL 16.15 passed 70 migrations, migration idempotence, separate
  login/role restrictions, purge cascades, exclusive ownership, household-budget
  contention and OAuth/DCR/session/activity contention checks. A separate
  real-process exercise using `startProductionOwnership` rejected a duplicate,
  terminated the owner with exit 1 after its DB backend was killed, and allowed
  replacement after that loss and after SIGKILL. This verifies the ownership
  component, not complete production startup, TLS or Azure revision replacement.
- **AUD-004:** six provider-schema errors were reproduced and corrected for
  AzureRM 5.13.0 (subnet `service_endpoint` blocks and DNS-link zone ID). Terraform
  formatting and `validate` now pass. The registry-generated lockfile covers
  Darwin ARM64 and Linux AMD64/ARM64; HashiCorp and partner signatures/checksums
  were verified by Terraform. No backend, plan, apply or Azure login was used.
- **AUD-026, high dependency advisory, fixed locally:** npm audit identified
  PostCSS 8.4.31 through Next 15.5.29, with four advisories and an aggregate of one
  high and one moderate affected package. `package.json` now scopes a PostCSS
  8.5.32 override to Next; the lockfile deduplicates the patched version already
  used by Tailwind. Next remains 15.5.29. A new lockfile audit reports zero known
  vulnerabilities. This is dependency remediation, not a demonstrated remotely
  exploitable Warthog route. References:
  [CSS output escaping](https://github.com/advisories/GHSA-qx2v-qp2m-jg93),
  [source-map reads](https://github.com/advisories/GHSA-6g55-p6wh-862q),
  [incomplete source-map fix](https://github.com/advisories/GHSA-fxqj-rqcc-2cmp),
  [source-map traversal](https://github.com/advisories/GHSA-r28c-9q8g-f849).
- **AUD-027, medium operational defect, fixed locally:** starting the first AMD64
  runtime image with no production configuration logged Next's `Ready` message,
  then a rejected instrumentation hook for missing `PUBLIC_BASE_URL`, but the
  container remained running and had to be stopped. Throwing from `registerNode`
  alone therefore did not enforce the documented startup-termination contract.
  This does not demonstrate authentication bypass or successful readiness. A new
  subprocess regression first observed exit 0 when a framework caught the rejected
  hook. `src/instrumentation-node.ts` now catches production initialization errors,
  emits fixed text without configuration/connection details and explicitly exits
  1. Development still rejects with its diagnostic error. The regression and 14
  related readiness/ownership/scheduler checks pass (16 total), as does TypeScript.
  The final full suite passes 5,072/5,072, and the rebuilt Linux AMD64 runtime
  exits 1 on missing configuration. Final image evidence is in the audit register. Reproduction:
  `/tmp/warthog-resume-runtime-startup-refusal-20261110.log` and
  `/tmp/warthog-resume-startup-regression-red-20261110.log`; focused result:
  `/tmp/warthog-resume-startup-focused-20261110.log`.

Final AMD64 runtime inspection confirms UID 1000, 70 migrations, 106 connector
files, expected package-lock hash and absence of environment files, credential
directories, test source and DB bootstrap from `/app`. The final offline Trivy
scan finds zero vulnerabilities among 117 Node packages; the 23 global npm CLI
findings are eliminated. The 215 raw Debian package/advisory pairs below remain
unchanged and require applicability/remediation review. Logs and exact image/source
identifiers are in the [audit register](README.md#final-local-image-evidence).

Docker Scout could not scan without Docker login; no login/account/PAT was created.
An official Trivy 0.76.2 release, verified against its SHA-256 asset digest, scanned
the public Node base anonymously using vulnerability database metadata updated
9 November 2026 at 19:03 UTC. The Linux AMD64 base index was
`sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d`.
The scan reported 215 Debian package/advisory pairs (100 distinct CVEs: 1 critical,
34 high, 95 medium and 85 low **package/advisory pairs**) and 23 bundled Node-tool
pairs (22 distinct CVEs: 10 high, 12 medium and 1 low pairs). These are raw scanner
counts, not counts of demonstrated Warthog exploits. No Debian fixed version was
listed; bundled npm/tool findings do list fixes. All 23 Node-tool pairs came from
the base image's global npm CLI tree. The runtime stage now removes that tree and
the npm/npx executables, because its entry point is `node server.js`. Build/test
stages retain npm. The final runtime scan verifies the resulting inventory.
Do not equate a zero application
npm audit with a clean OS/container image.

The critical zlib entry is CVE-2023-45853. The
[Debian tracker](https://security-tracker.debian.org/tracker/CVE-2023-45853)
explains that Bookworm's zlib does not build the affected contrib/minizip code.
That is relevant applicability evidence, not a blanket dismissal of the other
findings. Runtime-image inventory and remaining advisory applicability/remediation
must be reviewed before pinning and approving a production image. No image was
approved, uploaded or pushed during this follow-up.

Evidence is local: `/tmp/warthog-resume-linux-20261110.log`,
`/tmp/warthog-resume-linux-final-20261110.log`,
`/tmp/warthog-resume-postgres-first-20261110.log`,
`/tmp/warthog-resume-ownership-lifecycle-20261110.log`,
`/tmp/warthog-resume-terraform-20261110.log`,
`/tmp/warthog-resume-terraform-fixed-20261110.log`,
`/tmp/warthog-resume-provider-lock-20261110.log`,
`/tmp/warthog-resume-npm-audit-20261110.json`,
`/tmp/warthog-resume-npm-audit-fixed-20261110.json` and
`/tmp/warthog-resume-base-trivy-20261110.json`.
The audit register records the final integrated run and runtime image evidence.

## Further improvements, not verified exploitable bugs

- `src/server/db/index.ts` records migration names without content hashes. Once a
  migration is applied, editing its SQL is silently ignored on an existing DB.
  Establish immutable migrations/change review or a backward-compatible checksum
  policy before future releases; do not edit applied migrations to repair data.
- Docker base tags remain mutable at source. Pin a reviewed digest in the final
  production release and retain vulnerability/license inventory. The existing
  package lock pins exact npm artifacts. The 10 November registry/image scans and
  PostCSS remediation above supersede the earlier inability to scan; image advisory
  review remains open. Do not claim packages are vulnerability-free.
- Runtime staging currently has no symlinks in this checkout. Its accepted internal
  symlink handling should be characterized before adopting a package manager or
  build arrangement that creates symlinked runtime packages; this is not evidence
  that the current output is broken.

## Checks and limits

Passed: workflow/Dependabot/Compose YAML parsing; immutable action-reference and
read-only permission checks; Compose configuration; `node --check` for the amended
Linux check script; Terraform 1.16.3 formatting/parsing; `git diff --check`.

Account remediation: the new atomicity tests first reproduced 11 failures out of
12 checks against the original implementation. After the fix, 94 account deletion,
reset, purge and queue checks passed. A final run of all 14 new checks passed after
adding actual `SET ROLE warthog_purge` coverage and compatible account-row locking.
Evidence: `/tmp/warthog-delete-atomic-red.log`, `/tmp/warthog-delete-green.log`, and
`/tmp/warthog-delete-atomic-final.log`. These use local synthetic PGlite, not an Azure
database. Reset completion already used a caller-owned transaction; its missing
post-commit release discard and unexchanged-code revocation were repaired. There
is no persistent unwrapped-DEK cache in the inspected composition roots. A SQL
rollback cannot recall provider requests already dispatched before deletion, and
historical backups remain subject to the documented restore/deletion controls.
Purge now takes the user lock before OAuth connection locks, matching deletion.
PostgreSQL requires UPDATE on at least one column for that row lock: migration
0099 grants the already account-deleting purge role UPDATE only on `wrapped_dek`,
not general user updates. Its regression explicitly rejects UPDATE on `email`.

Timestamp remediation: 110 existing focused loader/render/helper checks passed.
A separate integration check saves encrypted preferences for UTC, Sydney,
Los Angeles and an invalid value, then verifies six actual loaders and rendered
home/activity output across a date boundary. Reset notice rendering also checks
explicit UTC versus the signed-in account zone. The pure default/validator was
extracted without changing the existing Sydney fallback or shared UTC household
month. Logs: `/tmp/warthog-display-time-regression.log`,
`/tmp/warthog-display-time-views.log`, `/tmp/warthog-audit-final-focused.log`.
Native browser interaction remains a separate acceptance gate.
The final combined focused run passed 53/53 checks after the pure extraction and
purge lock/column-privilege correction, including reset render labels, the complete
14-case deletion/reset atomicity suite and account-zone fallback/member isolation.

Historical blocker (resolved by the follow-up above): `terraform init -backend=false -input=false` could not resolve
`registry.terraform.io`; `terraform validate` consequently cannot load either
provider. Logs: `/tmp/warthog-audit-terraform-init.log` and
`/tmp/warthog-audit-terraform-validate.log`. No state/backend/cloud plan opened.
Docker/real-PG execution and remote CI were not attempted again after the known
access restrictions. Final full-suite/build execution is coordinated by the root
agent after all review fixes to avoid generated-output races.

Source references: [delivery ADR](../adr/production-delivery-controls.md),
[foundation](../../infra/README.md), [singleton procedure](../singleton-release-runbook.md),
[local validation](../local-release-validation.md), and [current release handoff](../production-release.md).
