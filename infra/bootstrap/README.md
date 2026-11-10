# Delivery bootstrap

The founder approved this exact state/identity stage on 10 November 2026. It is
now applied and live settings are independently verified; a follow-up plan has no
changes. No application foundation or DNS was deployed. The source approval flag
still defaults false and is not authorization for new changes. Use only personal
Warthog credentials; no Eucalyptus credential is needed or permitted.

Azure creates `blobServices/default` with the account. The module configures that
existing child using `azapi_update_resource`; attempting another create failed
on the initial apply. The corrected remainder completed without replacing the
account or changing the approved scope. Private state and both plans are retained
under `.delivery/activation-2026-11-10/`, not published.

## Approved and completed changes

- Register only `Microsoft.Storage` and `Microsoft.ManagedIdentity` if still
  unregistered, after the stage approval. Providers do not auto-register them.
- Create `rg-warthog-delivery-aue`, Hot Standard LRS account `stwarthogtfauee854`,
  and private `tfstate` / `plans` containers in Australia East. Recheck global
  name availability; do not silently adopt an existing account or rename it.
- Use a **public HTTPS endpoint authenticated with Entra**, TLS 1.2+, no shared
  keys or anonymous blob access. This is deliberate for hosted GitHub foundation
  jobs and requires review; it is not private-endpoint networking.
- Enable versioning and 30-day blob/container soft deletion. Expire live plans,
  snapshots and prior plan versions after seven days (lifecycle execution is
  asynchronous; soft-deleted items can remain recoverable for 30 days). No
  lifecycle deletion applies to current or historical Terraform state.
- Create four user-assigned identities `id-warthog-{plan,apply,images,release}-aue`
  and four exact GitHub OIDC environment trusts using the immutable subject prefix
  in the source. Recheck the repository OIDC subject settings before applying.
- Grant the plan and apply identities **Storage Blob Data Contributor** only on
  those two containers, for four assignments total. Images/release receive no
  initial resource permissions. No Owner or broad subscription write grant.

The initial 1 GB plus 10,000 reads/writes/lists is about **A$0.19/month** before
versions, extra usage and tax, already within the [launch estimate](../../docs/azure-costs.md).
Storage remains billable if workflows stop. Nothing here creates the production
database/app, private runner, passwords, wrapping key, external DNS or providers
outside the two named namespaces.

## Validate and execute only after the exact approval

Offline checks need no Azure sign-in or backend:

```sh
terraform -chdir=infra/bootstrap fmt -check
terraform -chdir=infra/bootstrap init -backend=false -input=false
terraform -chdir=infra/bootstrap validate
```

For an approved execution, explicitly check the personal account's subscription
and tenant, current eligible credits, global account name, and OIDC subjects.
Use `umask 077` and an ignored `.delivery/` directory for state, lock files, plan
and input files. Initialize this local backend with its `path` pointing to that
private directory; never use a public CI artifact or repository-tracked state.
Supply both scoped IDs and `bootstrap_approved=true` only after the founder's
specific approval. Save and review a plan showing exactly this stage, then apply
that same plan. No import, deletion, unrelated role or replacement is expected.

The initial local state is a bootstrap exception: retain its protected backup.
Migration into the new remote account requires updating the backend type to
`azurerm`, a separate `bootstrap.tfstate` key, Entra authentication, and reviewed
operator data-plane access. This module does not grant the operator storage access
or perform migration automatically. Do not confuse `production.tfstate` (the
foundation output coordinates) with bootstrap state.

After creation, verify no anonymous/shared-key data access, container RBAC,
versioning, retention and all exact OIDC subjects. Fill the four GitHub environment
client IDs and private backend coordinates from the outputs. Keep
`AZURE_DELIVERY_ENABLED=false`: foundation control-plane roles, conditional role
delegation, production secrets, runner lifecycle and the saved foundation plan
still need their separate review. Bootstrap success alone is not release readiness.


## Execution evidence

On 10 November 2026, the approved stage completed after correcting the generated
blob-service handling. All 18 Terraform instances are recorded in protected local
state. Independent ARM reads verify storage configuration/retention, both private
containers, four exact trusts and only four container-scoped grants. Anonymous
container lists return HTTP409. A fresh plan exits0 with no changes. GitHub client
IDs and the private foundation backend settings are configured; no end-to-end
GitHub OIDC foundation run is claimed yet. Production delivery remains disabled.
