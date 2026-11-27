# Using Warthog v3: old tool lists and services through Warthog — 27 November 2026

Application source `acc95043cc443bb2b0b1a6d9fe4384b75d27999f` is live as revision
`warthog--r45953930855a1`. It carries PR #75.

## Why

ChatGPT told the founder that Warthog couldn't save a skill or create an Outlook calendar event,
though get_context allowed both. It then suggested connecting ChatGPT's own Outlook Calendar
integration instead. ChatGPT was using a copy of Warthog's tool list from before 24 November, which
has no `save_skill`, `find_tools` or `call_tool`. The founder wants Warthog to be the one place
where their services and permissions are managed.

Routing Warthog's own tools through `call_tool` was considered and not built. It would blur
Activity, approval wording and the change-warning annotations apps rely on, and would tie Warthog to
one app's caching. The ADR (`docs/adr/editable-builtin-skills.md`) records the reasoning.

## What shipped

The house skill, Using Warthog, is at version 3, with two new lines under "Before you act":
- **Old tool list:** if `find_tools` and `call_tool` aren't in the agent's tool list either, or
  get_context allows something it has no tool for, its app has an old copy of Warthog's tools. It
  asks the person to refresh Warthog in the app's settings, or to reconnect, and doesn't say Warthog
  can't do it.
- **Through Warthog:** the agent uses the person's services through Warthog so their approvals, rules
  and Activity apply. When a service connected in Warthog is off for it, it says what to change in
  Warthog, rather than suggesting the person connect that service to the app as well.

These lines reach an agent with a stale tool list through get_context's `instructions`, which every
agent already calls first. A person who edited Using Warthog keeps their wording and is offered the
new version on Skills, as with any version change.

No migrations (99).

## Verification

- **Locally:** `npm test` passed 7,136 of 7,136, and `npm run typecheck` was clean. A new
  `house.test.ts` pins the two lines and checks they appear in get_context's instructions; the
  guidance pin is repinned at version 3.
- **PR checks:** passed for tree `25859680` on `node:22-bookworm-slim@sha256:be979e55…`. Main's tree
  after the merge is the same.
- **Image:** image run 45953540331 built `…@sha256:2e717607…`, reusing the PR's checks.
  - **Image checks:** 99 migrations, 107 catalogue entries and 81 brands; the source hashes match.
  - **Scan:** nothing added or removed against the previous release.
- **Production:**
  - **Release run:** [45953930855](https://github.com/Orlev01/warthog/actions/runs/45953930855)
    succeeded on a fresh private runner. The plan was reviewed (11 creates, no deletes) and the VM
    verified.
  - **Result:** one healthy replica, 100% traffic, zero old replicas.
  - **Configuration:** unchanged apart from image and revision (before: `137416dd…`). LinkedIn is
    still off.
  - **Probe:** 96/96 before and after.
  - **Agents:** get_context on production returns both new lines in `instructions`.
  - **Runner:** destroyed, and the cleanup check found nothing left.
