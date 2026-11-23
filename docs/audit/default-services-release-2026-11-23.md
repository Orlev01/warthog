# Services on for new agents, and reads kept on after the first grant — 23 November 2026

Application source `742d8811b479fda75b766f62b143bd1e83dd6c78` is live as revision
`warthog--r45121816498a1`. It carries PR #43.

## Why

The founder connected Meta's Muse and expected it to reach the services already connected in
Warthog. It reached none of them:

- **Nothing was ticked.** The consent screen never ticks a service, so an agent approved without
  ticking one gets none. With several agents and the same few services, every new agent needed
  the same clicks.
- **Granting afterwards gave no tools.** An agent connected with no services stores its "Defaults
  for every service" as reads off and changes off. The Connectors section of the agent's page always
  sends those two controls as shown, so ticking a service there said "can use it" while the agent
  was served none of its tools.

The founder asked to "fix the bug" and to add a switch under Connectors › Your services so that
every agent gets a service as soon as it's connected, then to "commit and open a PR, and then
release it", and later gave this session permission to merge and run the Azure release.

## What shipped (PR #43)

- **"On for new agents", per account.** Each account under Connectors › Your services has a switch.
  - **On:** every agent connected afterwards starts with that service ticked on its consent or
    access-key screen. Approving grants it, set to that account. The person can still untick it.
  - **One per service:** an agent uses one account of each service, so turning on a second account
    of a service moves the switch to it.
  - **Existing agents** don't change, and the Minimal starting set still grants no services.
  - **Activity:** each change is recorded as an agent defaults change naming the account.
- **The first grant takes consent's defaults.** When an agent goes from no granted service to at
  least one on its page, a "Defaults for every service" control the person left as it was becomes
  reading on and changes "ask me first". A control changed in the same save is kept.
- **Data:** migration 0119 adds `connections.default_for_agents`, with a partial unique index of
  one per person and service. That makes 90 migrations. No configuration, package or
  infrastructure changes.
- **Decision:** [default services ADR](../adr/default-services.md); the brief's Agent consent
  screen requirement is amended, and technical-design.md §7 links to the ADR.

## Verification

- **Locally:**
  - 6,534 of 6,534 tests and a clean typecheck after rebasing onto PR #45.
  - A browser check on a dev server: the switch on Connectors and its notice, and the access-key
    screen arriving with Gmail ticked. Phone width wasn't checked.
- **PR checks.** [45118821709](https://github.com/Orlev01/warthog/actions/runs/45118821709) passed
  on tree `7325edd`. Main's
  [45120451417](https://github.com/Orlev01/warthog/actions/runs/45120451417) passed on the merge
  tree `264ae20` (the PR's tree plus PR #45's release record), including the full suite on
  PostgreSQL 16.
- **Image.**
  - **Run 45121446733** reused main's checks. The image is `…@sha256:b787d55b…`.
  - **Checks:** linux/amd64, UID 1000, no setuid or setgid, and the deletion-journal label. The
    source, lockfile, 90 migrations, 107 catalogue entries and 81 brand marks all match the source
    hashes.
  - **Scan:** no advisories in application dependencies, and none added or removed against the
    PR #45 image.
- **Production.**
  - **Run:** [45121816498](https://github.com/Orlev01/warthog/actions/runs/45121816498) succeeded
    on a fresh private B2als_v2 runner. The runner's plan was reviewed (11 creates, no deletes).
    Before it was registered for this run only, the live VM was checked and private PostgreSQL DNS
    and TLS were confirmed.
  - **Result:** one healthy replica, explicit 100% traffic and zero old replicas.
  - **Configuration:** unchanged apart from image and revision; the hash before was `d2301130…`.
  - **Health:** config and database report ok, so migration 0119 is applied.
  - **Probe:** 69/69, before and after.
  - **Runner:** destroyed. The cleanup check found no group, resources, grants, subnet NAT or
    GitHub runner left.

## Follow-ups

- **Muse isn't repaired.** Agents whose services were granted while the bug was live keep reads and
  changes off until the person turns them on, since that might have been deliberate. For Muse:
  turn on "Allow reading from granted services", set changes to "Ask me first", and choose its
  Gmail account.
- **Several accounts of one service per agent** is still not done (see the
  [accounts ADR](../adr/google-published-and-accounts.md)).
- **Still open from the review:** two Highs, being fixed on `claude/security-highs`.
