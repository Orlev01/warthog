# Session-aware entry and public landing release — 11 November 2026

The session-entry fix and redesigned public landing page are deployed. Existing
valid browser sessions now leave `/signin` for a safe return destination or Home;
`/` also sends returning members to Home. Signed-out visitors see the polished
public page with bounded desktop composition, responsive layouts, clearer product
information, an explicitly illustrative workspace, setup steps and native FAQs.

The underlying persistent cookie and session windows are unchanged: 14 days idle
and 30 days absolute. Session validity is checked against the database; cookie
presence alone never grants access. This release adds no migration, dependency,
provider integration or signed-in layout change. See the
[implementation review and screenshots](public-entry-2026-11-11/review.md) and
[public design guidance](../design/public-front-door.md).

## Source and verification

Application source: `8544ba656b9567f90d04780a0c3b2258a7af8d7f`, integrated on main
after `16f16aa6976e22bb432220ad8188974f1418490a`.

- All **5,232 tests** passed, with no failures, cancellations or skips. TypeScript
  and the optimized production build/boot suite passed.
- Nine checks against the built local application covered real session redirects,
  exact callback parameters, unsafe return paths, anonymous/forged cookie access
  and secure cookie attributes, using a disposable synthetic account.
- Twenty browser width/theme combinations covered 320–1920px, landscape and both
  themes, with no document/child overflow or undersized navigation/disclosure
  targets. Additional checks covered safe areas, reduced motion, keyboard focus,
  FAQ operation and real account links. No browser warning/error logs were captured.
- [Source CI](https://github.com/Orlev01/warthog/actions/runs/42973293251) and the
  [image workflow](https://github.com/Orlev01/warthog/actions/runs/42975241680)
  completed successfully, including the Linux and PostgreSQL checks.

## Image and production

The founder approved the separate `azure-images` and `azure-production` gates.
The immutable deployed image is
`crwarthogprodauee854.azurecr.io/warthog@sha256:d05d9033cc53e5504ecc3abc55c2722bfe093ffd1d15272dcfda927990b64fed`.

Independent image inspection verified the source/base labels, Linux AMD64,
UID 1000, no setuid/setgid utility bits, and the lockfile, 76 migration and 106
catalogue hashes. The immutable base remains
`node:22-bookworm-slim@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d`.

Fresh base and candidate scans retain exactly **215 OS findings**: 1 critical,
34 high, 95 medium and 85 low, with zero non-OS findings and no added or removed
package/advisory pairs. The scanner reports no fixed Bookworm versions for these
entries. The existing [OS applicability review](runtime-image-review-2026-11-10.md)
continues to apply; the founder's production approval included these retained
findings. This is not a claim that the image has no vulnerabilities.

[Production workflow 42980822155](https://github.com/Orlev01/warthog/actions/runs/42980822155)
completed successfully at 07:56 UTC. Its stop, zero-replica, free database ownership
lock, start, held-lock and readiness checks passed. The approved revision is
`warthog--r42980822155a1`.

Four read-only production Chrome checks passed using the browser's existing
session: `/signin` and `/` reached Home without credentials, an Inbox return link
reached Inbox, and an external return URL safely fell back to Home. Browser
warning/error logs were empty. No production account data or settings were
changed; the verification tab was closed.

Independent Azure inspection at 07:58 UTC verified the exact image, one healthy
replica, explicit 100% traffic and zero replicas for all older revisions. The
application configuration is unchanged apart from image, revision suffix and
traffic target; the existing CPU/memory allocation and SMS-disabled setting remain.

All 15 live public checks passed: readiness/liveness, new landing content,
signed-out entry and support/legal routes, private no-store headers, nonce CSP,
the protected Home redirect and forged-cookie rejection on both public entries.

## Cleanup

The reviewed private runner used the existing B2als_v2 profile, no public NIC
address, no managed identity and no inbound access. Private Key Vault TLS and
PostgreSQL DNS/certificate-verified TLS passed before its one-job registration.

After terminal workflow success, the controller removed the runner. Independent
checks at 07:58 UTC verified its resource group and all scoped resources and role
assignments were absent, the shared subnet NAT was detached, and the GitHub
runner was deregistered. Ephemeral SSH keys were removed. Local preview data,
build output, candidate image and downloaded scan/provider caches were removed;
shared dependencies and other worktrees were left intact. The original local
environment file was byte-checked and remains unchanged.

## Verification limits

The responsive screenshots use a local production build and synthetic content.
Native device keyboards, assistive-technology speech, real provider delivery,
hardware passkeys and coordinated restore acceptance were not exercised by this
release. Existing session expiry and explicit revocation still require sign-in.

Raw operational evidence remains in ignored private
`.delivery/landing-signin-2026-11-11/`. This release-outcome documentation follows
the deployed application source and does not itself require another deployment.
