# Skills: Warthog's skills as cards, and a Show filter — 27 November 2026

Application source `6f5ddb7d3b854f9d82ccf1de283258a049df7f6b` is live as revision
`warthog--r45914516521a1`. It carries PR #74.

## Why

The founder prefers how their own skills look and work: a card each, opening an editor with
Preview, Edit and Agent access. Warthog's 17 skills were a long list in which each control opened
in place. The founder asked for one consistent way of working, and for the library's filter to
narrow it to their own skills or Warthog's.

## What shipped

- **Cards:** Warthog's skills are cards under their groups, the same card as the person's own
  skills, which now sit under "Your skills".
- **One editor:** a card opens the dialog the package editor uses.
  - Preview, Edit, and Agent access (on or off and which agents, saved together through the new
    `access` change).
  - Restore and Remove sit in the footer, confirmed in the dialog.
- **Show filter:** the library's filter, which was "Availability", is now "Show". Its options are
  All, Switched on, Switched off, Yours and Warthog's.
- **Counts:** the header and "Showing N of M" count both kinds.
- **Removed:** the per-skill forms that worked without JavaScript (`warthog-form.ts`, `?skill=`).

No migrations (99).

## Verification

- **Locally:**
  - `npm test` passed 7,133 of 7,133, and `npm run typecheck` was clean.
  - A Playwright browser check passed 30 of 30. It covered cards, every Show option, search, and
    edit/save, Escape, Restore, Agent access, Remove and Restore. It also checked focus return,
    390 px in dark mode, and the console.
- **PR checks:** passed for tree `ee9c7a15` on `node:22-bookworm-slim@sha256:be979e55…`. Main's tree
  after the merge is the same.
- **Image:** image run 45914225485 built `…@sha256:cd17d05f…`, reusing the PR's checks.
  - **Image checks:** 99 migrations, 107 catalogue entries and 81 brands; the source hashes match.
  - **Scan:** nothing added or removed against the previous release.
- **Production:**
  - **Release run:** [45914516521](https://github.com/Orlev01/warthog/actions/runs/45914516521)
    succeeded on a fresh private runner. The plan was reviewed (11 creates, no deletes) and the VM
    verified.
  - **Result:** one healthy replica, 100% traffic, zero old replicas.
  - **Configuration:** unchanged apart from image and revision (before: `10c38e56…`). LinkedIn is
    still off.
  - **Probe:** 96/96 before and after.
  - **Runner:** destroyed, and the cleanup check found nothing left.
