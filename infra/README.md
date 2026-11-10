# Warthog Azure foundation — review before provisioning

The [Azure delivery pipeline](../docs/azure-delivery.md) now provides manual private
plan/apply workflows with separate environment approvals. They are disabled pending
approved setup and have not operated on Azure. The historical local-validation
notes below predate repository publication; the infrastructure boundaries still apply.

This is locally prepared infrastructure source, **not a deployment or spending
authorization**. No Azure resource or provider registration has been created by
this audit. The module intentionally stops before the application workload,
production secrets, HSM key creation, database login bootstrap and public DNS.
The separately reviewed [application workload template](workload/README.md) takes
the resulting environment/identity IDs and existing versioned secret URLs. It is
not applied by this Terraform root or by CI.

## Included foundation

- Dedicated Warthog subscription and tenant checks; Australia East only.
- Resource group, VNet, separate delegated ACA/PostgreSQL subnets and a private
  bootstrap subnet. PostgreSQL has no public endpoint. Its NSG permits port 5432
  only from the app, bootstrap and database subnets; private DNS links to this VNet.
- PostgreSQL 16 with a caller-selected General Purpose SKU, storage, zone and
  7–35 day backup retention. This draft has no HA/replica/geo backup and explicit Premium SSD v1 performance tier, with no automatic
  storage growth; those tradeoffs must be included in the actual resource approval.
- User-assigned identity, ACR Basic with admin authentication off, Premium Key Vault
  with RBAC, purge protection and 90-day soft deletion, and a private LRS receipt
  container. Blob shared-key authentication is off. Vault/blob network rules allow
  the app/bootstrap service-endpoint subnets, plus the documented trusted-service
  bypass; this is not a claim that those services have private endpoints.
- ACA workload-profile environment with only the Consumption profile. It has no
  app process yet. Azure Monitor routes console/system logs to a workspace with
  30-day retention and a required reviewed daily ingestion cap.
- Identity roles: ACR pull, receipt-container Blob Data Contributor, vault Secrets
  User and Crypto Service Encryption User. No identity gets subscription Owner.
- Subscription budget notifications at 50/80/100% actual and 100% forecast. The AUD
  amount and recipients are required inputs, not historical budget proposals.

External networking creates Azure-managed load balancer/IP dependencies. Do not
create duplicate manual load balancers. Registry, storage, database, logs and those
dependencies can keep charging while the app is stopped. Log caps/budget emails
do not stop spending or guarantee credit coverage. The founder requested a usage
alert at the calculated estimate; [A$440/month is now configured](../docs/azure-costs.md).
The [launch profile](profiles/launch.tfvars.example.json) includes the selected
sizing, 0.1 GB/day logs and import of that existing alert, with provisioning still
false. Its empty recipient list must be populated from the reviewed private
inputs. Do not duplicate the budget or silently change its expiry. Recheck
available credits and exact resource approvals before paid stages.

## Secrets and state

Terraform 1.16+ and the pinned providers are required. The PostgreSQL administrator
password is a `sensitive`, `ephemeral` input sent only to
`administrator_password_wo`. Increment the required password version only during
an explicitly approved rotation. Do not set the ordinary password field, create a
random-password resource, put credentials in tfvars/backend files, enable trace
logging, or publish Terraform plans/state. Never enable `LOG_SENSITIVE_DATA`.

AzAPI handles storage and Log Analytics ARM resources without `listKeys` calls.
They therefore do not materialize access/shared keys as AzureRM computed outputs.
ACA logging uses the Azure Monitor destination rather than a workspace shared key.
No Key Vault secret value, application connection string or OAuth credential is
managed by this foundation. Nonsecret identifiers are the only declared outputs.

Use an existing, specifically approved Azure Blob state backend with Entra
authentication (`use_azuread_auth=true`), encryption, restricted RBAC, locking and
retention. Backend establishment itself needs resource/cost approval; the module
does not bootstrap or select somebody else's state store. State still contains
operational identifiers and must remain private. Commit the generated provider
lockfile only after reviewing registry checksums for intended platforms.

## Safe local checks

These commands do not apply resources; `init -backend=false` downloads pinned
providers without opening a remote backend. They require registry network access.

```sh
terraform -chdir=infra fmt -check -recursive
terraform -chdir=infra init -backend=false -input=false
terraform -chdir=infra validate
```

