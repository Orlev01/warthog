# Build your profile — 24 November 2026

Application source `01d045bf42902badfd4ac6ce337cf8ecd79b9c72` is live as revision
`warthog--r45334002203a1`. It carries PR #61 (the agent side) and PR #62 (About you suggestions, Home
and the screens), released together.

## Why

The founder asked for one step that has the person's own agent build their profile: go through
everything it can read through Warthog (not only email), fill in Life admin (every category, and new
ones it discovers) and About you, and move it to Home in place of "Add your details". Founder
decisions: Life admin and About you as suggestions the person confirms; "Build your profile" replaces
"Add your details"; safety by instruction, without a server-enforced build window
([decision record](../adr/profile-build.md)).

## What shipped

**PR #61: the agent side**

- **One prompt, one playbook.** `PROFILE_PROMPT` is the fixed text the person gives their agent, also
  served as the MCP prompt `build_profile`. The new built-in skill "Building a profile" names only
  the sources this agent can read (email, calendar and files through Warthog's own connectors),
  leans on "Life admin records", lifts three of its limits for this job only, and carries the safety
  lines word for word.
- **The offer.** `get_context` offers the build to an agent that can read email, calendar or files
  and save records, naming only those; calendar-only and files-only agents now get it.
- **Guardrails.** `remember` and task titles and notes refuse what Warthog never keeps and mask card
  numbers (so do the person's own memory edits). A suggested category about health, religion,
  politics, a union, sexuality or criminal matters is refused.

**PR #62: About you and the screens**

- **About you suggestions** (migration 0125, `identity_suggestions`). `save_record` takes `aboutYou`:
  the person's own preferred name, other email addresses, phone, postal address (with a moving
  date), time zone and language, each with a dated source from the last 12 months, from an agent
  that can read About you. They're encrypted and invisible to every agent until the person adds them
  on About you, one at a time ("Not mine" stops a repeat). At most 20 wait; the agent gets one
  neutral answer.
- **Home.** "Build your profile" is step 3, done once the person checks something an agent found
  (or keeps 5 records). Its block names the agent and what it can read with "Copy for <agent>", says
  what's missing, or how much waits to check. "Connect a service" counts only a service an agent can
  read.
- **Life admin.** The Add tab's prompt works across services and links an empty Life admin to Home.
  To check groups a build's suggestions by category, each with its own "Confirm all".
- **Review fixes:** safer About you input, no stuck Home step, one-of-a-kind details replaced not
  duplicated, `+61` phones matched, the sensitive check limited to agents' new suggestions, the source
  check counting the same organisation's subdomains (never a public suffix), and approval previews
  showing About you details.

**Migrations:** 0125, making 96.

## Verification

- **Locally:** 6,922 of 6,922 tests on #61 and #62 together, with a clean typecheck and build.
- **Browser check against `next dev`** (Playwright, virtual passkey, 390px and 1280px, light and
  dark), on a fresh account and a stand-in Gmail account:
  - no block before an agent; "Claude can't read anything yet" with a link to its Connectors;
  - ready: "Copy for Claude" copies exactly the prompt; the agent gets the offer and the skill;
  - the agent saves 3 records and 3 About you details; Home says 6 to check;
  - About you lists them with their sources; Add and Not mine work, and a declined detail isn't
    suggested again; only the added one reaches agents;
  - To check is grouped by category; confirming a group completes the step;
  - `remember` refuses a tax file number without echoing it; no sideways scroll or page errors.
- **Code review:** both PRs; the fixes are in `bc8a218`.
- **PR checks:** passed on PostgreSQL 16; main `01d045b` has the checked tree, so the image run
  reused the checks.
- **Image:** run 45333623870, `…@sha256:d65f8466…`:
  - linux/amd64, UID 1000, no setuid or setgid, the deletion-journal label;
  - 96 migrations, 107 catalogue entries and 81 brand marks, with the source hashes matching;
  - scan: no advisories in application dependencies, and none added or removed against the PR #60
    image.
- **Production:**
  - **Run:** [45334002203](https://github.com/Orlev01/warthog/actions/runs/45334002203) succeeded on
    a fresh private runner. Its plan was reviewed (11 creates, no deletes), the VM checked, and
    private PostgreSQL DNS and TLS confirmed without credentials.
  - **Result:** one healthy replica, explicit 100% traffic and zero old replicas.
  - **Configuration:** unchanged apart from image and revision. The hash before was `8c889b87…`.
  - **Probe:** 92/92 before and after.
  - **Runner:** destroyed, and the cleanup check found nothing left.

## Not checked in production

- **A real build with the founder's agent.** The founder copies the prompt from Home into their own
  agent; Warthog's own checks never use the production MCP tools.
- **Existing accounts:** "Finish setting up" reappears for an account that hasn't built a profile (or
  keeps fewer than 5 records), and "Connect a service" now needs an agent that can read it — both on
  purpose.
