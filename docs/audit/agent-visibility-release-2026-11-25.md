# Seeing which agent is doing what: agent names and Agents › Now — 25 November 2026

Application source `18dac62690cedb38e4c94f738124a65da3d465ea` is live as revision
`warthog--r45524200877a1`. It carries PR #68, PR #70 and migration 0127.

## Why

The founder runs several agents at once, often more than one from each provider (Claude, ChatGPT,
Gemini). They asked to see each agent, its name, and what it is asking Warthog to do.

The founder set the boundary: show only what Warthog records from calls made **to Warthog**.
Nothing an agent does elsewhere is captured or inferred.

## What shipped

**PR #68: agent names and providers** ([ADR](../adr/agent-names-and-providers.md))
- **App on your computer.** An app that signs in through a loopback callback (Gemini CLI, Codex,
  Claude Code connecting directly) reads "App on your computer" instead of "localhost", and
  consent offers that as its starting name. It stays unverified, and the stored platform is
  unchanged.
- **What the app reported.** `known-clients.ts` lists MCP client names measured from the real
  apps, each with its date and method:
  - `claude-code` and claude.ai's two names, measured 16 Nov;
  - `codex-mcp-client` (Codex CLI 0.170.0) and `gemini-cli-mcp-client` (Gemini CLI 0.46.0),
    measured 25 Nov against a recording server.

  The agent list and the agent's header show "says it's Gemini CLI" when that adds to the
  platform. "Via" and the Overview use product names.
- **Google.** Its callback stays "Google".
- **Rename.** Settings › Name renames an agent. The name, the copy each of its rules keeps and an
  "Agent renamed" entry commit together. The platform never changes.

**PR #70: Agents › Now and status updates** ([ADR amendment](../adr/agent-runs.md))
- **Now** (`/agents/now`) lists every agent's conversations from the last day, grouped Claude,
  ChatGPT, Gemini, then others.
  - **Each conversation shows:** the agent's own description (quoted and attributed), via,
    entries, last call, when its description changed, and its latest action in Warthog's words.
  - **Active** means it called Warthog in the last 15 minutes. The page says that Warthog only sees
    calls made to it.
  - **Calls without a conversation** read "N actions not in a conversation"
    (`/activity?agent=…&run=none`).
  - **Refreshing:** every 30 seconds while in sight, never while hidden, with a Pause toggle.
- **Status updates.** `get_context` with `run` and a new `working_on` replaces the conversation's
  description, at most once a minute. Each change is an agent-reported "Conversation status update"
  entry. Migration 0127 adds `agent_runs.label_changed_at` and lets the runtime role update the
  description.
- **Telling agents.** `RUN_NOTE` and the "Using Warthog" house guidance tell agents they can do
  this. The guidance is now version 2, so anyone who edited it is offered the new text.

## Verification

- **Before merge:**
  - `npm test`: PR #68 merged with main (and #69) passed 7,048 of 7,048. The combined tree that main
    now holds passed 7,074 of 7,074. `npm run typecheck` is clean.
  - **Browser checks** on `next dev`, Playwright with a virtual passkey, rerun on the combined tree:
    - names: 23 of 23 (loopback consent, the reported app, rename, refusals, 360px dark, no CSP
      errors);
    - Now: 31 of 31 (three agents, grouping, status update and its throttle, loose actions, refresh
      while visible, none while hidden or paused, 360px dark, no CSP errors).
  - **PR checks** passed for tree `dcbfafe…`, which is main's tree after the two merges.
- **Image:** image run 45523751526 reused those checks and built `…@sha256:52ffca32…` on
  `node:22-bookworm-slim@sha256:be979e55…`.
  - linux/amd64, UID 1000, no setuid or setgid, with the deletion-journal label;
  - 98 migrations, 107 catalogue entries and 81 brand marks, with the source hashes matching;
  - scan: no advisories added or removed against the #69 release, and none in application
    dependencies.
- **Production:**
  - **Release run:** [45524200877](https://github.com/Orlev01/warthog/actions/runs/45524200877)
    succeeded on a fresh private runner. The plan was reviewed (11 creates, no deletes), the VM
    checked, and private PostgreSQL DNS and TLS confirmed without credentials.
  - **Health:** the readiness check, which applies migrations first, passed with 0127.
  - **Result:** one healthy replica, 100% traffic and zero old replicas.
  - **Configuration:** unchanged apart from image and revision (before: `cd181651…`).
  - **Probe:** 92/92 before. After, 95/95, with three new checks: `/agents/now`,
    `/activity?run=none` and an agent's Settings with its rename notice each send a signed-out
    visitor to sign in.
  - **Runner:** destroyed, and the cleanup check found nothing left.

## Coordination

- **Release order:** this release followed #69's (record `0f89de5`), whose session handed over the
  release slot. The multi-account session held its merges until this record.
- **Merge order:** #68 was merged first. #70 then merged main and was checked on the exact tree main
  holds now.

Evidence: `release-evidence/2026-11-25-agent-visibility-18dac62`.
