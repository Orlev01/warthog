# Service emails, not marketing — 25 November 2026

Application source `e43fac059e9d4b1d181489dd2aa70e49b11157a1` is live as revision
`warthog--r45513459399a1`. It carries PR #67.

## Why

The founder asked why Life admin had found only their NAB card. They hold accounts with Macquarie,
Westpac, NAB, ANZ, ING, CommBank and Wise, and closed an Amex and an ANZ card. The causes:

- the banking search's words ("annual fee", "balance transfer") matched NAB's offers, not account
  emails;
- no rule told agents to pass over marketing;
- a bank record without its last 4 had no match key, so every scan would add it again.

## What shipped

- **Searches:**
  - every Gmail recipe leaves out the Promotions tab;
  - banking searches subjects: statement notices over 7 months, and welcome, approval and closure
    emails over 2 years;
  - the Outlook note says how to drop that and write `subject:` searches.
- **"Which emails to read":**
  - read service emails, not marketing;
  - a marketing email only shows the person is a customer;
  - search a newly seen provider by sender;
  - page on when an inbox has more.

  The "newest email" rule became "newest service email", and closed accounts are saved as cancelled.
  The rules are guidance, not fixed rules, as agreed with the built-in skills work.
- **Matching:** bank accounts, cards, loans and mortgages fall back to provider + name when a save
  has no last 4. Records saved earlier with no key are found through it.
- **Size guard:** the skill's guard moves from 33,000 to 35,000 characters.
- **ADR:** `docs/adr/life-admin-profile.md` is amended.

No migrations (96).

## Verification

- **Locally:** `npm test` passed 6,944 of 6,944 tests, and `npm run typecheck` was clean.
- **PR checks:** passed for tree `f801b0e` on `node:22-bookworm-slim@sha256:be979e55…`.
- **Image:** image run 45513005621 built `…@sha256:13a9cd6d…` on that base, reusing the PR's
  passing checks.
  - **Image checks:**
    - linux/amd64, UID 1000, no setuid or setgid, with the deletion-journal label;
    - 96 migrations, 107 catalogue entries and 81 brand marks;
    - the source hashes match.
  - **Scan:** no application-dependency advisories, and nothing added or removed against the
    previous release.
- **Production:**
  - **Release run:** [45513459399](https://github.com/Orlev01/warthog/actions/runs/45513459399)
    succeeded on a fresh private runner. The plan was reviewed (11 creates, no deletes), the VM
    checked, and private PostgreSQL DNS and TLS confirmed without credentials.
  - **Result:** one healthy replica, 100% traffic, zero old replicas.
  - **Configuration:** unchanged apart from image and revision (before: `2e5393a8…`).
  - **Probe:** 92/92 before and after.
  - **Runner:** destroyed, and the cleanup check found nothing left.
- **Live, through the founder's connector:**
  - `get_skill` returns the new "Which emails to read" section and the subject-based banking
    searches.
  - A re-save of the founder's Wise record, saved this morning with no last 4 and no key, was
    matched (`skipped`) rather than copied.
  - The two banking searches, run on the founder's seven inboxes, found every bank but Wise, and
    both closures.

## Not done

- Wise sends no statements or welcome emails in that window, so neither banking search finds it. An
  agent finds it only by searching the sender.
- Outlook has no Promotions filter, so there agents rely on the reading rules alone.
