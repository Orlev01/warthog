# What agents see, and fuller searches across inboxes — 24 November 2026

Application source `460ae18114b2f1dd7f4a33cd83ed4b14e81ee1a0` is live as revision
`warthog--r45314256670a1`. It carries PR #58.

## Why

The founder used PR #55 on seven Gmail inboxes, an Outlook mailbox and Outlook Calendar to fill in
Life admin. That surfaced five issues. The founder also asked for control over what Warthog hides:
"for me personally, im happy for everything to be brought through, others may want to filter … just
selecting from an option set". They approved the release ("merge and release").

## What shipped (PR #58)

**What agents see (Settings › Agent defaults).** One setting per person, with three levels (amended
[read-side protection ADR](../adr/read-side-protection.md)):

| Level | What it does |
|---|---|
| Private | Also hides tax file, Medicare, passport, licence, BSB and account-type numbers. |
| Standard | Today's behaviour, and the default. |
| Everything | Shows email and files as written, sign-in codes and reset links included, with a plain warning. |

- Every level still removes invisible characters and marks content as written by others, and
  "recently read" still asks.
- The level is read on every call, and an approved request uses the current level.
- Agents can't set it.
- Evidence shows the level when it isn't Standard, and a change is recorded as "from → to".
- Storage: `read_settings` (migration 0124).

**Fixes from using it.**
- A search across inboxes fills the room an empty inbox leaves from the inboxes that have more.
- One search covers up to 10 inboxes (was 5).
- `find_tools` and `call_tool` are always offered, so an app holding an older tool list can reach a
  service granted since.
- "ACCOUNT 7126 417 273" is no longer masked as a sign-in code.
- The save hint names only the missing identity fields.
- A one-inbox search names its inbox on each email.

Migrations: 0124, making 95.

## Verification

- **Locally:** 6,826 of 6,826 tests and a clean typecheck, on main `49a0af8`.
  - New tests cover:
    - each level, including a sign-in email held back at Standard and shown at Everything, end to end;
    - that an agent can't set its own level;
    - an approved request using the current level;
    - page filling;
    - the 10-inbox limit;
    - `call_tool` reaching a tool;
    - the AGL text.
  - Browser check of the settings panel (local `next dev`, at 1440px, 390px and dark):
    - three choices, with Standard chosen to begin with;
    - Everything shows its warning;
    - the choice saves;
    - Activity shows the change;
    - no overflow at 390px.
- **PR checks:** passed on PostgreSQL 16. Main `460ae18` has exactly the checked tree, `5c6554cf`.
- **Image:** run 45313844684 reused the checks. The image is `…@sha256:8209ce94…`.
  - linux/amd64, UID 1000, no setuid or setgid, the deletion-journal label.
  - 95 migrations, 107 catalogue entries and 81 brand marks, with the source hashes matching.
  - Scan: no advisories in application dependencies, and none added or removed against the PR #56/#57
    image.
- **Production:**
  - **Run:** [45314256670](https://github.com/Orlev01/warthog/actions/runs/45314256670) succeeded on a
    fresh private runner.
    - Its plan was reviewed: 11 creates, no deletes.
    - The VM was checked.
    - Private PostgreSQL DNS and TLS were confirmed without credentials.
  - **Result:** one healthy replica, explicit 100% traffic and zero old replicas.
  - **Configuration:** unchanged apart from image and revision. The hash before was `ef35bf11…`.
  - **Probe:** 88/88 before and after. The new check: signed-out `/settings/agents` goes to sign-in.
  - **Runner:** destroyed, and the cleanup check found nothing left.

## Not checked in production

- **The founder choosing Everything** and an agent then reading a sign-in email. This is covered by
  the end-to-end tests.
- **A search across seven real inboxes after the fill change.** It waits on the founder's next use.
