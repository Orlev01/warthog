# The Bills tab — 25 November 2026

Application source `27ff35f2a7d8c648ea0b62ecf2e3b23031071b17` is live as revision
`warthog--r45537740803a1`. It carries PR #71.

## Why

The founder asked for "a place to see all those recurring bills and the date they are due and the
accounts they are going to come out of and the emails associated with them". They chose a tab of its
own, grouped by date, with a switch to group by account.

Before this:
- a record had one date, which for rent, utilities and phones is when the contract ends;
- nothing said which card pays a bill;
- the monthly figure counted income and left out card annual fees.

## What shipped

- **A Bills tab after Upcoming:**
  - **By date:** Overdue, Next 30 days, Later, Date not known yet.
  - **By account** (`?bills=account`): with monthly subtotals per currency, and a warning when a
    closed card still pays a bill.
  - Rows keep their Details and Edit, and saving returns to Bills.
  - Paid with suggests the person's open cards and accounts.
  - There is a "Fill in my bills" prompt to copy for an agent.
- **29 bill kinds** in the catalogue:
  - every one has the account fields and `paid_with`;
  - kinds whose own date isn't the payment also have `next_payment`.
- **One rule (`src/domain/life-admin/bills.ts`)** for what is a bill, its monthly cost, the next
  payment and the account it comes out of:
  - Payments are counted on from a date along the bill's cycle and marked estimated.
  - A bill the person pays by hand stays overdue for 30 days.
  - Paid with is linked to an account only when exactly one fits.

  The Records cost line and `list_records`' `monthlyCost` use the same rule (live bills only).
- **`list_records view: "bills"`**, matched only against what the agent may see.
- **The skill:** bill kinds are marked `[bill]`, and "Life admin records" is now version 2 (34,927
  characters).
- **Amounts** show thousands separators.
- **Docs:** the ADR has a new section, "The Bills tab (amended 25 November 2026)", and `brief.yaml`
  now has six tabs.

No migrations (98).

## Verification

- **Locally:**
  - `npm test` passed 7,109 of 7,109, and `npm run typecheck` was clean.
  - A Playwright browser check passed 25 of 25 on a fresh account seeded through real MCP calls: both
    groupings, the overdue rego, an estimated date, the closed-card warning, editing Paid with from a
    Bills row and returning to Bills, at desktop, 390px and dark mode with no sideways scroll.
- **PR checks:** passed for tree `2206293` on `node:22-bookworm-slim@sha256:be979e55…`.
- **Image:** image run 45537364990 built `…@sha256:f1aa3cc2…`, reusing the PR's checks.
  - **Image checks:** linux/amd64, UID 1000, no setuid or setgid; 98 migrations; the source hashes
    match.
  - **Scan:** no application advisories. The diff is a Trivy database update with no package change
    (`scan-delta-note.json`):
    - the login/passwd advisory moved from TEMP-1154946-473926 to CVE-2026-135901;
    - CVE-2026-40228 no longer lists libsystemd0 and libudev1.
- **Production:**
  - **Release run:** [45537740803](https://github.com/Orlev01/warthog/actions/runs/45537740803)
    succeeded on a fresh private runner. The plan was reviewed (11 creates, no deletes), the VM
    checked, and private PostgreSQL confirmed.
  - **Result:** one healthy replica, 100% traffic, zero old replicas.
  - **Configuration:** unchanged apart from image and revision (before: `5dd1f546…`).
  - **Probe:** 95/95 before and after.
  - **Runner:** destroyed, and the cleanup check found nothing left.
- **Live, through the founder's connector:** `list_records view: "bills"` on the founder's records
  returned 17 bills (AUD 5,085.07 and USD 16 a month). The rego was overdue, the Westpac Altitude fee
  was charged to the card itself, 12 bills had no date yet and 16 had no Paid with.

## Not done

- The item page's own Edit form doesn't suggest cards for Paid with.
- Estimated dates don't move reminders.
