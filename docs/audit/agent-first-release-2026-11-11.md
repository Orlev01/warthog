# Agent-first integration release — 11 November 2026

Status: local integration complete; release checks and deployment pending. No
production change is implied by this source record. The deployment outcome will
be appended after the protected workflow completes.

The founder requested a comprehensive agent-first review, completion of its
follow-ups, integration of the parallel skills library and deployment. Work is
isolated in `codex/warthog-agent-first`, based on `da5301c`. Skills-library commit
`4047936` is merged through `da1a9d4`; its worktree remains untouched.

## Resulting product

Agents have workspaces for connectors, vault, skills, memory, spending, rules,
activity and settings. Account resource inventory remains separate from each
agent's effective access. Global defaults seed new agents; global rules remain
binding on all agents. Connection accounts, resource audiences, budgets and audit
history are controlled per agent.

Follow-ups include provider MCP OAuth/discovery/calls/refresh/reconnect; conservative
approval of provider tools; current-policy checks for held calls and releases;
per-field vault grants; per-memory audiences; per-service tool policies; bounded
collection pages and serialized quotas; validated task assignments and renewable
claims. Large tool inventories now have working discovery and dispatch helpers.

The integrated library imports folders, Markdown, `.skill`, `.plugin` and ZIP
files with preview, supports create/edit/duplicate/delete/search/download, retains
supporting text files and encrypts stored content. Package and workspace audience
changes use the same effective grants. Plugin scripts and hooks remain inert files.
Exports preserve content; imports require resource reassignment rather than
trusting old agent IDs.

Browser validation caught a lost-save window after paging: native controls could
be used before client handlers were ready. The form now uses React handlers and
keeps controls disabled until hydration completes. A library page renders at most
24 cards, with search across its full quota-bounded index.

## Validation before publication

The first complete local run exercised 5,152 tests: 5,151 passed and one outdated
expectation failed because it expected malformed task assignees to be accepted.
That test now checks both rejection without a write and inert free-text SQL
probes; all 21 task regressions pass. Focused UI/tool/collection checks passed 127
tests, with 98 render regressions after the library paging change. Counts overlap.
The final whole-suite CI result is recorded below when available.

Final browser acceptance passed 112 route/viewport combinations (320–1440 px),
seven workspace interactions, 30 library checks, six combined audience/paging
checks, five library-page checks, nine dark layouts and credential/default/not-found
checks. No page errors, console errors or horizontal overflow remained. Synthetic
fixtures included 59 library items, 58 memories, two service accounts and a long
unbroken agent name. Screenshots and scripts are retained under ignored
`.delivery/agent-first/`.

Typecheck, production build and standalone runtime packaging passed. Runtime
contains 75 migrations and 106 catalogue definitions. PostgreSQL 16 passed all
migrations twice, runtime/purge role separation, singleton ownership, account
cascades, concurrent task claims and quotas, package revision races and supporting
file audiences, plus existing OAuth/session/receipt/budget contention checks.
Delivery tests: 29 passed. Cost tests: 5 passed. Production npm audit: zero reported
package vulnerabilities on the pinned lockfile.

## Release scope and boundaries

Five additive migrations (`0100`–`0104`) add library packages, agent controls,
task claims, durable provider OAuth flows and resource audiences. Existing memory
write behavior is preserved; existing ambiguous multi-account connector grants
require an explicit account selection. No existing data is deleted by quotas.
Old application code can ignore the added columns/tables, but any rollback must
still follow the singleton maintenance and schema-compatibility runbook.

The deployment uses the existing application allocation, secret references,
hostname, SMS-off configuration and approved ephemeral runner profile. It is an
image-only update with the existing stop/zero-replica/database-lock/start checks;
it includes the expected maintenance interruption and loss of in-memory releases.

Synthetic MCP acceptance establishes the protocol implementation, not successful
consent with every real provider. Dots and Instinct are explicitly unverified;
no direct connection contract was established from their official information.
Warthog governs traffic through its own connection and does not control a provider's
separate runtime, direct tools, private memory or billing.

[Review and follow-up disposition](agent-first-review-2026-11-10.md),
[agent-first decision](../adr/agent-first-management.md),
[skills integration](../adr/private-skills-library.md),
[provider transport](../adr/provider-mcp-client.md),
[resource audiences](../adr/resource-audiences.md),
[collection bounds](../adr/collection-bounds.md),
[task claims](../adr/task-handoffs.md).
