# Several accounts per agent, and Life admin's four tabs — 24 November 2026

Application source `873ab68f8172b88cc66cbbd48febe5d3e9c76f31` is live as revision
`warthog--r45300201976a1`. It carries PR #52 (Life admin) and PR #55 (several accounts per agent),
released together.

## Why

- **PR #55.** The founder has three Gmail accounts and wants one agent to use all of them, each
  shown as its own row in the agent's Connected services. Until now an agent was given a service and
  set to one of its accounts
  ([ADR](../adr/several-accounts-per-agent.md)).
- **PR #52.** The founder asked for Life admin to have one row of tabs (Records, Upcoming, History,
  Tasks), for the moving checklist to go, for accounts to carry their account name, number and email,
  and for "Remind me (days before)" to say plainly what it does
  ([ADR amendment](../adr/life-admin-profile.md)).

The founder approved both ("merge and release").

## What shipped

**PR #55: agents are given accounts**

- **Storage.** New table `agent_account_grants` (migration 0122).
  - One row per agent and account, with that account's own reads, changes and tools.
  - Disconnecting an account removes it from every agent by cascade, and the service's other
    accounts stay granted.
  - The backfill carries every agent's access over exactly: a service's chosen account, or its only
    account, with the service's settings. Several accounts with none chosen gave no access before
    and still give none.
- **Binding.** Every connector call is bound to one granted account before the policy runs. Tools
  stay one set per service with an optional `account` (or `query.account` from an older tool list).
  Binding never falls back to another account.
- **Mail.** A Gmail or Outlook search with no account named covers up to 5 inboxes the agent may
  read. Each inbox is checked by the policy and the result guard with its own account, and the
  results are merged.
  - Ids carry their inbox (`<handle>.<id>`), so a read or a reply goes back to the inbox that holds
    the email.
  - Replies send from that inbox.
  - The search is one activity entry and never waits for approval.
- **Screens.**
  - The agent page has one divider row per account.
  - Consent and access-key screens have one tick box per account.
  - Several accounts can be on for new agents.
  - "Used by" is shown per account.
- **Rollback.** The old service columns keep a copy for one release, refreshed after a disconnect,
  so a rollback narrows access and never widens it.

**PR #52: Life admin**

- **Tabs.** Records | Upcoming | History | Tasks. Bookings are folded into Upcoming. Older
  addresses and reminder links still open the right place.
- **Moving checklist removed.** Migration 0121 drops its table.
- **Account details.** Account kinds get account name and account email; the skill tells agents
  what to carry over.
- **Reminders.** They show only for live dated records, as a choice of days.

**Migrations:** 0121 and 0122, making 93.

## Verification

- **Locally:**
  - each PR's own suite: #52 6,593 of 6,593; #55 6,754 of 6,754;
  - #52 and #55 merged together: 6,717 of 6,717, with a clean typecheck;
  - the one conflict, two lines of the Life admin skill text, kept both PRs' changes.
- **Browser checks against `next dev`:**
  - #52: tabs, account details and reminders.
  - #55, with three stand-in Gmail accounts and one Outlook account, at 1440px, 390px and dark:
    - one row per account, and saving per-account settings;
    - one Gmail tool set taking `account`, and `get_context` listing the granted inboxes with no
      ids;
    - a search naming both inboxes;
    - a send from an account with changes off refused, and an ungranted inbox refused;
    - the access-key screen ticking accounts;
    - disconnecting one of three and keeping the others.
- **PR checks:** passed on PostgreSQL 16. Main `873ab68` has exactly the checked tree, `cc779346`.
- **Image:** run 45299659302 reused the checks. The image is `…@sha256:d97115c5…`.
  - linux/amd64, UID 1000, no setuid or setgid, the deletion-journal label;
  - 93 migrations, 107 catalogue entries and 81 brand marks, with the source hashes matching;
  - scan: no advisories in application dependencies, and none added or removed against the PR #54
    image.
- **Production:**
  - **Run:** [45300201976](https://github.com/Orlev01/warthog/actions/runs/45300201976) succeeded
    on a fresh private runner.
    - Its plan was reviewed: 11 creates, no deletes.
    - The VM was checked.
    - Private PostgreSQL DNS and TLS were confirmed without credentials.
  - **Result:** one healthy replica, explicit 100% traffic and zero old replicas.
  - **Configuration:** unchanged apart from image and revision. The hash before was `73cde64e…`.
  - **Probe:** 84/84 before and after. Five new checks confirm that signed-out visitors to the new
    Life admin tabs, the access-key screen and Connectors are sent to sign-in.
  - **Runner:** destroyed, and the cleanup check found nothing left.

## Not checked in production

- **The 0122 backfill in a real account.** It is covered by migration tests for every case; no
  database credentials were used. The founder's agents should show the same accounts allowed as
  before.
- **A search across real inboxes.** This waits on the founder turning on more than one Gmail account
  for an agent.
