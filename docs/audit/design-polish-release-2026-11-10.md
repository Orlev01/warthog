# Design polish release — 10 November 2026

Status: deployed and healthy at [app.warthog.com.au](https://app.warthog.com.au).
Application source: `7e61d3d12d3fbd661d41f750551a8bf4bd019d1a`.
Revision: `warthog--r42809708265a1`, one healthy replica, explicit 100% traffic.
Image: `crwarthogprodauee854.azurecr.io/warthog@sha256:b288d99f921556f7aad9aacf2c36e2a2e1b88f8e6d77312884e3fcb5ceead7f6`.

The founder requested design skills and UI polish, then explicitly requested
deployment and approved both GitHub environments. Work used an isolated worktree
and three specialist agents reviewing responsive layout, interaction/accessibility,
and the design system. The existing visual identity is retained.

## Changes

- Add five contributor skills covering the design system, mobile, desktop,
  feedback and media. [AGENTS.md](../../AGENTS.md) routes future UI work to them;
  the technical design records their relationship to the application.
- Bound page containers and flexible children, wrap long names and values, and
  improve narrow forms, file controls, receipt details and QR sizing.
- Account for all four safe-area insets, mobile navigation and dynamic viewport
  height. Keep mobile text inputs and touch targets usable.
- Consolidate notices and copy feedback with consistent icons and accessible
  announcements. Copy success follows actual clipboard success; failure retains
  manual-copy help. Busy copy controls retain keyboard focus and prevent repeats.
- Keep disconnect confirmation within short and narrow viewports, with reachable
  actions, native focus containment, cancellation and focus restoration.

There are no new migrations, runtime dependencies, production credentials,
service tiers, DNS changes or provider messages. This is an image-only update
using the existing singleton maintenance procedure.

## Validation

[Source CI](https://github.com/Orlev01/warthog/actions/runs/42806739507) and
[pinned-base publication](https://github.com/Orlev01/warthog/actions/runs/42806740904)
passed. The four Node 22/Linux/PostgreSQL 16 shards passed **5,105 application
tests**, plus the existing delivery, cost and Terraform schema checks. Local
production build, TypeScript and 146 focused tests passed; all five skills
passed the skill validator.

Local browser checks covered 72 route/viewport combinations from 320 to 1920
pixels with zero horizontal overflow or console/page errors. Eighteen interaction
and display checks covered delayed and rejected clipboard access, duplicate-copy
prevention, keyboard focus, toast dismissal, short-screen dialogs, dark mode,
reduced motion, populated receipt details and portrait/landscape safe areas.

The exact published AMD64 image was checked for source/base labels, UID 1000 and
absence of setuid/setgid files. It uses the same pinned Node 22.23.4 Bookworm base
as the previous release. The fresh scan matches the previously reviewed **215 OS
package/advisory pairs** exactly: one critical, 34 high, 95 medium and 85 low,
with zero Node findings. No findings were added, removed or suppressed. The
[runtime image review](runtime-image-review-2026-11-10.md) describes the retained
risks and mitigations; this is not a vulnerability-free image.

## Deployment and live verification

[Production run 42809708265](https://github.com/Orlev01/warthog/actions/runs/42809708265)
completed successfully after the founder's separate `azure-production` approval.
The workflow verified stopped old replicas, free database ownership before
startup, held ownership afterward, health, exact traffic and unchanged workload
configuration. Independent checks at 11:52 UTC confirmed the exact new image,
one healthy replica, 100% traffic, zero old replicas and HTTP 200 readiness with
both configuration and database checks reporting `ok`.

All 16 public checks passed, including OAuth callback/state preservation,
callback/resource/PKCE rejection, MCP access boundaries, receipt authentication
and the Terms title. Production browser checks at 320, 390 and 1440 pixels
confirmed no overflow or page errors; the new viewport metadata and simulated
59-pixel top/34-pixel bottom safe areas were verified on the deployed sign-in page.
Authenticated design flows were exercised with local synthetic data; this release
did not create or alter production user records for UI testing.

An earlier dispatch, `42809626150`, failed its hosted input gate because the
approval reference contained unsupported punctuation. It provisioned no private
runner and made no production change. The corrected dispatch above is the
successful release; neither run's result is relabeled.

Billing credit eligibility was rechecked privately before provisioning the same
approved private B2als_v2 single-job runner profile. The application allocation,
SMS-off configuration, secret references and usage alert remain unchanged.
Independent inventory confirms the runner resource group, VM, disk, NIC, NAT,
egress IP and grants are removed, with no shared-subnet NAT association or GitHub
runner remaining. Temporary local registry credentials and SSH private keys were
removed as well.

Previous live provider and receipt evidence remains in the
[acceptance-fixes release](acceptance-fixes-release-2026-11-10.md). Unconfirmed
desktop push receipt, other provider consents and isolated coordinated recovery
remain separate acceptance work. No additional message or consent was attempted.
Private scan, workflow, configuration, browser and runner evidence is retained
under ignored `.delivery/design-polish/`.
