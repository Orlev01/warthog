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
append-only. Account deletion cascades. (Amended 25 November 2026: migration
`0127_run_status.sql` lets it also update `label_ct` and `label_changed_at`; see below.)

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
  envelope from the top level of the request instead of `params._meta`, so they were never
  recorded for current clients. Fixed on 16 November with a de-duplicated list of each agent's
  recent apps ([amendment](agent-evidence-and-controls.md#recent-apps-amendment-16-november-2026)).
  "Via" now uses the same reading.

## Amendment: status updates and Now (25 November 2026)

The founder runs several agents at once (Claude, ChatGPT, Gemini, and several of each) and asked
to see which agent is doing what. The founder set the boundary: show only what Warthog records
from calls made **to Warthog**. Nothing an agent does elsewhere is captured or inferred.

### Status updates

- **How it works.** `get_context` with both `run` and `working_on` replaces that conversation's
  description. No new tool is added, so the agent tool set is unchanged. `RUN_NOTE`, which every
  run's context carries, and the `working_on` description tell agents they can do this when their
  work changes. The house skill gets the same sentence once editable Warthog skills
  (`claude/builtin-skills`, which rewrites it) have landed.
- **Cleaning.** The new description is cleaned, redacted, cut and encrypted like a new run's.
- **Ownership.** It only applies to the calling agent's own run, as `resolveRun` checks. Another
  agent's run, or a malformed one, starts a new conversation as before.
- **When nothing changes.** Nothing changes, and nothing is recorded, when the description is the
  same words, is empty after cleaning, or comes within a minute of the last change
  (`RUN_LABEL_CHANGE_MS`). The first change after a run starts is always allowed. The response
  carries whichever description then stands, and a failure never withholds the context.
- **Each change is recorded.** Each change is an agent-reported entry of kind `run_status`,
  titled "Conversation status update", in the run, carrying `run {id, label}` and `previous`. It
  is written in the same transaction as the update, so the description never changes without its
  record. Every other entry keeps the description it was recorded under, so the hash-chained
  record holds the full history.
- **The call's own entry.** The pipeline re-reads the request's run for the call's own entry, so
  the `get_context` entry that made the change carries the new description.
- **Storage.** `0127_run_status.sql` adds `agent_runs.label_changed_at` and an index over the
  person's runs by last call. It grants the runtime role `UPDATE (label_ct, label_changed_at)`. It
  still never rewrites whose a run is, when it started, or `via`.

### Now

**Agents › Now** (`/agents/now`) is a tab between Your agents and Connect an agent. It adds no
sidebar item and doesn't depend on the open navigation decisions.

**What it shows:**
- Every agent's conversations seen in the last day, up to 50 (`listRuns` with `since`).
- They are grouped by provider: Claude, ChatGPT, Gemini, then others by name, then agents that
  name none. The provider comes from the same keywords as the agent's mark (`agentProvider`).
- Within a provider, agents are listed by name and conversations by when they started, so a
  refresh never moves rows.

**Each conversation shows:**
- The agent's description, quoted and attributed.
- "via", its entry count and its last call.
- When its description changed.
- Its latest action in Warthog's words. This comes from plaintext metadata only, so no payload is
  decrypted. It never reads a change's intent record, a status change or a `get_context`
  check-in, which would otherwise hide the work after every status update.
- An **Active** badge when it called Warthog in the last 15 minutes. The page says what Active
  means. Nothing says "live", "online" or "running", and the page says Warthog can't tell whether
  an app is still running or what it does elsewhere.

**Agents that don't use runs** still show: their own calls in the window with no run are counted as
"N actions not in a conversation", linking to `/activity?agent=…&run=none` (`ActivityFilters.noRun`).
That count covers `AGENT_ACTION_KINDS`: the agent's calls, refused requests and reports. It never
includes the person's changes to the agent. Connected agents with nothing in the window are named
in one line.

**Refreshing:** while the tab is in sight, the page reloads its data every 30 seconds through the
router. It reloads at once on return to a stale tab and never while hidden. There is a "Pause
updates" toggle (WCAG 2.2.2). "Updated 3:04 pm" is plain text, not a live region.

### Limits

- A status is still the agent's claim, and only agents that pass their run update it.
- The window is a day and 50 conversations. Older conversations stay in Activity and on each
  agent's Overview.
- Provider grouping follows the platform and the person's name for the agent. An app that
  connected through a callback on the person's computer is grouped by its name, which the person
  can change.

