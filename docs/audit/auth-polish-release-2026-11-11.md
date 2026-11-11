# Public navigation and account-entry release — 11 November 2026

Sticky public navigation, gradual section scrolling and the redesigned sign-in
and signup experience are deployed. The account pages have bounded forms,
consistent typography, clear setup stages and explicit **Back to home** links.
Mobile layouts prioritise the form; desktop layouts include a supporting product
introduction. Native smooth scrolling respects reduced-motion preferences and
keeps section headings below the sticky header and device safe area.

This release preserves authentication handlers, persistent sessions, cookie
lifetimes and required factors. It adds no migration, runtime dependency or
provider integration. See the [implementation review and screenshots](auth-polish-2026-11-11/review.md)
and [public design guidance](../design/public-front-door.md).

## Source and verification

Application source: `761d63e2e225bd58fb39f64ac33966ea72db1da8`, integrated on main
after the previous release record `716173c412b1809f318ce022160dd8d8ef53ce96`.

- All **5,235 tests** passed, with no failures, cancellations or skips. TypeScript,
  the optimized production build/startup suite and all **206 focused checks** passed.
- **91 local browser layout cases** covered account states, the public page and
  form-level feedback across 320–1920px, landscape, both themes and safe areas.
  No document/child overflow or undersized checked controls were observed.
- Running-app checks verified intermediate smooth-scroll positions, header
  clearance, reduced-motion behavior, both home links, keyboard disclosure and
  focus, and preserved return destinations. Captured warning/error logs were empty.
- [Source CI](https://github.com/Orlev01/warthog/actions/runs/43011839907) and the
  [image workflow](https://github.com/Orlev01/warthog/actions/runs/43014001185)
  succeeded, including Linux and PostgreSQL checks.

## Image and production

The founder approved the separate `azure-images` and `azure-production` gates.
The immutable deployed image is
`crwarthogprodauee854.azurecr.io/warthog@sha256:ef553dc66045a4753cae38311c4de0267784853ac4c40ba9ac5f69cf7d520d3a`.

Independent image inspection verified the source/base labels, Linux AMD64,
UID 1000, absence of setuid/setgid utility bits, and matching lockfile, 76 migration
and 106 catalogue hashes. The immutable base remains
`node:22-bookworm-slim@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d`.

The fresh candidate scan retains **215 OS findings**: 1 critical, 34 high,
95 medium and 85 low, with **zero non-OS findings** and no added or removed
package/advisory pairs. The unstripped official base also contains 23 unchanged
npm CLI findings; the runtime image removes npm/npx. The existing
[OS applicability review](runtime-image-review-2026-11-10.md) remains applicable,
and the founder's production approval included the retained findings.

[Production workflow 43018474414](https://github.com/Orlev01/warthog/actions/runs/43018474414)
succeeded at 12:26 UTC. Its stop, zero-replica, free ownership-lock, start,
held-lock and readiness checks passed. The approved revision is
`warthog--r43018474414a1`.

Four read-only production Chrome checks passed: existing sessions reached Home
from `/signin` and `/`, the live signup form remained bounded at 480px in a
1728px viewport, and its **Back to home** link reached the root's session-aware
Home destination. Captured warning/error logs were empty, and the tab was closed.
No production account data or settings were changed.

Independent Azure inspection at 12:29 UTC verified the exact image, one healthy
replica, explicit 100% traffic and zero replicas for all older revisions. The
configuration is unchanged apart from image, revision suffix and traffic target.
The existing resource allocation, nine secret references and SMS-disabled setting
remain unchanged.

All **17 live public checks** passed: readiness/liveness, public landing content,
signed-out entry and support/legal routes, the new account-page home links,
private no-store headers, nonce CSP, the protected Home redirect and forged-cookie
rejection on both public entries.

## Cleanup

The runner used the previously reviewed private B2als_v2 profile with no public
NIC address, managed identity or inbound access. Its exact saved plan was reviewed
before apply. Private Key Vault TLS and PostgreSQL DNS/certificate-verified TLS
passed before its one-job GitHub registration.

After terminal workflow success, the controller removed the runner. Independent
checks at 12:28 UTC verified its resource group, all scoped resources and role
assignments were absent, the shared subnet NAT was detached, and its GitHub
registration was gone. Ephemeral SSH keys were removed.

Local preview data, fixtures, build output, candidate image and downloaded
scan/provider caches were removed. Shared dependencies and other worktrees were
left intact. The original local environment file remains byte-for-byte unchanged.

## Verification limits

Responsive visual evidence uses the local production build and synthetic content.
Production browser checks reused an existing session; signed-out sign-in markup
was verified through public HTTP checks. Native keyboards, screen-reader speech,
hardware passkeys, authenticator QR scanning, provider delivery and coordinated
restore acceptance were not exercised by this release.

Raw operational evidence remains in ignored private
`.delivery/auth-polish-2026-11-11/`. This documentation follows the deployed source
and does not require another deployment.
