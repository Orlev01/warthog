# Functional product review — 12 November 2026

## Verdict

**Warthog delivers a working, permission-controlled gateway to shared resources,
but it does not yet deliver the complete agent management and audit product
described in the brief.** The agent-first navigation and many access checks are
real. The weakest part is the evidence a person needs to understand, investigate
and trust what an agent did.

The observed Claude-to-Gmail flow works. It also exposes an integration defect:
the application records useful request fields, then drops them when preparing the
activity view. Other gaps go beyond presentation: some failures are classified as
executed, some calls and administrative changes have no audit entry, and useful
client metadata is not retained.

The earlier release's passing tests established regression/build/deployment
health. They did not establish fulfillment of every product promise. This review
adds explicit writer-to-reader and failure-path probes rather than relying on
test totals.

## Scope and evidence

- Reviewed source: `c56e35401b9e610096036d3003dbcdc5b1836143`, fetched from GitHub
  main on 12 November. Review branch: `codex/warthog-product-review` in a new,
  managed worktree. Other worktrees were not changed.
- Compared the ratified brief, design, agent-first decisions, source paths,
  current portal and the founder's supplied Claude transcript.
- Read the signed-in production agent overview, resource controls, agent audit
  and full filtered activity log. Expanded a read, search and context entry.
  No messages were sent, inbox contents fetched, grants changed or customer data
  modified during this review.
- **596 targeted tests passed**, zero failures, cancellations or skips, covering
  MCP composition/policy/tools, resource controls, activity, connector routing,
  curated transports, spending and activity actions. This was not a new full
  suite, production load test or penetration test.
- **14 diagnostic groups** reproduced the baseline behavior using synthetic
  in-memory PGlite data and injected executors; there were no upstream service
  calls. See [results](diagnostic-results.json) and
  [executable diagnostic](diagnostics.mjs). These characterize defects and
  boundaries; their passing assertions are **not** acceptance tests for fixes.
- Production observations are recorded without customer email contents,
  addresses, account identifiers or real message IDs. Private working logs are
  under `.delivery/product-review/`.
- Existing consent and MCP metadata worktrees are separate work in progress.
  This review evaluates the stated baseline, not their future merged result.

## What the Claude example establishes

The live agent log contains **ten calls: one context fetch, one Gmail search and
eight Gmail reads**. The transcript summarizes six messages. This demonstrates
that Claude used the Warthog connection and that Warthog attributed the calls to
that credential's agent. It does not establish why eight reads produced six
summarized messages: repeats, extra reads and unsuccessful reads cannot be
distinguished from the visible record today.

