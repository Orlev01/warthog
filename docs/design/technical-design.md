# Warthog — technical design (v1)

Status: original design 2026-11-04, amended 2026-11-09 for the founder-approved
production identity, global messaging and delivery controls. Implementation and
live acceptance status are in `../production-release.md`; design intent is not
evidence that infrastructure exists or a feature passed production verification.
Inputs: `brief.yaml` (ratified + amended), `.agent/architecture.yaml` (Skynet: `nextjs-postgres`,
monolith, public ingress), and the architecture research of 2026-11-04 (sources in §13).

This document is the job-level design of record. The brief says WHAT; this says HOW. Build agents
read it through `.agent/conventions.md` (which points here and repeats the hard rules).

---

## Agent-first amendment (10 November 2026)

The founder's clarified product model is recorded in
[agent-first management](../adr/agent-first-management.md). Agents are the primary
management entry point; account resource ownership, per-agent access, global
new-agent defaults and enforced global rules are separate concepts. That decision
supersedes earlier navigation, memory-write coupling and skill assignment details.
See the [review](../audit/agent-first-review-2026-11-10.md) for implemented changes
and explicit provider integration limits.

## 1. Shape

One Next.js (App Router, TypeScript, Node runtime) application, one container, **one replica** in v1.
It serves:

| Surface | Path | Who |
|---|---|---|
| Public pages (landing, help, compatibility, privacy) | `/`, `/help/*`, `/privacy` | anyone |
| Sign-up / sign-in / recovery | `/signup`, `/signin`, `/recover`, `/device` | anyone |
| Portal (everything a signed-in person manages) | `/home`, `/inbox`, `/activity`, `/agents`, `/connectors`, `/vault`, `/rules`, `/spending`, `/skills`, `/memory`, `/life-admin`, `/household`, `/settings` | signed-in person (session) |
| Agent connector (MCP, Streamable HTTP) | `POST /mcp` | agents (Bearer token) |
| OAuth 2.1 authorization server | `/.well-known/oauth-authorization-server`, `/.well-known/oauth-protected-resource[/mcp]`, `/oauth/authorize`, `/oauth/token`, `/oauth/register`, `/oauth/revoke`, `/oauth/client-metadata.json` | agents + people (consent) |
| Background jobs | in-process scheduler started from `instrumentation.ts` | — |

**Why one replica:** pending identity/card releases live only in process memory (brief: discarded
from server memory on collection or expiry; never in the database or its backups), and per-agent rate
limits are in-memory. One replica is also the cheapest. Scaling out later needs a shared ephemeral
store; that is a later decision, not v1.

Background jobs run in the same process. Every job is idempotent and claimed with
`SELECT … FOR UPDATE SKIP LOCKED` from a `jobs` table, so a second replica would be safe for jobs
(not for releases).

## 2. Production infrastructure

Australia East remains primary hosting. Current founder decisions and unresolved
funding/provider gates are maintained in `../production-release.md`, with rationale
in `../adr/global-messaging.md`, `../adr/production-identity-and-email.md` and
`../adr/production-delivery-controls.md`. These supersede the original ACS,
Australia-only processing, public database firewall and parent-domain RP proposals.

