# Warthog agent-first review

Reviewed from deployed-source documentation commit `da5301c` in the isolated
`codex/warthog-agent-first` worktree. The older `warthog/main` checkout is behind
that baseline. The concurrent skills-library worktree was not edited. Its commit `4047936` was
subsequently integrated by merge `da1a9d4`, before any deployment.

The product has a substantial agent-aware foundation: authenticated connections,
per-connection grants, member-scoped storage, global and individual rules,
approvals, protected releases and an activity chain. Its portal did not make that
model clear, and several rendered controls did not match live behaviour. The
changes below establish the model in navigation, storage and enforcement.

This was a cross-domain source and integration review with regression testing. It
is not a claim that every line is defect-free, a penetration test, or live
certification of all catalogue services. This document records source review; the release record tracks deployment separately.

## Findings and changes

| ID | Impact | Finding | Remediation |
| --- | --- | --- | --- |
| AF-01 | High, product | Resources appeared as independent global screens; no agent management workspace | Added agent workspace, explicit account scope and agent selectors, global defaults page and durable architecture decision |
| AF-02 | High, access | Skills section always loaded an empty array and did not persist assignments | Added explicit per-agent overrides used by the settings page, context and direct skill fetch; source disable still wins |
| AF-03 | High, access | “Read shared memory” also authorised writes | Split read/write permission and preserved existing grants during migration |
| AF-04 | High, security | Approved connector holds executed without rechecking current permissions/rules | Re-evaluate current policy before execution and persist refusal; collection also checks current sensitive-data grant |
| AF-05 | High, security/product | Service execution selected the first connected account, without an agent-level account choice | Added account selection; ambiguous/missing selections fail closed; bound approval and reversal to the original account and included it in approval detail |
| AF-06 | High, audit | Permission edits had no transactionally coupled audit entry | Connection/row lock, partial merge and redacted agent-scoped audit write in one transaction; rollback tested |
| AF-07 | High, product | API-key Connect ended at a notice with no credential-entry form | Added authenticated credential form, encrypted persistence and audited outcome; no automatic agent grant |
| AF-08 | High, product | Provider MCP catalogue could present a successful connection using an empty tool-list stub; execution would use generic HTTP instead of MCP | Replaced the stub with SDK-backed OAuth, authenticated discovery/calls, refresh and reconnect; all provider tools require approval |
| AF-09 | Medium, observability | “View activity” opened permissions; list spending was always zero and labelled AUD | Separate Manage and filtered-activity links; real budget-period releases, correct currency, visible incomplete conversions |
| AF-10 | Medium, policy | Workspace omitted global rules and connector copy always promised ask-first | Show inherited rules and actual editable read/change settings |
| AF-11 | Medium, configuration | No persisted global agent defaults; request rate unbounded at save | Account defaults seed both onboarding routes; per-agent rate bounded; existing grants remain unchanged |
| AF-12 | Medium, financial correctness | Agent budget accepted arbitrary currency labels including SQL-shaped text | Validate recognised currency codes, normalise legacy AUD label, expose editable currency/period |
| AF-13 | Medium, security/data | Import enabled and shared every skill, including formerly disabled or chosen-agent skills | Export skill state/audience; preserve disable and require reassignment for every imported skill; export agent settings as reference |
| AF-14 | Medium, integrity | Agent creation, grants and initial credential issuance could commit separately | Wrap initial OAuth/access-key provisioning in transactions; static-key grants restricted to owned service connections |
| AF-15 | Medium, compatibility | Setup instructions assumed generic consumer-app connector screens; an access key was suggested as a fix for missing protocol support | One shared provider-guidance source, current official links, Notion Custom Agents guidance and explicit connection boundaries |

Key evidence: `src/app/(portal)/(protected)/agents/[id]/actions.ts`,
`src/components/agents/agent-workspace.tsx`, `src/server/agents/`,
`src/server/mcp/pipeline.ts`, `src/server/mcp/compose.ts`,
`src/server/connectors/tool-routing.ts`, `src/server/db/agent-permissions.ts`,
`src/server/db/skills.ts`, `src/server/mcp/tools/memory.ts`,
`src/server/export/build.ts`, `src/server/import/import.ts`.

