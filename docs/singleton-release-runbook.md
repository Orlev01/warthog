# Single-instance production release procedure

The [manual Azure pipeline](azure-delivery.md) automates this stop/wait/start
sequence after explicit setup and protected-environment approval. It is disabled
initially and has not been exercised against Azure. This runbook remains the
operator reference for approval, acceptance, configuration changes and recovery.

Prepared for later explicit deployment approval. No command here has been run
against Azure. This procedure deliberately includes downtime: pending plaintext
releases exist only in RAM, so routine rolling/blue-green updates are unsafe.
Min=max=1 applies to each revision, not all revisions combined. Azure single-mode
updates start a replacement before retiring the old process. See the
[revision lifecycle](https://learn.microsoft.com/en-us/azure/container-apps/revisions).

## 1. Review the exact release

Record source commit, reviewed diff, dependency lock hash, passing clean Linux/PG16
logs, approved base-image digest, final linux/amd64 image digest, non-root user,
runtime migration/catalogue manifest, and migration compatibility with rollback.
CI is source validation; the current development/PGlite boot test is not a test of
production credentials, production singleton ownership or Azure networking.

Approve the exact app resource, image digest, startup/health configuration, Key
Vault secret references, managed identity, expected cost and maintenance window.
Keep all previously settled domains/provider choices. Never print secret values or
full environment dumps. Stop if the running state differs from the reviewed plan.

The separate [workload template](../infra/workload/README.md) makes the proposed app
resource reviewable using required image/identity/environment/Key Vault references.
It is not included in the paid Terraform foundation or automatic CI deployment.

For the first app, configure manual **multiple revision mode**, target port 3000,
external HTTPS-only HTTP ingress, min=max=1, no extra scale rules and no sidecar
process that starts another copy of Warthog. Attach only its reviewed identity;
ACR pulls and Key Vault references use that identity. Set `AZURE_CLIENT_ID` to its
client ID for SDK calls. Use the complete production environment contract, with
secrets referenced from Key Vault and the approved hostname/RP from first sign-up.

Use HTTP startup and readiness probes on `/api/health`, and liveness on
`/api/health/live`, all on port 3000. A reasonable initial review configuration is
5-second timeout, readiness every 5 seconds with three failures, liveness every
10 seconds with three failures, and startup every 60 seconds with ten failures
(roughly ten minutes) for first-use migrations. The custom resource API declares a
maximum failure threshold of ten, despite larger platform defaults in the probe
guide; the template stays within that declared range. These are proposed timings,
to validate on the actual database. Do not rely on default TCP probes or change
the application validator to make an incomplete environment healthy.

## 2. Inventory and freeze concurrent deployments

Confirm the dedicated Warthog subscription ID and ensure no other release operator
or automation can update this app during the maintenance window. List **all**
revisions and each revision's replicas, not just the latest revision. Record the
current image digest and safe rollback revision. Do not copy secrets into the report.

Read-only CLI forms, after filling reviewed resource names:

```sh
az containerapp revision list --subscription e854f594-274f-4051-841b-78df7655d73c --resource-group "$WARTHOG_RESOURCE_GROUP" --name "$WARTHOG_APP" --query '[].{name:name,active:properties.active,health:properties.healthState}' -o json
az containerapp replica list --subscription e854f594-274f-4051-841b-78df7655d73c --resource-group "$WARTHOG_RESOURCE_GROUP" --name "$WARTHOG_APP" --revision "$WARTHOG_REVISION" --query '[].name' -o json
```

The Azure CLI must already be installed/authorized; this runbook does not silently
install extensions or create credentials. Use the portal equivalents if needed.

## 3. Stop, then prove the old process is gone

If an existing app uses single mode, review and change it to manual multiple mode
first; do not update its image yet. Deactivate every active old revision through
the portal's revision controls. This begins the approved maintenance outage.

Wait until every old revision is inactive and every old replica list is empty.
An accepted deactivate request, a 0% traffic weight or an unhealthy readiness
probe is insufficient evidence of process termination. Set a bounded maintenance
deadline; if termination cannot be established, stop and report rather than start
another process. Pending in-memory releases are discarded and must be requested
again; do not persist them as a workaround.

From the approved private PostgreSQL client, in one session, verify the ownership
lock is available using `SELECT pg_try_advisory_lock(1463898708, 1)`. It must return
true. Release it with `SELECT pg_advisory_unlock(1463898708, 1)` and close that
session before starting the app. If it returns false, identify the surviving
owner; do not kill arbitrary database sessions or change the ownership key.

## 4. Start exactly one approved revision

Only after both platform and database evidence above, create/activate the new
revision using its approved immutable image digest, environment and secret
references. Keep all other revisions inactive. Startup acquires database ownership;
readiness applies/checks migrations through the separate migration login.

Wait for HTTP readiness 200, then route 100% of app traffic to that revision.
When using the workload template, the approved new explicit revision target is
configured during the start step and can serve as soon as healthy; verify that
target after readiness instead of routing to an inactive prior revision. Do not
assume the template supplies a separate manual traffic hold after startup.
Confirm exactly one running replica across all revisions, ownership is held by
the app, the expected digest is running, and scheduler startup is visible with no
repeated ownership/migration errors. Do not activate old revisions alongside it.

## 5. Verify and decide

Use synthetic data to verify production hostname TLS, signup/passkey/TOTP/session,
browser vault unlock/approval/release collection, all six connector workflows,
email/SMS/push, private receipt upload/download, and a near-25-MiB upload through
the actual ingress. Record the encoded request-body size including framing. The
26-MiB application envelope is not documented proof of Azure ingress capacity;
the [workload notes](../infra/workload/README.md#request-body-size-still-requires-ingress-acceptance)
record the unresolved ceiling and required boundary checks. Check redacted logs
and confirmed delivery, not only API 2xx.
Record migration names, replica evidence, acceptance results, cost/alert settings
and any unresolved gates without exposing sensitive values.

If readiness or acceptance fails, deactivate the failed revision and repeat the
zero-replica/lock-available checks. Reactivate the old digest only if its schema
compatibility was reviewed. Otherwise retain the outage and fix forward or use
the separately approved restore procedure. Do not automate rollback by activating
an old revision while the failed process still exists.

Before reopening traffic after any database restore, reconcile deletion requests
made after the restore point using approved evidence independent of that snapshot.
Revoke restored credentials and sessions and reapply those deletions first. Earlier
backups can contain wrapped data keys still decryptable through the shared wrapping
key; current-row key removal is not backup erasure. The purge queue is not a durable
deletion journal once its user has been purged. A retained reconciliation process is
still unimplemented/unverified here; without it, do not claim a safe production
restore or reopen access to restored accounts. No new retention store is provisioned.

## Evidence still required

The stop/wait/start sequence, final-image production boot, lock loss termination,
startup migration timing and real ingress have not been exercised here. This
runbook makes the procedure reviewable; it does not certify Azure deployment.
The [Azure revision CLI](https://learn.microsoft.com/en-us/cli/azure/containerapp/revision?view=azure-cli-latest),
[replica listing](https://learn.microsoft.com/en-us/cli/azure/containerapp/replica?view=azure-cli-latest)
and [HTTP probe documentation](https://learn.microsoft.com/en-us/azure/container-apps/health-probes)
were checked on 9 November 2026.
