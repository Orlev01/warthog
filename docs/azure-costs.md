# Azure launch cost

The selected launch profile costs approximately **A$430.78/month**, or
**A$438.25 for a 31-day month**, before credits and tax. The founder authorized an
alert at the expected cost; **A$440/month** rounds the longer-month estimate up
to the next A$10. The subscription budget was created and independently read
back on 10 November 2026: actual 50/80/100% and forecast 100%, founder email,
1 November 2026–31 October 2027. It measures gross usage and does not stop spending.

These are launch planning allowances, not a fixed-price quote or a measured
production bill. Microsoft can change rates and currency conversion. Credits
apply separately at billing-profile level; current private credit evidence is
kept out of this repository. Do not assume credits cover support, Marketplace,
external providers or commitments. The budget's scheduled expiry needs review
before 31 October 2027; no recurring automation has been created.

## Calculation

Australia East retail rates observed 10 November 2026; 730 compute hours, one
0.5 vCPU / 1 GiB app assumed active all month. No ACA, log or bandwidth free grants
are subtracted because they can be shared or unavailable. If the app qualifies
for idle billing 75% of the month, the same model is about **A$388.76**. Frequent
background scheduling can keep it active, so the alert uses full active usage.

| Component | AUD/month |
| --- | ---: |
| PostgreSQL compute | 253.14 |
| PostgreSQL 32 GiB disk | 6.28 |
| PostgreSQL extra backup allowance | 2.16 |
| Container App compute and requests | 79.00 |
| ACA managed load balancer and two public IPs | 36.67 |
| ACR Basic | 7.20 |
| Premium Key Vault: two active HSM versions and operations | 16.39 |
| Logs at daily allowance | 14.44 |
| Receipt/state blobs and operations | 1.24 |
| Private DNS zone and queries | 1.28 |
| Internet and inter-zone transfer allowance | 3.41 |
| Ephemeral private VM runner, NAT, IP and disk | 4.59 |
| Operational alert allowance (not yet metered) | 5.00 |
| **Total** | **430.78** |


## What the allowances include

- PostgreSQL D2ads_v5 compute, 32 GiB disk, and 16 GiB paid backup storage beyond
  the included backup allowance. Seven-day PITR WAL churn can raise that quantity.
- ACA compute plus one million requests; its VNet-managed Standard load balancer,
  two public IPs and 50 GB processed data. No dedicated-profile management fee,
  private-endpoint feature or planned-maintenance feature is selected.
- Two active RSA-HSM 3072 key versions, 100,000 advanced key operations and 10,000
  secret operations. Basic registry images remain within its included 10 GiB.
- 0.1 GB logs/day, 30-day retention; 11 GB combined receipts/state/retained versions;
  100,000 writes, 100,000 reads and 10,000 list operations. The log cap is delayed
  and can be exceeded; storage and request counts are assumptions, not quotas.
- One private DNS zone and one million queries; 20 GB billable internet egress
  and 20 GB same-region inter-zone transfer at no charge, per current Azure
  policy. No shared free grants are assumed. Existing public DNS remains with GoDaddy.
- Four deployments at up to four VM hours each: 16 Linux B2s compute hours,
  24 rounded-up NAT/IP/disk hours allowing setup/teardown, 20 GB NAT data and a
  small disk-operations allowance. This requires deleting VM/disk/NIC/NAT/IP after
  the job. It does not price an always-on runner. A forgotten NAT alone adds about
  A$47/month, plus its IP; the reviewed runner lifecycle is a release prerequisite.
- A$5 reserved for operational alert charges. Their exact metric/query selection
  is not deployed yet; replace the allowance with actual rules before launch.

The Azure-only total excludes GST, external SMS/email/domain fees, AI/provider
API charges, existing account support plans, and temporary restore/load-test or
migration environments. Twilio's separately approved A$20/month target and
Resend Free remain separate; the complete SMS quote is unresolved. No paid
subscription commitments, redundant region, always-on staging environment,
Front Door/WAF, Bastion, Firewall or dedicated HSM pool are included.

## Reproduce or revise

```sh
python3 infra/costs/estimate.py --check-profile
python3 infra/costs/estimate.py --hours 744 --json
python3 infra/costs/estimate.py --active-fraction 0.25
```

[launch-model.json](../infra/costs/launch-model.json) contains public meter IDs,
prices, dates, units and assumptions. Small ACA AUD rates are rounded by the
retail API; the calculator uses the Australia East USD rates converted with the
same day's retail AUD/USD factor (1.421161), not a zero price or a generic US
region's rate. That conversion is a pricing reference, not guaranteed invoice FX.

Update the profile, meter evidence and model together when changing resource
size, retention, workload counts or networking. CI checks the arithmetic and
profile agreement. Do not automatically raise a budget in response to an alert;
first inspect its service breakdown and investigate unplanned usage.

## Infrastructure choices and readiness

[Architecture decision](adr/launch-infrastructure-cost.md) explains the retained
General Purpose database and Premium Key Vault, and the later scale/HA triggers.
The launch profile is reviewable source with provisioning disabled. Import the
existing budget via `import_existing_budget=true` using the exact dates and
recipients already configured; do not create a second budget. An approved plan
must still show expected settings and no unwanted replacement before apply.

This budget creation is not evidence of a deployed or certified production
system. Private delivery identity/state/runner setup, secrets, operational alerts,
browser/provider acceptance and coordinated recovery tests remain explicit gates.

Sources: [Azure retail API](https://learn.microsoft.com/en-us/rest/api/cost-management/retail-prices/azure-retail-prices),
[ACA billing](https://learn.microsoft.com/en-us/azure/container-apps/billing),
[ACA managed networking](https://learn.microsoft.com/en-us/azure/container-apps/custom-virtual-networks#managed-resources),
[Key Vault pricing](https://azure.microsoft.com/en-us/pricing/details/key-vault/),
[NAT pricing](https://azure.microsoft.com/en-us/pricing/details/azure-nat-gateway/),
[PostgreSQL backups](https://learn.microsoft.com/en-us/azure/postgresql/backup-restore/concepts-backup-restore),
[budget behavior](https://learn.microsoft.com/en-us/azure/cost-management-billing/costs/tutorial-acm-create-budgets).
