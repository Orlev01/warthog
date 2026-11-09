# Review-only Warthog application workload

The [manual delivery pipeline](../../docs/azure-delivery.md) can now consume this
template for a separately approved first creation. It is disabled pending setup.
Existing app releases copy the reviewed revision and change only its image; they
do not overwrite app configuration with this full template.

`container-app.template.json` is a separate ARM resource-group template for **one
application**, using an existing reviewed foundation. It is not included in the
Terraform root, applied by CI, or authorized by the earlier source-work approval.
Applying it creates a running, chargeable container. `parameters.example.json` is
an intentionally invalid checklist: its approval flags are false and missing
facts are placeholders. Never supply secret values in either file.

The template uses the documented
[Microsoft.App/containerApps 2025-01-01 resource API](https://learn.microsoft.com/en-us/azure/templates/microsoft.app/2025-01-01/containerapps):
Australia East, Consumption, a caller-approved immutable image and resource size,
one user-assigned identity for image pulls/Key Vault/SDK calls, external HTTP ingress
on port 3000 with HTTP redirected to HTTPS, and exactly one container with
min=max=1. It preserves the image's existing entry point; no second app process,
sidecar, Dapr service, autoscaling rule or additional paid service is added.

**Multiple revision mode is deliberate, but does not enforce one global replica.**
Before any workload update, use the
[stop/wait/start runbook](../../docs/singleton-release-runbook.md): deactivate all
prior revisions, prove their replica lists empty, and privately test/release the
database ownership lock. `priorReplicasStopped=true` records that review; it does
not discover or stop anything. Freeze concurrent operators and automation.

## Required inputs and separate approvals

Copy the example to a private untracked parameter file and fill every field only
after its relevant approval. Do not commit the populated file. Required facts are:

1. App/resource-group name and exact dedicated Warthog subscription scope; approved
   maintenance window, credit-only funding protection and actual workload quote.
   Both approval flags require explicit review. No actual expenditure is approved
   by this artifact.
2. Existing Australia East environment ID, identity resource/client IDs and ACR
   server. Verify that the identity is attached to this app, can pull this image,
   read the referenced Key Vault secrets, wrap/unwrap using the reviewed key and
   access the private receipt container. Existing network and RBAC propagation
   must be accepted; the template creates no role assignments or firewall rules.
3. Approved release commit, clean Linux/PG16 evidence, runtime manifest and
   `registry/repository@sha256:…` image. No tag is accepted by the offline guard.
   Supply the reviewed revision suffix and explicitly approve 0.5 vCPU/1 GiB.
   These constrained values reflect the proposed initial size, not spend approval.
4. The complete `productionEnvironment` map in the example: app origin/RP,
   operator/contact and exchange-rate endpoint; wrapping-key URL/name and Blob
   names; public email settings; Twilio region/country routes and all five SMS
   limits; OAuth client IDs and VAPID public key/subject. All values are strings;
   `SMS_COUNTRY_ROUTES_JSON` is a JSON object encoded as a string. Do not add
   undocumented variables, dev flags, ACS fallbacks or alternate auth hosts.
5. Existing **version-pinned secret URLs** for each `keyVaultSecretUrls` entry:
   three distinct database logins, HMAC key, Resend key, Twilio account/key IDs and
   secret, Google/Microsoft secrets, private Google early-access list and VAPID
   private JWK. This map contains URLs, never credentials. The public VAPID key
   must correspond to the private JWK. DB URLs must use the approved private host
   and `sslmode=verify-full`. Bootstrap remains a separate private-client operation.
6. One explicit revision traffic target (100%; never `latestRevision` or split
   traffic), and the exact existing app custom-domain bindings. First creation
   supplies an empty domain array; later updates copy existing approved bindings
   unchanged. No new hostname, certificate or DNS binding is authorized here.

The offline guard checks only the documented local contract, not actual account
eligibility, secret contents, key pairing, capacity, billing or certificate status.
The application's production-readiness validator remains authoritative for runtime
values; do not weaken it to pass probes. Resend Free limits, Twilio redaction/STOP
and A$20 allowance, launch-country acceptance, all six connector setups, Google
named testers and push acceptance remain independent launch gates.

Version-pinned Key Vault URLs avoid the automatic rotation behavior of unversioned
references. Review rotations as releases with the same singleton procedure; never
rotate by exposing values in a report or by restarting overlapping revisions.
[Azure secret-reference and rotation behavior](https://learn.microsoft.com/en-us/azure/container-apps/manage-secrets).

## Health and traffic

All probes are HTTP to the container's port 3000. Startup/readiness use
`/api/health`; liveness uses `/api/health/live`. Startup allows ten failures at
60-second intervals (roughly ten minutes); readiness uses three at five seconds;
liveness uses three at ten seconds. Each timeout is five seconds. These are
proposed timings, not measured production guarantees.

The resource API describes a custom failure-threshold maximum of ten. The
[health-probe guide](https://learn.microsoft.com/en-us/azure/container-apps/health-probes)
also shows larger platform defaults. This template stays within the declared API
range rather than assuming those defaults permit arbitrary custom values. Verify
real migration/startup timing and adjust the reviewed interval if necessary.

For creation and updates, the only traffic target is the new explicit revision;
it can serve as soon as healthy. Requests can fail during this intentional outage.
Configure that target only after proving every prior process stopped. After startup,
verify readiness and the actual revision name/100% target. Do not route traffic to
an inactive old revision: the documented traffic mechanism targets active revisions.
This template therefore includes the approved traffic change in the start step;
it does not promise a separate manual hold after readiness. Public signup still
requires custom-host HTTPS and end-to-end acceptance. No old process may be
reactivated alongside it. [Traffic rules](https://learn.microsoft.com/en-us/azure/container-apps/traffic-splitting).

ARM is a full resource update, not an assumed merge patch. Before reusing this
template on an existing app, compare all current nonsecret settings with it and
stop if there are unknown secrets, identities, traffic rules or configuration that
would be lost. Domain bindings must be preserved. Do not treat this as automatic CD.

## Request-body size: still requires ingress acceptance

The code allows a 26 MiB request envelope (27,262,976 bytes), including multipart
overhead around a receipt of up to 25 MiB. `next.config.mjs` sets `26mb` for Server
Actions; the current prepared-import route also enforces `26 * 1024 * 1024` bytes.
These application limits do **not** prove the Azure path accepts the same body.

As checked 9 November 2026, the official
[HTTP ingress overview](https://learn.microsoft.com/en-us/azure/container-apps/ingress-overview)
documents TLS and a 240-second request timeout but does not specify a request-body
ceiling. The referenced app resource's ingress schema has no body-size property.
Its `dapr.httpMaxRequestSize` belongs to Dapr and is not an ingress upload setting.
No Dapr setting is added here.

The [premium ingress settings](https://learn.microsoft.com/en-us/azure/container-apps/premium-ingress)
document timeout/header controls and additional workload nodes, not a verified
26 MiB upload solution. This draft does not enable premium ingress, Front Door,
Application Gateway, API Management or another proxy to guess around the gap.

Before launch, test valid synthetic receipt/import uploads through the actual
HTTPS app hostname, recording encoded body size, status, elapsed time and resulting
private Blob/database artifact without logging content. Include near-ceiling
accepted bodies and an oversized rejection. Exact 26 MiB transport acceptance
needs an approved safe synthetic test or Microsoft confirmation; a small upload or
health 200 is insufficient. If a 413/reset/timeout occurs, identify which hop rejected
it and return for review of any required setting, support inquiry or paid change.

## Local checks and limits

```sh
python3 infra/workload/check_template.py
# Optional after privately preparing reviewed nonsecret parameters:
python3 infra/workload/check_template.py /private/path/workload.parameters.json
```

The script parses JSON, checks singleton/probe/secret-reference structure, and can
check a complete supplied parameter file without network access or printing values.
It does not run Azure validation or a deployment. The separately gated delivery
script contains the first-creation command and requires actual singleton evidence.
The ARM expressions/schema and live platform behavior still require validation in
the authorized account. No populated parameter file or credentials were created.
