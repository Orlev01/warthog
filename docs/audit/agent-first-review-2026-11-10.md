# Warthog agent-first review

Reviewed from deployed-source documentation commit `da5301c` in the isolated
`codex/warthog-agent-first` worktree. The older `warthog/main` checkout is behind
that baseline. The concurrent skills-library worktree was not edited or merged.

The product has a substantial agent-aware foundation: authenticated connections,
per-connection grants, member-scoped storage, global and individual rules,
approvals, protected releases and an activity chain. Its portal did not make that
model clear, and several rendered controls did not match live behaviour. The
changes below establish the model in navigation, storage and enforcement.

This was a cross-domain source and integration review with regression testing. It
is not a claim that every line is defect-free, a penetration test, or live
certification of all catalogue services. No production settings were changed.

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
| AF-08 | High, product | Provider MCP catalogue could present a successful connection using an empty tool-list stub; execution would use generic HTTP instead of MCP | Production flow explicitly unavailable; disabled control with reason; reject and exclude unsupported provider MCP execution |
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
| Connectors and networking | Catalogue, API-key/OAuth/MCP paths, curated tools, generic request construction, guarded fetch | Member-scoped encrypted credentials, fixed hosts, DNS-at-connect guard, redirect/size/time bounds; unsupported MCP path no longer advertised as working |
| Sensitive data and cards | Vault browser crypto, wrapped keys, release handler/store/collector, ledger, currency and household checks | Device-protected fields, approval and one-time release remain; budget tracks authorised releases, not verified merchant charges |
| Skills and memory | Scope storage, get_context/get_skill/remember/search_memory, portal actions | Effective skill assignments enforced consistently; independent memory writes; subset sharing per memory remains unsupported |
| Tasks and life admin | Assignment-scoped reads/updates, records capabilities, receipts/storage, reminders | Shared account inventory with explicit grants; task assignee validation and concurrent note updates merit follow-up |
| Activity and observability | Redaction/fingerprints, writer/hash chain, filters, integrity job, metrics | Per-agent history and settings audit; external direct actions remain outside coverage; agent reports remain unverified |
| Account and household | Deletion/reset/purge, invitations, address sharing, budgets | New tables cascade with account deletion; household does not confer access to another member's private agent resources |
| Portability | Export schema/builder, import transaction, protected device transfer | Corrected skill scope/enable widening; agent grants exported as reference and require reconnect/review |
| Notifications | Notification prefs/outbox, push/fallback/SMS budgets, provider senders | Account-wide delivery channels; no outbound messages sent by this review |
| Deployment and infrastructure | Docker/Next build, runtime config validation, private DB/TLS settings, CI/runbooks/singleton guards | Single-replica release-store assumption remains; no cloud mutation or deployment performed |
| Dependencies and quality | Lockfile audit, typecheck, existing and new regression suites, scaffold/placeholder scan | No runtime dependency added; rendered-flow tests exposed gaps missed by large unit-test count |

## Remaining work, ordered by importance

1. Complete and live-test outbound provider-hosted MCP authorisation, refresh,
   authenticated discovery, tool registration, calls and reconnect. It is now
   deliberately unavailable, not silently functional. Notion-as-agent connecting
   inbound to Warthog is distinct from Warthog connecting outbound to Notion tools.
2. Add integration acceptance for each external agent platform and real service
   before marking it supported. Provider documentation establishes capability,
   not successful Warthog interoperation. Slack, Instinct and Dots need a specific
   client/connection contract, not inference from their names.
3. Add resource granularity where needed: arbitrary memory audiences, per-field
   vault access and connector-specific read/change policies. Today memory has
   private/shared scopes, identity has tier-level grants, and connector tool
   classes are per agent. The UI and ADR state these limits.
4. Bound/paginate large memory and skill scans. Memory and skill reads can still
   decrypt an unbounded account set; activity has a 5,000-row limit and the new
   workspace shows 50 entries. Large-memory quotas require storage/API design.
5. Strengthen task hand-offs: reject nonexistent/foreign assignees, lock concurrent
   note appends, and provide claims/leases for two agents acting on an unassigned
   task. Current member scoping prevents cross-account reads but does not provide
   a distributed work queue.
6. Reduce duplicated schema/template mapping and stale scaffold comments. Keep
   end-to-end browser and MCP acceptance alongside narrow seam tests; passing
   thousands of unit tests did not establish a complete provider connection flow.
7. Integrate the other agent's skills-library branch separately and rerun assignment,
   retrieval, export/import and migration checks. This branch reserves migration
   0101; that checkout was using 0100 when inspected.

## Compatibility sources checked

Reviewed on 10 November 2026:

- [Claude remote custom connectors](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp).
- [OpenAI custom MCP setup](https://developers.openai.com/api/docs/guides/custom-mcp-server).
- [Notion Custom Agent MCP connections](https://www.notion.com/help/mcp-connections-for-custom-agents).
- [Gemini CLI MCP documentation](https://github.com/google-gemini/gemini-cli/blob/main/docs/tools/mcp-server.md).
- [xAI remote MCP tools](https://docs.x.ai/developers/tools/remote-mcp).
- [MCP authorisation security considerations](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/draft/basic/authorization/security-considerations.mdx).

Incoming Warthog credentials remain separate from upstream service credentials;
this is consistent with MCP's prohibition on token passthrough.

## Validation

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
