# Azure delivery

The founder authorized publishing this source and building CI/CD for
`Orlev01/warthog` on 10 November 2026. This supersedes the earlier publication
hold. It does not authorize Azure provisioning, credential creation, expenditure,
production deployment or DNS changes. The repository-wide
`AZURE_DELIVERY_ENABLED` variable starts as `false`; missing also means disabled.

## What runs

| Workflow | Trigger | Result |
| --- | --- | --- |
| `ci.yml` | Main pushes, pull requests, manual, reusable call | Delivery safety tests, Terraform schemas, clean Node 22/Linux/PG16 tests and build, non-root AMD64 runtime |
| `azure-foundation.yml` | Manual `plan` or `apply` on main | Private saved Terraform plan, then a separately approved apply of its exact SHA-256 |
| `azure-image.yml` | Manual on main | Full checks with a caller-reviewed immutable Node base, then build/push candidate to existing ACR and record registry digest |
| `azure-release.yml` | Manual `inspect`, `create` or `update` on main | First app creation or image-only update with an intentional maintenance outage |

All Azure workflows share a non-cancelling concurrency group. CI has no Azure
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

Before first activation, inspect the actual subscription's ARM `subscriptionPolicies`
and its billing-profile credit terms. A sponsorship-labelled quota, an active
credit grant or an available balance is not proof of an enabled spending limit.
Resolve any discrepancy between the offer, spending-limit status and cash-fallback
behavior before approving chargeable bootstrap resources. Keep account-specific
billing evidence and support correspondence in ignored private files, not this
public repository. [MCA credit behavior](https://learn.microsoft.com/en-us/azure/cost-management-billing/benefits/credits/mca-check-azure-credits-balance).

Keep the approved cash ceiling separate from `monthly_azure_budget_aud`, which
sets a usage notification budget. Cost Management costs exclude credits and taxes;
credits are applied at billing-profile invoice level. An available credit balance
can be shared with other subscriptions and does not prove current net cash cost.
Never copy a cash-after-credit ceiling into the usage budget and describe it as
cash protection. Azure offers no custom hard spending limit, and budget alerts or
delayed shutdown automation cannot guarantee one. The founder's cash target does
not authorize an overshoot. Resolve the control limitation before activation and
retain the exact resource, identity, credential and DNS review boundaries.
[Cost data limitations](https://learn.microsoft.com/en-us/azure/cost-management-billing/costs/understand-cost-mgt-data),
[spending limits](https://learn.microsoft.com/en-us/azure/cost-management-billing/manage/spending-limit).

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
No federated credential or role assignment has been created by this task.
Review custom roles/scopes against the actual plan, including role-assignment
permissions and budget scope; do not grant subscription Owner as a shortcut.

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
| Repository | `AZURE_DELIVERY_ENABLED=false` initially | None |
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

Provisioning/operating this runner requires its own resource and cost approval.
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
   [audit gates](audit/README.md). Separately approve the actual Azure quote,
   sponsorship-only funding protection, backend, identities, private runner and
   credentials. Budget notifications do not enforce a spending stop.
2. Configure the environment protections, OIDC identities and settings above.
   Verify the private artifact container is not public. Enable
   `AZURE_DELIVERY_ENABLED` only after those approvals, not simply to make a job green.
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

Local tests cover scope/approval guards, private plan integrity/age/input checks,
configuration drift, stopping before ownership checks, lingering replicas, held
locks and failed-start cleanup. Actionlint checks all workflow schemas. Azure CLI
operations, OIDC exchange, private networking, ARM deployment and actual release
behavior remain unexecuted until separately authorized. Generic command failures
intentionally omit raw stdout/stderr; investigate with an approved private client,
not verbose public Actions logs. Do not enable Terraform trace logging.

CLI references: [revision copy/list/deactivate](https://learn.microsoft.com/en-us/cli/azure/containerapp/revision?view=azure-cli-latest),
[replica inventory](https://learn.microsoft.com/en-us/cli/azure/containerapp/replica?view=azure-cli-latest),
[Blob Entra authentication](https://learn.microsoft.com/en-us/cli/azure/storage/blob?view=azure-cli-latest),
[Terraform ephemeral values](https://developer.hashicorp.com/terraform/language/manage-sensitive-data).
