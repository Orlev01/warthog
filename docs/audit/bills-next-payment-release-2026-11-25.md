# Bills follow-up: Next payment, debit cards, totals — 25 November 2026

Application source `50be4ca0a638238a842f59e513d6c5352c3b60b2` is live as revision
`warthog--r45548430007a1`. It carries PR #72.

## Why

Dogfooding the Bills tab (#71) on the founder's records turned up three problems:
- Medibank renews yearly but is debited monthly, and had nowhere to keep that payment date.
- GitHub's receipt names the debit card on an ANZ account, not the account.
- "About AUD 5,060.48 a month" read as a mistake. It was mostly rent.

## What shipped

- **Next payment on every bill kind.** When set, it wins over the kind's own date, and Warthog counts
  on from it by the cycle.
- **`card_last4` on a bank account** ("Debit card (last 4)"). Paid with matches it.
- **Totals that say what's in them.** When one bill is half or more of a total, the Bills line and
  each account group name it.
- **The skill** names `next_payment` and `paid_with` once (34,857 characters). "Life admin records"
  is now version 3.

No migrations (98).

## Verification

- **Locally:** `npm test` passed 7,110 of 7,110, and `npm run typecheck` was clean.
- **PR checks:** passed for tree `8a844e2` on `node:22-bookworm-slim@sha256:be979e55…`.
- **Image:** image run 45548001670 built `…@sha256:d0d352d4…`, reusing the PR's checks.
  - **Image checks:** 98 migrations; the source hashes match.
  - **Scan:** nothing added or removed against the previous release.
- **Production:**
  - **Release run:** [45548430007](https://github.com/Orlev01/warthog/actions/runs/45548430007)
    succeeded on a fresh private runner. The plan was reviewed (11 creates, no deletes) and the VM
    verified.
  - **Result:** one healthy replica, 100% traffic, zero old replicas.
  - **Configuration:** unchanged apart from image and revision (before: `1aadbbc0…`).
  - **Probe:** 95/95 before and after.
  - **Runner:** destroyed, and the cleanup check found nothing left.
- **Live:** the founder's ANZ Access Basic got `card_last4` 6004, and Medibank got Next payment 9 Nov.
  Both wait in To check for the founder, as changes to checked records do.
