# Email safety, part 2: saved-by labels, recently read, cleaner views — 17 November 2026

Application source `102d77ffc1935ad8da91015fd6d537ee05840690` is live as revision
`warthog--r43967617925a1`. It carries PRs #33–#35, the rest of the email-safety series that #31 and
#32 began in the [combined release](combined-release-2026-11-17.md)
([ADR](../adr/read-side-protection.md)). The founder asked for everything left to be released, end
to end.

## What shipped

- **#33: memories and tasks say who saved them.** `get_context`, `search_memory` and `list_tasks`
  carry `savedBy`: the person, "you", or another agent by name. Each task note says who wrote it.
  The kind is structured, so an agent named "the person" can't pass as the person. Labels only, by
  founder decision: no quarantine.
- **#34: recently read.** A 60-minute window per agent opens after it is shown content someone else
  wrote: mail other than the person's own sent mail and drafts, events the person didn't organise,
  Drive text, and provider results.
  - Every approval in the window says what the agent recently read. A first email to an address
    gets one combined heads-up that names the sender once.
  - **Behaviour change:** an agent the person lets act alone is asked first, inside the window,
    before it:
    - sends to an address the person has never emailed;
    - sends an invitation with guests, or edits an event;
    - writes through an email, messaging or calendar service.
  - Agents that ask first, the default, get no new approvals. Drafts, known addresses, never-allow
    rules, denials and approvals behave as before.
- **#35: faster, cleaner views.**
  - Gmail search returns checked summaries (who, subject, date, preview and flags), 10 a page by
    default and up to 25, so triage takes one call.
  - Checked mail views reach agents as readable text, with `structuredContent` alongside. Long links
    are listed by domain and fetched with `read {id, link: N}`.
  - Top-level `<style>` hiding rules are honoured. Invitation (`.ics`) parts are decoded and
    cleaned.
  - Drive exports Docs and Sheets and reads shared-drive files. Calendar list parameters are
    allowlisted.
  - An email service's consent line reads "Reads a checked copy of your email, without sign-in codes
    or password links." The main help page has a "What agents see in your email" section.

**Migration 0114** is additive. It adds `agent_read_exposures`: one row per person and agent, holding
the window's end and the last few senders, encrypted under the person's data key and never a
subject. The runtime role may select, insert and delete, and update only the window columns.
Account and agent deletion cascade. That makes 85 migrations, applied by the new revision when it
first opened the database. There are no configuration, hostname, infrastructure, package, workflow
or delivery-script changes.

## Verification

- **Pull requests:** #33, #34 and #35 were stacked, and each passed every check against main
  `e8c9781` plus the PRs below it. All three merged with merge commits.
- **Main:**
  - #33's merge (`5b7b968`) ran the full checks once (run
    [43951661290](https://github.com/Orlev01/warthog/actions/runs/43951661290)). #33's PR run had
    used the workflow from before #30, which records no reusable result. 6,223 tests passed.
  - The pushes for #34 and #35 (`39b4dd3`, `102d77f`) reused their PR runs. #35's run
    [43869618009](https://github.com/Orlev01/warthog/actions/runs/43869618009) checked tree
    `f4e46c4`, which is `102d77f`'s tree: 6,247 tests passed, with zero failures, cancellations or
    skips.
- **Image:** run [43966969767](https://github.com/Orlev01/warthog/actions/runs/43966969767) reused
  that result for the same tree and base, and published in 2 minutes.
  - The image is `…@sha256:e09a272a…`. It carries the exact source label and journal label `v1`.
  - It is linux/amd64, UID 1000, with no setuid/setgid.
  - All 85 migrations, 106 catalogue entries and 80 brands match by hash.
  - It is built on the same Node base as the previous release, `node:22-bookworm-slim@sha256:e9f565d3…`.
- **Image scan:** 226 OS advisory pairs, none outside OS packages. That is identical to the previous
  image, with none added or removed.
- **Production:**
  - Run [43967617925](https://github.com/Orlev01/warthog/actions/runs/43967617925) succeeded. Its
    release job ran 22:16–22:20Z on 16 November.
  - Expected configuration hash: `067c18c6…`, the same as after the
    [previous release](combined-release-2026-11-17.md).
  - Independent inspection: one healthy replica running the exact image, explicit 100% traffic,
    zero old replicas, and configuration unchanged apart from image and revision.
  - **Migration 0114:** the readiness probe opens the database, and opening it applies any pending
    migration first. The probe answers `database: ok` on the new revision, so 0114 applied.
- **Production probe:** 62/62, the same website and app checks as the previous release.
- **Runner:** a fresh private lease (11 reviewed creates) was destroyed after the job. The cleanup
  check found no group, resources, grants, subnet NAT or GitHub runner left.

## Follow-ups

- **A signed-in check through the founder's own Gmail connector** (search summaries, a withheld
  code, the recently-read note on an approval) is offered to the founder, not yet run. It reads real
  email, so it needs their yes.
- The follow-ups from the [previous release](combined-release-2026-11-17.md) still stand.

## Coordination

- Session warthog-email-agent-safety wrote #33–#35, merged them and was the release operator, at the
  founder's request.
- Session skynet-group-be released `e8c9781` first, then handed over its recipe and stood down on
  this release.
- Session skynet-group-03 held PR #37 (landing diagrams) until this record reached main.
