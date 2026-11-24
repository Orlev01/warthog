# Build your profile: the step's row always lands somewhere — 24 November 2026

Application source `d5b5b2ac540f9699a9f25d865590834f581c82f3` is live as revision
`warthog--r45368148441a1`. It carries PR #64.

## Why

The founder reported that clicking "Build your profile" on Home only changed the address to
`/home#build-profile`: nothing on the screen moved. The row links to Home's block, which wasn't on
the page once the step was done (they keep 5 or more confirmed records), before any agent was
connected, or when no agent was connected yet. Once the step was done, the full prompt also had no
home.

## What shipped

- **Life admin's Add tab** has a permanent "Build your whole profile" panel, first: who can run the
  build and what it can read, with "Copy for <agent>", or what's missing and where to fix it. The
  build can be run again any time to fill gaps.
- **The row follows the step:** to Home's block while it's to do, to the Add tab once done.
- **Home's block shows in every state** while the step is to do, including before an agent is
  connected.
- **The block outlines itself** where a link lands (`:target`), so a click always visibly does
  something.

No migrations (96).

## Verification

- **Locally:** 6,926 of 6,926 tests, a clean typecheck.
- **Browser check against `next dev`** on a fresh account: before an agent, with an agent, and after
  5 confirmed records, the row lands on a visible, outlined block; once done it opens Life admin's Add
  tab on "Build your whole profile". No page errors.
- **PR checks:** passed on PostgreSQL 16 (on the new base `node:22-bookworm-slim@sha256:170fab70…`).
- **Image:** run 45346845321 ran the full checks on the merged tree (`2fb5018c`). The image is
  `…@sha256:9db5f74c…`:
  - linux/amd64, UID 1000, no setuid or setgid, the deletion-journal label;
  - 96 migrations, 107 catalogue entries and 81 brand marks, with the source hashes matching;
  - scan: no advisories in application dependencies. One OS advisory (CVE-2026-121757 in libc 2.36-9+deb12u14)
    was re-rated from unknown to medium by the scanner's database; the package didn't change
    (`scan-delta-note.json`).
- **Production:**
  - **Run:** [45368148441](https://github.com/Orlev01/warthog/actions/runs/45368148441) succeeded on
    a fresh private runner (plan reviewed: 11 creates, no deletes; VM checked; private PostgreSQL DNS
    and TLS confirmed without credentials).
  - **Result:** one healthy replica, explicit 100% traffic and zero old replicas.
  - **Configuration:** unchanged apart from image and revision. The hash before was `ff831dff…`.
  - **Probe:** 92/92 before and after.
  - **Runner:** destroyed, and the cleanup check found nothing left.