| Need | Service | Notes |
|---|---|---|
| App runtime | Container Apps (Consumption), min=max 1 replica, candidate 0.5 vCPU / 1 GiB | Private VNet integration; manual stop/wait/start revisions; database ownership guard |
| Images | Container Registry Basic | |
| Data | PostgreSQL Flexible Server v16, reviewed General Purpose SKU/storage/backup retention | Private delegated subnet/DNS; no public database access; three application logins with verified TLS; separate private administrator bootstrap |
| Key encryption key | Key Vault **Premium**, one RSA-HSM 3072 key | Wraps per-person data keys; preserve old versions for live data and retained backups |
| App secrets | Key Vault (same vault), referenced as Container Apps secrets | Database URLs, OAuth clients, VAPID, messaging credentials and HMAC key; no secret values in source/images/Terraform state |
| Receipt files | Storage account (blob), private container, no public access, no shared keys | files are encrypted by the app before upload |
| Email | Resend Free, approved sending domain | Domain-restricted sending key; international processing/privacy contract and actual account/delivery acceptance remain gates |
| SMS | Twilio US1, explicit approved ISO-country routes | Separate founder-paid allowance; registration, STOP and body-redaction entitlement/complete price remain gates; no assumption of worldwide coverage |
| Logs/metrics | Azure Monitor diagnostic routing to Log Analytics, 30-day retention and reviewed daily cap | Redaction before logging; operational alerts/recipients still require configuration and testing |
| Cost controls | Required approved AUD budget notifications at 50/80/100% actual and 100% forecast | No verified automatic stop or credit-only cash-fallback protection; budget/credit availability is not a hard cap |
| Identity | User-assigned identity with scoped ACR pull, vault secret/key wrapping and receipt-container access | Azure SDK identity selected with `AZURE_CLIENT_ID`; no subscription-wide application role |

`infra/` now contains a Terraform foundation draft, not an applied/certified stack.
It requires Terraform write-only/ephemeral support; OpenTofu compatibility is not
assumed. CI performs no cloud apply or production CD. Workload rollout uses the
separate `../singleton-release-runbook.md`. The module does not manage GoDaddy or
output fabricated DNS records. Preserve all existing records; review exact new
records after provider generation. The approved application origin and narrow RP
ID are both `app.warthog.com.au`; email sender identity is validated independently.

The admin portal (13 November 2026) is served by the same container on a second custom
domain, `admin.warthog.com.au`, derived from the public base URL and bound separately; see
[admin-portal.md](admin-portal.md) and [the decision](../adr/admin-portal.md).

## 3. Libraries (job ADR — extends the bundle allowlist)

The `nextjs-postgres` bundle allows `next, react, react-dom, pg, zod`. This job ADR adds only
permissively licensed, free libraries, each for a need the brief states:

