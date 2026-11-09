# Production delivery controls

**10 November 2026 amendment:** the founder authorized publishing all Warthog source
to `Orlev01/warthog` with the personal account and building Azure CI/CD. The new
[delivery workflows](../azure-delivery.md) add separate manual, protected-environment
steps for private Terraform plan/apply, ACR publication and singleton app releases.
Automatic cloud deployment remains disabled. Existing funding, credential,
production and DNS approvals remain required. The historical source-only decision
below describes the original audit authorization, not the current publication scope.

Accepted for local implementation during the founder-requested engineering audit,
9 November 2026. This authorizes source preparation only; publication, credentials,
paid infrastructure, deployment and exact DNS changes retain their separate gates.

## Problem and decision

The release had a Dockerfile and a disposable PostgreSQL check but no CI workflow
or infrastructure source, while the original design claimed `infra/` existed.
Manual portal setup alone cannot reliably preserve the private database, identity,
probe and single-instance contract across later changes.

Add a read-only-permission GitHub Actions workflow that checks the clean Node 22
Linux build, full test suite, TypeScript, runtime assets and PostgreSQL 16 bootstrap,
roles, migrations, ownership and concurrent household budget behavior. Reuse the
same disposable Compose harness as local verification. Build the separate non-root
runtime image and record its ID/platform and source revision. The workflow has no
cloud login, publishing, deployment or secrets. Pin actions to reviewed commits and
prepare dependency-update proposals without automatic merging. CI runner billing
and repository publication must be reviewed before enabling it.

Use Terraform for the Azure foundation only. Require a reviewed plan and explicit
resource configuration; do not encode a guessed spend envelope. Keep database
passwords in Terraform ephemeral inputs and provider write-only arguments, and
avoid resource schemas that write generated storage/workspace keys to state.
Application secret contents and database login bootstrap stay outside Terraform.
Protect state as sensitive operational metadata despite excluding secret values.

The application remains a single Node process. Azure single-revision mode starts
the replacement before stopping the old revision; it is not a stop-before-start
guarantee. Keep the database ownership lock and a deliberate maintenance-window
stop/wait/start rollout. Do not add automatic production CD or imply zero downtime.
The foundation contains no application workload or public DNS mutation; the release
runbook owns the later approved workload transition.

## Superseded architecture assumptions

The current production decisions are recorded in `../production-release.md` and
the messaging/identity ADRs. They supersede the original design's ACS setup,
Australia-only data processing, parent-domain passkey RP, public database firewall,
B1ms production default, and purported automatic spending stop. Terraform and a
budget alert cannot themselves guarantee Azure credit-only billing. The spending
guard remains an external provisioning gate until an enforceable policy is agreed.

## Validation and limits

Validate YAML, Compose, script syntax and Terraform/provider schemas locally where
available. Only a real CI run and Docker/PostgreSQL execution can establish that
the workflow passes; static checks are not substitutes. Final-image production
boot/TLS, singleton replacement, provider delivery, browser acceptance, backup
restoration and post-provisioning health remain separate evidence requirements.

Sources checked 9 November 2026: [Azure revision lifecycle](https://learn.microsoft.com/en-us/azure/container-apps/revisions),
[probe behavior](https://learn.microsoft.com/en-us/azure/container-apps/health-probes),
[GitHub Actions security](https://docs.github.com/en/actions/reference/security/secure-use),
[Terraform write-only arguments](https://developer.hashicorp.com/terraform/language/manage-sensitive-data/write-only),
[AzureRM PostgreSQL write-only password](https://github.com/hashicorp/terraform-provider-azurerm/blob/v4.39.0/website/docs/r/postgresql_flexible_server.html.markdown).
