# Life admin: a change of link shown, and a past trip finished for agents — 23 November 2026

Application source `8ed9c61c2208c9391a1f3e8b53dc94d5757e7f41` is live as revision
`warthog--r45143920020a1`. It carries PR #51.

## Why

Testing the new Records tab with the founder's real data (as their agent, after PR #48) turned up
three gaps:
- **A change of link showed no detail.** A proposed link of the motorcycle's rego to the Mondial
  showed in To check as "Claude suggests a change" with no lines.
- **Agents saw the finished Queenstown trip as upcoming.** `list_records`, `get_context`'s
  counts and the hand-over worked out each record alone, so a trip had no dates.
- **Stray lines.** Records being given their kind listed ChatGPT's stray `type` and `source`
  fields as "removed".

The founder approved the follow-up ("yes please"), then its merge and release ("merge and release
#51").

## What shipped (PR #51)

- **To check shows a change of link:** "Belongs to: not linked → Mondial HPS 300", or
  "→ not linked".
- **`recordPhases` is shared.** It moves to `src/domain/life-admin/phases.ts`, and
  `list_records`, `get_context`'s summary and the hand-over all use it. A trip takes the span of
  its bookings everywhere, so a past trip is finished for agents too.
- **Stray-field lines are hidden.** When a change gives a record a kind the catalogue knows, its
  stray `type` and `source` removals no longer show.
- **No other changes.** No migrations (still 91), and no configuration, package or infrastructure
  changes.

## Verification

- **Locally:** 6,624 of 6,624 tests and a clean typecheck. After the rebase onto PR #49, the 377
  Life admin, records and `get_context` tests passed.
- **PR checks:** passed on PostgreSQL 16. Main `8ed9c61` has exactly the checked tree,
  `e9cd8a4`.
- **Image.**
  - **Run 45143439432** reused the checks. The image is `…@sha256:b4d3ccb7…`.
  - **Checks:** linux/amd64, UID 1000, no setuid or setgid, the deletion-journal label, and 91
    migrations. The source hashes match.
  - **Scan:** no advisories in application dependencies, and no change against the PR #49 image.
- **Production.**
  - **Run:** [45143920020](https://github.com/Orlev01/warthog/actions/runs/45143920020) succeeded
    on a fresh private runner. Its plan was reviewed (11 creates, no deletes), the VM was checked,
    and private PostgreSQL DNS and TLS were confirmed.
  - **Result:** one healthy replica, explicit 100% traffic and zero old replicas.
  - **Configuration:** unchanged apart from image and revision; the hash before was `e4d75131…`.
  - **Probe:** 79/79.
  - **As an agent:** `list_records` now returns the founder's Queenstown trip as completed,
    27–31 Aug.
  - **Runner:** destroyed. The cleanup check found nothing left.
