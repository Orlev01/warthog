# Agent conversations release — 16 November 2026

Application source `aca26743ea7ac2a34b70a7e4f353859217f17ca6` is live as revision
`warthog--r43796560300a1`. This is PR #28 (main `aca2674`), which the founder asked to be merged
and released.

## What shipped

**One agent's conversations can be told apart** ([ADR](../adr/agent-runs.md)). No client sends a
session or conversation id: concurrent Claude Code sessions, Claude Code through the claude.ai
connector, and claude.ai chats were measured on 16 November and send identical requests.
So Warthog hands one out. People still do nothing beyond adding the connector.

- `get_context` takes an optional `working_on`, starts a run and returns
  `run: { id, workingOn, note }`. The house skill tells agents to pass `run` on every later call.
- Every tool advertises an optional, lenient `run`. It is resolved only for the calling agent's own
  runs; anything else is ignored and never blocks the call.
- Entries recorded for that agent during the request are linked to the run in
  `activity_entry_runs`. A held call keeps its run through approval.
- "Via" names the product a request came through (`x-anthropic-client`, else the MCP client name):
  Claude Code, Claude Cowork or claude.ai. It is shown as a client claim.
- **Screens.** A run is called a "conversation":
  - Activity rows read "Claude via Claude Code · Conversation “…”", with a `?run=` filter and
    chip.
  - Entry details and Inbox approval cards name the conversation and how the request came in.
  - Each agent's Overview has a "Recent conversations" panel.

**Migration 0113** is additive. It adds `agent_runs`, whose label is encrypted under the person's
data key; the runtime role may insert and select, and update only `last_seen_at`. It also adds
`activity_entry_runs`, which is append-only, with a composite foreign key to the same person's run.
Account deletion cascades. That makes 84 migrations, applied by the new revision when it first
opened the database. There are no configuration, hostname, infrastructure, workflow or
delivery-script changes.

## Verification

- **Before merge:**
  - `npm test` passed 6,131 tests (25 new), and typecheck and `next build` passed.
  - Three real Claude Code sessions (Haiku and Sonnet), given ordinary requests that never
    mentioned runs, started and followed their own conversations. Every entry landed in the right
    one.
  - An independent review found no isolation problem. Its nine findings were fixed and
    re-verified.
  - PR #28 passed all six checks.
- **Image:** run [43792807994](https://github.com/Orlev01/warthog/actions/runs/43792807994)
  repeated the suite: 6,131 pass, zero failures, cancellations or skips. Image
  `…@sha256:e6c6c385…` carries:
  - the exact source label, the pinned base, journal label `v1`;
  - linux/amd64, UID 1000, no setuid/setgid;
  - matching hashes for all 84 migrations, 106 catalogue entries and 80 brands.
- **Image scan:** 227 OS advisory pairs, none outside OS packages, against 224 yesterday.
  - The three added pairs are CVE-2026-125709 (MEDIUM, no Debian 12 fix) in `gcc-12-base`,
    `libgcc-s1` and `libstdc++6` `12.2.0-14+deb12u1`.
  - The 195 OS packages and their versions are identical to the previous image, and the five base
    layers are unchanged. So the vulnerability database gained the advisory; the image did not
    change, and production already carried the same packages.
- **Production:**
  - Run [43796560300](https://github.com/Orlev01/warthog/actions/runs/43796560300) succeeded. Its
    release job ran 03:16–03:20Z, including the maintenance stop.
  - Expected configuration hash: `5b19f503…`, the same as the state after the previous release.
  - Independent inspection: one healthy replica running the exact image, explicit 100% traffic,
    zero old replicas, configuration unchanged apart from image and revision.
- **Production probe:** 62/62, the same website and app checks as the
  [previous release](website-review-fixes-release-2026-11-15.md#verification).
- **Feature on production:** one read-only `get_context` through the founder's claude.ai connector
  (agent "Claude") with `working_on` returned a run and the new conversation instructions. The
  insert into `agent_runs` succeeded, so migration 0113 is in place. That call left one
  conversation, "Post-release check of conversations", in the founder's Activity.
- **Runner:** a fresh private lease (11 reviewed creates) was destroyed after the job. The cleanup
  check found no group, resources, grants, subnet NAT or GitHub runner left.

## Follow-ups

- **App details.** Warthog's per-agent "app details" read the 2026-07-28 envelope from the request's
  top level instead of `params._meta`, so they are never recorded for current clients. Fixing it
  needs de-duplicating "Client information reported" entries first (see the ADR).
- The deferred items from the [previous release](website-review-fixes-release-2026-11-15.md)
  still stand.

## Coordination

Session be was the sole release operator; no other session was working on Warthog. Main was frozen
from the image build to the release dispatch.
