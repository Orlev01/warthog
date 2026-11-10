# Agent-first integration release — 11 November 2026

Status: integrated, deployed and verified in production on 11 November 2026
(Sydney time). Temporary runner cleanup is complete and independently verified.

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

The final complete local run passed all 5,152 tests, with no failures or skips.
The initial run found one outdated expectation that malformed task assignees were
accepted. The corrected regression verifies rejection without a write and retains
inert free-text SQL probes. All 21 task regressions pass. Focused UI/tool/collection
checks passed 127 tests, with 98 render regressions after the library paging
change. Counts overlap.

Both [source CI](https://github.com/Orlev01/warthog/actions/runs/42910141510) and
the [pinned image publication](https://github.com/Orlev01/warthog/actions/runs/42911453253)
passed all 5,152 tests across four Linux shards, with no failures, cancellations or
skips. Each shard also passed the actual PostgreSQL checks. Delivery,
infrastructure, cost and runtime checks passed.

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
Older images ignore the new per-field and resource-audience restrictions.
Additive schema compatibility therefore does not establish authorization
compatibility: any rollback requires a permission-policy review as well as the
singleton maintenance and schema-compatibility runbook. The workflow does not
automatically reactivate an old image.

The deployment uses the existing application allocation, secret references,
hostname, SMS-off configuration and approved ephemeral runner profile. It is an
image-only update with the existing stop/zero-replica/database-lock/start checks;
it includes the expected maintenance interruption and loss of in-memory releases.

Synthetic MCP acceptance establishes the protocol implementation, not successful
consent with every real provider. Dots and Instinct are explicitly unverified;
no direct connection contract was established from their official information.
Warthog governs traffic through its own connection and does not control a provider's
separate runtime, direct tools, private memory or billing.

## Published image review

Application source: `58beb72d27edd43ca6e318451605c2335c1e2963`.

Reviewed immutable image:
`crwarthogprodauee854.azurecr.io/warthog@sha256:d0586fb120214a1df3e0aa8c811cf473c406738e6386ed1091f5561ea6923813`.

Its source/base labels, Linux AMD64 platform, non-root user and absence of
setuid/setgid bits were independently checked. All 75 migration hashes, 106
catalogue hashes and the lockfile hash match the source. The pinned Node base is
`node:22-bookworm-slim@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d`.

A fresh Trivy scan has the same 215 OS package/advisory pairs as the previous
reviewed image: one critical, 34 high, 95 medium and 85 low, with no additions or
removals and no non-OS/Node findings. This is not a vulnerability-free image; the
[existing applicability review](runtime-image-review-2026-11-10.md) remains
relevant. ZIP import uses bounded Node zlib, and the library never executes
uploaded scripts/hooks or OS archive tools.

## Production outcome

The founder separately approved image publication and the protected production
environment in GitHub. [Production release 42914641971](https://github.com/Orlev01/warthog/actions/runs/42914641971)
completed successfully at approximately 22:43 UTC on 10 November (09:43 Sydney
time on 11 November). [Warthog](https://app.warthog.com.au) serves the reviewed
application source and digest above as revision `warthog--r42914641971a1`.

Independent Azure inspection confirmed one healthy replica, explicit 100% traffic
to that revision, all older revisions inactive with zero replicas, and unchanged
application configuration apart from the image, revision suffix and traffic
target. The workflow verified the database ownership lock was free after stopping
the old process and held after starting the new one. Successful readiness follows
startup migrations; no separate remote migration-table query is claimed.

All 16 live public checks passed: readiness/liveness, signed-out access, MCP
authentication/origin/method handling, exact OAuth loopback redirect and state,
PKCE/resource rejection, receipt authentication and terms. Browser checks passed
at 320, 390 and 1440 px with no page errors or horizontal overflow; the 390 px
check verified emulated safe-area padding. Authenticated resource and upload flows
were exercised with synthetic local fixtures before publication, not by modifying
production user data.

Release logs, immutable image review, live snapshots and acceptance evidence are
retained privately under `.delivery/agent-first-release/`.

The isolated runner was destroyed after the successful release. Independent
inspection at 22:46 UTC confirmed the lease resource group, VM, disk, NIC, NAT,
egress public IP and scoped role assignments were absent; the shared subnet's NAT
was detached; and the GitHub runner was deregistered. The local ephemeral SSH
private key and registry credentials were removed. Application infrastructure was
not part of that teardown.

The documentation commit containing this outcome follows the deployed application
commit; it does not change the running source or require another deployment.

[Review and follow-up disposition](agent-first-review-2026-11-10.md),
[agent-first decision](../adr/agent-first-management.md),
[skills integration](../adr/private-skills-library.md),
[provider transport](../adr/provider-mcp-client.md),
[resource audiences](../adr/resource-audiences.md),
[collection bounds](../adr/collection-bounds.md),
[task claims](../adr/task-handoffs.md).