The live grants permit Gmail reads, choose one Gmail account and set changes to
ask-first. Therefore a Gmail read does not normally need a Warthog inbox approval.
The tool permission prompts shown inside Claude belong to Claude's own permission
layer. A Warthog approval is a separate held request with an approval identifier
and an in-app decision. Claude documents its own tool access settings and
approval prompts. [Claude connector documentation](https://support.claude.com/en/articles/11176164-use-connectors-to-extend-claude-s-capabilities).

The mismatch between the chat's apparent user profile and the Warthog profile is
an account-provenance problem to explain, not evidence here of a cross-account
authorization bypass. Warthog resolves the bearer to the Warthog account that
consented and to that account's selected Gmail connection. It does not verify
that the human described by Claude's chat profile is the same human. A low-tier
profile name is also user-maintained data, not identity verification. We should
show the connected account explicitly and avoid inferring a Gmail identity from
the profile name alone.

## Promise versus delivered behavior

| Product area | What works | Product completeness / boundary |
| --- | --- | --- |
| Agent workspace | Per-agent resources, controls and activity; account/global settings separated | Real management of a credential-backed connection; no independent model, conversation or sub-agent registry |
| Authentication and ownership | OAuth/access keys bind to an account and agent; member-scoped queries; token revocation | Does not establish the remote chat user's identity; client name/platform is not attested identity |
| Connectors | Selected account, service grant, read/change policy, encrypted credentials, actual Gmail access observed | Tool lists are empty in agent settings; no persistent individual-tool allowlist or mailbox/folder restriction |
| Global and agent rules | Runtime allow/ask/deny, global restrictions, explicit tool rules, current-policy checks on held calls | Rules needing message/recipient/amount semantics do not automatically cover arbitrary API requests |
| Approvals and revocation | Held calls, expiry, owner decisions, sensitive release step-up, disconnect/release cancellation | Claude prompts are separate; revocation cannot recall data already delivered or stop an external provider's other tools |
| Vault | Selected fields, low/high tiers, device-protected sensitive values and one-time releases | Audit does not say which permitted fields a context fetch actually returned; post-release provider use remains outside control |
| Skills/plugins | Encrypted library, supporting files, audiences/overrides, disabled-state enforcement | Retrieval is governed; execution/adherence in the external model is not. Scripts/hooks are files, not executed plugins |
| Memory | Read/write separation, per-memory audience, source agent and stored time | No automatic ingestion of private provider memory; read evidence lacks returned IDs/versions; owner CRUD auditing is incomplete |
| Tasks/handoffs | Owned assignees, shared-task claims, notes/status and access checks | Passive task board polled by agents; assignment does not launch or wake an agent. Read/write share one task capability |
| Life-admin records | Owner-scoped records, reminders, receipt handling and agent CRUD | A records grant covers the owner's record collection, including changes; no selected-record audience or independent read-only grant |
| Cards/spending | Approval-bound card releases, budget checks, per-agent ledger, labelled agent reports | Tracks authorized releases, not bank-confirmed charges, model-token costs or all agent spending; cannot bind a released card to a merchant/amount at the issuer |
| Audit and investigation | Account/agent attribution, encrypted payloads, hash chain, filters, disputes store | Material gaps in readable details, search, outcomes, lifecycle coverage, continuation and dispute presentation |
| Metadata/observability | Agent name/platform/status, connected/last-call times and call count; aggregate operational metrics | No retained MCP client/version/capabilities, per-run correlation or per-agent latency/error dashboard |
| Portability | Broad export, device-local protection, reassignment on import, separate imported history | Valid exports can exceed the import UI's 16 MiB cap; disputes are not included in the export builder |
| Household | Separate member accounts, shared address/budget and member totals | Household membership does not grant access to another member's private agents/resources; this is the intended boundary |
| Notifications | Push/fallback pipeline, preferences, suppression and bounded sending implemented | Current release records retain SMS off; delivery timing and real-device reliability were not recertified by this review |
| Platform/operations | Guarded network transport, private DB, singleton deployment/ownership checks, existing release validation | No new proof of the 500 ms p95, 100k-event export target, every device's accessibility or every provider's live interoperability |

## Findings and required follow-ups

### PR-01 — P1: stored audit evidence disappears in the portal

`src/server/mcp/pipeline.ts:344` writes `params`, `reason` and
`connectorAccountId`. `activity/actions.ts:264` reads only `summary` and `detail`.
Ordinary pipeline calls provide neither. `src/server/agents/workspace-data.ts:53` reduces
events further to title, outcome and time. The live UI and synthetic probe both
show empty expanded details despite a stored reason and parameters. The same
mismatch hides `log_activity` outcome text, whose schema puts the summary in
`reason`.

**Required:** one typed event-to-view formatter for actual stored event variants,
used by home, agent and full activity views. Show service/account, action,
redacted targets/parameters, supplied reason and observed outcome. Distinguish
missing historical evidence from empty text. Test with entries produced by the
real pipeline, not only hand-built `{summary, detail}` fixtures.

### PR-02 — P1: upstream errors can be recorded as “Executed”

HTTP connectors return `{status: number, body, truncated}`. Provider MCP returns
the provider's tool result, including `isError`. The pipeline's
`asToolRefusal` (`pipeline.ts:182`) recognizes only
`{status: "refused", reason}`. Consequently both a synthetic HTTP 500 and an MCP
`isError: true` result became `executed`. `compose.ts:157` then wraps the result
as ordinary MCP text, without surfacing the nested provider error at the outer
MCP result level.

**Required:** normalize transport, provider and business outcomes before auditing
and returning them. Separate attempted, successful, refused, failed and unknown
outcomes. Preserve safe status/error codes, truncation and structural result
summaries. Exercise HTTP 401/403/404/429/500, provider `isError`, timeouts and
successful empty results. Do not retain full email bodies merely to repair this.

### PR-03 — P1: failed calls and post-action audit failures break completeness

If execution throws, `pipeline.ts:519` emits operational metrics and rethrows
without an activity record. The probe recorded **zero new activity entries** for
a thrown transport failure. SDK validation and unknown-tool rejection can also
occur before the pipeline. Count semantics consequently differ from “every
request received.”

Execution also precedes the audit append (`pipeline.ts:500`). An injected audit
failure occurred after the synthetic side effect but caused an error response.
This creates an ambiguous retry window: an external action may have happened
without its final record. Held-call failures retain an outcome internally but
their catch path also omits an activity outcome event (`pipeline.ts:617`).

**Required:** durable request/attempt identity and recorded intent before an
external mutation, terminal audit events for success/refusal/failure, safe
validation-failure events for authenticated callers, and reconciliation of
unknown outcomes. Use provider idempotency where supported; do not claim universal
exactly-once execution or automatically replay ambiguous actions. Keep invalid
bearer traffic in separate security telemetry, not an invented user's audit.

### PR-04 — P1: sensitive administration is not fully audited

OAuth agent creation (`src/app/oauth/authorize/actions.ts:202`) creates the agent
and grants and sends a security alert, but does not append a connection audit
event. Access-key creation has the same omission. Rule create/edit/pause/delete
(`rules/actions.ts:326`) and owner memory add/edit/delete
(`memory/actions.ts:270`) do not append activity either. Memory rescoping and
per-agent permission edits do have transactional audit writes.

The synthetic rule creation and owner memory creation both succeeded with **zero
new audit entries**. This is narrower than the brief's “every rule change” and
“every memory write.”

**Required:** a lifecycle event inventory and transactional writes for each
administrative mutation, with actor, affected resource, safe before/after change,
permission/policy version and applicable agent attribution. Test failures of the
audit write roll back internal mutations. Preserve account-wide changes as such;
do not falsely attribute the owner's action to an agent.

### PR-05 — P1: message restrictions are not universal for generic API tools

Generic connector requests carry method/path/body but no trusted message channel
or recipient extraction. `registry.ts:399` copies only declarations that exist;
`evaluate.ts:133` matches a send-message rule only when the channel matches.
The pure policy probe allowed a generic change-capable request under an explicit
“never allow email” rule when its change policy was `allow`. No request was sent.

The default ask-first policy reduces exposure, and a service-wide deny still
works. The brief limits message classification to declared curated tools, so this
is also a product-language limit: “never send email” cannot be presented as a
universal guarantee. Provider MCP already takes a more conservative route for
untrusted semantics; arbitrary API tools need an explicit policy too.

**Required:** trusted service adapters for message/recipient/amount extraction or
conservative refusal/approval when an applicable restriction cannot be evaluated.
Show rule coverage in the editor. Prove a generic sending route cannot silently
bypass the user's intended prohibition.

### PR-06 — P2: tool-level control is not available as promised

`agents/[id]/actions.ts:223` passes empty read/change tool arrays, matching the live
Gmail settings screen. Stored permissions grant services and tool classes;
`pipeline.ts:198` sets `grantedTools: [call.tool]` rather than reading an allowlist.
Specific-tool rules can constrain a known tool, but are not a visible, durable
per-tool access editor. There are also no Gmail folder/label/message constraints.

**Required:** populate the real permitted tool inventory and implement an explicit
per-tool policy if retaining that promise, with a deliberate policy for newly
discovered tools. Keep discovery, context, direct calls and approved holds in
agreement. Separate tasks/records read/write and selected-record audiences if
those resources are to have the same granularity as memory and vault fields.

### PR-07 — P2: useful agent metadata is available but not retained

The `agents` table stores one row per credential connection: name, platform,
status, connected time, last active time and request count. OAuth token storage
also binds the client ID. That is meaningful identity for authorization, but not
a model/run/conversation identity. A credential shared across sessions or workers
is indistinguishable in the current record.

The MCP composition constructs a stateless server without a persistence hook for
client implementation information or capabilities (`compose.ts:443`). Legacy
MCP initialization includes client information/version/capabilities; modern MCP
uses per-request metadata. These are client assertions and must be labelled as
such, not trusted as proof of the human or model identity.
[Legacy lifecycle](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle),
[modern protocol metadata](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning).

**Required:** bounded, provenance-labelled client observations tied to the verified
connection, with last-observed times and protocol versions. Use a Warthog-generated
request ID; optionally accept client-provided run/task references as unverified
correlation. “Connected” should clearly mean access authorized, not a live
heartbeat or independently running worker.

### PR-08 — P2: the context contract does not explain account provenance well

`get_context` returns granted profile values and service IDs, but no selected
service-account label or explicit current-agent identity. The full house
instructions are not included: only the title and “use this when” line appear
(`get-context.ts:161`, `domain/skills/index.ts:75`). Fetching the house skill is an
extra optional call. In the observed sequence Claude fetched context but did not
fetch that skill or submit an outcome report.

**Required:** include concise house instructions in the initial context/server
instructions, the current connection's identity, selected account provenance and
clear coverage limits. Encourage a final outcome report without pretending it is
an observed fact. This can improve the profile mismatch explanation, but cannot
guarantee an external model follows instructions.

### PR-09 — P2: history, search and disputes are incomplete user workflows

The full activity loader reads at most 500 entries (`activity/actions.ts:94`) and
does not expose/use the store's cursor. Free-text search checks only the empty
summary field on those rows. A search for the synthetic stored reason returned
zero results. A reduced page-limit probe confirmed attempted continuation returns
the same page. Date filters can narrow history, but there is no honest browse-next
or bounded search continuation.

Disputes are stored append-only, but `readDisputes` has no product caller; filing a
synthetic dispute left the activity view unchanged. The export builder does not
include disputes either.

**Required:** keyset navigation, explicit search coverage/continuation, searchable
safe event fields and a visible dispute badge/note/history with export support.
Old entries must remain reachable by their linked ID even beyond the first page.

### PR-10 — P2: result evidence and observability do not explain a run

Normal events retain request parameters but not returned target references,
counts, response status, result summary, policy rationale/rule ID or latency.
The limited calendar-reversal metadata is an exception. The pipeline metrics
emitted by `pipeline.ts:378` carry only outcome/error category; they do not even
populate the available connector/platform dimensions, and there is no per-agent
performance view. There is no reliable search → reads → task → outcome linkage.

**Required:** implement the evidence contract below and show one correlated work
sequence, while explicitly distinguishing observed results from agent-reported
summaries. Do not imply that Warthog automatically receives prompts, conversations,
model reasoning, token usage, provider bills or actions outside the connection.

### PR-11 — P2: export and import capacities do not match

The import UI rejects files above 16 MiB (`components/settings/data-transfer.tsx:103`),
the legacy endpoint has the same cap, and the prepared endpoint caps requests at
26 MiB. Memory, skill and package collections permit substantially larger
combined content; history adds more. Export builds a complete, formatted JSON
document. A valid account can therefore produce an export it cannot restore
through the supported UI.

**Required:** versioned bounded/chunked transfer or an agreed larger safe streaming
format. Verify round trips at maximum supported combined collection/history
sizes, including protected data and packages. Preserve the current reassignment
safety for imported resources; do not restore old credentials.

### PR-12 — P2: catalogue size is not interoperability evidence

There are 106 definitions: 62 API-key, 34 provider MCP, six OAuth and four basic
auth. The loader marks API-key/basic/provider MCP entries connectable based on
configuration type, not a recorded successful live acceptance
(`connectors/catalogue.ts:106`). Six Google/Microsoft service groups have local
curated implementations; generic endpoints and externally discovered tools cover
the other paths. This is not proof that 100 services are usable end to end or that
all provider registration flows work today.

**Required:** per-service evidence for connect, identity, read, write approval,
error, refresh, reconnect and revoke; record tested date and supported operation
set. Label configured, protocol-tested and live-verified separately. The supplied
Claude/Gmail flow adds genuine live read evidence for that combination only.

### PR-13 — P2: the integrity claim needs an explicit threat boundary

Runtime database privileges prevent ordinary application updates/deletes, and the
chain detects altered entries and interior gaps. However, the checker compares
only the remaining rows, with no independently retained head/count. The synthetic
privileged-DB probe deleted the last entry: integrity still reported intact, with
four checked instead of five. This was not a production mutation or a runtime-role
bypass.

**Required:** qualify the claim as consistency of the retained chain, or add
independently protected head checkpoints if privileged truncation detection is
required. Never let “intact” imply that every action was logged or that the
record's asserted business outcomes are true.

## Minimum useful agent evidence contract

| Layer | Retain / present | Trust and privacy treatment |
| --- | --- | --- |
| Connection | Stable agent/connection ID, owner, credential kind, consent/client binding, display label, grants/version, connected/revoked times | Verified by Warthog's authorization path; never store credential values in events |
| Client observation | Client name/version, protocol, declared capability summary, observed time | Optional, bounded, self-reported; no model/human identity inference |
| Request | Server request ID, agent, service account reference, tool/action, time, safe parameters/targets, supplied reason | Warthog-observed envelope; reason remains agent-supplied; redaction before persistence |
| Decision | Allow/ask/deny, rule reference/reason, permission version, linked approval, decision actor/time | Warthog-enforced facts, separately identifiable from the client's own prompt |
| Result | Attempt/terminal status, upstream status/error class, duration, counts/target references, truncation, safe outcome description | Derived from actual response; do not store raw inboxes, documents or secrets by default |
| Work sequence | Optional task/run/parent-request reference, result/artifact references, final outcome report | Server correlation where possible; external run IDs and completion claims labelled as reported |
| Investigation | Readable detail, filters/search/continuation, disputes, export, missing-evidence markers | Same semantics in global and per-agent views; no fabricated backfill |

Missing historical fields cannot be reconstructed reliably from the existing
audit entries. Stored reasons/parameters can be displayed for old events, but
unrecorded results, client metadata, failures and lifecycle events must be shown
as unavailable. Do not rewrite old hash-chained rows to make the history look
complete.

## Recommended implementation order and acceptance

1. **Repair audit truth first:** PR-01 through PR-04 and PR-09. A synthetic
   context → Gmail search → two reads → reported outcome sequence must show the
   actual account, safe targets, supplied reasons and results in both audit views.
   Failed, refused and unknown outcomes must be distinguishable; a persisted
   dispute must be visible. Inspect an event beyond the initial page.
2. **Close policy coverage and tool controls:** PR-05/06. Prove prohibited sending
   cannot escape through generic tools, and a denied tool cannot be discovered,
   called directly or executed from an old approval. Preserve per-agent isolation.
3. **Add provenance and usable metadata:** PR-07/08/10. Test legacy and modern MCP,
   missing/spoofed metadata, multiple sessions using one credential and two
   separately registered agents. Demonstrate what is observed versus reported.
4. **Finish product acceptance:** PR-11/12/13. Large account round trip, connector
   acceptance matrix, explicit integrity guarantees and real-device notification
   checks. Update promises and help text to the evidence actually established.

Audit presentation must use the current Warthog design skills, with readable
mobile event details and accessible disclosure controls. Coordinate the shared
MCP schema/metadata and consent files with the existing worktrees when implementing
these follow-ups; this review has not changed their code.

## Reproduce this review

From the review checkout, with its pinned dependencies and Node 22:

```sh
mkdir -p .delivery/product-review
node --import tsx docs/audit/product-review-2026-11-12/diagnostics.mjs
```

The diagnostic uses a fresh in-memory test database, closes it in `finally`, and
writes synthetic results to `.delivery/product-review/probe-results.json`.
Assertions describe the reviewed baseline and should be replaced or inverted as
the defects are repaired. No production code was changed or deployed by this
review. The local report is intended for the next implementation/integration pass.
