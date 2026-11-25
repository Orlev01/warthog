# Agent names and providers

Decision date: 25 November 2026. The founder uses several Claude, ChatGPT and Gemini agents at once
and asked to see each one clearly by provider and name. This covers only how agents that connect to
Warthog are labelled. Nothing about what agents do outside Warthog is captured.

## What was wrong

- **Apps on the person's computer showed as "localhost".** Gemini CLI, Codex and Claude Code
  connecting directly sign in through a loopback callback. The consent screen stored the callback's
  host as the platform and offered it as the agent's name, so the Agents list read "localhost".
- **An agent's name was fixed when it connected.** Two agents of one provider could only be told
  apart by the name typed on the consent screen, and a mistake there stayed.
- **"Via" and the apps line only knew Anthropic's apps.** Any other app showed its raw client name
  ("gemini-cli-mcp-client 0.46.0").

## Decisions

### The platform is Warthog's record; the app's report is a claim

- The stored platform stays what the connection proved: a known callback host (Claude, ChatGPT,
  Google), the access-key page's choice, or the callback host itself. Nothing in this change
  rewrites it.
- **Loopback callbacks** (`localhost`, `127.0.0.1`) are shown as "App on your computer", and the
  consent screen offers that as the starting name. They stay unverified: any app on the computer can
  receive one.
- **Google's callback stays "Google".** `oauth-redirect.googleusercontent.com` is Google's
  account-linking relay. Nothing measured ties it to Gemini, which connects through Gemini CLI
  (`src/domain/agents/compatibility.ts`). It gets a "Gemini" label only after a real Gemini
  connection is measured on that host.
- **DCR `client_name` is not used.** Registration is anonymous, so any client could register as
  "Claude" and have that name offered or stored.

### What an agent's apps reported, from measured names only

`src/domain/agents/known-clients.ts` lists the MCP client names Warthog has seen from the real apps.
Each entry records the date and the method:

| Client name | Product | Provider | Measured |
| --- | --- | --- | --- |
| `claude-code` | Claude Code | Claude | 16 Nov 2026, Claude Code 2.1.289 and Cowork ([agent runs](agent-runs.md)) |
| `Anthropic/ClaudeAI` | claude.ai | Claude | 16 Nov 2026, claude.ai's connector checks |
| `Anthropic/Toolbox` | claude.ai | Claude | 16 Nov 2026, claude.ai's connector checks |
| `codex-mcp-client` | Codex | ChatGPT | 25 Nov 2026, Codex CLI 0.170.0 (title "Codex") |
| `gemini-cli-mcp-client` | Gemini CLI | Gemini | 25 Nov 2026, Gemini CLI 0.46.0 |

**How the 25 November names were measured.** Each CLI started a session against a throwaway
recording MCP server on the same machine. Each ran with a temporary home folder and a dummy API key,
so no model was called and the person's own settings were untouched. `gemini mcp list` reports
`mcp-test-client` for its health check. That is not the name a session uses, so it is not listed.

**How the table is used:**
- **Stored:** nothing new. The names come from the app details Warthog already keeps per agent
  (`agents.client_observation_ct`, up to 8 recent apps).
- **Worked out when a page loads:** `reportedApp(seen)` returns the product when every known app an
  agent came through is the same product, otherwise their shared provider. Unknown names are left
  out. Apps from different providers give nothing, because the credential is then being used from
  more than one maker's app.
- **Shown:** beside the platform on the Agents list and the agent's header, as "says it's Gemini
  CLI", only when it adds something. The claude.ai connector already reads "Claude". The Overview's
  apps line uses product names; the technical details keep the raw names.
- **"Via"** uses the same table for clients that send no product header.

A name that is not in the table is shown as reported, after redaction, as before. ChatGPT's own
connector is not listed: it needs a public server to measure, and its callback host already names
it.

### Renaming an agent

- The agent's Settings section has a **Name** panel. Disconnected agents keep it, since a name is
  only a label.
- **The name is cleaned** (`normaliseAgentName`): Unicode normalised, invisible and control
  characters removed, whitespace collapsed, 1–200 characters. A name the redaction module would
  change (a card number, a code) is refused, not stored part-hidden, because names are plain
  metadata that other agents can read.
- **One transaction** (`auditedOwnerChange`, under a row lock) renames the agent, renames the copy
  of its name each of its rules keeps (`rules.scope_agent_name`, used in the rule's sentence when
  it is shown and enforced) and records `agent_renamed {name: {from, to}}`. A failed audit write
  leaves the old name everywhere.
- **What it leaves alone:** an unchanged name records nothing. The platform is never touched.
  Earlier activity keeps the names it recorded (for example a disconnection's `displayName`).
- **No migration:** migration 0094 already lets the app role update `agents` and `rules`.
- **Short names** (UI/UX audit W-36) remain an open founder decision. Renaming already lets the
  person choose a short name, and it doesn't block a separate short label later.

## Limits

- The reported app is the app's own claim. It never decides permissions, and it is labelled as a
  claim.
- An app Warthog hasn't measured gets no product or provider until someone measures its name and
  adds a dated row.
- Several sessions sharing one credential are still one agent ([agent runs](agent-runs.md)). A
  rename names the credential, not a conversation.
