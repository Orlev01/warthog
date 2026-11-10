# First application release — 10 November 2026

The founder approved publication and then the exact first application deployment,
including the remaining findings in the [runtime image review](audit/runtime-image-review-2026-11-10.md).
[Release 42768897430](https://github.com/Orlev01/warthog/actions/runs/42768897430)
succeeded using source `f406b2b070554d452bbcbf5f966d42428bb0351c` and immutable image:

```text
crwarthogprodauee854.azurecr.io/warthog@sha256:e8b03f1639b68cc8b6765a50ccbeae9006f03fb0e033d5d659da2f77e60f2ea7
```

## Verified outcome

- One healthy replica of `warthog--r42768897430a1`, 0.5 vCPU / 1 GiB, with
  explicit 100% traffic and min/max replicas both one. No other revision exists.
- Default Azure HTTPS readiness and liveness return 200. Configuration and
  database checks pass. A read-only query inside the live container confirms
  all 70 migrations, PostgreSQL TLS 1.3, and runtime UID 1000.
- SMS is disabled. Nine versioned Key Vault references are injected; no Twilio
  settings or credentials are injected. Email/push and connectors retain their
  production configuration requirements.
- The workflow used the scoped release OIDC identity and proved the database
  ownership lock free before startup and held after startup. Its first-create
  operation bound no custom domain.
- The fresh private runner, disk, NIC, NAT, egress IP, lease group and grants are
  removed. Independent Azure inventory confirms deletion and subnet detachment;
  GitHub runner inventory is empty.
- All four approved Resend DNS records are now provider-verified. Tracking remains
  disabled and Free-plan overages remain off. The subsequent approved single
  signup email is provider-confirmed delivered, with founder-confirmed receipt.
- The separately approved app CNAME and ownership TXT are saved and exact on both
  authoritative nameservers. All eleven prior records remain, for thirteen total.
  A free Azure managed certificate is bound to [app.warthog.com.au](https://app.warthog.com.au);
  trusted TLS verifies that hostname and expiry 10 May 2027. Domain health, signup
  and sign-in pages return 200. Configuration comparison confirms only the custom
  domain binding changed; the image, singleton and traffic remain intact.
- Read-only Chrome checks pass for landing, signup, sign-in, privacy, terms and
  help. Navigation and rendering work at the default desktop viewport, without
  captured console warnings/errors or TLS interstitials. Those initial checks
  submitted no form. A separately approved signup submission later sent exactly
  one verification email; after the founder supplied the received code, email
  verification succeeded. That test stopped at the passkey-choice screen. The
  founder then completed signup using an Authenticator app. Read-only Chrome
  checks verify the authenticated home, settings, notifications and security
  pages, one current-device session, and the intended SMS-disabled UI. No
  settings or account data were changed by those checks.

The initial startup probe timed out. Subsequent
probes became healthy; readiness, replica inventory and HTTPS were checked again
after the release completed. The live resolver uses short cluster search domains
and has no `LOCALDOMAIN` override. This does not resolve the other retained native
library findings in the approved image review.

## Validation and delivery follow-up

[Publication run 42762919981](https://github.com/Orlev01/warthog/actions/runs/42762919981)
passes all eight jobs: 5,078 application tests, 27 delivery tests, five cost tests,
four Terraform root validations, real PostgreSQL checks and runtime builds.
The exact published image independently passes the non-root, no-setuid/setgid,
no-npm and missing-configuration termination checks. Its scan has zero Node
package findings; retained OS findings are documented, not suppressed.

An operator approval reference containing semicolons was caught before the first
attempt obtained an approved environment or registered a runner. That run was
cancelled and its unused runner fully deleted. The corrected dispatch succeeded.
The hosted gate now validates the same approval-reference contract before
requesting a private runner. A second correction accepts Azure's actual
`dapr: null` response during inspection/update while still rejecting enabled Dapr.
All 28 delivery regression tests, Actionlint and the actual live-app contract pass.
These follow-up delivery changes do not change the deployed application image.

## Remaining launch work

Navigation observations for a later UI pass: landing/signup/sign-in lack direct
policy links, although the policy pages work and Help links to Privacy, which
links to Terms. The terms page has the generic browser title "Warthog". These are
discoverability/metadata observations, not missing policy pages or new approval gates.
The Security page also lacks an Authenticator enrollment indicator and describes
recovery only in terms of losing passkeys. The founder completed Authenticator
signup; this is an observed presentation gap, not evidence that enrollment failed.

The single signup-email delivery and email-code verification checks passed.
The founder subsequently completed Authenticator signup and initial authenticated
page checks pass. Fresh sign-in, credential/recovery lifecycle, push, connector,
upload-limit and coordinated restore/deletion acceptance remain outstanding. Further DNS, provider purchases/messages and
future deployments retain their approval boundaries. Account-specific evidence remains in the
ignored, owner-only `.delivery/activation-2026-11-10/` directory.

The full Azure estimate remains A$430.66/month, or A$438.13 for 31 days, before
credits, tax and external providers. Active startup-credit linkage was checked
before this paid stage; the A$440 usage alert is unchanged.
