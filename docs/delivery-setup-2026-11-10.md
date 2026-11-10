# Delivery setup — 10 November 2026

The founder authorized completing foundation permissions, production secrets and
the private runner, and explicitly allowed internal PostgreSQL DNS. Public DNS,
provider purchases/live messages and the application's release review remain
separate. This record supersedes earlier setup holds; it is not launch certification.

**Subsequent approved work:** the founder authorized the
[SMS-off initial launch](sms-disabled-launch.md) and the exact four Resend DNS
additions. Both authoritative nameservers match those additions; all seven prior
records remain. DKIM/CNAME are verified, MX/SPF remain pending. Resend API confirms
open/click tracking false, and the console still shows Free with overages off.
Forge delivery eligibility enabled automatically after its CNAME verified. App DNS
and application deployment are still pending; no message was sent.

## Applied and verified

- The approved Australia East foundation is applied: private PostgreSQL 16
  General Purpose D2ads_v5, 32 GiB P4 disk, seven-day backups; Consumption hosting
  environment; ACR Basic; Premium Key Vault; LRS receipt storage; private network
  and internal database DNS; 30-day logs with a 0.1 GB/day allowance.
- Foundation state uses the approved Entra-authenticated Blob backend. Bootstrap
  and access-module state remain in owner-only local storage. Both foundation
  and access follow-up plans report zero changes. Independent ARM reads verify
  resource settings, 18 access grants and the unchanged A$440 budget.
- Four delivery identities have scoped foundation, registry and release roles.
  Role-assignment writes are constrained to the application principal and four
  approved data roles. There is no subscription Owner delegation. The original
  four GitHub environments still require founder review, main only and no admin
  bypass. A separate cleanup identity cannot create resources or read app secrets.
- Twenty-one versioned vault entries hold generated credentials, provider keys,
  allowlist and verified database URLs. The RSA-HSM 3072 wrapping key passes a
  wrap/unwrap round trip. Application access is limited to twelve named secrets
  and that named key. A live application-identity test verifies all twelve reads,
  six denied administrator/raw-password/delivery-URL reads, denied vault listing
  and HSM use. Its temporary attachment to the setup VM was removed afterward.
- The private `warthog` database and four distinct logins are initialized.
  Migration, runtime, purge and delivery logins all connect with `verify-full`
  TLS. The delivery login has no role memberships, is read-only by default and
  passes the session advisory-lock probe. Application migrations have not run.
- GitHub foundation inputs, registry identifiers, production resource identifiers
  and the verified ownership connection are configured privately. No application
  passwords, OAuth secrets or personal GitHub token are in source or public logs.

## Provider credentials

Microsoft Web OAuth uses the approved callback, personal/multitenant audience and
delegated permissions, with no tenant-wide administrator consent. Its current
server credential expires **9 May 2027** and needs a reviewed rotation before then.

Google OAuth is External/Testing, with the approved Google tester and separate
Warthog email allowlist. The only callback is
`https://app.warthog.com.au/connect/callback`; there are no JavaScript origins.
Gmail, Calendar and Drive APIs are enabled, the requested connector scopes are
saved, and project billing is unlinked. Consent support uses the approved Gmail
address; the public application contact remains `oren@nava-co.com`. No Google
user-data authorization or public verification is claimed.

Resend uses a new sending-only key restricted to `mail.warthog.com.au`. The domain
object exists and tracking is off, but verification awaits separately approved
public DNS. The account remains Free with overages disabled; no email was sent.

Twilio uses an isolated Warthog subaccount and a restricted key granting only
message creation and phone-number lookup. The account is Trial; sender/Messaging
Service setup is gated behind an upgrade. No number, plan or registration was
purchased and no message was sent. Actual routes, registration/STOP acceptance,
redaction entitlement and a complete A$20 quote remain unresolved; do not invent
Messaging Service SIDs or imply that credentials alone make SMS usable. The
[sales-response review](twilio-pricing-review-2026-11-10.md) corroborates public
base prices but does not resolve redaction or approve a larger SMS budget.

## Private execution and remaining release work

Secret/database initialization uses a temporary setup VM that is destroyed before
any GitHub runner is registered. Protected Run Command inputs may remain in the
guest agent cache; Docker jobs can gain root access. The runner controller therefore
requires a fresh VM and rejects prior secret commands or a paginated command list.
Each release uses a one-job JIT registration and a unique release-run label, with
no ambient Azure identity, public NIC address or inbound ports.

The B2s size was unavailable in this subscription. The equivalent B2als_v2 has
been provisioned successfully at a lower hourly rate. The revised full launch
allowance is **A$430.66/month**, **A$438.13 for 31 days**; the existing **A$440 alert**
is unchanged. These are gross usage estimates before credits/tax and external
providers, not an enforced spending cap or a measured production bill.

A fresh identity-free runner was verified online with its unique JIT label.
Docker, Azure CLI core Container Apps commands, PostgreSQL 16 and certificate trust
are installed; private database DNS and TLS chain/hostname checks pass without
using a database credential. No application job ran during this rehearsal.

The independent [cleanup run](https://github.com/Orlev01/warthog/actions/runs/42756721647)
passed live OIDC authentication, lock acquisition, NAT detachment and deletion of
the expired rehearsal group. Independent inventory confirms both temporary groups
are gone, no lease VM/disk/NIC/NAT/IP remains, the bootstrap subnet has no NAT, and
GitHub has no registered runner. The application foundation remains intact.

Foundation plan/apply and image publication are independently enabled for manual
use behind their existing required reviews; enabling them does not dispatch a job.
`AZURE_DELIVERY_ENABLED=false` still prevents application release dispatch. The remaining
first-create inputs now use the approved SMS-off mode, with nine core secret
references and no Twilio inputs. Local contract and Azure read-only Template
validation pass. An approved immutable image and workload/release review are still
required. Email DNS is applied as described above; app DNS and provider acceptance
remain separate. No Container App or image publication occurred during setup.
The [candidate image review](audit/runtime-image-review-2026-11-10.md), browser/provider
acceptance, 26 MiB ingress and coordinated restore/deletion tests remain launch
gates in the [audit](audit/README.md).

The full [CI run on cd344e5](https://github.com/Orlev01/warthog/actions/runs/42756304600)
passes all six jobs, 5,072 application checks, 24 delivery checks, five cost checks,
all four Terraform roots, builds/runtime packaging and real PostgreSQL checks.
The final documentation/workflow-switch follow-up passes Actionlint and explicit
stage-gate checks; application and delivery Python source are unchanged after that
full CI. The later SMS-off changes pass 119 focused Node 22 Linux tests, real
PostgreSQL checks, 27 delivery tests and five cost tests; pinned-base full CI is
required again before image publication. Account-specific evidence, populated inputs,
plans and state are retained privately under `.delivery/activation-2026-11-10/`.
