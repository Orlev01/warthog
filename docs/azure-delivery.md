# Azure delivery

**10 November setup:** the approved foundation, scoped permissions, private
database and versioned credentials are applied and verified. See the
[current setup record](delivery-setup-2026-11-10.md),
[access module](../infra/access/README.md), [runner procedure](../infra/runner/README.md)
and current [state](../state.md). This supersedes the older setup-approval holds
below for those named tasks; app release reviews, provider purchases/messages and
public DNS restrictions remain; internal database DNS was explicitly allowed.
A separate main-only cleanup environment has no human
review gate because it only removes expired runner leases. The original four
delivery review gates are unchanged.

The founder authorized publishing this source and building CI/CD for
`Orlev01/warthog` on 10 November 2026. This supersedes the earlier publication
hold. Later explicit authorizations covered the cost profile, budget, bootstrap
and delivery setup described above. Application release reviews, provider purchases
and exact public DNS changes remain separate. Foundation and image workflows now have independent enabled switches, so completed
setup can be used for their manual, reviewed operations. The application switch
`AZURE_DELIVERY_ENABLED` is now `true` after the separately approved
[first release](first-app-release-2026-11-10.md). Every later release remains manual
and requires its own reviewed image/workload and environment approval. Missing
switches mean disabled.

## What runs

| Workflow | Trigger | Result |
| --- | --- | --- |
| `ci.yml` | Main pushes, pull requests, manual, reusable call | Delivery safety tests, Terraform schemas, clean Node 22/Linux/PG16 tests and build, non-root AMD64 runtime |
| `azure-foundation.yml` | Manual `plan` or `apply` on main | Private saved Terraform plan, then a separately approved apply of its exact SHA-256 |
| `azure-image.yml` | Manual on main | Full checks with a caller-reviewed immutable Node base, then build/push candidate to existing ACR and record registry digest |
| `azure-release.yml` | Manual `inspect`, `create` or `update` on main | First app creation or image-only update with an intentional maintenance outage |
| `azure-runner-cleanup.yml` | Hourly and manual on main | Independently remove expired private runner leases; no app/secret/provisioning permission |

Foundation, image and application workflows share a non-cancelling concurrency
group. Cleanup uses its own group and the shared private-runner lease. CI has no Azure
identity or production secrets. Publishing an image does not deploy it. No workflow
performs DNS changes, creates application credentials, upgrades messaging plans,
registers Azure providers, provisions a runner/backend, or automatically rolls back.
There is no automatic cloud deployment after a push or PR merge.

The Linux suite is divided with Node's built-in `--test-shard` across four standard
Ubuntu jobs, and all four must pass. Each gets its own disposable PostgreSQL
container and performs the real database checks. Local validation defaults to the
complete unsharded suite. This avoids the much slower hosted database tests pushing
one monolithic job towards its timeout; it does not skip tests or use larger paid
runners. [Standard public-repository runner billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions).

## GitHub protection and Azure identity setup

Create the four environments below with `Orlev01` as required reviewer, a selected
**branch** policy for `main` only (not a tag), and administrator bypass disabled.
Self-review is permitted because the founder may both dispatch and separately
approve a release. The approval click is still required. Do not remove this gate
or automatically approve waiting jobs. Environment creation alone creates no cloud
identity, resources or credentials.

