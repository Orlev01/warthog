# Admin portal release — 13 November 2026

Application source `40f0db356c2120d14c9b8f90ed025690a9bd2ae0` is live at
[app.warthog.com.au](https://app.warthog.com.au) as revision
`warthog--r43390913050a1`. `admin.warthog.com.au` was bound the same evening, after the
follow-up [recovery hardening release](recovery-hardening-release-2026-11-13.md) (see
"Hostname binding" below).

## What shipped

- **The operator admin portal** (PR #20; [decision](../adr/admin-portal.md),
  [design](../design/admin-portal.md),
  [build and verification record](admin-portal-2026-11-13/README.md)):
  - Overview, Sign-ups and activation, Usage, Accounts, Reliability, Traffic and System
    pages, each with today, 7, 30 and 90-day ranges, served only on the admin host.
  - An "Admin portal" panel on Settings for the `admin` role. Entry needs a step-up
    within five minutes and goes through a single-use 60-second handoff to the admin
    host's own session (12 h absolute, 60 min idle). The admin session ends with the app
    session.
  - Aggregate-only reads through one allowlisted module. No page lists addresses.
  - Instrumentation for sign-up and sign-in funnels, connector outcomes, agent token
    exchanges, job failures, account deletions and host/route-class traffic counts.
- **Three additive migrations:** 0110 `users.created_at` (backfilled), 0111
  `admin_sessions` and 0112 range-scan indexes (83 migrations in all).
- No production setting changed: the admin origin is derived from `PUBLIC_BASE_URL`.

## Verification

- Before merge, the branch was rebased on main `5816004`, so it runs on top of PR #19's
  step-up token rotation. A real-browser run of that path passed:
  - a sign-up session (no step-up) asks to "Confirm it's you" with a virtual passkey;
  - the app token rotates and the handoff lands on the admin Overview;
  - the rotated cookie stays signed in and the old one is refused;
  - app sign-out ends the admin session.
- [PR CI 43383980886](https://github.com/Orlev01/warthog/actions/runs/43383980886) and
  [main CI 43386014134](https://github.com/Orlev01/warthog/actions/runs/43386014134):
  **5,966 tests**, zero failures, cancellations or skips.
- [Image run 43388289676](https://github.com/Orlev01/warthog/actions/runs/43388289676)
  repeated them before publication. An earlier run, 43386103377, stopped at publish
  because its approval reference contained parentheses; nothing was published.
- Image `crwarthogprodauee854.azurecr.io/warthog@sha256:5b2b8c91859f9b348070b67b78cedae8553b9f0ab7278248e26dfceb5c85d717`:
  - exact source label, pinned base, journal label `v1`, linux/amd64, UID 1000, no
    setuid/setgid;
  - all 83 migration, 106 catalogue and 80 brand file hashes match the source;
  - scan: the same 219 OS package/advisory pairs as the previous image, none added,
    zero non-OS.
- [Production run 43390913050](https://github.com/Orlev01/warthog/actions/runs/43390913050)
  (`update`, expected configuration `f217d6ca…`) succeeded. Independent inspection: one
  healthy replica, exact image, explicit 100% traffic, zero old replicas, configuration
  unchanged apart from image and revision.
- Public checks:
  - health 200 with config and database ok;
  - public pages 200;
  - `/admin` and `/admin/usage` on the app host 404;
  - signed-in routes redirect to sign-in;
  - unauthenticated `/mcp` returns 401.
- Runner: fresh private lease (11 reviewed creates, plan `9302f8d7…`), private Postgres
  TLS checked without credentials, destroyed after the job. The group, resources, grants
  and subnet NAT were verified absent, and no GitHub runner remains.

## Hostname binding

Bound on 13 November, between releases, as [the launch runbook](../admin-portal-launch.md)
§2 describes.

- DNS (added by the founder at GoDaddy; existing records untouched):
  - CNAME `admin` → `warthog.orangestone-a3a5c61a.australiaeast.azurecontainerapps.io`;
  - TXT `asuid.admin` → the app's custom-domain verification id.
  - Both resolved identically at ns19/ns20.domaincontrol.com, 1.1.1.1 and 8.8.8.8.
- `az containerapp hostname add`, then `bind --validation-method CNAME`:
  - managed certificate `mc-cae-warthog-pr-admin-warthog-co-9287`, state `Succeeded`;
  - served as CN=admin.warthog.com.au by GeoTrust TLS RSA CA G1, expiring 13 May 2027;
  - SNI binding beside the unchanged `app.warthog.com.au` binding.
- The live revision stayed `warthog--r43398915940a1`, Running, with 100% traffic. The
  binding changes the configuration fingerprint, so the next `update` must take its
  expected hash from a fresh snapshot.
- External checks on `https://admin.warthog.com.au`:
  - `/` and `/usage` without an admin session redirect to
    `https://app.warthog.com.au/settings?notice=admin_signin_required`;
  - `/session` without a handoff redirects to `…?notice=admin_handoff_expired`;
  - `/api/auth/signin`, `/oauth/authorize` and `/api/health` return 404;
  - responses carry `X-Robots-Tag: noindex, nofollow`, HSTS and the app's CSP.
- On the app host, health is ok, `/` returns 200 and `/admin` returns 404.
- Not yet recorded: `existingCustomDomains` in the private workload parameters (only a
  future `create` needs it).

## Coordination

Session skynet-group-be was the sole release operator for this release, at the founder's
request. Session skynet-group-d3 held PR #21 (recovery and reset hardening) and pushed
nothing to main from merge to release.
