# Marketing motion release — 12 November 2026

The public marketing page now has flowing neutral backgrounds, sparse drifting
dots, gentle pointer response and short section entrances. Actions and FAQ
disclosures have restrained movement. A pause/play control persists its setting
for the browser tab; reduced-motion and forced-colour preferences take precedence.
Backgrounds pause outside the viewport and when the document is hidden.

React Bits informed the visual direction. The SVG/CSS implementation is original
and adds no dependency, copied component source, remote asset or tracking.
Authentication pages, signed-in views, sessions and data models are unchanged.
See the [implementation review and screenshots](marketing-motion-2026-11-12/review.md)
and [public design guidance](../design/public-front-door.md).

## Source and verification

Application source: `3ec56f0a73b50a623a3b96bde7fd392a54f36947`, integrated on main
after the previous release record `772449a8c1e6d0e4fa55c9c54b6bd32909c5e928`.

- All **5,236 local tests**, the final production build, typecheck and **14 focused
  landing/public-entry checks** passed. No tests failed, skipped or were cancelled.
- **20 local browser layout cases** covered 320–1920px, landscape, light/dark
  themes and safe areas. No document/content overflow or undersized checked
  navigation/action/disclosure targets were observed.
- **13 interaction checks** passed, including pause persistence, keyboard resume,
  reduced motion, forced colours, smooth scrolling, FAQ keyboard use, pointer
  response and offscreen suspension. Captured warning/error logs were empty.
- [Source CI](https://github.com/Orlev01/warthog/actions/runs/43118701953) and the
  [image workflow](https://github.com/Orlev01/warthog/actions/runs/43122060761)
  succeeded, including Linux and PostgreSQL checks.

## Image and production

The founder approved both protected environments, `azure-images` and
`azure-production`. The immutable deployed image is
`crwarthogprodauee854.azurecr.io/warthog@sha256:6a05807c34aa8bbf8176f0fcbe95984fb58a4be2c8440e100e530a2e5cd31d79`.

Independent image inspection verified source/base labels, Linux AMD64, UID 1000,
absence of setuid/setgid utility bits, and matching lockfile, 76 migration and
106 catalogue hashes. The immutable base remains
`node:22-bookworm-slim@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d`.

The fresh candidate scan retains **215 OS findings**: 1 critical, 34 high,
95 medium and 85 low, with **zero non-OS findings** and no added or removed
package/advisory pairs compared with the preceding release. The unstripped base
also contains 23 unchanged npm CLI findings; npm/npx are removed from the runtime
image. The existing [OS applicability review](runtime-image-review-2026-11-10.md)
remains applicable. Production approval included these retained findings.

[Production workflow 43127100188](https://github.com/Orlev01/warthog/actions/runs/43127100188)
succeeded at 00:38 UTC (11:38 Sydney). Its stop, zero-replica, free ownership-lock,
start, held-lock and readiness checks passed. The approved revision is
`warthog--r43127100188a1`.

Independent Azure inspection at 00:41 UTC verified the exact image, one healthy
replica, explicit 100% traffic and zero replicas for all older revisions.
Configuration is unchanged apart from image, revision suffix and traffic target;
resource allocation, nine secret references and the SMS-disabled setting remain
unchanged.

All **20 live public checks** passed: readiness/liveness, marketing content and
motion markup, signed-out entry and support/legal routes, account-page home links,
absence of marketing decoration on account pages, private no-store headers, nonce
CSP, the protected Home redirect and forged-cookie rejection on both public entries.

Six read-only production Chrome checks passed: existing sessions reached Home
from `/signin` and `/`; Home and signup had no marketing decoration; the signup
form stayed bounded at 480px in a 1728px viewport without overflow; and its
**Back to home** link reached the root's session-aware destination. Captured
warning/error logs were empty. The temporary tab was closed, and no production
account data or settings were changed.

## Cleanup

The runner used the reviewed private B2als_v2 profile without a public NIC address,
managed identity or inbound access. Its exact saved plan was reviewed before
apply. Tooling, Key Vault TLS and private PostgreSQL DNS/certificate-verified TLS
passed before its one-job GitHub registration.

After terminal workflow success, the controller removed the runner. Independent
checks at 00:41 UTC verified its resource group, all scoped resources and role
assignments were absent, the shared subnet NAT was detached, and its GitHub
registration was gone. Ephemeral SSH keys were removed.

Local preview data, build output, candidate image and downloaded scan/provider
caches were removed. Shared dependencies and other worktrees were left intact.
The original local environment file remains byte-for-byte unchanged.

## Verification limits

Responsive motion evidence uses the local production build. Production browser
checks reused an existing session; signed-out marketing markup was verified over
HTTP. The automation browser kept local tabs visible, so hidden-document behavior
was tested using a temporary document override, not a native background-tab event.
Native device keyboards, screen-reader speech, hardware passkeys, provider delivery
and coordinated restore acceptance were not exercised by this release.

Raw operational evidence remains in ignored private
`.delivery/marketing-motion-2026-11-12/`. This documentation follows the deployed
source and does not require another deployment.