Inspect eligible billing-profile credit availability before further paid stages.
The founder selected estimate-based usage alerts after reviewing the lack of a
custom cash cap; do not reopen that superseded decision. Keep account-specific
billing evidence and support correspondence in ignored private files.
[MCA credit behavior](https://learn.microsoft.com/en-us/azure/cost-management-billing/benefits/credits/mca-check-azure-credits-balance).

The founder subsequently requested cost-focused production infrastructure and an
alert at the calculated usage estimate. The [cost review](azure-costs.md) documents
the selected launch profile and the A$440 monthly budget now created in Azure.
This resolves the earlier choice between a custom cash cap and usage monitoring;
do not reopen that question. `monthly_azure_budget_aud` measures gross Azure usage
before credits and tax. Credits apply at billing-profile invoice level, and the
shared balance can lag. Recheck eligible credit availability before paid stages.
Alerts do not enforce a spending cap or authorize unreviewed resources.

The launch profile sets `import_existing_budget=true` and matches the existing
budget's dates. The foundation plan must adopt that exact budget rather than
create a duplicate. Supply its existing founder recipient privately. Verify the
imported amount, expiry and notifications in the saved plan before applying it.

The separate [bootstrap module](../infra/bootstrap/README.md) was explicitly
approved and applied on 10 November 2026. State storage/plan retention, four exact
GitHub OIDC identities and four container-scoped state grants are verified. Their
client IDs and foundation backend coordinates are configured in GitHub. The
source keeps `bootstrap_approved=false` by default; do not create a duplicate
bootstrap. Production resources and scoped permissions were added in the later
authorized setup; do not recreate either stage.

Each environment needs a separately approved Entra application/service principal
or user-assigned identity and federated credential. Use OIDC, not an Azure client
secret or the personal GitHub token. The personal token is only for authorized
repository publication and configuration; never store it in this repository or
Actions secrets. Keep Eucalyptus accounts and identities out of this delivery flow.

The repository API reports immutable subjects enabled with prefix
`repo:Orlev01@180486014/warthog@1451921931`. For the default subject policy, use:

| Environment | Exact expected OIDC subject suffix | Access to approve |
| --- | --- | --- |
| `azure-foundation-plan` | `:environment:azure-foundation-plan` | Foundation resource reads, state locking/read and private plan-container writes |
| `azure-foundation-apply` | `:environment:azure-foundation-apply` | Exact foundation resource writes, narrowly scoped role-assignment rights, state/plan access and subscription-budget rights |
| `azure-images` | `:environment:azure-images` | ACR push/pull on the dedicated registry; no app or infrastructure writes |
| `azure-production` | `:environment:azure-production` | App/revision/traffic and resource-group deployment rights, identity assignment for first creation, ACR pull; no secret-value listing, DNS or foundation writes |

The full subject is the prefix plus the table suffix. Issuer:
`https://token.actions.githubusercontent.com`; audience:
`api://AzureADTokenExchange`. Recheck the repository OIDC API and claims before
creating trust; do not assume the older name-only `repo:Orlev01/warthog` subject.
The four federated credentials, bootstrap grants and scoped permissions in the
table are configured. The access module constrains assignment writes to the app
principal and four approved data roles, and scopes budget rights to the existing
budget. Independent ARM checks verify these grants; app secret/key access is
additionally tested live. A future permission change still needs review against
its actual plan; do not grant subscription Owner as a shortcut.

All workflows pin subscription `e854f594-274f-4051-841b-78df7655d73c` and tenant
`72277873-e056-4612-9b1c-7ad58e02fcf3`, and check the logged-in account again before
operating. Do not replace them with Eucalyptus scopes.

References: [GitHub Azure OIDC](https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-in-azure),
[immutable OIDC subjects](https://docs.github.com/en/actions/reference/security/oidc),
[environment protection](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments).

## Required settings

Environment variables are identifiers, never passwords. Secrets below are existing
approved values supplied privately; their names in workflow source do not authorize
creation or rotation. Populated parameters and backend/state/plans stay untracked.

| Scope | Variables | Secrets |
| --- | --- | --- |
| Repository | `AZURE_FOUNDATION_ENABLED=true`, `AZURE_IMAGE_ENABLED=true`; `AZURE_DELIVERY_ENABLED=true` for manual reviewed app releases; separate `AZURE_RUNNER_CLEANUP_ENABLED=true` | None |
| Both foundation environments | Their own `AZURE_CLIENT_ID`, `PLAN_STORAGE_ACCOUNT`, `PLAN_CONTAINER` | Identical `FOUNDATION_TFVARS_JSON`, `FOUNDATION_BACKEND_JSON`, approved `POSTGRES_ADMIN_PASSWORD` |
| `azure-images` | `AZURE_CLIENT_ID`, `ACR_NAME` | None |
| `azure-production` | `AZURE_CLIENT_ID`, `ACR_NAME`, `RESOURCE_GROUP`, `APP_NAME`, `POSTGRES_FQDN` | `WORKLOAD_PARAMETERS_JSON` for first creation; `OWNERSHIP_DATABASE_URL` for the approved private ownership-check connection |

`FOUNDATION_TFVARS_JSON` is a JSON object matching every required input in
`infra/variables.tf` except `postgres_admin_password`. It contains the explicitly
reviewed names/CIDRs/SKU/storage/retention/zone/log allowance/budget/recipients and
`provisioning_approved=true` only after actual approval. Never place a password in
it. The password uses an ephemeral Terraform input and write-only provider field.

`FOUNDATION_BACKEND_JSON` has exactly four string keys: `resource_group_name`,
`storage_account_name`, `container_name`, and `key`. The pipeline adds Entra/OIDC
authentication and the fixed Warthog tenant/subscription. Use an existing approved,
private encrypted backend with locking and retention. The private plan container
also needs approved RBAC, network access and retention. Hosted foundation runners
must have approved access to those endpoints; do not open firewalls to work around
a failed run. If a private-only backend is required, review a dedicated trusted
runner for these two jobs before enabling them. This pipeline bootstraps neither.

`WORKLOAD_PARAMETERS_JSON` follows `infra/workload/parameters.example.json` and
contains only nonsecret settings and **versioned Key Vault URLs**. The approved
image/suffix/traffic and observed stop evidence are supplied by the release script.
First creation requires an empty custom-domain array. `deploymentApproved` must
already be true after actual workload/cost approval. The development examples are
deliberately invalid production inputs.

The founder-approved first launch sets `smsEnabled=false`. Its runtime receives
`SMS_ENABLED=false` and nine core secret references; omit every Twilio secret URL,
region, route and SMS limit. The guard rejects extra SMS fields in this mode.
Email, push and connector readiness remain mandatory. SMS activation is a later
reviewed configuration release with provider registration, pricing and acceptance;
the image-only update workflow cannot silently turn it on.

`OWNERSHIP_DATABASE_URL` must connect to the same private `warthog` database as the
application, match `POSTGRES_FQDN` from the approved foundation, and use
`sslmode=verify-full`. Use the approved least-privilege login with advisory-lock
access, not an administrator credential. It is passed to libpq via the child
environment as explicit `PGHOST`/`PGDATABASE`/`PGUSER`/`PGPASSWORD`/TLS fields,
never command-line arguments or logs. URL-encoded credentials are decoded once.
Its private client needs the reviewed CA trust and DNS/network path. The supported
URL query options are `sslmode=verify-full` and optional `sslrootcert`; put the
approved CA at libpq's default root-certificate location or supply that file path.
Ambient PostgreSQL service/host settings are discarded.

## Private deployment runner

`azure-production` requires a dedicated, ephemeral Linux x64 runner labelled
`warthog-production` in the approved bootstrap subnet. It needs Python 3, Docker,
Git, a current GitHub runner supporting Node 24 actions, the Azure CLI with
Container Apps commands already installed, PostgreSQL 16
`psql`, and the required root CA trust. Dynamic Azure extension installation is
disabled. Test these tools and the private database path before approving a job.
Do not reuse a shared Eucalyptus runner or a persistent personal workstation.

Use the approved runner profile within the reviewed release. Changes to its size,
networking or lease allowance need their own resource/cost review.
The public repository is configured to require maintainer approval for **all
external contributors' fork workflow runs**, not just first-time contributors.
Review every fork's workflow changes before approval; never approve a fork job
requesting a private runner. Provision a fresh single-job runner only for the
approved production run, with external teardown after success, failure or timeout.
Where runner-group workflow restrictions are available, allow only this workflow
on trusted main; labels alone are not an access-control boundary. Public PR checks
run only on disposable GitHub-hosted runners. Do not attach
an ambient privileged Azure identity, reusable GitHub PAT, application credentials,
or user data to the runner. Destroy it after each job, including failure/cancellation;
the workflow's temporary files and Docker config are additionally cleaned normally.

## Release sequence

1. Pass the push CI on the intended main commit. Review its source and the still-open
   [audit gates](audit/README.md). Reuse the already-approved setup, recheck eligible
   credits and approve the exact image/workload and maintenance window. Review
   any changed resources or costs separately. Budget notifications do not stop spending.
2. Configure the environment protections, OIDC identities and settings above.
   Verify the private artifact container is not public. Foundation and image
   switches permit their separately reviewed manual jobs. Enable the application
   `AZURE_DELIVERY_ENABLED` switch only after its inputs and release approvals are ready.
3. Dispatch foundation `plan` with the approval reference and approve the plan
   environment. It records only a plan ID, SHA-256 and change count in public logs.
   Privately review `foundation/<run-id>-<attempt>/review.txt`, `manifest.json`, and
   `plan.tfplan` in the approved container. No plan/state is uploaded to GitHub
   artifacts. Deletions/replacements are rejected and need a separate migration.
4. Dispatch foundation `apply` from the **same main commit**, supplying that plan ID
   and SHA-256, then approve the separate apply environment. Inputs/backend/lockfile
   must be unchanged and the plan no older than 24 hours. Terraform applies the
   saved plan with state locking; it does not silently re-plan. Review resulting
   `foundation.json` privately. A later failed run is not permission to force-unlock
   state, recreate resources, or retry changed parameters without review.
5. Complete the separately approved private database bootstrap, wrapping key,
   versioned Key Vault secrets and provider setup in the existing runbooks. No
   pipeline creates placeholders or opens the database publicly.
6. Review OS-image advisories and the exact official Node base digest. Dispatch
   image publication with `node:22-bookworm-slim@sha256:<64-hex-digest>`. The reusable
   CI runs against that same base; only after it passes and the image environment
   is approved can the job publish a candidate. Record the returned
   `<registry>.azurecr.io/warthog@sha256:<digest>`, source SHA and lock/runtime evidence.
   A new candidate does not resolve the existing OS advisory applicability gate.
7. For an existing app, dispatch release `inspect`. Review its live settings and
   record the resulting configuration SHA-256. Review migration compatibility,
   pending in-memory release loss and the maintenance outage. Freeze other portal
   operators and automation; GitHub concurrency does not lock out external actors.
8. Dispatch `create` for the first app or `update` with the reviewed config hash,
   exact candidate digest and approval reference. Approve `azure-production` only
   for that exact run. The candidate must have been built from this main commit.
   Wait for the hosted `gate` job to pass before provisioning its private runner.
   Approval references are 3–200 characters: letters, digits, spaces and
   `. _ : / -` only. A rejected reference does not justify creating a runner.
   The script deactivates all old revisions, waits for **all** replicas to vanish,
   checks/releases the private ownership lock, rechecks configuration, and only
   then starts the new revision. Existing apps use an image-only revision copy;
   environment, secret references, identities and custom domains are preserved.
9. Verify one healthy replica, the expected image, held ownership lock, explicit
   100% traffic and HTTPS health. Finish the production hostname/provider/browser/
   upload/restore acceptance in the [singleton runbook](singleton-release-runbook.md).
   First creation does not create or bind a custom domain. Approve any exact DNS
   changes separately after preserving all existing GoDaddy records/apex behavior.

For app configuration/secret rotations or a changed resource size, use a separate
reviewed maintenance change. The image-update workflow deliberately cannot apply
arbitrary ARM configuration over an existing app. Its first-create template still
covers the initial complete runtime environment. Terraform handles later foundation
changes through new reviewed saved plans.

## Failure behavior and validation limits

A startup/readiness failure deactivates only the attempted new revision, checks
termination and retains the outage. It never activates the old revision. Review
schema compatibility and repeat zero-replica/lock checks before any manual rollback.
If termination cannot be proved, or a runner is killed/cancelled mid-command, stop
and follow the singleton runbook; never infer termination from the workflow status.
All Azure workflows disable cancellation by a newer run, but manual cancellation
and infrastructure failures still require operator recovery.

Azure may serialize secret-backed environment entries with `value: ""` after a
revision copy. Configuration comparison normalizes only that empty field when
`secretRef` is nonempty; all substantive settings remain protected. The
[10 November release record](audit/acceptance-fixes-release-2026-11-10.md) records
the initial false-positive stop, regression fix and verified operator continuation.
A failed workflow remains failed even when its reviewed candidate is later
recovered by an operator.

Local tests cover scope/approval guards, private plan integrity/age/input checks,
configuration drift, stopping before ownership checks, lingering replicas, held
locks and failed-start cleanup. Actionlint checks all workflow schemas. Azure CLI
operations, cleanup OIDC exchange, private database networking and foundation
ARM changes are now verified as recorded in the setup report. The first
application creation has succeeded with singleton/ownership/HTTPS checks and runner
cleanup; browser/provider/upload/restore acceptance remains pending. Generic command failures
intentionally omit raw stdout/stderr; investigate with an approved private client,
not verbose public Actions logs. Do not enable Terraform trace logging.

CLI references: [revision copy/list/deactivate](https://learn.microsoft.com/en-us/cli/azure/containerapp/revision?view=azure-cli-latest),
[replica inventory](https://learn.microsoft.com/en-us/cli/azure/containerapp/replica?view=azure-cli-latest),
[Blob Entra authentication](https://learn.microsoft.com/en-us/cli/azure/storage/blob?view=azure-cli-latest),
[Terraform ephemeral values](https://developer.hashicorp.com/terraform/language/manage-sensitive-data).
