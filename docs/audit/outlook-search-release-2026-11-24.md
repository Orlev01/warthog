# Outlook search paging — 24 November 2026

Application source `4351664dc661886c41c9d499b70ed25ffeb234e6` is live as revision
`warthog--r45344965311a1`. It carries PR #63, which makes Outlook search actually search and lets it
page past its first page.

## Why

Filling in Life admin from the founder's Outlook inbox turned up four problems with Outlook search,
each checked against Microsoft Graph through the live connector:

1. **Search words that weren't wholly quoted were ignored, with no error.** `invoice OR receipt`
   gave the 25 newest emails, exactly as with no search, and the agent took every one for a match.
2. **A search couldn't get past its first page.** Graph pages a search with `$skiptoken`, which
   Warthog dropped, so the agent got page 1 again; `$skip`, which the tool description named, is
   refused with search words; and the top-up of a short page across several inboxes never ran.
3. **`$filter` or `$orderby` with a search is refused by Graph,** though the tool description said
   they combine.
4. **A read that the service refused said "Check the activity record before retrying a change",**
   which is wrong for a read.

## What shipped

- **Quoting:** search words go to Graph as one quoted string, with any quote inside escaped. Words
  already quoted are sent unchanged.
- **Paging:** `$skiptoken` is allowed (decoded if copied URL-encoded, and its format checked). The
  checked view gives the next page as `nextSkipToken` (a search) or `nextSkip` (a listing), and the
  text says how to ask for it. Across several inboxes, each inbox's next page and the top-up use the
  token.
- **Clear refusals before any request:** `$search` with `$filter` or `$orderby` points to a date in
  the words (`received>=2026-11-01`, checked live); `$search` with `$skip` points to `$skiptoken`.
- **Read failures** now say the service answered with an error and that nothing changed, because it
  was a read. Changes keep their wording.
- **Docs:** the tool description and `docs/adr/read-side-protection.md`.

**Migrations:** none (still 96).

## Verification

- **Locally:** 6,926 of 6,926 tests and a clean typecheck.
- **PR checks:** passed on PostgreSQL 16. Main `4351664` follows a docs-only record commit, so its
  tree differs from the PR's and the image run ran the full checks again; they passed.
- **Image:** run 45343433419, `…@sha256:27bb2f86…`:
  - linux/amd64, UID 1000, no setuid or setgid, the deletion-journal label;
  - 96 migrations, 107 catalogue entries and 81 brand marks, with the source hashes matching;
  - **base:** `node:22-bookworm-slim@sha256:170fab70…`, the current official tag (upstream moved it
    from `e9f565d3…` since the last release; the PR's checks ran on it);
  - scan: no advisories in application dependencies, and none added or removed against the PR #61–#62
    image.
- **Production:**
  - **Run:** [45344965311](https://github.com/Orlev01/warthog/actions/runs/45344965311) succeeded on
    a fresh private runner. Its plan was reviewed (11 creates, no deletes), the VM checked, and
    private PostgreSQL DNS and TLS confirmed without credentials.
  - **Result:** one healthy replica, explicit 100% traffic and zero old replicas.
  - **Configuration:** unchanged apart from image and revision. The hash before was `b62d555b…`.
  - **Probe:** 92/92 before and after.
  - **Runner:** destroyed, and the cleanup check found nothing left.

## Not checked in production

- **A search through the founder's agent.** Warthog's own checks never use the production MCP tools.
  The next Life admin pass over Outlook is the real check: a multi-word search returns only matches,
  and its second page is new mail.
