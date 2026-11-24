# Agent-first management

Decision date: 10 November 2026. This implements the founder's clarification that
Warthog is a central place to manage agents, rather than a collection of unrelated
personal-data tools. It amends the original navigation and permission details in
the brief and technical design. It does not make Warthog an agent execution host.

## Ownership and access

The person owns the account and its resources. An agent is an individually
credentialed connection, with its own permissions and history. Two agents that
share one credential cannot be independently identified; create a separate
connection for each agent that needs separate control.

| Resource | Account responsibility | Individual agent responsibility |
| --- | --- | --- |
| Connectors | Connect, renew and remove service accounts; store encrypted credentials | Grant service access; select the specific account; allow reads and choose off / ask / allow for changes |
| Vault | Maintain everyday and protected identity fields | Choose all or specific fields; allow everyday reads and protected requests; each protected release requires approval |
| Cards | Maintain device-encrypted card data | Permit requests, set amount/currency/period budget; each release needs approval |
| Skills | Maintain enabled skills and their default audience (all or chosen agents) | Explicit assignments override that audience for this agent; disabling the source skill disables it everywhere |
| Memory | View, edit, delete and change private/shared scope | Independent read/write permission; sharing flag controls new memories; explicit per-memory agent audiences override the source default |
| Rules | Global restrictions apply on every request | Agent rules add restrictions; they cannot override a global denial |
| Activity | Account-wide, append-only record and integrity verification | Filter by agent; show Warthog-observed actions separately from agent reports |
| Tasks and records | Own shared tasks, hand-offs and records | Explicit capability grants; owned connected assignees, atomic updates and renewable claims on unassigned tasks |
| Preferences | Account profile and working preferences | Currently shared with all connected agents; no per-agent preference override |
| Notifications and household | Account notification channels; separately authorised household address and aggregate budgets | Agent requests trigger those policies; a household does not share members' agents or private resources |

The top-level resource pages are explicitly labelled **Account resources · all
agents**, with an agent selector. The Agents list opens a workspace with Overview,
Connectors, Vault, Skills, Memory, Spending, Rules, Activity and Settings. Top-level
activity and spending remain aggregate views.

## Defaults versus enforced policy

`/settings/agents` stores the starting permission template and request rate for new
connections. OAuth consent and access-key setup use the selected template; new
grants capture the configured rate. Defaults do not rewrite existing agents.
Services, sensitive identity and cards are not silently granted by a default.

Global rules are different: they are evaluated for existing and new agents on
requests. The agent workspace shows both inherited global and individual rules.
A prior approval does not override a later denial: held calls recheck the current
policy before execution. A revoked card/identity permission prevents collection
of an outstanding release. Already collected information cannot be recalled.

## Storage and enforcement

Migration `0101_agent_controls.sql` adds account defaults, an independent memory
write grant, per-agent skill overrides, and service-account selections. Existing
memory-write behaviour is preserved during migration by copying `memory_read`.
Existing budgets using the old display label `A$` are normalised to `AUD`.

A skill is available when it is enabled and its explicit agent override, or its
default audience when no override exists, permits the agent. The same rule drives
context discovery, direct `get_skill` retrieval and the settings page. The old
`skills_scope` grants column remains legacy metadata; it is not another allowlist.

Connector grants still name services. `connector_accounts` maps each granted
service to the chosen connection. A legacy grant with exactly one account can use
that account. Multiple accounts require a selection. A missing selected account
never falls back to a different one. The server binds the account to a call before
holding it for approval; changing the selection prevents that hold executing
against the replacement account. The approval shows the account label. Reversals
also require the original account binding; older entries without it cannot be
automatically undone through a different account.

Permission saves lock the connection and permission row, merge only submitted
fields, validate ownership, update skill overrides and append a redacted audit
entry in one transaction. A failed audit write rolls back the settings. Agent
creation, permission creation and credential issuance are also transactional.

Exports include skill state, default audience and agent settings as reference
metadata, without credentials. Disabled skills stay disabled on import. All skills
need assignment after import, including shared skills that may have had per-agent denials;
old agent ids are not automatically trusted in the destination account. Agent
credentials and grant snapshots are not restored.

## Boundaries and unfinished integrations

Warthog enforces and observes requests routed through Warthog. It cannot control a
platform's separate direct tools, private model memory, billing, or runtime. A
service connector is not an agent registration. A provider's support for remote
MCP does not establish that its integration has passed a live Warthog test.

Outbound provider MCP now uses the pinned SDK with encrypted, session-bound OAuth
state, authenticated discovery, refresh, reconnect and approved calls. See
[the provider MCP decision](provider-mcp-client.md). Provider tools always require
approval because their effect annotations are untrusted. Each real provider still
needs authenticated acceptance before being labelled verified.

[Resource audiences](resource-audiences.md) adds arbitrary per-memory audiences,
per-field vault grants and per-service read/change overrides. [Collection bounds](collection-bounds.md)
describes pagination and storage limits. Provider-runtime lifecycle control remains
outside Warthog's connection: Dots and Instinct have no verified direct integration
contract, so the product does not invent setup steps for them.

[Agent evidence and controls](agent-evidence-and-controls.md) adds explicit tool
allowlists, task/record write controls, selected-record access, client observations,
durable attempt/outcome evidence, investigation and chunked account transfers.

[Agent runs](agent-runs.md) tells one agent's conversations apart without new credentials: Warthog
hands each conversation a run through `get_context`, and Activity, the Inbox and the agent's
Overview group by it.

[One agent, several accounts of a service](several-accounts-per-agent.md) (24 Nov 2026) replaces
the single chosen account per service: an agent is given accounts, each with its own settings, and
every connector call is bound to one granted account before the policy runs. "Never falls back"
and "the server binds the account before holding it" still hold.

## Onboarding: Build your profile (amended 24 November 2026)

Home's set-up step "Add your details" is replaced by "Build your profile" ([decision](profile-build.md)):
after connecting an agent and giving it a service it can read, the person copies one prompt into that
agent, which fills in Life admin and suggests About you details for them to check. "Connect a service"
counts only once some agent can read the service, keeping the account owned apart from what each agent
can actually use.
