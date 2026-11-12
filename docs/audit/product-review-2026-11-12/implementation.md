# Product review implementation — 12 November 2026

**Subsequent deployment:** these changes and the latest main were released as
application source `9f2ef12`. See the [production release record](../product-review-release-2026-11-12.md)
for the immutable image, hosted checks and live acceptance. The evidence below
describes the preceding implementation phase.

The thirteen review findings have implementation changes and explicit acceptance
records on isolated branch `codex/warthog-product-review`. This is local
implementation evidence, not a deployment attestation or certification of all
external providers. The original [review](review.md) and diagnostic results remain
historical evidence; missing historical observations are not fabricated.

The completed consent (`f8fb718`) and MCP tool metadata (`b77586c`) changes were
merged before implementation. Other worktrees were not edited. See the
[implementation decision](../../adr/agent-evidence-and-controls.md).

| Finding | Implemented behavior | Acceptance |
| --- | --- | --- |
| PR-01 | Shared safe formatter for home, agent and full activity views; reasons, targets, account, decisions and result evidence | Real pipeline → encrypted writer → portal loader; mobile and desktop inspection |
| PR-02 | HTTP, provider and business refusals normalized before recording and returning; MCP errors surface failures | 401/403/404/429/500, provider `isError`, unavailable resources, successful results and thrown changes |
| PR-03 | Server request/attempt IDs; durable pre-change intent; failed/unknown outcomes; authenticated boundary rejection records; atomic pending and completed approval evidence | Audit-outage rollback, single-claim holds, no replay of unfinished claims; stale claimed holds report unknown |
| PR-04 | Transactional connection/key, rule and owner-memory lifecycle events with actor and affected resource | Real owner actions and injected audit failure rollback; existing consent/key regressions |
| PR-05 | Unknown API/provider semantics receive conservative restrictive-rule handling; editor explains coverage | A real generic sending route cannot bypass a never-email rule |
| PR-06 | Real tool inventory and explicit current/future-tool policy; independent task/record writes; selected-record audience | Discovery, direct execution, revoked-tool approved holds, account isolation and browser save/reload |
| PR-07 | Bounded encrypted client name/version/protocol/capabilities with provenance and observation time | Legacy/modern metadata, identity retention across normal calls, invalid/unknown requests and actual PostgreSQL storage |
| PR-08 | House instructions in initial context; credential-backed current agent and selected service-account provenance | Context regressions; supplied identity is explicitly distinguished from chat-user/model verification |
| PR-09 | Keyset continuation, page-bounded search, exact entry links and visible/exported disputes | Browser search reaches an event beyond the first 500; writer/reader isolation; disputes survive export and re-import |
| PR-10 | Policy fingerprint, server request/attempt IDs, client-reported run correlation, counts/references/status/truncation, duration and bounded per-agent performance | Synthetic context → search → reads → reported summary sequence; separate 429 failure; no raw response-body retention |
| PR-11 | Chunked encrypted staging; atomic/idempotent commit; supporting package files and protected values preserved; cross-part address remapping; prior imported history retained | 67 MB capacity round trip, maximum capped collection counts, 100,000 history entries, protected chunks, conflicting/missing parts and rollback |
| PR-12 | Catalogue distinguishes configured, locally protocol-tested and operation-specific live evidence | [106-service evidence matrix](connector-verification.json), generated from the same evidence labels used by the product; live gaps explicitly recorded |
| PR-13 | Integrity describes consistency of retained entries and its privileged-truncation/completeness limits | Existing chain tests and browser integrity check over 521 synthetic entries |

## Lifecycle event inventory

New transactional audit coverage includes OAuth agent consent, access-key creation,
replacement and revocation; rule creation, editing, pausing and deletion; and owner
memory creation, editing and deletion. Existing permission changes, memory
rescoping, agent disconnects, connector lifecycle, approval decisions and protected
release events remain in their existing paths. Client observation changes and
multipart import completion are also recorded. Account-owner edits are labelled
as owner actions; global rule/memory changes are not falsely attributed to an agent.
Connection events use the persisted grant snapshot, including a nondefault
account request limit; OAuth and access-key regressions verify the complete snapshot.

Pending approval creation, its encrypted held arguments and its audit event commit
together. A claimed hold's final outcome and terminal audit also commit together.
An external side effect cannot be rolled back with a database transaction. A
persisted attempt without a confirmed completion requires inspection of Activity
and the provider before a new request; Warthog does not automatically replay it.

## Capacity and privacy acceptance

