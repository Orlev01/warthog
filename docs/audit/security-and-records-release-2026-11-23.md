# Rate limit before any key, addresses purged on deletion, and a readable Life admin — 23 November 2026

Application source `fadcc53bed447c08f3e6e5ecafa2f0e8716cba8a` is live as revision `warthog--r45127308436a1`. It carries PR #47 and PR #48.

## Why

- **Two Highs.** The 23 November review ([review](life-admin-profile-review-2026-11-23.md)) left
  two Highs open after PR #45:
  - expensive key work happened before rate limiting;
  - email addresses outlived account deletion.
- **Life admin was hard to read.** The founder found the page unreadable: "'Your things' is not an
  acceptable tab name … filter by all things … by a specific category … keep different statuses
  separate, I want to see what's active first and foremost and always … category and status
  should be multiple choice."
- **Approval.** The founder approved merging and releasing these together with PR #45 ("merge and
  release all three").

## What shipped

**PR #47: the two Highs** (`claude/security-highs`).
- **The rate limit comes first.**
  - The MCP dispatch counts each tool call against its agent's limit before it builds anything for
    the request, with one read of the agent's grants and no key.
  - An over-limit call gets the same refusal, counted and summarised once per burst. It unwraps no
    key, resolves no tools and reads no service.
  - Inside the pipeline, the limit now comes before the policy context.
- **A DEK cache** (design §4.1, at most 5 minutes) sits in front of the production Key Vault
  wrapper.
  - It is keyed by a SHA-256 of the wrapped value, so a rotation can't serve a stale key.
  - It holds 1,000 keys at most, gives callers copies and zeroes dropped entries.
  - Account deletion drops the person's key at once.
- **The purge deletes the address.** It now deletes the person's sign-in codes, attempts, throttle
  alerts and the household invites sent to them, by address, in the account's transaction.
  - **Migration 0120** lets the purge role read only the `email` column of those tables, and
    delete rows.
  - **An hourly `email-address-retention` sweep** deletes codes and attempts after a day, alerts
    after 90 days, and invites 30 days after they were used or lapsed.
  - **The privacy page** says so.

**PR #48: Life admin's Records tab** (`claude/life-admin-filters`).
- **Records** (was "Your things") shows what's **active first**, as one panel per category, most
  urgent first.
  - **On hold, Finished and Cancelled** are separate, quieter lists.
  - **Category** and **Status** are multiple-choice filters (GET parameters; applied on tick).
  - Rows are compact, and To check has **Accept all**.
  - Empty "Nothing here yet" panels are gone.
- **Agents with an older copy of Warthog's tools** (ChatGPT; the claude.ai connector) can only send
  `kind` and `fields`, so they put `type` and `source` inside `fields`. Their record calls are now
  lifted into today's parameters before the SDK checks them. Before, 19 of the founder's records
  landed under Other.
- **Accepting an agent's change** now moves the record to the kind, parent and state the agent
  proposed. Before, a pending change kept only fields.

**Migrations:** 0120 makes 91. There are no configuration, package or infrastructure changes.

## Verification

- **Locally:**
  - **PR #47:** 6,564 of 6,564 tests.
  - **PR #48** (stacked on #47): 6,610 of 6,610 tests, typecheck clean.
  - **Browser checks** (real Chromium, virtual passkey):
    - the Records tab at 1440px, 390px and dark mode, with and without JavaScript;
    - an older-client save filed as its kind;
    - two older records moved into their kinds, shown as "Kind: … → …";
    - "Accept all" moving them into Vehicles and Going out.
- **PR checks.** Both PRs passed on PostgreSQL 16 after rebasing onto main `755585f` (PRs #43 and
  #46 had landed). Main `fadcc53` has exactly the tree checked on #48, `fc24b27`.
- **Image.**
  - **Run 45126975623** reused the checks. The image is `…@sha256:8a7dd4de…`.
  - **Checks:** linux/amd64, UID 1000, no setuid or setgid, and the deletion-journal label. The
    source, lockfile, 91 migrations, 107 catalogue entries and 81 brand marks all match the source
    hashes.
  - **Scan:** no advisories in application dependencies, and no change against the PR #46 image.
- **Production.**
  - **Run:** [45127308436](https://github.com/Orlev01/warthog/actions/runs/45127308436) succeeded
    on a fresh private B2als_v2 runner. The runner's plan was reviewed (11 creates, no deletes).
    Before it was registered for this run only, the live VM was checked and private PostgreSQL DNS
    and TLS were confirmed.
  - **Result:** one healthy replica, explicit 100% traffic and zero old replicas.
  - **Configuration:** unchanged apart from image and revision; the hash before was `a72be2eb…`.
  - **Health:** the database reports ok, so migration 0120 is applied.
  - **Probe:** 74/74, including 3 new checks: the Records tab, with and without filters, and the old
    `?tab=things` link ask a signed-out visitor to sign in.
  - **Runner:** destroyed. The cleanup check found no group, resources, grants, subnet NAT or
    GitHub runner left.

## Follow-ups

- **All three review Highs are fixed and live** (PR #45 earlier today, and PR #47).
- **Refresh the old tool lists.** ChatGPT's and the claude.ai connector's copies of Warthog's tools
  stay old until the person refreshes or reconnects them. Their saves are now filed correctly
  either way.
- **Known limits:**
  - one mail account per service per agent;
  - PDFs aren't read;
  - no recurrence;
  - no parcels.