On 10 November 2026, initialization with `-backend=false` and provider-schema
validation passed using Terraform 1.16.3, AzureRM 5.13.0 and AzAPI 2.13.0. The first
validation reproduced six errors in the draft: subnet service endpoints now need
`service_endpoint { service = ... }` blocks, and the private DNS VNet link needs
`private_dns_zone_id`. Those argument forms were corrected without changing the
intended endpoints or network boundaries. Versioned provider references:
[subnet schema](https://github.com/hashicorp/terraform-provider-azurerm/blob/v5.13.0/website/docs/r/subnet.html.markdown)
and [DNS link schema](https://github.com/hashicorp/terraform-provider-azurerm/blob/v5.13.0/website/docs/r/private_dns_zone_virtual_network_link.html.markdown).

The generated `.terraform.lock.hcl` records registry-verified provider checksums
for `darwin_arm64`, `linux_amd64` and `linux_arm64`. It remains local/uncommitted
with the rest of the release tree. No backend, credentials, Azure plan or resource
was opened or created. Actual account planning, ARM validation, funding and live
capacity remain **unverified**; local validation is not deployment certification.

Before a real plan: inspect the dedicated subscription, confirm resource-provider
registration/quota and actual AUD billing scope, verify funding/credit protection,
approve the exact resource names/CIDRs/SKU/zone/storage/log quota/budget recipients,
and approve secure credential handling. Neither provider auto-registers resources.
Set `provisioning_approved` only after that actual founder approval; the flag is not
a substitute for it. The launch profile supplies reviewed design values, but keeps approval false and
contains no passwords or recipient addresses. It is a proposal for the actual
resource plan, not permission to provision.
Ordinary CI never applies resources. Only the separately enabled, manually approved
foundation workflow can apply an exact reviewed saved plan.

## Required subsequent stages

1. Through an approved client in the private bootstrap subnet, create/review the
   RSA-HSM 3072 wrapping key and application secrets directly in Key Vault. Preserve
   old wrapping-key versions while any data or retained backup depends on them.
   Key Vault network/RBAC propagation and ACA secret-reference resolution need a
   real acceptance check. No broad public firewall workaround.
2. Run `db/bootstrap.psql` using the approved private PostgreSQL administrator
   connection, set the three role passwords privately, and store three URL-encoded
   `sslmode=verify-full` connection URLs in Key Vault. The administrator password
   is not an application credential. Remove the temporary client after validation.
3. Complete the separate [single-instance release procedure](../docs/singleton-release-runbook.md)
   with an approved immutable image and secret references. This module does not
   create an app with placeholder credentials or a temporary authentication domain.
4. Add operational alerts for app readiness/restarts/ownership loss, failed jobs,
   PostgreSQL CPU/storage/connections, log cap exhaustion and backup failures after
   exact alert costs/recipients are reviewed. Logs alone are not alert delivery.
5. Verify email/SMS/push/all six connector flows, browser passkeys, TLS, uploads and
   backup restoration. Bind the approved app hostname and add only specifically
   approved GoDaddy records after a fresh complete zone/conflict check.

## Recovery and rollback

`prevent_destroy` protects database, vault, receipt container/account and resource
group while these blocks remain in configuration. It is not a backup and does not
protect against portal deletion. PostgreSQL PITR retention does not back up Blob
contents or Key Vault keys. Before launch, define and test a coordinated restore
procedure, receipt/key retention and recovery objectives; retain deletion records
needed to avoid resurrecting accounts when restoring older database backups.

Clearing `wrapped_dek` in the live database does not remove its earlier copies from
PITR/backups while the shared Key Vault wrapping key still exists. Current purge
queue rows also disappear with the user, so a restored snapshot alone cannot prove
which users requested deletion afterwards. Before reopening a restored app, use
an approved retained deletion record independent of that snapshot to reconcile
post-restore-point deletions, revoke their access and remove their restored data.
That durable reconciliation process/evidence is not implemented or verified here;
its absence is a restore/launch gate. Do not describe current-row shredding as
irreversible erasure of every backup, or add a new retention store without review.

A schema migration may prevent rolling an older image back. Review compatibility
before release. Do not automatically downgrade migrations or restore a database
over new user writes. A restore uses a separately approved isolated server/client,
validates role boundaries/decryption/blob references and deletion handling, then
follows the same single-instance cutover. This can add temporary charges.

Provider references: [AzureRM 5.13.0](https://github.com/hashicorp/terraform-provider-azurerm/releases/tag/v5.13.0),
[AzAPI 2.13.0](https://github.com/Azure/terraform-provider-azapi/releases/tag/v2.13.0),
[write-only inputs](https://developer.hashicorp.com/terraform/language/manage-sensitive-data/write-only),
[Azure Monitor log routing](https://learn.microsoft.com/en-us/azure/container-apps/log-options).
