# Admin portal — design of record

13 November 2026. The founder asked for a simple, intuitive admin portal at
`admin.warthog.com.au` that shows sign-ups, usage, traffic and the product's
success and failure points, signed in with the founder's own account under the
same security as `app.warthog.com.au`. The brief reserved this ("a separate
admin app for user counts, connector health, errors and usage"; `users.role`
and the personal-content-free `metric_events` store exist for it). The decision
is in [the ADR](../adr/admin-portal.md); this document is the HOW. Four
specialist reviews (product analytics, security and privacy, engineering and
delivery, UX and design) fed it; where they differed the stricter option won.

## 1. Shape

- **One container, two hosts.** The same Next.js process serves both hosts.
  `src/proxy.ts` decides by the request host (`x-forwarded-host`, else `host`,
  lower-cased, port stripped). The ingress passes a client-supplied
  `X-Forwarded-Host` through, so a non-browser client can choose which host's
  routing its own request gets: the split is a routing convenience, not a
  security boundary, and the portal's own session gate is what protects it
  (see [the website decision](../adr/website-root-domain.md#rules)). On the
  admin host every path is rewritten under the internal prefix (§2; `/` →
  `<prefix>`, `/usage` → `<prefix>/usage`, `/session` → `<prefix>/session`),
  static assets pass through, and a path that already starts with the prefix is
  404. On the app host (and any unknown host) the prefix's paths are 404 except
  `<prefix>/handoff`, and `/admin` is an ordinary missing page. So the member
  app, `/api/auth`, `/oauth`, `/mcp`, `/dev` and `/connect` do not exist on the
  admin origin, and no admin page exists on the app origin. Admin responses
  carry `X-Robots-Tag: noindex, nofollow`.
  The proxy also forwards the original path as `x-admin-pathname` so the admin
  chrome lights the current section without `usePathname` (a rewritten request
  would otherwise hydrate with a different path).
- **The admin origin is derived, not configured.** `adminBaseUrl` in
  `src/server/config.ts` is `PUBLIC_BASE_URL` with a leading `app.` label
  replaced by `admin.` (otherwise `admin.` is prefixed), same scheme and port:
  `https://app.warthog.com.au` → `https://admin.warthog.com.au`;
  `http://localhost:3000` → `http://admin.localhost:3000` (Chrome, Firefox and
  Node resolve `*.localhost` to loopback; Safari needs an `/etc/hosts` line).
  `ADMIN_BASE_URL` overrides it only outside production; production refuses
  the variable, so the Azure release stays image-only and
  `scripts/ci/deploy_app.py` `validate_live` is untouched.
  `assertProductionReleaseConfiguration` checks the derived host is https,
  contains a dot, is not an IP and differs from the app host.

## 2. Who may enter, and how

Passkeys are scoped to the RP ID `app.warthog.com.au`, so the admin host can
never run a ceremony itself, and a weaker factor there would not be "the same
security". The admin host therefore authenticates nobody: it only exchanges a
proof minted by the app host.

1. **Role.** `users.role = 'admin'` is the only thing the gates consult. The
   hourly `operator-role` sweep promotes the account whose normalised email is
   `OPERATOR_EMAIL` (`config.operatorEmail`, already required in production):
   `UPDATE users SET role = 'admin' WHERE lower(email) = $1 AND role <> 'admin'
   AND wrapped_dek <> ''`. Promote only; never demote; config is never read at
   request time.
2. **Entry control (amended 13 November 2026).** The member app shows no admin
   entry, link, notice, script or style, for anyone, the operator included; the
   only way in is typing the admin host's address. The portal's routes live under
   an internal prefix that is not a guessable word (`ADMIN_PREFIX` in
   `src/server/http/admin-routing.ts`), so `/admin` on the app host is simply a
   path the app does not have; the prefix is visible only to visitors of the
   admin host. The admin host's `/signin` page (outside the guarded group; where
   the guard sends everyone without an admin session) offers one "Sign in" link to
   `<publicOrigin>/signin?next=<prefix>/handoff`, the app's ordinary sign-in. A
   visitor already signed in is forwarded straight on; a fresh sign-in records a
   step-up. `<prefix>/handoff` is the one internal path the app host serves: a
   server-only route (`src/server/admin/app-handoff-handler.ts`, no page, no
   client code) that calls `startAdminHandoff` (logic in
   `src/server/admin/handoff.ts`). That re-derives the session from
   `__Host-wh_session` and requires `role = 'admin'`, a live account
   (`wrapped_dek <> ''`) and a fresh step-up (`requireStepUp`, 5 minutes). Success
   is a 303 to `<adminOrigin>/session?handoff=<token>`; a stale step-up is a 303 to
   `/signin?next=<prefix>/handoff&fresh=1`, where `fresh=1` shows the sign-in form
   even to a signed-in visitor; anyone else gets a bare 404. The portal's
   stylesheet is imported only by the portal layout.
3. **Handoff token.** 32 random bytes (hex), stored only as SHA-256 in
   `admin_sessions.handoff_hash`, 60-second TTL, one live handoff per app session
   (minting deletes that session's unexchanged rows). Stateless tokens cannot be
   single-use, so the store is the database.
4. **Exchange.** `GET /session?handoff=…` on the admin host (`/admin/session`
   after the rewrite) consumes it with one conditional UPDATE that also requires
   the app session to exist and the user to still be an admin; exactly one
   concurrent request can win. It sets `__Host-wh_admin` and 303-redirects to
   `/` so the token leaves the address bar at once. Any invalid, expired or
   reused token gives the same 303 to the admin host's `/signin?notice=expired`.
   The exchange path shares the proxy's auth IP limiter.
5. **Admin session.** `admin_sessions.session_id REFERENCES sessions(id) ON
   DELETE CASCADE`, so sign-out, "sign out this session", recovery, reset and
   deletion all revoke admin access with no new code. Cookie `__Host-wh_admin`,
   HttpOnly, Secure, SameSite=Lax, 12 h absolute, 60 min idle. Every verify is
   one guarded UPDATE that re-checks the role, the tombstone and the app
   session's own 14-day/30-day windows. `POST /signout` on the admin host ends
   only the admin session (Origin must equal the admin origin) and lands on the
   admin host's `/signed-out` page, whose "Sign in again" goes to its `/signin`.
6. **Audit.** Metric events, never personal content: `admin.handoff`
   (`minted | step_up_required | not_admin`), `admin.session`
   (`exchanged | rejected`), `admin.signout`, `admin.lookup` (`found | none`).

## 3. What the portal may read

All admin SQL lives in `src/server/admin/reads.ts`. It names every selected
column, never `SELECT *`, imports no key wrapper, envelope or recorder, and
returns aggregates plus the per-account facts below. A static test asserts the
module never mentions `payload_ct`, `credentials`, `wrapped_dek`, `detail`,
`args`, `secret_enc`, `account_label`, `display_name`, `endpoint`, `keys` or
`key-wrapper`.

Allowed: `metric_events` (all columns); `users.id/role/created_at`;
`sessions.created_at/last_seen_at`; counts of `passkeys`, `totp_secrets`,
`recovery_codes`; `agents.platform/status/connected_at/last_active_at/request_count`;
`connections.connector_id/status/connected_at`;
`approvals.status/created_at/expires_at/decided_at`;
`activity_entries.kind/source/outcome/connector_id/occurred_at` as counts;
`jobs.type/status/attempts/run_at`; `sweep_runs`; `schema_migrations`;
`households`/`household_members` counts; `email_codes.purpose/created_at/consumed_at`
and the attempt tables as counts; `connector_requests.status/requested_at` as
counts (the typed `service_name` is shown only as a length-capped label when a
service was asked for at least twice).

Never selected: activity payloads, merchant/amount per account, connection
credentials or account labels, wrapped keys, approval detail or question, held
request args, authenticator secrets, passkey material, memories, skills,
identity or high-tier fields, cards, receipts, push endpoints, email-code
addresses, mobile numbers, addresses, agent display names.

**Emails.** No list in the portal shows an address. Account rows are keyed by
sign-up date and a short opaque reference (the first eight characters of the
id). One "Look up an account" field takes a single exact address, normalises it
and binds it as a parameter, and shows that account's operational facts
(sign-up date, factors, agents by platform, connections by connector and status,
last active, household membership, pending approvals). Accounts and every
count exclude crypto-shredded tombstones (`wrapped_dek = ''`).

## 4. Data: what exists and what is added

Existing: `agent.request` / `agent.request.latency_ms` (`platform`,
`connectorId`, `outcome`, `errorCategory`), `approval.decision`,
`approval.response_time_ms`, `integrity.check`, the hourly snapshots
(`users.total`, `households.total`, `agents.active`, `connector.connections`,
`connector.failures`), `activity_entries.kind = 'agent_connected' |
'connection_change'`, `sessions.last_seen_at` (slides on every portal verify, the
basis of active-people counts), `agents.last_active_at`.

New metrics, all through the guarded `recordMetricEvent`, best effort (a
metrics failure never fails the user's action), names in
`src/server/metrics/names.ts`:

| Name | Value | Dimensions |
| --- | --- | --- |
| `signup.step` | 1 | `outcome`: `code_sent`, `throttled`, `email_verified`, `code_rejected`, `factor_enrolled`; `platform`: `passkey` or `totp` on `factor_enrolled` |
| `signup.completed` | 1 | `outcome`: `ok`, `account_exists`; `platform`: `passkey` or `totp` |
| `signin.attempt` | 1 | `outcome`: `ok`, `failed`, `throttled`; `platform`: `passkey`, `totp` (on `ok`); `errorCategory`: `passkey`, `email_code`, `totp` |
| `connector.connect` | 1 | `connectorId`; `outcome`: `ok`, `failed`, `declined`; `errorCategory`: the failing stage |
| `connector.refresh` | 1 | `connectorId`; `outcome`: `ok`, `failed`, `lapsed` (Google Testing-mode lapses, recorded only before 17 Nov 2026) |
| `job.failure` | 1 | `outcome`: the sweep name or job type |
| `account.deleted` | 1 | — |
| `http.requests` | count per minute | `outcome`: `<host>.<route>.<kind>` from closed vocabularies (host `app`, `admin`, `site` for the website host (labelled "Website"), `other`; route `public`, `auth`, `portal`, `api`, `mcp`, `oauth`, `admin`, `health`, `other`; kind `document`, `fetch`, `limited`) |
| `admin.handoff`, `admin.session`, `admin.signout`, `admin.lookup` | 1 | `outcome` as in §2 |

Traffic is counted in the proxy into a process singleton keyed by those labels
(never a path, query, IP, user agent or cookie) and flushed once a minute by
the `traffic-flush` sweep; the app runs one replica, so the counter is complete
and a restart loses at most a minute. The proxy cannot see response status
codes; status-coded traffic stays in Azure ingress metrics, linked from the
Traffic page.

Schema (additive):
- `0110_users_created_at.sql`: `users.created_at timestamptz` (nullable),
  backfilled from the earliest of that person's passkey, authenticator and
  recovery-code timestamps, then `DEFAULT now()`, indexed.
- `0111_admin_sessions.sql`: the table in §2 with its `warthog_app` grant.
- `0112_admin_indexes.sql`: `metric_events (recorded_at)`,
  `sessions (last_seen_at)`, `activity_entries (occurred_at)`.

Sweeps added to `buildPeriodicSweeps`: `traffic-flush` (1 min),
`operator-role` (1 h), `metrics-retention` (daily; deletes `metric_events`
older than 400 days). The `users.total` snapshot now excludes tombstones.

## 5. Pages

Routes live in `src/app/admin/`; the layout is thin over `requireAdminSession`
and mounts `AdminChrome` (a twin of `PortalChrome` over `AppShell`'s new
optional `chrome` prop: groups, icons, home link, workspace label, help link).
Navigation: **Overview** `/`; **Product** — Sign-ups `/signups`, Usage
`/usage`, Accounts `/accounts`; **Health** — Reliability `/reliability`,
Traffic `/traffic`, System `/system`. Overview, Sign-ups, Usage, Reliability and
Traffic use the wide (1216px) measure; Accounts and System the reading (896px)
measure. The sidebar footer has "Back to Warthog" (the app origin) and "Sign out
of admin".

Every page: `wh-page` → `WorkspaceHeading` (title, one-line purpose, a live
`meta` summary, and the range switch in its `nav` slot as `FilterLinks` hrefs
`?range=today|7d|30d|90d`, validated server-side, default `7d`) → panels. Each
range is compared with the previous equal-length period. Pages are
server-rendered with no client state, so Back/Forward and deep links work.
Dates and times use `src/domain/display-time.ts` in the admin's own account
time zone with one "Times are Sydney time." note; numbers use `Intl.NumberFormat("en-AU")`;
deltas are words ("up 12% on the previous 7 days"); below a denominator of 10
the UI shows absolute deltas and "n of m", never a percentage.

- **Overview.** Five tiles: Sign-ups (sparkline), Active people, Agent requests
  (sub-line "n refused or failed"), Approvals decided (sub-line median reply),
  Needs attention (danger tone when > 0; first in markup on phones when > 0).
  Then a 1.6/1 grid: a **Needs attention** panel of named, linked problems
  (connections needing reconnection, approval expiry rate, overdue sweeps,
  failed jobs, a failed integrity check, sign-in lockouts) or "Nothing needs
  attention"; the **Activation funnel** (accounts → with a factor → with an agent
  → with a service → with a handled request → with a decided approval); a
  **Trends** panel (sign-ups, active people, requests per day); **Top
  services** as a bar list.
- **Sign-ups.** Sign-ups per day; the sign-up funnel from `signup.step`
  (`code_sent` → `email_verified` → `factor_enrolled` → completed) with refusals;
  activation milestones (how many accounts reached each, and the median days to
  it); factor mix.
- **Usage.** Active people and active agents today/7d/30d with the definitions
  stated; agent requests per day split by outcome; by platform and by connector
  (bar lists); latency p50/p95; approvals decided per day, median and p95
  response time, expiry rate; connections by connector and status; services
  asked for.
- **Accounts.** The exact-address lookup; a list of accounts (newest first)
  with sign-up date, factors, agents, connections, last active and attention
  badges ("Reconnect needed", "No factor"); filters for stalled steps.
- **Reliability.** Sign-in outcomes and lockouts; agent request failures by
  category, platform and connector; connector reconnects and refresh failures;
  integrity checks; job queue (pending, claimed, failed by type) and each sweep's
  last run against its interval.
- **Traffic.** Requests and documents per day by route class and host; today's
  hourly profile; the admin host separately; a link to Azure ingress metrics.
  Azure's own probes of `/api/health` (readiness every 5 s, liveness every 10 s,
  about 1,080 an hour) are shown as a Health checks tile of their own. They are
  left out of the requests, page loads, breakdowns and today's hours, which they
  would otherwise outnumber by about ten to one. The probes reach the container
  directly, so Azure's ingress metrics and request billing never see them.
- **System.** Migration version, scheduler and sweep health, SMS enabled flag,
  households, accounts and tombstones awaiting purge, metric-store size.

New primitives (`src/components/admin/`, styles in `src/app/<internal prefix>/portal.css`, imported only by the portal layout, tokens
only, inline SVG, no new dependency): `StatTiles`, `Sparkline` (`role="img"`,
`<title>`, `currentColor` on `--wh-tint`, a visually hidden table for longer
series), `BarList` (inline-style widths; the count carries the meaning),
`Funnel` (conversion in words; the biggest drop marked), `FactList` (reuses
`wh-evidence-facts`), `RangeTabs`. Lists use `ListGroup`; the only `<table>` is
the sweep table in a labelled scroll region. Empty states name the next step;
a failed read shows a `PageNotice` and the panel's inline empty state, never raw
error text.

## 6. Delivery

The code needs no new production configuration. Release as usual: merge to
`main`, `azure-image.yml`, then `azure-release.yml` `inspect` → `update` with
the reviewed digest. The image-only revision copy preserves custom-domain
bindings. Binding `admin.warthog.com.au` is a separate, founder-approved step
([runbook](../admin-portal-launch.md)): two GoDaddy additions (`CNAME admin` →
the app FQDN, `TXT asuid.admin` → the app's verification id) and
`az containerapp hostname add` then `bind` with a free managed certificate.
Bind outside the `inspect` → `update` window (a binding changes the
configuration fingerprint; rerun `inspect` if needed). Never delete the app
while the `admin` CNAME exists.

## 7. Verification

node:test with `freshDb`: origin derivation and override rules; proxy host
matrix (rewrite, pass-through, 404s, limiter, headers); migration backfill;
admin session mint/exchange/verify/sign-out including single use, TTL, cascade
revocation and demotion; role reconciliation; the reads module's column
allowlist on a seeded database; traffic classification and flush; each new
metric hook with a fake recorder; period and bucket maths; static-markup render
tests for every view and primitive. Then `npm run typecheck`, the full
`npm test` and `npm run build`. Browser evidence on `admin.localhost` at
320/390/1440 widths in both themes, keyboard navigation of range tabs and
charts, and the handoff round trip, recorded under `docs/audit/admin-portal-2026-11-13/`.
