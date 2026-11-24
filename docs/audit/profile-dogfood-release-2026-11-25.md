# Fixes from dogfooding Build your profile — 25 November 2026

Application source `8771b03d97223e4b3753b210b803185b65d0c4fa` is live as revision
`warthog--r45509554516a1`. It carries PRs #65 and #66.

## Why

The founder ran "Build your profile" with Claude (Claude Code) on their own account. The build
worked:
- 5 Life admin records and 7 About you suggestions were saved;
- `aboutYou` was accepted, even though the client showed an older copy of the tool's schema.

It also turned up the problems below.

## What shipped

- **PR #65:**
  - **`create_task`'s assignee:**
    - it takes "me", an agent's name or its id;
    - a name two agents share is refused rather than guessed;
    - the field says what it takes.

    An agent passing its own name had been refused.
  - **Tax and government search:** it now searches by sender (ato.gov.au, my.gov.au,
    servicesaustralia.gov.au) instead of matching the word "fine".
  - **Outlook guidance:** the searches' heading says how to search Outlook.
  - **`list_records` view "categories":** gives each category's record count.
  - **`log_activity`:** answers `{status, occurredAt}` instead of the stored entry, which included
    the person's user id and the audit chain's hashes.
- **PR #66:** the Outlook calendar list.
  - **Before:** it returned raw Graph JSON with full HTML bodies (112,000 characters, cut off after 8
    events) and ignored the date window.
  - **Now:** it reads `calendarView` over a window (90 days ahead by default, up to 3 years). It
    fetches only the fields needed (`$select`), sorts by start and returns a compact checked view.

No migrations (96).

## Verification

- **Locally:** `npm test` passed 6,934 of 6,934 tests on #65 and 6,937 of 6,937 on #66;
  `npm run typecheck` was clean on both.
- **Image:** image run 45507629454 built `…@sha256:dcdcd835…` on
  `node:22-bookworm-slim@sha256:be979e55…`. The image run re-ran the full checks on the merged tree.
  - **Image checks:**
    - linux/amd64, UID 1000, no setuid or setgid, with the deletion-journal label;
    - 96 migrations, 107 catalogue entries and 81 brand marks;
    - the source hashes match.
  - **Scan:**
    - no application-dependency advisories;
    - one new OS advisory, CVE-2026-124851 in libzstd1. It was published 24 Nov 2026, is unrated,
      and has no fixed version. It comes from the base image (`scan-delta-note.json`).
- **Production:**
  - **Release run:** [45509554516](https://github.com/Orlev01/warthog/actions/runs/45509554516)
    succeeded on a fresh private runner. The plan was reviewed (11 creates, no deletes), the VM
    checked, and private PostgreSQL DNS and TLS confirmed without credentials.
  - **Result:** one healthy replica, 100% traffic, zero old replicas.
  - **Configuration:** unchanged apart from image and revision (before: `eebd9073…`).
  - **Probe:** 92/92 before and after.
  - **Runner:** destroyed, and the cleanup check found nothing left.