## Cross-domain coverage

| Domain | Evidence reviewed | Conclusion / remaining boundary |
| --- | --- | --- |
| Product and navigation | Brief, technical design, all protected route groups, shell, home, agent/connect/resource screens | Agent is now the management entry point; account resource ownership remains explicit |
| Design and accessibility | Local design skills, primitives, layout, form wiring, status/notice patterns | Uses existing visual tokens and responsive widths; browser evidence below is required for layout claims |
| Agent identity and authentication | OAuth registration/metadata/consent, bearer resolution, access keys, disconnect, session and step-up modules | Unique credential per independently managed agent; no generic control of provider runtimes |
| Authorisation and rules | Context loader, policy evaluator, registry, held-call execution, rule storage | Runtime uses current per-agent grants and global restrictions; approved-call revocation defect repaired |
| Connectors and networking | Catalogue, API-key/OAuth/MCP paths, curated tools, generic request construction, guarded fetch | Member-scoped encrypted credentials, fixed hosts, DNS-at-connect guard, redirect/size/time bounds; provider MCP has a real transport and conservative approval policy; live provider acceptance is separate |
| Sensitive data and cards | Vault browser crypto, wrapped keys, release handler/store/collector, ledger, currency and household checks | Device-protected fields, approval and one-time release remain; budget tracks authorised releases, not verified merchant charges |
| Skills and memory | Scope storage, get_context/get_skill/remember/search_memory, portal actions | Effective skill and per-memory assignments enforced consistently; independent memory writes; field and service policy granularity implemented |
| Tasks and life admin | Assignment-scoped reads/updates, records capabilities, receipts/storage, reminders | Owned connected assignees, transactional note updates and renewable claims implemented |
| Activity and observability | Redaction/fingerprints, writer/hash chain, filters, integrity job, metrics | Per-agent history and settings audit; external direct actions remain outside coverage; agent reports remain unverified |
| Account and household | Deletion/reset/purge, invitations, address sharing, budgets | New tables cascade with account deletion; household does not confer access to another member's private agent resources |
| Portability | Export schema/builder, import transaction, protected device transfer | Corrected skill scope/enable widening; agent grants exported as reference and require reconnect/review |
| Notifications | Notification prefs/outbox, push/fallback/SMS budgets, provider senders | Account-wide delivery channels; no outbound messages sent by this review |
| Deployment and infrastructure | Docker/Next build, runtime config validation, private DB/TLS settings, CI/runbooks/singleton guards | Single-replica release-store assumption remains; no cloud mutation or deployment performed |
| Dependencies and quality | Lockfile audit, typecheck, existing and new regression suites, scaffold/placeholder scan | No runtime dependency added; rendered-flow tests exposed gaps missed by large unit-test count |

## Follow-up disposition — 11 November 2026

| Original follow-up | Result |
| --- | --- |
| Outbound provider MCP | Implemented durable OAuth/PKCE/issuer binding, authenticated discovery/calls, rotation-safe refresh, reconnect, guarded streaming transport and approval policy. Synthetic protocol acceptance passes. [Decision](../adr/provider-mcp-client.md). |
| External platform acceptance | Official interfaces reviewed; product distinguishes a connection guide from verified interoperability. Dots and Instinct are explicitly unverified. Live authenticated acceptance requires the real provider account/consent and is not claimed from documentation or mocks. |
| Resource granularity | Arbitrary per-memory audiences, explicit vault fields, service-specific tool policies and release/collection revocation checks implemented. [Decision](../adr/resource-audiences.md). |
| Collection scans | Memory and agent skill indexes use bounded keyset pages, direct skill IDs, and serialized encrypted-byte/row quotas; package supporting files load on demand. Exports remain complete. [Decision](../adr/collection-bounds.md). |
| Task hand-offs | Reject foreign/nonexistent/disconnected assignees; row-lock notes and status; renewable ten-minute claims for shared tasks; imports reset assignment. [Decision](../adr/task-handoffs.md). |
| Mapping and scaffold cleanup | OAuth and access-key setup share initial grant mapping; registry publishes real context schemas; obsolete provider stub comments removed. Browser and protocol acceptance cover integrated flows. |
| Skills-library integration | Merged `4047936`; reconciled per-agent overrides and library audiences, encrypted package portability, disable state and supporting-file access. [Integration notes](../adr/private-skills-library.md). |

