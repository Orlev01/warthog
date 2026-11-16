# Agent runs: telling one agent's conversations apart

Decision date: 16 November 2026. The founder uses many Claude Code sessions and asked whether
Warthog can tell them apart. The constraint: **people do nothing beyond adding the Warthog
connector**. No scripts, headers or per-session setup.

## What the clients send (measured, 16 November 2026)

A throwaway MCP server recorded every header and body from:
- two concurrent Claude Code 2.1.289 sessions connected directly;
- two concurrent sessions through the claude.ai connector;
- two claude.ai chats.

In every route the concurrent sessions sent **identical** requests. Nothing identified a session
or conversation:
- Every request used protocol revision 2026-07-28, which has no `Mcp-Session-Id`. When claude.ai
  checked the connector with the 2025 handshake, it never sent back a session id the server issued.
- The only per-call value is `_meta["claudecode/toolUseId"]`, which is new on every call.
  `progressToken` counts 1, 2… in every session alike.
- Connector traffic arrives from many Anthropic addresses with `User-Agent: Claude-User`. An
  `x-anthropic-client` header names the product: `ClaudeCode`, `Cowork` (claude.ai sessions) or
  `ClaudeAI` (claude.ai's own connector checks).
- Claude Code gives its session id to local stdio servers it starts, but not to remote servers
  or to `headersHelper`.

A credential is still the only identity: every conversation with one agent shares it
([agent-first management](agent-first-management.md)). Making each conversation its own agent
would mean a consent screen, a new-agent email and new permissions for every chat. That was
rejected as overwhelming.

## Decision

**Warthog hands out the run itself, inside the connection.**

- **Starting a run.** `get_context` (which the house skill already says to call first) takes an
  optional `working_on` description. It starts a run and returns `run: { id, workingOn, note }`.
  `get_context` with `run` continues that run.
  - Paging with a cursor and no run starts nothing.
  - If a run cannot be started, the context is still returned, without one.
- **Passing it back.** Every tool advertises an optional `run` field. The MCP layer resolves it
  against `agent_runs` **for the calling connection's agent only**. Anything else is ignored: a
  malformed id, an unknown run, or another agent's or person's run.
  - A wrong run never blocks or changes the call. A run is bookkeeping, not permission.
  - The `run` field and `get_context`'s `run` and `working_on` are lenient: an object, a number
    or an over-long value is dropped rather than refused, so a malformed run can't cost the
    agent its call or its context.
  - The tool body validates against its own schema, which drops `run`, so a run never reaches
    tool params or a provider.
- **Recording.** The MCP recorder links every entry recorded for the calling agent during the
  request to the run. That includes the pipeline's entries, `log_activity` and calls refused for
  their input. A request too malformed to read has no run to link to.
  - The link lives in `activity_entry_runs`, written in the entry's own transaction and only
    to the same person's run.
  - The entry's encrypted payload also carries `run: { id, label? }` inside the hash chain.
  - The activity chain itself is unchanged.
- **Held calls.** A held call stores its run with its arguments. The entry for its approved
  execution therefore joins the same run, and the approval's detail names it.
- **"Via".** The product a request came through is `x-anthropic-client` when present, otherwise
  the MCP client name. A 2026-07-28 client sends that name in `params._meta` on every request; a
  2025 client sends it only in `initialize`, so its later calls show no "via". It is mapped to "Claude Code", "Claude Cowork" or "claude.ai", and
  unknown values are shown as reported, after redaction.
  - It is stored as plain metadata in the payload, the approval detail and the run.
  - It is a client claim, labelled as such, and never identity.

The label is the agent's own description, so it is treated as personal content:
- It is cleaned and redacted with the person's released-value matcher over the whole text.
- It is then cut to 100 characters at a word boundary, so a cut can't split a secret past the
  matcher or leave part of one.
- It is encrypted under the person's data key (`agent_runs.label_ct`).

**Screens.** The UI calls a run a **conversation**:
- **Activity rows** read "Claude via Claude Code · Fixing the website tests". The conversation
  links to `/activity?run=<id>`, which shows the entries of that conversation, with a removable
  chip.
- **Entry details** show both values, each with how it was reported.
- **Inbox approval cards** add "Conversation (as the agent described it)" and "Came through (as
  the app reported it)" after the details Warthog checked.
- **Wording.** In Activity rows the agent's description is quoted and introduced ("Conversation
  “…”"), so it can't pass for one of Warthog's own labels. An agent named after its product
  isn't repeated ("Claude Code via Claude Code").
- **Each agent's Overview** lists its eight most recent conversations. Their entry counts match
  Activity: a change's "Started" record isn't counted separately.

## Storage

Migration `0113_agent_runs.sql` is additive:
- `agent_runs` holds the user, id, agent, start and last-seen times, `via` and the encrypted
  label.
- `activity_entry_runs` holds the user, entry seq and run, with a composite foreign key to the
  same person's run.

The runtime role may insert and select both tables and update only `last_seen_at`. Links are
append-only. Account deletion cascades.

## Limits

- **The agent chooses.** Runs depend on the agent passing the id back. An agent that ignores the
  instruction leaves entries with no conversation, which is the same as before this change.
- **Labels are claims.** A label is the agent's claim, not proof of which human conversation
  acted.
- **Long sessions can split.** A long session whose context is summarised may lose its id and
  start a second run.
- **Subagents.** Claude Code subagents share the parent's connection. They appear as their own
  runs if they call `get_context`.
- **Shared permissions and cap.** All of an agent's conversations share its permissions and its
  rate limit. Separate permissions still need separate agent connections.
- **Imports.** Imported history keeps the conversation names in its payloads, but not the
  links between entries and runs.
- **When Anthropic sends a session id.** If Claude Code or claude.ai starts sending one,
  Warthog can read it alongside the run. The protocol's run slot (`_meta["app.warthog/runId"]`)
  stays as an agent-reported reference.
- **App details.** Found while measuring: Warthog's per-agent "app details" read the 2026-07-28
  envelope from the top level of the request instead of `params._meta`. So they are never
  recorded for current clients. This change reads the client name correctly for "via" only.
  Fixing the per-agent record itself would log "Client information reported" each time one agent
  is used from different apps, so it needs de-duplicating first (a follow-up).
