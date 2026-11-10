# Launch infrastructure and cost

10 November 2026. The founder requested production-quality hosting with a cost
mindset, retaining premium features where they add value, using available Azure
credits, and creating a usage alert at the calculated expected monthly cost.
This replaces the prior hold on choosing between a cash cap and usage alerts.
Exact resource creation, credentials, role grants, deployment and DNS retain
their existing review boundaries.

## Decision

Use the small [launch profile](../../infra/profiles/launch.tfvars.example.json).
Most of the foundation was already on economical tiers. Do not invent savings
by removing security controls or claiming a running workload has been downsized:
no Warthog foundation has been provisioned yet.

| Component | Launch choice | Reason and upgrade trigger |
| --- | --- | --- |
| PostgreSQL 16 | General Purpose D2ads_v5, 2 vCPU / 8 GiB; 32 GiB Premium SSD v1 P4; 7-day PITR; no HA/read replica/geo backup | Predictable database CPU for auth, encrypted records and job coordination. Microsoft advises against Burstable for production; a cash saving here adds throttling risk. Raise compute on sustained CPU/latency/connection pressure. Raise storage before 70% utilization; P4 has only 120 provisioned IOPS, so measure I/O latency and increase its performance tier if required. |
| Container App | Consumption, 0.5 vCPU / 1 GiB, one continuously running instance | Scheduler and in-memory authentication flows need a live process. No dedicated profile, premium ingress, GPU or scale-to-zero. Raise resources after measured memory/CPU pressure. Scale-out needs application state/fencing work first. |
| Key Vault | Premium vault, RSA-HSM 3072 wrapping key | Small per-version cost preserves hardware key protection for sensitive personal data. This is the multi-tenant vault, not a dedicated Managed HSM pool. Count old active key versions; retain every version still needed for data/backups. |
| Registry and blobs | ACR Basic; Hot Standard LRS blobs with existing Entra/RBAC/network restrictions | No Premium registry, geo replication, private endpoint service or Premium blob tier without demonstrated need. Review retained images before exceeding Basic's 10 GiB inclusion; never delete a needed rollback digest. |
| Logs | Analytics, 30 days, initial 0.1 GB/day ingestion cap | Small launch allowance without longer paid retention. A cap can be exceeded and can interrupt diagnostics; alert on approaching it and revisit after real usage. Keep security/audit data requirements independent of this diagnostic-log cap. |
| Networking | Existing private PostgreSQL VNet; ACA-managed load balancer and two public IPs | Required network isolation retained. Do not add a second load balancer, NAT for the app, Firewall, Bastion, Front Door or Private DNS Resolver by default. |
| Deployment runner | Short-lived Linux B2als_v2 VM, private subnet, temporary NAT egress, no inbound public IP | Existing release code needs Docker. ACA Jobs cannot run Docker. Delete the runner's disk/NIC/NAT/IP after use; guest shutdown alone keeps charging. The runner lifecycle implementation and acceptance remain required before release. |

The infrastructure now pins PostgreSQL storage type and exposes its performance
tier explicitly; the profile selects the smallest disk/tier. Cost data and
calculator are checked in. Terraform can adopt the separately created alert with
an import block, preserving its expiry instead of trying to create a duplicate.
The profile intentionally keeps `provisioning_approved=false`, omits passwords
and has no notification recipients. Populate reviewed private inputs only after
the exact resource/identity approval; this example is not deploy authorization.

## Expected cost and alert

The [reproducible estimate](../azure-costs.md) is **A$430.66 per average month**,
or **A$438.13 for a 31-day month**, before credits and tax. It assumes the app is
active continuously and takes no shared free grants. Use a **A$440 monthly Azure
usage alert**, with actual 50/80/100% and forecast 100% thresholds. This follows
the founder's instruction to alert at the estimated cost. It is not a shutdown
mechanism or cash-after-credit cap.

Do not buy reserved capacity or savings plans at this stage. Those commitments
can be excluded from sponsorship credits and reduce flexibility before real load
is measured. Confirm current eligible credit balance and scope before each paid
stage; do not repeat the superseded request to approve a custom cash cap.

## Availability and readiness

This is a sensible small production baseline, not a high-availability design or
a completed production certification. A single database and app have maintenance
and failure downtime. Add zone-redundant database HA when the required recovery
time or business impact justifies a second server. Database compute can scale;
shrinking a provisioned database disk is destructive and is not an optimization.

Keep existing release gates: immutable image review, private database/Key Vault
bootstrap, operational alerts, browser/provider/ingress acceptance, singleton
replacement, and a tested coordinated restore with deletion reconciliation. A
backup checkbox alone does not meet those recovery requirements. Do not enable
paid workflows or mark production ready based only on this cost refactor.

References: [PostgreSQL compute](https://learn.microsoft.com/en-us/azure/postgresql/compute-storage/concepts-compute),
[PostgreSQL storage schema](https://github.com/hashicorp/terraform-provider-azurerm/blob/v5.13.0/website/docs/r/postgresql_flexible_server.html.markdown),
[Key Vault pricing](https://azure.microsoft.com/en-us/pricing/details/key-vault/),
[ACA managed networking](https://learn.microsoft.com/en-us/azure/container-apps/custom-virtual-networks#managed-resources),
[log caps](https://learn.microsoft.com/en-us/azure/azure-monitor/logs/daily-cap).
