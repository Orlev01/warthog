# Policy and account numbers no longer mistaken for card numbers — 24 November 2026

Application source `0a912ec3c068b289677bdfe3e939652260fcbab5` is live as revision
`warthog--r45321866247a1`. It carries PR #60.

## Why

The founder chose "Everything" (PR #58) and asked for Life admin to be filled in. With nothing
hidden, the QBE CTP green slip email showed its policy number, 36-0107901349-8. At Standard that
number had read as `[card ••••3498]`, and saving it to Life admin cut it to its last four. It has a
Diners prefix and passes the card check digit by chance; about one long number in ten does. The
founder asked for the fix and approved its release ("merge and release").

## What shipped (PR #60)

- **A number is a card only when it's printed as cards are:** run together, in fours, or in Amex's
  4-6-5 and Diners' 4-6-4 groups (`cardGrouped`, shared by the email check and Life admin).
- **Life admin also needs a card scheme's prefix**, and keeps a policy, account or member number
  field as written. Only a banking record's reference could hold a card.
- **The email check treats a number after "insurance", "ctp" or "green slip" as a reference.**
- **Real card numbers are still hidden** however they are printed.
- **No migrations** (still 95).

## Verification

- **Locally:** 6,829 of 6,829 tests and a clean typecheck. New tests cover:
  - the QBE number with and without dashes;
  - an oddly grouped number;
  - a Luhn-valid number with no card prefix;
  - a policy number kept on a vehicle insurance record;
  - a card still cut in a record's notes and in a banking record's reference.
- **PR checks:** passed on PostgreSQL 16 after merging main (PR #59). Main `0a912ec` has exactly the
  checked tree, `469b7b52`.
- **Image:** run 45321424618 reused the checks. The image is `…@sha256:be0ce318…`.
  - linux/amd64, UID 1000, no setuid or setgid, the deletion-journal label.
  - 95 migrations, 107 catalogue entries and 81 brand marks, with the source hashes matching.
  - No advisories in application dependencies, and none added or removed against the PR #59 image.
- **Production:**
  - **Run:** [45321866247](https://github.com/Orlev01/warthog/actions/runs/45321866247) succeeded on
    a fresh private runner.
    - Its plan was reviewed: 11 creates, no deletes.
    - The VM was checked.
    - Private PostgreSQL DNS and TLS were confirmed without credentials.
  - **Result:** one healthy replica, explicit 100% traffic and zero old replicas.
  - **Configuration:** unchanged apart from image and revision. The hash before was `ebe91bbb…`.
  - **Probe:** 92/92 before and after.
  - **Runner:** destroyed, and the cleanup check found nothing left.
