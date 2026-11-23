# The front door covers every feature shipped since launch — 23 November 2026

Application source `fd4f7b426c2467ad516c75a10bad9dbc5142dae0` is live as revision `warthog--r45133098951a1`. It
carries PR #50.

## Why

The founder: "since building Warthog we've introduced a whole bunch more features and I want to
make sure that the marketing website reflects the set of features … draft the code, change the
marketing frontend website, and release and push it."

The front door at [warthog.com.au](https://warthog.com.au) still described the launch-day product.
- Life admin was one line.
- It didn't mention cards and spending, checked email reads, undo, tasks between agents, export,
  the phone app, or that more than 100 services can be connected.

## What shipped (PR #50)

Every addition follows the page's existing patterns ([design](../design/public-front-door.md)):
- **Services:** a band like the agents band. More than 100 services, by kind, named as plain text.
  It says Google is in early access and that a missing service can be asked for.
- **Control:** a new row for what agents read (marked as written by someone else, sign-in codes
  and reset links held back, a flag on a first email to someone new). The activity row now covers
  conversations and Undo.
- **Spending:** a new section of cards.
  - A card released for one purchase, with the security code never kept.
  - Budgets checked before the person is asked.
  - A household budget.
  - The scope note says the limits cover card requests through Warthog only.
- **Your context:** four cards in pairs: memory and skills, the vault, tasks handed between agents,
  and export.
- **Life admin:** a new section with a static, labelled example of the Records list.
  - Filled in by the person's own agent from email.
  - Active first, with reminders.
  - A log any agent can continue.
  - The moving checklist.
  - The scope note says Warthog doesn't read email itself.
- **Questions:** how the phone app and notifications work. Text messages are switched off in
  production, so they aren't mentioned.
- **Section links:** they gain "Life admin".

No migrations (still 91), and no configuration, package, infrastructure or server changes. There's
no new animation and no remote assets.

## Verification

- **Locally:**
  - **Tests:** 6,620 of 6,620 tests, and typecheck clean. Seven new tests (one per feature
    section, plus a guard against promising text messages or control beyond Warthog) were written
    first.
  - **Browser:** Chromium at 1440, 768, 390 and 320px and dark mode, with no horizontal scroll.
    The "Life admin" section link lands on its heading.
- **PR checks.** Passed on PostgreSQL 16 for tree `489518c`. Main `fd4f7b4` has the same tree.
- **Image.**
  - **Run 45132430028** reused the checks. The image is `…@sha256:b369e894…`.
  - **Checks:** linux/amd64, UID 1000, no setuid or setgid, and the deletion-journal label. The
    source, lockfile, 91 migrations, 107 catalogue entries and 81 brand marks all match the source
    hashes.
  - **Scan:** no advisories in application dependencies, and no change against the PR #47 and #48
    image.
- **Production.**
  - **Run:** [45133098951](https://github.com/Orlev01/warthog/actions/runs/45133098951) succeeded
    on a fresh private B2als_v2 runner. The runner's plan was reviewed (11 creates, no deletes).
    Before it was registered for this run only, the live VM was checked and private PostgreSQL DNS
    and TLS were confirmed.
  - **Result:** one healthy replica, explicit 100% traffic and zero old replicas.
  - **Configuration:** unchanged apart from image and revision; the hash before was `a888cdde…`.
  - **Health:** the database reports ok.
  - **Probe:** 79/79, including 5 new checks on warthog.com.au.
    - The services, spending and life admin sections are present, each with its heading.
    - The section links reach Life admin.
    - The page never mentions text messages.
    - The four section checks failed against the previous release, as expected.
  - **Runner:** destroyed. The cleanup check found no group, resources, grants, subnet NAT or
    GitHub runner left.

## Follow-ups

- **PR #49** (Life admin links and monthly cost, another session's) is waiting for the founder's
  approval to merge. Its session will release it after this record.
