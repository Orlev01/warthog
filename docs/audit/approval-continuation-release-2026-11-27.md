# Approval continuation: agents carry on after the person approves — 27 November 2026

Application source `f7d3780efd1b7405eae7181abd773dfe8b0da02e` is live as revision
`warthog--r45961446024a1`. It carries PRs #76 and #77.

## Why

ChatGPT sent an Outlook email through Warthog and got `pending_approval` back. The founder approved
it in Warthog, and Warthog sent it. ChatGPT only found out when the founder asked "what happened?".
Warthog's house rule told agents to "stop and wait", which they read as "end your reply". A
`pending` answer from check_approval also didn't tell them to ask again.

The founder wanted a fix that works for ChatGPT, Claude, Gemini, Grok and others, and nothing hacky.
No AI app lets an outside service start a new reply in a conversation that has ended. Each app can,
however, wait inside the same reply within its own tool-call limit, and MCP Tasks is the supported way
for a client to carry on after the reply has ended. The ADR (`docs/adr/approval-continuation.md`)
records each app's limits, the sources, what was rejected, and ChatGPT Events as later work.

## What shipped

- **PR #76, every app waits in the same reply:**
  - **Pending reply:** a held change now tells the agent to say in one line that it's waiting for the
    person's approval in Warthog, then to call check_approval straight away.
  - **check_approval:** waits up to 50 seconds per call (was 25), under ChatGPT's 60-second limit. A
    `pending` answer now carries `expires_at` and a `next` saying to call again.
  - **Disconnects:** the wait stops as soon as the app disconnects. The held change is untouched.
  - **House rule:** now says to wait with check_approval and carry on with the result. It still says
    the person decides only in their own signed-in Warthog app.
  - **Failed or unknown sends:** an approved send that fails or ends unknown now gives the agent its
    own reason. Before, the agent was told "This was a read, so nothing changed".
- **PR #77, Claude carries on by itself:**
  - **Tasks:** a client that declares the MCP Tasks extension (`io.modelcontextprotocol/tasks`) gets a
    task for a held change instead of `pending_approval`. The task id is the approval id.
  - **Polling:** `tasks/get` reports `working` until the person decides, then `completed` with the
    same result check_approval gives.
  - **Unchanged:** every other client keeps the PR #76 behaviour.
  - **Who decides:** `tasks/cancel` is acknowledged and changes nothing, because only the person
    decides.
  - **Running once:** the held change still runs exactly once.

House rules aren't part of the guidance pin, so Using Warthog stays at version 3. No migrations (99).

## Verification

- **Locally:**
  - **Tests:** `npm test` passed 7,149 of 7,149 on the combined branch, and `npm run typecheck` was
    clean.
  - **New tests:**
    - the 50-second limit;
    - `pending` with `expires_at` and `next`;
    - stopping on a disconnect without running the held send, checked by deliberately breaking it;
    - the failed and unknown reasons;
    - the task methods, including scoping by agent and the missing-extension error.
- **PR checks:**
  - #76 passed for tree `75b8309e`.
  - #77 passed for tree `5661f80a` on `node:22-bookworm-slim@sha256:be979e55…`, and main's tree after
    the merge is the same.
- **Image:** image run 45961047011 built `…@sha256:834d8963…`, reusing the PR's checks.
  - **Image checks:** 99 migrations, 107 catalogue entries and 81 brands; the source hashes match.
  - **Scan:** nothing added or removed against the previous release.
- **Production:**
  - **Release run:** [45961446024](https://github.com/Orlev01/warthog/actions/runs/45961446024)
    succeeded on a fresh private runner. The plan was reviewed (11 creates, no deletes) and the VM
    verified.
  - **Result:** one healthy replica, 100% traffic, zero old replicas.
  - **Configuration:** unchanged apart from image and revision (before: `af03e35d…`). LinkedIn is
    still off.
  - **Probe:** 96/96 before and after.
  - **Agents:** get_context on production returns the new pending-approval rule in `instructions`.
  - **Runner:** destroyed, and the cleanup check found nothing left.
- **Not yet checked:**
  - **Real apps:** a held send hasn't been tried in ChatGPT or claude.ai yet. The founder will try
    one in each: ChatGPT should wait in the same reply, and claude.ai should carry on by itself.
  - **Claude's Tasks support:** this comes from Claude's own documentation.

Evidence: `release-evidence/2026-11-27-approval-continuation-f7d3780`.
