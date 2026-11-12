# Activity organisation release — 12 November 2026

The founder asked for the audit log to stop being "one long thread" — a timeline
across all agents, activity grouped by agent (click an agent to see its activity),
activity grouped by type (read, write and other) and other helpful grouping,
filtering and organisation — and for the same thinking to be applied across the
app. Five read-only reviewers (activity UX, data layer, whole-app information
architecture, design system/accessibility, trust/security) reported first; the
work was then built in one integration branch plus five parallel page lanes.

Application source `80a353084e1e17eb6f5e0b2811de83f5a7c213a4` is live at
[app.warthog.com.au](https://app.warthog.com.au) as revision
`warthog--r43164384841a1`. It also carries main's workspace-depth commit
`2f18a38`; the founder chose one combined release, and that commit's separate
image run was cancelled before publication.

## What changed

- **Activity** has four views: Timeline (day headings, compact rows, one details
  disclosure per entry), By agent (exact counts, type split, what needs attention,
  drill-down with a way back, and an "Account and Warthog" group for entries with
  no agent), By type (reads, changes, approvals and releases, agent reports,
  rejected requests, connections and access, account changes) and By service.
  Quick filters include Needs attention (blocked, failed or disputed); applied
  filters are removable chips; the filter and integrity forms keep the view.
- Types and outcome groups are derived from plaintext metadata only, with one rule
  table shared by TypeScript and a parameterized SQL `CASE`. Grouped counts are
  exact over the whole record and decrypt nothing. The hash chain is unchanged.
- **Home** links each recent entry, labels agent reports, surfaces the last day's
  attention items, and gives each agent its last-day count and last activity.
  **Agent workspace** audit log shows type counts and entries by day.
- **Other pages:** Inbox tabs (waiting/history) with ordered, filtered history;
  Life admin records by due date and tasks by status; Rules tabs, grouping by scope
  and a status filter; Connectors category filter, connected badges and tool
  summaries (service disconnect stays one click, per the brief); Memory filters and
  date groups; Spending by merchant; one Vault tab row; More grouped like the
  sidebar; agent summary and deterministic ordering on list queries.

## Fixes found during review

- Undo was never offered in production: the page's reversal table named
  `google_calendar__create_event`, the curated tool is `google-calendar__create`.
  The table now comes from the curated definitions; the undo service refuses
  entries that are not Warthog's own record of an agent call and stores an outcome
  code instead of a sentence.
- Home showed agent reports unlabelled. An agent-supplied reason now reads
  "Stated reason: …" wherever no Warthog summary exists.

## Verification

- [Main CI 43161612772](https://github.com/Orlev01/warthog/actions/runs/43161612772):
  **5,455 tests**, zero failures, cancellations or skips across four Linux/PG16
  shards, plus delivery and Terraform checks. The
  [pinned-image run 43162005247](https://github.com/Orlev01/warthog/actions/runs/43162005247)
  repeated them before publication.
- Image `crwarthogprodauee854.azurecr.io/warthog@sha256:e2936eb17ee4b8482f6396e78362f6b77c084ac91c3786ebe1acfe4b69126123`:
  exact source label, reviewed `node:22-bookworm-slim@sha256:5ec23b7c…` base,
  linux/amd64, UID 1000, no setuid/setgid, all 78 migration and 106 catalogue
  hashes match. Scan: 219 OS package/advisory pairs (1 critical, 34 high, 95 medium,
  85 low, 4 unknown), zero non-OS — identical to the previous image's scan.
- No migrations, dependency, infrastructure, workflow or configuration changes.
- [Production run 43164384841](https://github.com/Orlev01/warthog/actions/runs/43164384841)
  succeeded after the founder approved both protected environments in GitHub.
  Independent inspection: one healthy replica, exact image, 100% traffic, zero old
  replicas, configuration unchanged apart from image and revision suffix.
- Public checks after release: health/live 200 with config and database ok;
  public pages 200; every signed-in route redirects to sign-in; unauthenticated
  `/mcp` returns 401.
- Local browser pass (seeded data): 16 changed routes at 1440 and 390 px with no
  console errors or horizontal overflow. Production signed-in pages were not
  exercised.
- Runner: fresh private B2als_v2 lease (11 reviewed creates); after the job,
  the lease group, resources, role grants and subnet NAT were verified absent and
  no GitHub runner remains. The ephemeral key was deleted.

## Follow-ups

- The brief's adjustable approval expiry (2 minutes to 24 hours) does not exist;
  the Rules page no longer shows it as a disabled template.
- Several pages still use the older `text-2xl` page title rather than
  `WorkspaceHeading`.
- Undo has no double-undo guard, and an undo's delete call is recorded under the
  agent's connection.
- Activity date filters are UTC while times show in the account zone.
- `listAgentsForUser` now orders disconnected agents first everywhere, including
  pickers.
