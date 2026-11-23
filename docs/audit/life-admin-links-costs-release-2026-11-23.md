# Life admin: receipts and subscriptions belong to what they were for, and what you pay a month — 23 November 2026

Application source `d57f625144b9633ced7fc54233d89507dd93f906` is live as revision
`warthog--r45136369712a1`. It carries PR #49.

## Why

**The question.** After agents had filled Life admin from two of the founder's real inboxes, the
founder asked whether records should be filed by document type instead of by what they're about.

**The answer:** they stay filed by what they're about. The reasoning is now in the
[ADR](../adr/life-admin-profile.md):
- **Many documents describe one thing.**
  - The motorcycle's rego appears in three emails (a renewal notice, last year's receipt and the
    CTP purchase).
  - A Queenstown trip appears in seven.
  - AGL sends a new bill every month.
- **Agents file by subject reliably.** ChatGPT chose the right subject kind for all 19 records that
  an older tool schema had put under Other.
- **What made the page hard to read was status,** which PR #48's Records tab fixed.

**Two refinements came out of the data.** The founder approved them, and then approved merging and
releasing the PR ("You have my go ahead and approval").

## What shipped (PR #49)

- **Receipts, subscriptions and memberships can belong to any thing,** as other insurance and
  domains already can. An eSIM sits under the trip it was for, and a software plan under the
  business that pays it. The agents' skill is generated from the catalogue, so they learn this
  with no other change.
- **The Records tab says what you pay a month,** for example "You pay about AUD 161.24 and USD 16.00
  a month for 3 recurring records".
  - It counts the active, recurring records in the chosen categories.
  - It is worked out once in `src/domain/life-admin/costs.ts`, which `list_records`' `monthlyCost`
    now uses too, with no change to its output.
- **No other changes.** No migrations (still 91), and no configuration, package, infrastructure or
  MCP contract changes.

## Verification

- **Locally:** 6,619 of 6,619 tests, and typecheck clean.
- **Browser check** (real Chromium, virtual passkey, seeded through `/mcp`):
  - the receipt heads under its trip, and the subscription under its business;
  - the cost line matches what agents get for live records and leaves out a cancelled subscription;
  - the Subscriptions filter narrows it;
  - no horizontal scroll at 390px.
- **PR checks.** Passed on tree `933db1d`, after a rebase onto PR #50's record. The merge commit has
  the same tree.
- **Image.**
  - **Run 45135894852** reused the checks. The image is `…@sha256:69fbbbaf…`.
  - **Checks:** linux/amd64, UID 1000, no setuid or setgid, and the deletion-journal label. The
    source, lockfile, 91 migrations, 107 catalogue entries and 81 brand marks all match the source
    hashes.
  - **Scan:** no advisories in application dependencies, and no change against the PR #50 image.
- **Production.**
  - **Run:** [45136369712](https://github.com/Orlev01/warthog/actions/runs/45136369712) succeeded
    on a fresh private B2als_v2 runner. The runner's plan was reviewed (11 creates, no deletes).
    Before it was registered for this run only, the live VM was checked and private PostgreSQL DNS
    and TLS were confirmed.
  - **Result:** one healthy replica, explicit 100% traffic and zero old replicas.
  - **Configuration:** unchanged apart from image and revision; the hash before was `f48f2968…`.
  - **Probe:** 79/79.
  - **Runner:** destroyed. The cleanup check found no group, resources, grants, subnet NAT or
    GitHub runner left.

## Follow-ups

- **The founder's records,** done as an agent: link the Airalo NZ eSIM receipt to the Queenstown
  trip, and propose a NAVA business with GitHub Team under it.
- **PR #51** (Life admin display fixes, from another session) is next in the release queue and will
  rebase onto this.
