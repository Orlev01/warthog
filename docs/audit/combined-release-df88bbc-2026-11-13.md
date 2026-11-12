# Combined release with deletion journal activation — 13 November 2026

Application source `df88bbcc193465130873781294774d9028e36404` is live at
[app.warthog.com.au](https://app.warthog.com.au) as revision
`warthog--r43217944024a1`. This is the first release of an image that carries the
deletion journal contract (`io.warthog.deletion-journal=v1`), so it ran as an
`update` with the separately approved one-time `activate_deletion_journal=true`.
The founder named Claude the sole release operator; Codex prepared the activation
handoff and did not dispatch, approve or provision anything for this release.

## What shipped

- **Brand marks, accent and connector modules** (`820e886`, `b779596`): each
  connected service on an agent's Connectors section is a collapsible module with
  its own mark, access badge, account and a live read/change/tool summary; official
  marks for Google and Microsoft services and agents, one restrained indigo accent
  with semantic tones. See [ADR](../adr/brand-marks-and-accent.md).
- **Whole-app UI/UX pass** (PR #17): see
  [uiux-pass-2026-11-12](uiux-pass-2026-11-12/review.md).
- **Account deletion journal and recovery** (PRs #9, #10, #12, #15, #16): Next.js
  16 and TypeScript upgrade; deletion evidence preserved across isolated database
  recovery; foundation apply bound to reviewed changes; recovery cost tests. See
  [recovery-storage-2026-11-12](recovery-storage-2026-11-12.md).

No migration files changed since the live release (78 migrations).

## Activation scope

The release added exactly one setting, `DELETION_JOURNAL_CONTAINER=account-deletions`,
alongside the image, revision suffix and traffic. The deploy script and an
independent inspection both confirmed that nothing else in the app configuration
changed. Before activation, a read-only recheck at 12:12 and again at 20:35 UTC
passed all 15 storage checks: versioning, 14-day blob and container soft delete,
no permanent delete, locked 42-day journal retention, no protected append, private
container, receipt-only lifecycle, no shared-key or anonymous access, default-deny
network rules, an add-only writer role, exactly one new app grant at the container
scope, and unchanged existing grants. Codex's completed write/deny probe evidence
was kept, not repeated.

At startup the app writes the journal's first `coverage.json` marker before the job
scheduler starts; the new revision logged the scheduler start at 20:43:05 UTC with
no errors. Older images without journal support must not resume deletion writes.

## Verification

- [Main CI 43208595050](https://github.com/Orlev01/warthog/actions/runs/43208595050)
  and the [pinned-image run 43210744745](https://github.com/Orlev01/warthog/actions/runs/43210744745):
  **5,685 tests** each, zero failures, cancellations or skips.
- Image `crwarthogprodauee854.azurecr.io/warthog@sha256:bf1b74a09d3a235a58887ec8f027c2f7f0032d434795fd542b368d2ec9a78b18`:
  exact source label, reviewed `node:22-bookworm-slim@sha256:5ec23b7c…` base,
  journal label `v1`, linux/amd64, UID 1000, no setuid/setgid; all 78 migration,
  106 catalogue and 80 brand file hashes match the source. Scan: 219 OS
  package/advisory pairs (1 critical, 34 high, 95 medium, 85 low, 4 unknown), zero
  non-OS, identical to the previous live image.
- [Production run 43217944024](https://github.com/Orlev01/warthog/actions/runs/43217944024)
  succeeded after the founder approved both protected environments in GitHub.
  Independent inspection: one healthy replica, exact image, explicit 100% traffic,
  zero old replicas.
- Public checks after release: health 200; public pages 200; signed-in routes
  redirect to sign-in; unauthenticated `/mcp` returns 401; brand marks served as
  `image/svg+xml`. Production signed-in pages were not exercised.

## Release operation notes

- A second Claude session dispatched an image-only release (run 43216615766) of
  the same image a minute after publication. At the founder's direction it was
  cancelled before approval; that session destroyed its runner lease and the
  cleanup was independently verified before this release's runner was created.
- The production approval arrived after the first runner lease had expired
  (15:29 UTC) and the VM had shut down. That lease was destroyed and a fresh
  three-hour lease with the same reviewed profile (11 creates, no public NIC,
  deny-all inbound) was created for the waiting job rather than restarting the
  expired VM.
- After the job, the lease group, resources, role grants and subnet NAT were
  verified absent, no GitHub runner remains, and the ephemeral keys were deleted.

## Still separate

The Azure recovery drill (clone, synthetic fixture execution, original-journal
reader and firewall exception) remains unapproved; its refreshed source artifacts
are ready but nothing has run.