| Package | Licence | Need |
|---|---|---|
| `@modelcontextprotocol/server`, `@modelcontextprotocol/client` (v2) | Apache-2.0 | Warthog is an MCP server (agents) and an MCP client (provider-hosted connectors) |
| `zod` **v4** | MIT | required by the MCP SDK v2 (^4.2) — pin v4 everywhere |
| `@simplewebauthn/server`, `@simplewebauthn/browser` | MIT | passkeys, incl. the PRF extension |
| `oauth4webapi` | MIT | Warthog as OAuth client to Google/Microsoft/others (code+PKCE, refresh) |
| `@pushforge/builder` | MIT | Web Push with VAPID (NOT `web-push`, which is MPL-2.0) |
| `@azure/identity`, `@azure/keyvault-keys`, `@azure/storage-blob`, `@azure/communication-email` | MIT | Azure services (SMS is called through ACS's REST API with HMAC request signing — the SMS SDK pulls a vulnerable `uuid`) |
| `qrcode` | MIT | authenticator-app enrolment QR |
| `tailwindcss` v4, `@tailwindcss/postcss` | MIT | styling |
| `lucide-react` | ISC | icons |
| dev: `@electric-sql/pglite` | Apache-2.0 | in-process Postgres for tests and local dev (no Docker) |
| dev: `tsx`, `typescript`, `@types/*` | MIT/Apache-2.0 | test runner + types |

Nothing else at runtime without a new job ADR. Versions are pinned exactly (`package-lock.json`):
Next **15.5** and TypeScript **5.9** (the house-proven line; Next 16 / TS 7 are a later, deliberate
upgrade).

Accepted audit/licence notes (2026-11-04): `postcss` inside Next 15 has a high advisory that needs
attacker-controlled CSS — Next only processes our own CSS at build time, and the fix is Next 16;
`sharp` (Next's optional image optimiser) ships `libvips` under LGPL-3.0, dynamically linked and
unmodified — house precedent (Art to Heart). Explicitly rejected: Nango (Elastic License 2.0, not
permissive), `web-push` (MPL-2.0), and any paid card vault. The subsequent explicit
Twilio/Resend messaging exception supersedes the original hosted-messaging ban;
it does not approve an unquoted paid plan or change Warthog's own authentication.

## 4. Data protection

### 4.1 Per-person data key (server side)
- Each person has a random 256-bit **data key (DEK)**. It is stored only **wrapped** by the Key Vault
  KEK (`RSA-OAEP-256`). Unwrapped DEKs are cached in process memory for at most 5 minutes.
- Encrypted with the DEK (AES-256-GCM, random 96-bit nonce, `v1:` versioned envelope, the row id and
  column name as associated data): every personal-content column — low-tier vault fields, preferences,
  skills, memories, tasks, life-admin records, connector credentials (OAuth tokens, API keys), activity
  details (redacted parameters, result summary, reason), dispute notes, household shared address,
  receipt files (encrypted before upload).
- Plaintext metadata (needed for filtering, never personal content): ids, timestamps, kinds, agent id,
  connector id, tool name, outcome, amounts + currency + merchant name for card releases (needed for
  budgets), card brand + last four.
- **Account deletion:** clear the live wrapped DEK and revoke access before confirmation;
  a job purges live rows within 24 hours. Retained backups can contain the older
  wrapped DEK and are not cryptographically erased by that update. The independent
  [deletion journal and recovery procedure](../adr/deletion-recovery-journal.md)
  reconcile later deletions before a restored database can be considered for use.
- Search over encrypted fields (memory, activity text) decrypts in the app within the already
  filtered set (max 5,000 rows per query) — acceptable at v1 scale.

### 4.2 Device-held vault (high-tier details and cards)
- The browser creates a random 256-bit **vault key (VK)** at first use. High-tier values and card data
  are encrypted **in the browser** with VK (AES-256-GCM, WebCrypto). The server stores ciphertext only.
- VK is stored server-side only **wrapped**, once per unlock method (`vault_unlock_methods`):
  - **Passkey PRF:** `get()` with `extensions.prf.eval.first = salt_v1` (a fixed per-person 32-byte salt),
    `userVerification: "required"`; wrapping key = HKDF-SHA256(prf output, info `warthog/vault-wrap/v1`).
    PRF counts as present only when `results.first` actually comes back. After `create()`, run a
    `get()` immediately to obtain the PRF output (many authenticators only report `enabled` on create).
  - **Vault passphrase:** PBKDF2-SHA256, 600,000 iterations, 16-byte salt (WebCrypto; no extra library).
  - **Recovery code:** 128 random bits shown as 26 base32 characters in groups; wrapping key =
    HKDF(code, info `warthog/vault-wrap/v1`). The server separately stores scrypt(HKDF(code, info
    `warthog/recovery-auth/v1`)) to verify recovery sign-in without learning the wrapping key.
- Unwrap is always verified (GCM tag). If a PRF-derived key fails to unwrap (Apple has acknowledged
  occasional PRF output differences across devices), fall back to passphrase/recovery code — never
  silently re-key.
- Devices that cannot do PRF ask for the passphrase or recovery code each time; nothing is stored on
  the device.
- **Release:** on approval, after step-up, the browser decrypts the value with VK and posts it over TLS
  to `/api/approvals/:id/release`. The server holds it in the in-memory **release store** (Map, TTL
  5 minutes, single collection), never writes it to the database, logs or metrics, and records a
  **fingerprint**: HMAC-SHA256(fingerprint key = HKDF(DEK, `warthog/fp/v1`), normalised value)
  kept 90 days.

### 4.3 Redaction (before anything is written to activity, logs or metrics)
1. Known secret fields by name (passwords, tokens, `authorization`, `api_key`, codes …) → `[redacted]`.
2. Any 13–19 digit sequence (spaces/dashes allowed) that passes the Luhn check → `[card ••••1234]`.
3. Every alphanumeric token of length ≥ 5 (normalised) whose fingerprint matches a released value of
   that person within 90 days → `[released value]`.
4. Values longer than 2,000 characters are truncated with a marker.
Redaction is a pure module with exhaustive unit tests; the activity writer and the logger both call it.

## 5. People: sign-in and sessions
- Email one-time codes: 6 digits, 10-minute expiry, stored as HMAC, max 5 attempts, then backoff.
- Passkeys via SimpleWebAuthn, RP ID `app.warthog.com.au` (from config), `residentKey: required`,
  `userVerification: required`, PRF requested on create and get.
- Authenticator app fallback: RFC 6238 TOTP implemented with `node:crypto` (30 s, 6 digits, ±1 step).
- Recovery code issued at sign-up (shown once, confirmed saved). Recovery (email code + recovery
  code + new passkey) removes every other passkey, the authenticator app and every session in the
  transaction that saves the new passkey, and alerts once, naming the agents it keeps.
- Sessions: random 256-bit id in a `__Host-wh_session` cookie (HttpOnly, Secure, SameSite=Lax), stored
  hashed; 14-day idle / 30-day absolute expiry; `stepped_up_at` on the session; step-up valid 5 minutes.
- New-device sign-in: email code + (synced passkey | hybrid QR | approval from a signed-in device via
  push + step-up | recovery code).
- Account reset when every passkey and the recovery code are lost: email code + 7-day wait, alerts on
  every channel, cancellable from any signed-in device; erases VK-wrapped data and revokes agents and
  connections. Completion alerts every channel again; a new passkey can then be set up for 7 days,
  and a signed-in device can close that sooner after a step-up.
- Every server action and route checks `Origin` (Next's server-action check plus our own for routes),
  and every member-scoped query is filtered by the session's user id (never an id from the client).

- Admin portal access: `users.role = 'admin'` (reconciled hourly from `OPERATOR_EMAIL`), a
  single-use 60-second handoff minted on the app host after a fresh step-up, exchanged on the
  admin host for `__Host-wh_admin` (12 h absolute / 60 min idle) that cascades from the app
  session ([admin-portal.md](admin-portal.md) §2).

## 6. Agents: OAuth 2.1 + MCP

### 6.1 Authorization server (built in-house, test-first)
- Metadata: RFC 8414 at `/.well-known/oauth-authorization-server`; RFC 9728 at
  `/.well-known/oauth-protected-resource` and `/.well-known/oauth-protected-resource/mcp`
  (resource = `https://<public host>/mcp`).
- `/mcp` without a valid token → `401` with
  `WWW-Authenticate: Bearer resource_metadata="…", scope="warthog"`.
- Authorization code + **PKCE S256 only**; `resource` parameter required and must equal the MCP
  resource; `iss` returned in the authorization response (RFC 9207); form-urlencoded token endpoint.
- Client registration: **CIMD** (`client_id` is an https URL; fetch with SSRF guards — https only, no
  private/loopback IPs, 5 s timeout, 64 KB cap, cache 24 h) advertised with
  `client_id_metadata_document_supported: true` and `token_endpoint_auth_methods_supported: ["none"]`;
  **DCR** (RFC 7591) at `/oauth/register` for clients that need it (Gemini, older Claude); redirect URIs
  must be https, or `http://localhost` / `http://127.0.0.1` (any port) for local clients.
- Known platform callbacks get a "Verified platform" badge on the consent screen (claude.ai,
  claude.com, chatgpt.com, Google's oauth-redirect); any other redirect host is shown prominently.
- Tokens are **opaque** random 256-bit values stored as SHA-256 hashes, bound to one agent
  connection: access token 1 hour; refresh token 30 days, rotated on every use, reuse of an old
  refresh token revokes the connection's tokens (`invalid_grant`).
- **Disconnect** deletes the connection's tokens and access keys in the same transaction that marks it
  disconnected → the next request is refused (brief NFR).
- Per-agent **access keys** (`wh_ak_` + 32 random bytes base62) for platforms that only send static
  Bearer headers (xAI API, Llama Stack): shown once, stored hashed, same connection model.

### 6.2 MCP server
- `@modelcontextprotocol/server` v2 `createMcpHandler` in `src/app/mcp/route.ts` (`runtime = "nodejs"`),
  **stateless**; supports protocol 2026-07-28 and the 2025-11-25 `initialize` handshake; validates
  `Origin` and the `Mcp-*` headers; `X-Accel-Buffering: no` on SSE; GET/DELETE → 405.
- Tool list for an agent = Warthog core tools + the connector tools it is permitted, namespaced
  `<connector>__<tool>`. If the total exceeds 80, connector tools collapse into `find_tools` +
  `call_tool`.
- Core tools: `get_context`, `get_skill`, `request_identity_detail`, `request_card`, `check_approval`
  (`wait_seconds` ≤ 25, long-poll), `collect_release`, `remember`, `search_memory`, `list_tasks`,
  `create_task`, `update_task`, `complete_task`, `list_records`, `save_record`, `update_record`,
  `log_activity`. Every tool takes an optional `reason`.
- **Pipeline for every call** (one function, `handleAgentCall`):
  connection active → rate limit (in-memory sliding window, default 120/min) → permission check →
  policy engine (§8) → `allow` | `ask` | `deny` → execute | hold | refuse → **activity entry written
  before the response** (§9).
- **Ask** = the call is held (`held_requests`, encrypted args), an approval is created, the agent gets
  `{status:"pending_approval", approval_id, expires_at, message}`. On approval Warthog executes the
  held call exactly once and the result is returned by `check_approval`. Denied / expired → refusal.
  "Ask for more detail" → `check_approval` returns the question; the agent re-calls the tool with
  `in_reply_to: approval_id` and its answer, creating a linked approval.

## 7. Connector engine
- **Catalogue = data files** `catalogue/connectors/<id>.yaml`: id, name, aliases, category, auth kind
  (`oauth2 | api_key | basic | provider_mcp`), base URL, auth details (authorize/token URLs + scopes,
  or header template like `Authorization: Bearer {key}`), key-entry instructions + provider docs
  link, optional `verify` request, curated tool set, Google early-access flag. A schema-validated
  loader rejects bad entries at boot. Adding an entry = a PR + deploy; no code change.
- **Availability:** `oauth2` entries are connectable only when their client id/secret are configured;
  `api_key`/`basic` always; `provider_mcp` always (Warthog registers itself via CIMD at
  `/oauth/client-metadata.json`, falling back to DCR).
- **Credentials** are stored DEK-encrypted per connection; a refresh job renews OAuth tokens before
  expiry; failures mark the connection "Reconnect needed" and notify.
- **General request tool** per connector: `<id>__request {method, path, query, body}`; `path` is relative
  to the entry's base URL (host cannot be overridden → no SSRF); GET/HEAD = reads, anything else =
  makes changes (every request, for a catalogue entry with `get_is_change`). Upstream timeout 20 s;
  responses truncated to 100 KB for agents.
- **Checked reads** ([ADR](../adr/read-side-protection.md)): the pipeline passes every executed
  connector result through `resultGuard` before the agent reads it — a notice, hidden characters
  removed, sign-in links/codes and card numbers hidden, download links dropped; Gmail and Outlook
  messages become a checked view and sign-in mail a stub. Mail reads may fetch 2 MiB internally
  so a whole message can be checked; Gmail is always read as `full` or `metadata`, never `raw`.
  Gmail search returns checked summaries (headers + preview, ≤ 25); checked mail views are
  returned to the agent as readable text with `structuredContent`; Drive `read_text` exports
  Google Docs/Sheets and refuses binary files.
- **Provider-hosted tools:** `readOnlyHint: true` → reads; otherwise makes changes.
- **Curated tools** (declared reads/changes + reversal + "sends a message" flag): Gmail (search, read,
  draft, send), Google Calendar (list, create↔delete, update), Google Drive (search, read text,
  metadata), Outlook mail (search, read, draft, send), Outlook calendar, OneDrive (search, read), plus
  the provider-hosted servers' own tools (Notion, Linear, Todoist, Airtable, Dropbox, …).
- **Google early access:** an allowlist of emails in config (it protects Google's lifetime cap of 100
  people for an unverified app). The Google app is published, so connections last until Google
  refuses a renewal ([ADR](../adr/google-published-and-accounts.md)).
- **Several accounts of one service:** the same Google or Microsoft account connected again renews
  its connection in place; adding another account keeps agents on the account they use; other
  accounts can be renamed; a card names the account when there are several
  ([ADR](../adr/google-published-and-accounts.md)).
- Launch target: ≥ 30 `provider_mcp` + ≥ 60 `api_key` entries + Google + Microsoft (+ any the founder
  registers: Slack, GitHub, Spotify, Strava, …) ≥ 100 connectable.

## 8. Policy engine (pure TypeScript, `src/domain/policy/`)
`evaluate(call, ctx) → { decision: "allow" | "ask" | "deny", reason, rule_id? }`, deterministic, in order:
1. agent connection active (else deny "disconnected");
2. permission: connector granted, tool granted, tool class allowed (reads / makes changes setting);
3. **never-allow** rules matching (action, condition) → deny;
4. for card requests: card access on + budget set; per-purchase limit; agent budget for its period;
   member limit + household budget (household currency); merchant allow/block lists; currency
   converted with the latest daily ECB reference rate (Frankfurter, free) — no rate → deny;
5. for high-tier and card requests → **always ask** (CVV / device unlock needs the person);
6. **ask-first** rules matching, or the tool class default "ask me first" → ask;
7. allow.
Rule actions/conditions are exactly the brief's vocabulary. Each rule renders back to an English
sentence by a pure function (`ruleSentence`).

- **Recently read** ([ADR](../adr/read-side-protection.md)): after `evaluate` (and `prepareCall`),
  an `allow` for an outbound call (email send, invitation with guests, messaging write) by an agent
  whose 60-minute `agent_read_exposures` window is open is escalated to `ask` when the recipient is
  new to the person's Sent mail (or can't be checked), or for any invitation or messaging write.
  Drafts never; denials and never-allow rules are unchanged; approval satisfies it.

## 9. Activity record
- `activity_entries(user_id, seq, occurred_at, kind, source ['warthog' | 'agent_reported'], agent_id,
  connector_id, tool, outcome, amount, currency, merchant, payload_ct, prev_hash, entry_hash)`.
- `entry_hash = SHA-256(prev_hash ‖ canonical(all other fields incl. payload_ct))`; `seq` contiguous
  per user (unique index). The integrity check recomputes the chain over ciphertext (no decryption).
- The application database role has **INSERT and SELECT only** on `activity_entries` and
  `activity_disputes` (UPDATE/DELETE revoked); a separate `warthog_purge` role is used only by the
  account-deletion job.
- Disputes are a separate append-only table referencing the entry. Undo writes a new entry.
- Undo is single-shot: before the reversal runs, the service claims `(user_id, entry_seq)` in
  `activity_undo_claims` (plaintext metadata; runtime role SELECT/INSERT/DELETE plus UPDATE of
  `approval_id` only) with one atomic `INSERT … ON CONFLICT DO NOTHING`. A request that does not
  win the claim runs and records nothing. The claim is kept once the reversal executed or is held
  for approval — a held one records its `approval_id` — and released when it was refused, failed
  or threw. A claim whose approval was denied, expired or is gone (for that person) is stale: it
  counts as no claim, and the next undo deletes exactly that claim (matched on its approval id)
  and claims once more. The Activity page reads the state in SQL: "Undone" (no approval, or
  approved), "Undo waiting for your approval" linking to `/inbox?approval=<id>` (pending or more
  detail), or Undo again (stale). Account deletion cascades to the claims.

## 10. Notifications
- Web Push (VAPID via `@pushforge/builder`), service worker `public/sw.js`, every push shows a
  notification (iOS requirement); payload ≤ 4 KB, contains only an opaque approval ID or a validated life-admin record ID and category (no personal content or arbitrary URLs). The worker reconstructs an internal destination; the authenticated page enforces ownership. Push transport has a 15-second deadline and cancels unused response bodies.
- Fallback job at `created_at + fallback_delay`: if the approval is still unopened,
  send through the configured Twilio/Resend adapters subject to channel consent,
  persistent usage limits and provider suppression. Each link is single-use,
  hashed and expires after 10 minutes; approval still requires sign-in. A durable
  SMS attempt claim prevents ambiguous transport retries from duplicating sends.
- All senders behind an interface with a dev/test **outbox** implementation (`/dev/outbox`, only when
  `WARTHOG_DEV_TOOLS=1`, which the production build refuses to start with).

## 11. Look and feel

The [11 November design decision](../adr/admin-console-design.md) adopts the
[measured OpenAI admin-console structure](admin-console-reference.md), superseding
indigo accents and mobile bottom navigation. Warthog retains its own identity,
licensed local Inter, Lucide icons, accessibility and agent-first permission model.

- Neutral canvas and grouped 260px desktop sidebar; 52px page header; primary tabs
  and contextual sub-tabs. Mobile uses the same navigation in an accessible drawer.
- Black/white primary actions, muted grey surfaces, restrained dividers and semantic
  status colours. Tokens and explicit/system themes live in `globals.css`.
- Bounded 1216px workspaces, 896px reading pages and 768px focused flows. Individual
  forms remain readable; phone controls retain 44px targets and 16px input text.
- Contributor rules: [design system](../../.agents/skills/warthog-design-system/SKILL.md),
  [mobile](../../.agents/skills/warthog-mobile-design/SKILL.md),
  [desktop](../../.agents/skills/warthog-desktop-design/SKILL.md),
  [feedback](../../.agents/skills/warthog-feedback/SKILL.md) and
  [media](../../.agents/skills/warthog-media/SKILL.md).
- PWA installation, icons, service worker and iOS guidance remain supported.

## 12. Development and testing
- `npm test` = `node --test` via `tsx` over `src/**/*.test.ts` (the loop's objective gate);
  `npm run typecheck` = `tsc --noEmit`.
- Tests and local dev use **PGlite** (`DATABASE_URL=pglite:memory` / `pglite:./.data/dev`); migrations are
  plain SQL files in `db/migrations` applied by a tiny runner; the same runner applies to Azure Postgres.
- Seams with fakes: clock, random, Key Vault (local AES KEK from env in dev/test), push, email, SMS,
  upstream HTTP (connector calls), exchange rates.
- A software passkey authenticator (test helper) produces real attestation/assertion objects incl. PRF,
  so WebAuthn flows are tested end to end without a browser.
- Dev tools (only with `WARTHOG_DEV_TOOLS=1`): outbox viewer, "sign in as" for the acceptance walk,
  approve-from-outbox links, a fake MCP agent console that calls `/mcp` with a dev access key.
- The local-only CI workflow reuses the disposable Linux/PostgreSQL 16 Compose
  harness, followed by a separate non-root runtime image build. Remote CI, Linux
  execution and production-mode acceptance have not yet been certified; see
  `../local-release-validation.md` and the current release handoff.

## 13. Sources (research 2026-11-04)
MCP spec 2026-07-28 (transports, authorization, client registration); Claude connector auth docs;
OpenAI Apps SDK auth; Gemini custom apps OAuth; MCP TS SDK v2 docs; Nango licence + self-hosting docs;
W3C WebAuthn L3 + MDN PRF; WebKit web push; Azure Container Apps billing, PostgreSQL pricing, Key Vault
pricing, ACS SMS concepts/pricing/AU number rules, ACS email limits; Google OAuth testing-mode and
restricted-scope rules; Microsoft consent policies.

## 14. Private skills library (10 November 2026)

The founder requested Grove-inspired skill/plugin import and editing for one
person. [Private skills library ADR](../adr/private-skills-library.md) records
the investigation, encrypted package storage, source-to-skill projection,
optional supporting-file reads through `get_skill`, export compatibility,
responsive UI, validation evidence and parallel-branch integration requirements.
Packages are private content; importing one neither executes code nor connects
services. New package skills start disabled until the person grants availability.