`scripts/verify-large-transfer.ts` uses only disposable local PGlite data. It
restored a 67,147,192-byte fixture, exported it, then restored that export into a
second account in 18 parts per transfer. Counts: 1,000 skills (900 standalone and
100 package members), 100 complete packages, 5,000 memories, 1,000 protected fields,
1,000 cards and 100,000 historical entries. It checks actual skill/supporting text,
archived disputes and all card/address links, not only counts. The measured run
completed in about 24 seconds; this is not a production latency/load guarantee.

A separate browser-controller regression handles an over-16-MiB protected backup
with maximum-size field values, verifies every upload is below the request limit,
and verifies plaintext does not leave the device. A real-store regression splits
protected values across parts and validates the final card's remapped address.
Staging expires after 24 hours, is owner scoped and encrypted, and is removed by
the existing hourly cleanup. Concurrent PostgreSQL commit retries restore once.
The legacy single-request format retains its 26 MiB wire allowance for cached
clients. New multipart payloads are bounded to 12 MiB, normally targeting 4 MiB.
A route regression verifies both compatibility and rejection of oversized parts.

Imported history remains distinct from the live hash chain on subsequent exports.
Agent settings are reference data in the downloaded file; agents, credentials and
assignments are deliberately not reinstated. Reconnect and review access after an
import. Browser memory and per-item limits remain practical bounds.

## Browser acceptance

The local browser uses a disposable container and synthetic account; no production
account, external messages or real connector credentials are involved. Verified:

- Agent overview shows client assertions, observation time, authorized-connection
  meaning and bounded latency/failure evidence.
- Connector tool checkboxes, current/future-tool policy and selected account are
  visible. Saving and reloading preserves the tool restriction.
- Task/record writes can be disabled independently of read access. Checked-record
  selection persists after saving and reloading.
- The per-agent log distinguishes allowed reads, denied reads, a provider failure,
  owner permission changes, pre-execution attempts and reported summaries.
- Expanded details expose safe parameters, account, request/attempt/run correlation,
  policy decision, HTTP status and timing; response bodies remain absent.
- Search explicitly covers a page; continuation preserves the query and reaches
  the oldest entry and its dispute. Keyboard activation opens historical details,
  including the missing-result warning. Integrity explains its scope.
- Layouts at 320, 390 and 1440 pixels preserve readable controls and details with
  no document overflow in the inspected narrow views. Light and dark appearances
  were inspected; no browser console errors were observed.

## External acceptance boundaries

The matrix distinguishes unverified from failed. The supplied Claude/Gmail session
is evidence for connection/context/search/read only. It does not establish Gmail
sending, provider identity verification, refresh/reconnect/revocation, other
providers' live operation sets, or real-device notification delivery. Those rows
remain explicitly unverified and require controlled, authenticated acceptance
with the relevant accounts; a passing simulated transport suite is not a substitute.

Warthog still governs only its own connection. It does not receive private model
conversations/reasoning, provider usage bills or activity through separate tools.
Per-tool restrictions are not Gmail folder/label/message restrictions. A selected
record audience includes checked records and records created by that agent.
Task assignment does not launch a worker. There is no issuer-enforced card budget
or independently anchored protection against privileged audit-tail deletion.

## Validation log

Completed validation:

- Full suite: **5,256 passed**, zero failures, cancellations or skips. Final
  follow-ups then passed **234** pipeline/UI regressions, **24** catalogue
  regressions, and **56** consent/credential/import/audit regressions, including
  three additional grant-snapshot and legacy-import compatibility tests. These
  focused counts overlap the full suite and must not be added as distinct tests.
- Final TypeScript check and production build passed; runtime packaging passed.
- PostgreSQL 16: **78 migrations**, repeat application, role separation, account
  purge, concurrency and the new evidence/control/import checks passed.
- Capacity acceptance: the **67,147,192-byte**, **100,000-history-entry** round
  trip described above passed.
- Desktop/mobile interaction and appearance acceptance passed as described above.
- A Linux Docker production build and runtime packaging also passed before the
  final small outcome, layout and compatibility follow-ups. It is supporting
  portability evidence, not a final release image attestation.

Raw local logs and synthetic screenshots are under `.delivery/product-review/`.
The browser tab and this task's preview/database containers were removed after
verification. Other agents' worktrees and running services were left untouched.
Reproduction commands:

```sh
npm run typecheck
npm test
node --max-old-space-size=4096 --import tsx scripts/verify-large-transfer.ts
node --import tsx scripts/connector-verification-matrix.ts
npm run build
node scripts/prepare-runtime.mjs
```

The existing local PostgreSQL Compose workflow additionally runs
`scripts/verify-local-postgres.ts`, including the new evidence/control/import checks.
Migrations `0106_agent_evidence.sql` and `0107_chunked_import.sql` are additive.
Older images do not enforce the new controls: review rollback behavior before any
release. No production deployment was performed for this implementation pass.
