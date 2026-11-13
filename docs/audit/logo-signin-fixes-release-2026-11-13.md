# Logo, UI/UX follow-ups and sign-in audit fixes release — 13 November 2026

Application source `75bdbf0c708a65d42a17f56716b48bc45d635922` is live at
[app.warthog.com.au](https://app.warthog.com.au) as revision
`warthog--r43339696686a1`.

## What shipped

- **The founder's Warthog logo** (`3fb29b1`):
  - The logo replaces the shield glyph and word in the wordmark: larger at the top of
    the workspace sidebar, and header-sized on the auth, public and status screens.
  - It is a transparent asset masked with the `--wh-logo` token, so it is navy in light
    mode and near-white in dark mode. The link is still named "Warthog home".
  - The browser tab, app and touch icons use the head on a white tile: a new 32px tab
    icon, regenerated 192, 512, maskable and Apple icons, and a `favicon.ico`.
- **UI/UX follow-ups** (PR #18):
  - Replace or revoke an agent's access key.
  - Add an authenticator from Security.
  - Approve sign-ins from another device.
  - Keep the last sign-in method.
  - Name real tools and services in rule sentences.
  - Show disconnected agents as Disconnected.
- **Sign-in audit fixes** (PR #19; decision record
  [signin-audit-fixes-2026-11](../adr/signin-audit-fixes-2026-11.md)):
  - Access-key create and replace need a fresh step-up and send an email.
  - The `safeReturnPath` open redirect is closed.
  - The session token rotates when a step-up is confirmed.
  - Confirmation prompts offer only the person's own methods.
  - The release was held until these fixes landed, at the founder's direction.

No migrations, dependencies, infrastructure, workflows or delivery scripts changed since
the previous release (80 migrations).

## Verification

- [Main CI 43337351290](https://github.com/Orlev01/warthog/actions/runs/43337351290):
  **5,863 tests**, zero failures, cancellations or skips. The
  [image run 43337433020](https://github.com/Orlev01/warthog/actions/runs/43337433020)
  repeated them before publication.
- Image `crwarthogprodauee854.azurecr.io/warthog@sha256:7c03165af348f93a32258d3c433c00c1a58420c242d131b604b781980f66f41e`:
  - exact source label, pinned base, journal label `v1`, linux/amd64, UID 1000, no
    setuid/setgid;
  - all 80 migration, 106 catalogue and 80 brand file hashes match the source;
  - scan: the same 219 OS package/advisory pairs as the previous image, zero non-OS.
- [Production run 43339696686](https://github.com/Orlev01/warthog/actions/runs/43339696686)
  succeeded with no approval gate. Independent inspection: one healthy replica, exact
  image, explicit 100% traffic, zero old replicas; configuration unchanged apart from
  image and revision.
- Public checks:
  - health 200 and public pages 200;
  - signed-in routes redirect to sign-in, and unauthenticated `/mcp` returns 401;
  - the logo, `favicon.ico` and the 32px tab icon are served, and the tab icon is
    declared first.
- In the founder's signed-in browser, `/signin?next=/.//evil.example` landed on the
  founder's own `/home`, and the sidebar shows the logo in dark mode.
- Runner: fresh private lease (11 reviewed creates), destroyed after the job. The
  group, resources, grants and subnet NAT were verified absent, and no GitHub runner
  remains.

## Coordination

Three sessions worked on main today. The founder kept one release operator, and the
other sessions dispatched nothing and paused merges to main during this release.

Audit items 4 and 5 are in progress separately (recovery leaves old factors, and a
completed reset stays re-enrollable). They will ship in a later release.