Additional defect repaired: inventories over 80 connector tools advertised discovery
and call helpers without execution handlers. Both helpers now work with pagination,
current account selection, trusted declarations and normal policy/audit enforcement.

## Compatibility sources checked

Reviewed on 10–11 November 2026:

- [OpenAI Dots plugin guidance](https://help.openai.com/en/articles/20001530-getting-started-with-your-dot).
- [Instinct product site](https://instinct.com/).
- [Claude remote custom connectors](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp).
- [OpenAI custom MCP setup](https://developers.openai.com/api/docs/guides/custom-mcp-server).
- [Notion Custom Agent MCP connections](https://www.notion.com/help/mcp-connections-for-custom-agents).
- [Gemini CLI MCP documentation](https://github.com/google-gemini/gemini-cli/blob/main/docs/tools/mcp-server.md).
- [xAI remote MCP tools](https://docs.x.ai/developers/tools/remote-mcp).
- [MCP authorisation security considerations](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/draft/basic/authorization/security-considerations.mdx).

Incoming Warthog credentials remain separate from upstream service credentials;
this is consistent with MCP's prohibition on token passthrough.

## Original review validation

The integrated release validation is recorded in the follow-up release record.
These counts describe the original pre-integration source review.


Initial integrated regression run: 5,105 tests passed. Focused agent/permission,
connector and MCP regression: 378 tests passed. A further 22 focused security and
workspace checks passed, including revoked held calls, per-agent skill retrieval,
independent memory writes, foreign-id rejection and audit-write rollback. These
counts overlap and are not an additive total.

Production dependency audit: zero reported vulnerabilities (`npm audit --omit=dev`)
on this lockfile at review time. This is not evidence of absence of vulnerabilities.
Final validation:

- Production build and boot smoke: 9 passed, including standalone output, unauthenticated
  guards, OAuth/MCP responses, client-bundle secret scan and job startup. The boot test
  runs the built app with development configuration and PGlite; Azure runtime was not tested.
- Latest targeted follow-up: 71 passed, including changed connector actions, permission
  actions, import isolation and settings/connector views.
- Browser: 112 route/viewport combinations passed at 320, 360, 390, 768, 1023, 1024
  and 1440 px; the tablet check used a short 540 px height. Each checked successful
  loading, one main heading and absence of document-level overflow. Synthetic
  fixtures included a long unbroken agent name, two service accounts and private/shared memories.
- Browser interactions: service-account selection persisted; memory read/write stayed
  independent; skill revocation left a sibling agent unchanged; global defaults
  saved without rewriting existing agents; permission changes appeared in the audit;
  agent selector and keyboard navigation worked.
- Additional browser checks: all nine agent sections in dark mode with reduced motion;
  credential-form save with a synthetic key and no automatic agent grant; Minimal
  onboarding default; unknown-agent not-found view. No browser console/page errors
  remained. This does not establish real-device or screen-reader acceptance.
- Delivery tooling: 29 Python tests passed; infrastructure cost checks: 5 passed.
- No runtime dependency was added. Formatting used an ephemeral development formatter.

Local browser evidence is in `.delivery/agent-first/` (ignored by Git), including
`browser-results.json`, `browser-extra-results.json`, `overview-desktop.png`,
`overview-mobile-dark.png` and `connectors-desktop.png`. Test logs are under
`/tmp/warthog-agent-first-*.log`.

The browser pass exposed and fixed long-agent-name overflow. An earlier full run
caught an OAuth transaction deadlock and outdated navigation/copy assumptions;
these were corrected and the affected OAuth, UI and security tests rerun. The
final regression exercised all 420 test files: **5,117 passed, zero failed,
cancelled or skipped**. It ran in three batches to keep the dev server separate
from the build: 4,956 ordinary tests, 152 tests from the 16 dynamic-route files,
and the 9 build/boot tests. Dynamic-route files were executed by literal filename
because Node's test CLI interprets brackets in explicit paths as glob patterns.
Final `npm run typecheck` and `git diff --check` passed.
