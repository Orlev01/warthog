# Admin console design release — 11 November 2026

Status: integrated, deployed and verified in production. Temporary runner cleanup
is complete and independently verified.

The founder requested the admin.openai.com workspace design principles, stronger
navigation grouping, mobile and desktop polish, integration with the latest main,
and deployment. [PR 7](https://github.com/Orlev01/warthog/pull/7) integrated the design
on top of `f8d88ed`, retaining the previously deployed agent-first and skills-library
work. The merged application source is
`fc131dab5cf17cf5c6878c53d4113e935ac91b0d`.

## Interface and validation

The application now uses a neutral admin shell, grouped sidebar navigation,
section tabs, nested agent navigation and URL-backed in-page views. Page widths
are bounded by purpose; narrow screens use a focus-managed navigation drawer.
The shared component treatments and contributor skills cover colors, type,
spacing, icons, feedback, forms, mobile behavior and media.

The final local suite passed 5,154 tests, with typecheck and production build.
All six [PR checks](https://github.com/Orlev01/warthog/actions/runs/42918418182)
passed. The browser review covered 74 route/width combinations plus navigation,
draft persistence, history, keyboard, dialog, toast, theme and safe-area checks.
No horizontal overflow or browser warning/error logs remained. The four changed
contributor skills passed validation. See the [design reference](../design/admin-console-reference.md)
and [browser validation](../design/admin-console-validation.md).

Both [main push CI](https://github.com/Orlev01/warthog/actions/runs/42923528755)
and the [pinned-base image checks](https://github.com/Orlev01/warthog/actions/runs/42925327938)
passed all 5,154 tests across four Linux/PostgreSQL 16 shards, with no failures,
cancellations or skips. The founder approved `azure-images` in GitHub and image
publication completed successfully.

The merged commit adds no migration, dependency, image-base, workflow or
infrastructure change to the previously deployed agent-first application.
Runtime packaging remains 75 migrations and 106 catalogue definitions.

## Published image

The deployed immutable image is
`crwarthogprodauee854.azurecr.io/warthog@sha256:832d0a0ec819de6a6c4e687781f6a07643d4eceb34456a2222cc4dfc5ba4b86e`.

Independent inspection verified its exact source/base labels, Linux AMD64 platform,
UID 1000 runtime and absence of setuid/setgid bits in the runtime utility paths.
The lockfile, all 75 migration hashes and all 106 catalogue hashes match the source.
A fresh Trivy 0.76.2 scan using the 10 November database retains the same 215 OS
package/advisory pairs as the preceding reviewed image: one critical, 34 high,
95 medium and 85 low. There are no added or removed pairs and no non-OS findings.
This does not establish that the image is vulnerability-free. The unchanged
application/native-code exposure and remaining applicability limits are recorded
in the existing [OS review](runtime-image-review-2026-11-10.md).

The reviewed runtime base is
`node:22-bookworm-slim@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d`.

## Production outcome

The founder separately approved `azure-production` for the exact source and image,
including the retained OS findings and maintenance interruption.
[Production release 42931814911](https://github.com/Orlev01/warthog/actions/runs/42931814911)
completed successfully on 11 November. [Warthog](https://app.warthog.com.au)
serves the reviewed image as revision `warthog--r42931814911a1`.

Independent Azure inspection at 01:35 UTC confirmed one healthy replica,
explicit 100% traffic, all older revisions inactive with zero replicas, and
unchanged application configuration apart from the image, revision suffix and
traffic target. The workflow verified the database ownership lock was free after
stopping the old process and held after starting the new one. Successful readiness
follows startup migrations; no separate migration-table query is claimed.

All 16 public checks passed: readiness/liveness, signed-out access, MCP
authentication/origin/method handling, exact OAuth loopback redirect and state,
PKCE/resource rejection, receipt authentication and terms.

Read-only browser checks used an existing authenticated session. Home at 1440px,
Skills at 390px, and Skills Import & create at 320px had no horizontal overflow.
The URL-backed tab selected the correct panel. The mobile navigation drawer
opened, closed with Escape and returned focus to Open navigation. Browser warning
and error logs were empty. No application records or account settings were changed;
the temporary tab was closed and the viewport override reset.

The private runner's tools, Key Vault TLS, private PostgreSQL DNS and
certificate-verified TLS 1.3 were checked before registration. The runner was
destroyed after the workflow completed. Independent inspection at 01:35 UTC
confirmed the lease group, VM, disk, NIC, NAT, egress public IP and scoped role
assignments were absent, the shared subnet NAT was detached, and the GitHub runner
was deregistered. Local ephemeral SSH keys and registry credentials were removed.

The production update uses the existing allocation and configuration, including
SMS disabled. It follows stop/zero-replica/free-lock/start/held-lock/readiness
checks and an intentional maintenance interruption. It does not automatically
roll back. The [previous release record](agent-first-release-2026-11-11.md)
retains the agent-first permission compatibility and provider acceptance limits.

Write interactions were tested against local synthetic fixtures before release.
Live public/browser checks do not establish new provider consent, notification
delivery or coordinated restore acceptance.

Operational snapshots, raw logs and scan evidence stay in ignored private
`.delivery/admin-design-release/`; no production credentials or customer data
belong in this document. The release-outcome documentation commit follows the
deployed application source and does not itself require a new deployment.
