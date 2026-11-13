# Recovery and reset hardening release — 13 November 2026

Application source `1faf694339b9f76ab12bddcb989c65e55e49078e` is live at
[app.warthog.com.au](https://app.warthog.com.au) as revision
`warthog--r43398915940a1`. It follows the
[admin portal release](admin-portal-release-2026-11-13.md) by about an hour.

## What shipped

- **Recovery and reset hardening** (PR #21, sign-in audit items 4–6; decisions in
  [signin-audit-fixes-2026-11](../adr/signin-audit-fixes-2026-11.md)):
  - Account recovery removes the lost sign-in methods at the passkey step.
  - A recovery's passkey step is refused for an account deleted mid-recovery.
  - A completed reset sends an alert, can be closed by the owner, and its re-enrolment
    window is 7 days instead of 30.
  - Members can remove their authenticator app from Settings › Security.
  - The recovery review points at Agents for Disconnect.
- No migrations (still 83), dependencies, infrastructure, workflows or delivery scripts
  changed. `closed` is a new value in the unconstrained `account_resets.status` column.
- Deploy-time effect, accepted by the founder before release: a reset already completed
  before this deploy keeps its `requested_at`, so its re-enrolment window became 7 days.

## Verification

- [Main CI 43393577895](https://github.com/Orlev01/warthog/actions/runs/43393577895):
  **6,015 tests**, zero failures. The
  [image run 43396448407](https://github.com/Orlev01/warthog/actions/runs/43396448407)
  repeated them before publication.
- Image `crwarthogprodauee854.azurecr.io/warthog@sha256:5692a39729539f40993199c1ef69fe370f79cab22205ff01f476680495528b4f`:
  - exact source label, pinned base, journal label `v1`, linux/amd64, UID 1000, no
    setuid/setgid;
  - all 83 migration, 106 catalogue and 80 brand file hashes match the source;
  - scan: the same 219 OS package/advisory pairs as the admin portal image, none added,
    zero non-OS.
- [Production run 43398915940](https://github.com/Orlev01/warthog/actions/runs/43398915940)
  (`update`, expected configuration `7838c0e1…`) succeeded. Independent inspection: one
  healthy replica, exact image, explicit 100% traffic, zero old replicas, configuration
  unchanged apart from image and revision.
- Public checks:
  - health 200 with config and database ok;
  - public, recovery and help pages 200;
  - `/admin` on the app host 404;
  - signed-in routes redirect to sign-in;
  - unauthenticated `/mcp` returns 401.
- Runner: fresh private lease (11 reviewed creates, plan `ef3f05bb…`), private Postgres
  TLS checked without credentials, destroyed after the job. The group, resources, grants
  and subnet NAT were verified absent, and no GitHub runner remains.

## Coordination

Session skynet-group-d3 built PR #21 and the founder merged it. Session skynet-group-be
released it as the sole release operator. The `admin.warthog.com.au` binding still waits
for its DNS records and will run only between releases.
