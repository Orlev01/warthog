# Approval continuation: the agent carries on after the person approves

Decision date: 27 November 2026. On 27 November ChatGPT sent an Outlook email through Warthog and was
told `pending_approval`. The founder approved it in Warthog, and Warthog sent it. ChatGPT only found
out when the founder asked "what happened?" (Warthog task 508d394f). The founder asked for a fix that
works across ChatGPT, Claude, Gemini, Grok and others, without anything hacky.

## What was wrong

- **Warthog already does the work.** Approving runs the held call once, in the inbox action. The
  agent's later `check_approval` gets the stored outcome. `check_approval` could already wait 25 s.
- **Agents were told to end their reply.** The house rule said "When Warthog tells you a request is
  pending approval, stop and wait". ChatGPT read "stop" as "end the reply". When a wait came back
  `pending`, nothing said to ask again.
- **Nothing can reach an agent.** Warthog had no webhook, event, MCP Tasks, progress or elicitation
  support. Its `/mcp` is stateless, and GET returns 405.
- **A failed approved send was described as a read.** When an approved hold failed, or the service
  didn't confirm it, `check_approval` went back through the pipeline as a non-change call. The
  pipeline replaced the hold's reason with "This was a read, so nothing changed". That is wrong for a
  send that may have gone out.

## What the agents' apps allow (researched 27 November 2026, primary sources)

No app lets an outside service start a new reply in someone's conversation. Two documented
mechanisms continue one:

| App | Waits on one tool call | Continues by itself after the reply ended |
| --- | --- | --- |
| ChatGPT (developer mode, apps) | 60 s, a hard limit (OpenAI staff, community forum, 27 Apr 2026) | Only MCP Events webhooks, in Work chats on web and desktop. Not personal ChatGPT, mobile or voice. MCP Tasks has "no timeline" (OpenAI Support, 7 Sep 2026). |
| claude.ai, Desktop, mobile | 240 s (claude.com/docs/connectors/building) | **MCP Tasks** (2026-07-28 extension): "Claude usually picks up the result unprompted" (Claude Code MCP docs; GA article 24 Nov 2026) |
| Claude Code | 5 min idle on HTTP | MCP Tasks (CLI v2.1.304+). Channels are local stdio only. |
| Gemini CLI | 10 min, configurable (geminicli.com MCP docs) | Not found |
| Gemini app, Gemini Enterprise | Not found | Not found; write actions confirm in the app |
| Grok (web, mobile) | Not found | Not found |
| Codex | `tool_timeout_sec`, default 60 | Not found; Tasks issue open |

The MCP Tasks extension (`io.modelcontextprotocol/tasks`, SEP-2663) names "human approvals" and
"approval gates" as uses. The client host polls `tasks/get`, not the model.

## Decisions

### 1. Every app: wait in the reply it is in (this change)

Works in every app today and needs nothing from it:

- **The held call's `next`** tells the agent four things. Tell the person in one line that the
  request is waiting for their approval in Warthog. Call `check_approval` straight away. Call it
  again while it says `pending`, until `expires_at`. If the reply has to end first, call it at the
  start of the next reply.
- **Never resend the request.**
- **`check_approval` waits up to 50 s**, the default. That stays under ChatGPT's and Codex's 60 s
  limit and Azure ingress's 240 s.
- **It returns as soon as the person decides**, with the result.
- **A `pending` result carries `expires_at`** and a `next` saying to call again.
- **A cancelled request stops the wait.** Under the 2026-07-28 transport, a closed stream is a
  cancellation.
- **The house rule now reads:** don't send it again or try another way. Wait with `check_approval`,
  calling it again while it says pending, then carry on with the result. The person decides it from
  their own signed-in app, never by reply. The rule is fixed text: a person's skill edits can't
  change it.
- **`check_approval` passes an approved hold's own failure reason through** (`reportsHeldOutcome`).
  It is never a read's "nothing changed".
- **Each wait is still recorded in Activity.** The pipeline records every agent call, and a typical
  approval adds one or two entries.

### 2. Claude: MCP Tasks for held calls (next change)

- **What changes.** When the client declares the Tasks extension, a held call returns a task instead
  of `pending_approval`. The task id is the approval id, scoped like `check_approval`. `tasks/get`
  reports `working` until the person decides, then the call's result.
- **Who it reaches.** Claude then continues on its own, even after its reply ended.
- **Everyone else.** Clients without the extension keep decision 1.
- **What stays the same.** Approval still happens only in Warthog's signed-in app, and the held call
  still runs once.

### 3. Not now

- **ChatGPT MCP Events.** Webhooks into Work chats need four things: signed outbound requests from
  Warthog, an SSRF guard on the callback, a subscription table, and retries. The extension is beta,
  and it doesn't reach personal ChatGPT, which the founder uses. Revisit when it reaches personal
  chats or a member needs it.
- **Rejected as hacky or the wrong control:**
  - typing into a chat, or asking the person to reply to approve: the house rule forbids approving
    by reply;
  - Claude Code Channels: local stdio only;
  - URL-mode elicitation: 2026-07-28 removed its completion signal, and the push notification
    already brings the person to Warthog;
  - marking sends `destructiveHint`: the person would confirm twice, and the app's own confirm is
    weaker than Warthog's.
- **A webhook for operator-run agents** (Managed Agents, the OpenAI Agents API). The Events
  extension is the standard route if a member runs one.

## Verification

Tests cover:
- the 50 s ceiling, the `pending` result's `expires_at` and `next`, and stopping when cancelled
  (`src/server/mcp/tools/check-approval.test.ts`);
- the held failure reason (`src/server/mcp/pipeline.held-outcome.test.ts`);
- the wording, through the existing house and tool-list tests.
