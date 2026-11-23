# Delivery status — 23 November 2026 (Life admin display fixes)

**Live at [warthog.com.au](https://warthog.com.au) (the website) and
[app.warthog.com.au](https://app.warthog.com.au) (the app).** Application source
`8ed9c61c2208c9391a1f3e8b53dc94d5757e7f41` runs as `warthog--r45143920020a1`, with one healthy
replica, explicit 100% traffic and zero old replicas.

PR #51 shows a change of link in Life admin's To check, gives agents a past trip as finished, and
drops stray "Type/Source → removed" lines. No migrations (still 91). See the
[release record](docs/audit/life-admin-display-release-2026-11-23.md).

# Earlier delivery status — 23 November 2026 (Life admin: receipts and subscriptions belong to what they were for, and what you pay a month)

**Live at [warthog.com.au](https://warthog.com.au) (the website) and
[app.warthog.com.au](https://app.warthog.com.au) (the app).** Application source
`d57f625144b9633ced7fc54233d89507dd93f906` runs as `warthog--r45136369712a1`, with one healthy
replica, explicit 100% traffic and zero old replicas.

PR #49 keeps Life admin filed by what it's about, which the founder's real data confirmed, and adds
two refinements. Receipts, subscriptions and memberships can belong to any thing (an eSIM under its
trip, a software plan under its business), and the Records tab says what the active recurring
records cost a month. No migrations (still 91). See the
[release record](docs/audit/life-admin-links-costs-release-2026-11-23.md).

# Earlier delivery status — 23 November 2026 (the front door covers every feature shipped since launch)

**Live at [warthog.com.au](https://warthog.com.au) (the website) and
[app.warthog.com.au](https://app.warthog.com.au) (the app).** Application source
`fd4f7b426c2467ad516c75a10bad9dbc5142dae0` runs as `warthog--r45133098951a1`, with one healthy
replica, explicit 100% traffic and zero old replicas.

PR #50 gives the front door a section or card for every feature shipped since launch: services,
what agents read and Undo, spending, tasks and export, life admin, and the phone app. No migrations
(still 91). See the [release record](docs/audit/front-door-features-release-2026-11-23.md).

# Earlier delivery status — 23 November 2026 (rate limit before any key, addresses purged, Records tab)

**Live at [warthog.com.au](https://warthog.com.au) (the website) and
[app.warthog.com.au](https://app.warthog.com.au) (the app).** Application source
`fadcc53bed447c08f3e6e5ecafa2f0e8716cba8a` runs as `warthog--r45127308436a1`, with one healthy
replica, explicit 100% traffic and zero old replicas.

PR #47 fixes the review's last two Highs (rate limiting before any key unwrap, with a 5-minute DEK
cache; email addresses purged on deletion and swept on a schedule; migration 0120 makes 91). PR #48
gives Life admin a Records tab that shows what's active first, with multiple-choice category and
status filters, and files records from agents with an older copy of the tools as the kind they
meant. See the [release record](docs/audit/security-and-records-release-2026-11-23.md).

# Earlier delivery status — 23 November 2026 (security and privacy answers on the front door)

**Live at [warthog.com.au](https://warthog.com.au) (the website) and
[app.warthog.com.au](https://app.warthog.com.au) (the app).** Application source
`e8261f3c991d9f43888d42cdddd3cc9a89f85604` runs as `warthog--r45124440998a1`, with one healthy
replica, explicit 100% traffic and zero old replicas.

PR #46 adds twelve Security and privacy questions to the landing FAQ, and a "We never sell your
information" section to the privacy policy. No migrations; still 90. See the
[release record](docs/audit/security-faq-release-2026-11-23.md). PRs #47 and #48 are next.

# Earlier delivery status — 23 November 2026 (services on for new agents)

**Live at [warthog.com.au](https://warthog.com.au) (the website) and
[app.warthog.com.au](https://app.warthog.com.au) (the app).** Application source
`742d8811b479fda75b766f62b143bd1e83dd6c78` runs as `warthog--r45121816498a1`, with one healthy
replica, explicit 100% traffic and zero old replicas.

PR #43 adds "On for new agents" to each account under Connectors › Your services, and keeps reads on
and changes "ask me first" when an agent's first service is granted on its page. Migration 0119 makes
90. See the [release record](docs/audit/default-services-release-2026-11-23.md). PR #46 (landing FAQ
and privacy copy) is merged on main after this source and not yet released.

# Earlier delivery status — 23 November 2026 (OAuth consent bound to the request on screen)

**Live at [warthog.com.au](https://warthog.com.au) (the website) and
[app.warthog.com.au](https://app.warthog.com.au) (the app).** Application source
`e3a6015f382b697288019093b191e7361ba3198f` runs as `warthog--r45118618704a1`, with one healthy
replica, explicit 100% traffic and zero old replicas.

PR #45 fixes the review's High OAuth consent swap: the consent form is bound to the request it
shows, and Approve asks the person to confirm it's them. No migrations (still 89). See the
[release record](docs/audit/consent-binding-release-2026-11-23.md).

# Earlier delivery status — 23 November 2026 (life admin: typed profile, life areas, bookings, hand-over journal)

**Live at [warthog.com.au](https://warthog.com.au) (the website) and
[app.warthog.com.au](https://app.warthog.com.au) (the app).** Application source
`9edf3ec623daeac144881df66f37a0eaa5dd609b` runs as `warthog--r45106611024a1`, with one healthy
replica, explicit 100% traffic and zero old replicas.

PR #44 makes life admin a typed profile the person's own agent fills in from email: filed by what
it's about (20 built-in categories, hidden until used, plus categories agents suggest), bookings and
cases with live and finished, things other records belong to, Upcoming and Bookings views, and an
append-only journal on every item so any agent can take over live work. Migrations 0117 and 0118
make 89. See the [release record](docs/audit/life-admin-release-2026-11-23.md).

# Earlier delivery status — 20 November 2026 (Contact us, your requests, LinkedIn switched off)

**Live at [warthog.com.au](https://warthog.com.au) (the website) and
[app.warthog.com.au](https://app.warthog.com.au) (the app).** Application source
`70c2a9f4ed51393b34f56c01cb6208a5eb64c460` runs as `warthog--r44658921004a1`, with one healthy
replica, explicit 100% traffic and zero old replicas.

PR #42 adds Contact us in the app (messages reach the admin Requests page), shows people their own
requests on Connectors, and emails them once when a requested service arrives. PR #41 adds the
LinkedIn connector, switched off until the founder's LinkedIn app exists (docs/linkedin-launch.md).
Migration 0116 makes 87. See the [release record](docs/audit/contact-linkedin-release-2026-11-20.md).

# Earlier delivery status — 20 November 2026 (requests in the admin portal)

**Live at [warthog.com.au](https://warthog.com.au) (the website) and
[app.warthog.com.au](https://app.warthog.com.au) (the app).** Application source
`3f7a8f5149d16b30c9f92d079554f6d3b64d34a9` runs as `warthog--r44641742159a1`, with one healthy
replica, explicit 100% traffic and zero old replicas.

PR #40: requests people make in the app ("Request a service", Google early access) are recorded on
the admin portal's new Requests page with the person's address and account facts, instead of being
emailed. Every admin page now checks sign-in itself, which closes a gap where a crafted request
could read admin pages without signing in. Migration 0115 makes 86. See the
[release record](docs/audit/admin-requests-release-2026-11-20.md).

# Earlier delivery status — 17 November 2026 (Notion connects)

**Live at [warthog.com.au](https://warthog.com.au) (the website) and
[app.warthog.com.au](https://app.warthog.com.au) (the app).** Application source
`2c306f7aee1099ebf02e41b8f6998d17b06ef7ec` runs as `warthog--r44003796746a1`, with one healthy
replica, explicit 100% traffic and zero old replicas.

PR #39: Warthog's client document now names it ("Warthog") and lists the authorization-code and
refresh grants, so Notion's sign-in accepts it instead of answering "Invalid client_id". See the
[release record](docs/audit/notion-client-name-release-2026-11-17.md).

# Earlier delivery status — 17 November 2026 (Google published; several accounts)

**Live at [warthog.com.au](https://warthog.com.au) (the website) and
[app.warthog.com.au](https://app.warthog.com.au) (the app).** Application source
`407f2907611bf57b936a5296de710d20348e594d` runs as `warthog--r43992933196a1`, with one healthy
replica, explicit 100% traffic and zero old replicas.

PR #38: the Google app is published (unverified, up to 100 people), so Google connections no longer
end after 7 days. The same Google or Microsoft account reconnects in place, a second account keeps
agents on the account they use, Notion and key-based accounts can be renamed, and approval cards
name the account when a person has several of one service. No migrations (still 85). See the
[release record](docs/audit/google-accounts-release-2026-11-17.md).

# Earlier delivery status — 17 November 2026 (landing diagrams, round trips)

**Live at [warthog.com.au](https://warthog.com.au) (the website) and
[app.warthog.com.au](https://app.warthog.com.au) (the app).** Application source
`75b433a2b6e2bb0caa46a8fdba46c9e28c8ea6f2` runs as `warthog--r43972166974a1`, with one healthy
replica, explicit 100% traffic and zero old replicas.

PR #37 changes the website's "why one home" diagrams. Every request now makes a round trip:
out to the service and its answer back to the agent, through Warthog in the With picture. The
Without picture runs two or three trips at a time instead of 25. No migrations (still 85) and no
configuration change. See the [release record](docs/audit/landing-round-trip-release-2026-11-17.md).

# Earlier delivery status — 17 November 2026 (email safety, part 2)

**Live at [warthog.com.au](https://warthog.com.au) (the website) and
[app.warthog.com.au](https://app.warthog.com.au) (the app).** Application source
`102d77ffc1935ad8da91015fd6d537ee05840690` runs as `warthog--r43967617925a1`, with one healthy
replica, explicit 100% traffic and zero old replicas.

PRs #33–#35 finish the email-safety series:
- #33: memories and tasks say who saved them (`savedBy`);
- #34: recently read. Approvals say what an agent just read from someone else. For an hour after,
  an agent the person lets act alone is asked first before emailing a new address, inviting
  guests or writing through a messaging service;
- #35: Gmail search returns checked summaries, mail views reach agents as readable text, and
  invitations and Drive Docs and Sheets are read cleanly.

Migration 0114 (`agent_read_exposures`, additive) makes 85. #35's checks passed 6,247 tests on the
released tree. See the [release record](docs/audit/email-safety-release-2026-11-17.md).

# Earlier delivery status — 17 November 2026 (combined release)

**Live at [warthog.com.au](https://warthog.com.au) (the website) and
[app.warthog.com.au](https://app.warthog.com.au) (the app).** Application source
`e8c9781511c4be6faf041376beb8b2337d9cdf18` runs as `warthog--r43951592207a1`, with one healthy
replica, explicit 100% traffic and zero old replicas.

PRs #29–#32, in one release:
- #29: each agent's app details are read from `params._meta` and recorded once per app;
- #30: CI checks each version once, test databases are copies, and admin Traffic counts health
  checks on their own;
- #31: every connector result reaches agents checked (read guard);
- #32: approval cards show what goes out; recipient rules also match calendar guests; Gmail and
  Outlook drafts take plain fields.

No migrations. The main suite passed 6,222 tests. The repository is public again. See the
[release record](docs/audit/combined-release-2026-11-17.md).

# Earlier delivery status — 16 November 2026 (agent conversations)

**Live at [warthog.com.au](https://warthog.com.au) (the website) and
[app.warthog.com.au](https://app.warthog.com.au) (the app).** Application source
`aca26743ea7ac2a34b70a7e4f353859217f17ca6` runs as `warthog--r43796560300a1`, with one healthy
replica, explicit 100% traffic and zero old replicas.

PR #28 tells one agent's conversations apart, with nothing for people to set up beyond the connector:
- `get_context` starts a run (a "conversation") from the agent's `working_on`, and every tool takes it
  back as `run`, resolved only for the calling agent;
- Activity rows, entry details, Inbox approval cards and each agent's Overview show the conversation
  and the product the request came through ("via");
- migration 0113 adds `agent_runs` (encrypted label) and `activity_entry_runs` (append-only links).

The image suite passed 6,131 tests. See the
[release record](docs/audit/agent-runs-release-2026-11-16.md).

# Earlier delivery status — 15 November 2026 (website review fixes)

**Live at [warthog.com.au](https://warthog.com.au) (the website) and
[app.warthog.com.au](https://app.warthog.com.au) (the app).** Application source
`c00f1e99874f7897a7effc78384b7e8dadaf87ba` runs as `warthog--r43644774383a1`, with one healthy
replica, explicit 100% traffic and zero old replicas.

PR #27 carries the fixes from a review of PR #26 (nothing exploitable was found):
- only the app host is offered as an installable app;
- the public pages name their website URL as canonical;
- a signed-in member who opens Sign up goes Home;
- the public 404 leads to the website;
- website redirects are no longer counted in traffic;
- documentation corrections (passkey RP ID, `existingCustomDomains` must stay `[]`, rollback).

The image suite passed 6,106 tests; no migration changes. See the
[release record](docs/audit/website-review-fixes-release-2026-11-15.md).

# Earlier delivery status — 14 November 2026 (website on the root domain)

**Live at [warthog.com.au](https://warthog.com.au) (the website) and
[app.warthog.com.au](https://app.warthog.com.au) (the app).** Application source
`d45072c3bc4d282269f3c17b886daf743ebbf71d` runs as `warthog--r43589445907a1`, with one healthy
replica, explicit 100% traffic and zero old replicas.

PR #26 moved the marketing front door to its own host:
- `warthog.com.au` always shows the front door and the public pages, signed in or not;
- `www.` forwards to the website, and every other website path forwards to the app;
- on the app, `/` sends a signed-out visitor to sign-in.

Four hostnames are now bound (`warthog.com.au`, `www`, `app`, `admin`). The image suite passed
6,097 tests; no migration changes. See the
[release record](docs/audit/website-root-domain-release-2026-11-14.md).

# Earlier delivery status — 14 November 2026 (landing diagrams)

**Live at [app.warthog.com.au](https://app.warthog.com.au).** Application source
`7eb72f683057464726568329f632132030592385` runs as `warthog--r43555128449a1`, with one
healthy replica, explicit 100% traffic and zero old replicas. It carries:
- PR #25: three animated diagrams on the public front door (why one home, ask me first,
  shared memory);
- PR #24: the sign-in vs eviction race fix and branded HTML emails;
- the lucide-react 1.70.0 update.

The image suite passed 6,077 tests; no migration changes. See the
[release record](docs/audit/landing-diagrams-release-2026-11-14.md).

The GitHub repository became private on 14 November at the founder's request. Releases
still work. The foundation environments lost their required-reviewer gate (see the
amendment in [Azure delivery](docs/azure-delivery.md)).

# Earlier delivery status — 13 November 2026 (admin portal hidden from the member app)

**Live at [app.warthog.com.au](https://app.warthog.com.au).** Application source
`2366ed6964725097967035ffb546f588ef0f65f5` runs as `warthog--r43435987370a1`, with one
healthy replica, explicit 100% traffic and zero old replicas. The member app gives no sign
that the admin portal exists (PRs #22 and #23): no Settings entry, and its routes are under
an unguessable internal prefix. The only way in is typing `admin.warthog.com.au` and signing
in there through the app's ordinary sign-in. A production probe found `/admin` and
`/handoff` identical to any missing page. Both hostnames are bound.

The full suite passed 6,016 tests; no migration changes. See the
[release record](docs/audit/admin-hidden-entry-release-2026-11-13.md).

# Earlier delivery status — 13 November 2026 (recovery and reset hardening)

**Live at [app.warthog.com.au](https://app.warthog.com.au).** Application source
`1faf694339b9f76ab12bddcb989c65e55e49078e` runs as `warthog--r43398915940a1`, with one
healthy replica, explicit 100% traffic and zero old replicas. On top of the admin portal
it carries PR #21 (sign-in audit items 4–6):
- recovery removes the lost sign-in methods;
- a completed reset alerts, can be closed by the owner, and re-enrols within 7 days;
- members can remove their authenticator app from Security.

Main and pinned-image CI passed 6,015 tests; no migration changes. See the
[release record](docs/audit/recovery-hardening-release-2026-11-13.md).
`admin.warthog.com.au` is bound with a managed certificate (expires 13 May 2027). See
"Hostname binding" in the [admin portal release record](docs/audit/admin-portal-release-2026-11-13.md).

# Earlier delivery status — 13 November 2026 (admin portal)

**Live at [app.warthog.com.au](https://app.warthog.com.au).** Application source
`40f0db356c2120d14c9b8f90ed025690a9bd2ae0` runs as `warthog--r43390913050a1`, with one
healthy replica, explicit 100% traffic and zero old replicas. It carries the operator
admin portal (PR #20): sign-ups and activation, usage, accounts (no addresses listed),
reliability, traffic and system pages, entered from Settings by the `admin` role after a
fresh step-up through a single-use handoff. Migrations 0110–0112 are additive. `admin.warthog.com.au`
was bound after the next release ([runbook](docs/admin-portal-launch.md)).

Main and pinned-image CI passed 5,966 tests. See the
[release record](docs/audit/admin-portal-release-2026-11-13.md) and the
[build and verification record](docs/audit/admin-portal-2026-11-13/README.md).

# Earlier delivery status — 13 November 2026 (logo, UI/UX follow-ups, sign-in audit fixes)

**Live at [app.warthog.com.au](https://app.warthog.com.au).** Application source
`75bdbf0c708a65d42a17f56716b48bc45d635922` runs as `warthog--r43339696686a1`, with one
healthy replica, explicit 100% traffic and zero old replicas. It carries:
- the founder's Warthog logo, as the browser tab icon and as the brand mark in the
  sidebar and headers;
- the UI/UX follow-ups (PR #18);
- the sign-in audit fixes (PR #19): access-key step-up and alerts, the open-redirect
  fix, and session rotation on step-up.

Main and pinned-image CI passed 5,863 tests; no migration changes. See the
[release record](docs/audit/logo-signin-fixes-release-2026-11-13.md). Audit items 4–5
are in progress for a later release.

# Earlier delivery status — 13 November 2026 (undo guard, approval expiry, Inbox marks)

**Live at [app.warthog.com.au](https://app.warthog.com.au).** Application source
`81a98621567c3638248bbcf0de4b6da6e320f6e7` runs as `warthog--r43325136204a1`, with one
healthy replica, explicit 100% traffic and zero old replicas.
- Undo now runs once per entry and shows whether it is done or waiting for approval
  (migration 0108).
- The approval expiry is a per-person setting on Rules & budgets, from 2 minutes to
  24 hours, default 15 (migration 0109).
- The Inbox shows each agent's mark.

Main and pinned-image CI passed 5,739 tests. Releases no longer wait for GitHub
environment approvals: at the founder's request, required reviewers were removed and
each environment keeps only its `main` branch policy. See the
[release record](docs/audit/undo-expiry-release-2026-11-13.md).

# Earlier delivery status — 13 November 2026 (combined release, deletion journal active)

**The combined release is live at [app.warthog.com.au](https://app.warthog.com.au).**
Application source `df88bbcc193465130873781294774d9028e36404` runs as
`warthog--r43217944024a1`, with one healthy replica, explicit 100% traffic and zero
old replicas. It carries the brand marks, accent and collapsible connector modules,
the whole-app UI/UX pass, and the account deletion journal with its recovery work.
This release activated the deletion journal (`DELETION_JOURNAL_CONTAINER=account-deletions`,
the only configuration change) after the storage protections and the add-only writer
grant were rechecked. See the
[release record](docs/audit/combined-release-df88bbc-2026-11-13.md).

Main and pinned-image CI passed 5,685 tests; no migration changes. The founder
approved both protected environments in GitHub. The temporary runner is verified
removed. The Azure recovery drill remains a separate, unapproved step.

# Earlier delivery status — 12 November 2026 (activity organisation)

**The activity organisation release is live at [app.warthog.com.au](https://app.warthog.com.au).**
Application source `80a353084e1e17eb6f5e0b2811de83f5a7c213a4` runs as
`warthog--r43164384841a1`, with one healthy replica, explicit 100% traffic and zero
old replicas. It includes main's workspace-depth commit `2f18a38`. See the
[release record](docs/audit/activity-organisation-release-2026-11-12.md) for the
changes, image, verification and follow-ups.

Activity now has Timeline, By agent, By type and By service views; Home, the agent
audit log, Inbox, Life admin, Rules, Connectors, Memory, Spending, Vault, More and
the agents list are grouped and filterable. Undo is offered again for curated
calendar events. Main and pinned-image CI passed 5,455 tests; no migrations or
dependency changes. The founder approved both protected environments in GitHub.
The temporary runner is verified removed.

**Recovery protection follow-up:** the approved storage/access changes are
applied and independently verified, including receipt versioning/14-day soft
deletion and a locked 42-day journal. The one synthetic probe found an add-only
retry compatibility issue; its remaining denial checks have not run. The narrow
adapter fix passes 66 targeted tests and TypeScript. Image publication, journal
activation and the isolated cloud recovery drill are still separate gates;
production continues on the image above. See the
[storage and test record](docs/audit/recovery-storage-2026-11-12.md).

# Earlier delivery status — 12 November 2026

**The product review fixes and latest main integration are live at
[app.warthog.com.au](https://app.warthog.com.au).** Application source
`9f2ef12dbf6b1c8c75797b1c647d694cd4b3b7ee` runs as
`warthog--r43149429380a1`, with one healthy replica, explicit 100% traffic and
zero old replicas. The [release record](docs/audit/product-review-release-2026-11-12.md)
contains the immutable image, retained findings, maintenance scope and verification.

The thirteen functional review findings have implementation and acceptance
records covering granular agent controls, accurate execution evidence, lifecycle
events, client metadata, account provenance, usable audit history and large data
transfers. The consent improvements and MCP tool metadata from the latest main
are preserved. The agents coordinated one release, with no competing deployment.

Both source and pinned-image CI passed **5,259 tests**, with zero failures or
skips, plus real PostgreSQL 16, runtime, infrastructure and delivery checks.
All **36 public production checks** passed before and after deployment. An
independent reviewer also passed 24 public and 17 browser checks, covering
expired consent, recovery navigation and responsive access-key controls without
creating credentials or changing account settings. These public counts overlap.
Two additive migrations bring the runtime to 78 migrations; all existing migration
files and dependencies are unchanged. Older images ignore the new restrictions,
so rollback requires a permission-policy review and is never automatic.

The founder approved both protected GitHub environments. The current scan retains
219 OS findings, including four newly listed glibc package/advisory pairs, with
zero non-OS findings in the runtime. The release record explains applicability
and limits; this is not a vulnerability-free image. Existing allocation,
versioned secret references, identity, hostname and SMS-off settings are preserved.

Temporary runner cleanup is independently verified: no owned cloud resources,
scoped grants, subnet NAT association or GitHub registration remain. The ephemeral
private key and local registry credentials are removed. Private operational
evidence is retained under `.delivery/product-review-release/` in the isolated
review worktree. Live all-provider, real-device notification and coordinated
restore verification retain their documented boundaries. Earlier status below
is historical where superseded by this release.

# Historical bug-bash delivery — 11 November 2026

**The bug-bash fixes are live at [app.warthog.com.au](https://app.warthog.com.au).**
Application source `9a7de2e58e9ed3bede61d65bbb9716d0a2214900` runs as
`warthog--r42954727454a1`, with one healthy replica and explicit 100% traffic.
The [production workflow](https://github.com/Orlev01/warthog/actions/runs/42954727454)
succeeded after the founder approved both protected environments. The
[release record](docs/audit/bug-bash-release-2026-11-11.md) identifies the exact
image, compatibility impact, retained OS findings, verification and cleanup.

Three independent perspectives and the coordinator recorded findings and fixes
in the [bug-bash report](docs/audit/bug-bash-2026-11-11/coordinator.md). Changes
address authentication/reset races, OAuth client binding, push deadlines,
reminder correctness, Calendar Undo outcomes, forms, mobile targets and focus.
The admin-console design, agent-first model and skills library are preserved.

Local Linux, main CI and pinned-image CI each passed 5,225 tests. Build,
TypeScript, all 76 migrations and real PostgreSQL16 checks passed. Browser work
covered 97 local route/width/theme combinations plus interaction tests. All 16
production public checks and five authenticated desktop/mobile cases passed,
with no document overflow or browser warnings/errors.

Migration 0105 adds nullable OAuth client binding. Legacy refresh tokens need
reauthorization; current access tokens retain their normal expiry. Reauthorization
creates a new agent connection, so review/reapply custom permissions and remove
the obsolete entry after the replacement works. Static access keys and provider
credentials are unaffected. See the [migration decision](docs/adr/oauth-refresh-client-binding.md).

Independent Azure verification confirmed the exact image, unchanged settings,
zero old replicas and healthy readiness. Capacity remains 0.5 vCPU/1 GiB with
SMS disabled. The fresh scan retains 215 reviewed OS findings (1 critical,
34 high, 95 medium, 85 low), no added/removed pairs and no non-OS findings.

The temporary runner and all associated cloud resources/grants are verified
removed; the shared subnet NAT is detached and the GitHub runner deregistered.
Ephemeral keys, registry credentials, preview/test resources and downloaded task
caches are removed. Browser overrides were reset and the test tab closed. Private
evidence remains in ignored `.delivery/bug-bash-2026-11-11/`.

No production records or account settings were mutated during acceptance.
Real provider receipt, hardware passkeys, assistive-technology speech and
coordinated restore retain their existing verification boundaries. Earlier
entries below are historical where superseded by this release.

# Historical admin-console delivery — 11 November 2026

**The integrated admin console design is live at [app.warthog.com.au](https://app.warthog.com.au).**
[PR 7](https://github.com/Orlev01/warthog/pull/7) merged the design with the latest
main, retaining the deployed agent-first and skills-library work. Application
source `fc131dab5cf17cf5c6878c53d4113e935ac91b0d` is running as
`warthog--r42931814911a1`, with one healthy replica and explicit 100% traffic.
The [production workflow](https://github.com/Orlev01/warthog/actions/runs/42931814911)
succeeded after the founder approved both protected environments. See the
[release record](docs/audit/admin-console-release-2026-11-11.md) for the exact
image, retained OS findings, verification and cleanup evidence.

The neutral workspace shell, grouped sidebar, section tabs, nested agent
navigation, bounded page widths and mobile drawer follow the reviewed
[admin-console reference](docs/design/admin-console-reference.md). Contributor
skills define the reusable design, desktop, mobile, feedback and media conventions.
The private skills library and agent-specific resource controls remain integrated;
see the [preceding release](docs/audit/agent-first-release-2026-11-11.md).

Main and pinned-image CI each passed all 5,154 tests, with no failures or skips.
Local browser validation covered 74 route/viewport combinations plus interaction
checks. All 16 production public checks passed. Read-only authenticated browser
checks verified Home and Skills at 1440, 390 and 320px, tab selection, mobile drawer
Escape/focus return, no horizontal overflow and no browser warnings/errors.

Independent Azure checks confirm the exact image, unchanged application settings,
zero old replicas and healthy readiness. The allocation remains one 0.5-vCPU/1-GiB
replica with SMS disabled. No migration, dependency or infrastructure change was
introduced by this design release. The fresh image scan retains the reviewed
215 OS findings with no additions/removals or non-OS findings.

The temporary runner, disk, NIC, NAT, egress IP and scoped grants are verified
removed; the shared subnet NAT is detached and the GitHub runner deregistered.
Ephemeral local SSH keys and registry credentials were removed. Browser overrides
and the temporary verification tab were cleaned up. Private release evidence is
under ignored `.delivery/admin-design-release/`.

No production records or account settings were changed during browser acceptance.
Additional provider consents, desktop notification receipt and isolated coordinated
restore remain subject to their existing acceptance boundaries. Earlier status
entries below are historical where superseded by this release.

# Historical acceptance-fixes status — 10 November 2026

**Warthog is available at [app.warthog.com.au](https://app.warthog.com.au).**
The acceptance fixes are deployed from source
`09e13608110ef6419d6dd876faba17582b291596`, as revision
`warthog--r42799281150a1`, with one healthy 0.5-vCPU/1-GiB replica and explicit
100% traffic. The old revision is inactive with zero replicas. Live checks
confirm 70 migrations, PostgreSQL TLS 1.3, UID 1000 and one database ownership
lock. See the [current release record](docs/audit/acceptance-fixes-release-2026-11-10.md)
for the immutable digest, evidence and limits.

[Pinned-base publication CI](https://github.com/Orlev01/warthog/actions/runs/42796225675)
passes all six jobs and 5,092 application tests. The published image retains
exactly the previously reviewed OS findings, with no Node findings. Sixteen
post-release public checks pass, including OAuth loopback callback/state,
MCP access boundaries, authenticated receipt downloads and the Terms title.

[Release workflow 42799281150](https://github.com/Orlev01/warthog/actions/runs/42799281150)
failed safely after Azure added empty literal fields beside existing environment
secret references. It stopped the candidate and proved zero replicas/free database
ownership. A narrowly scoped normalization fix passes all 29 delivery tests.
[Final CI on the guard fix](https://github.com/Orlev01/warthog/actions/runs/42802425805)
passes all six jobs and 5,092 application tests with zero failures.
After exact live configuration and zero-replica checks, the operator resumed the
same reviewed candidate; HTTPS readiness passed at 10:48:55 UTC. The failed
workflow remains recorded as failed. Tooling correction `7cae752` is separate
from the deployed application source; no rollback or app configuration change
was used.

Fresh email-plus-Authenticator sign-in passes. The approved Gmail connection and
labels-only read both pass; no message content was read and no mail was sent or
modified. Google remains in Testing mode. Exactly one approved Chrome test push
was reported sent, but the founder could not confirm seeing the OS notification.
Do not resend without separate approval. Local browser tests pass for the new
agent-disconnection Cancel/Confirm dialog and receipt upload/download/deletion,
including exact near-limit file bytes and oversized-file rejection. Production
receipt upload/download repeats pass for 1,024 and 26,213,376 bytes, with exact
SHA-256 matches. Oversized uploads are rejected before submission; the single
synthetic record and both files are removed. Production Authenticator status,
Memory required validation and policy links also pass.

Earlier production Memory/Skill CRUD and cleanup, temporary-agent OAuth/MCP,
permission reduction, refresh rotation and token revocation remain recorded in
the [first acceptance round](docs/audit/live-acceptance-2026-11-10.md). That agent
is disconnected and its tokens revoked. The approved real Gmail connection is
retained. Other provider consents and isolated coordinated recovery remain
separate acceptance work; no real account is reset.

SMS remains disabled, with nine core Key Vault references and no Twilio
configuration injected. Twilio is not required for the current app. Previously
approved Resend DNS and app DNS/certificate remain unchanged and verified.
Startup-credit linkage was checked before this release; estimated Azure usage
remains A$430.66/month (A$438.13 for 31 days), before credits/tax/providers. The
A$440 usage alert is unchanged. It is an alert, not a spending stop.

The fresh private one-job runner and its VM, disk, NIC, NAT, egress IP, resource
group and grants are deleted. Independent inventory confirms no shared-subnet
NAT association or GitHub runner remains. `AZURE_DELIVERY_ENABLED=true` permits
manual reviewed releases; required-reviewer/main-only gates remain in place.
Future deployment, credential, message, spending/profile and DNS changes retain
their approval boundaries. Private evidence stays in the ignored owner-only
`.delivery/activation-2026-11-10/` directory.

Earlier checkpoints below are historical where superseded by this status.

# Historical checkpoint — repository publication and Azure delivery, 10 November 2026

**Cost review and budget follow-up:** the founder requested a small, robust
production baseline, retaining premium features where they add value, using
available credits, and setting an alert at the expected usage cost. This replaces
the earlier unresolved cash-cap/usage-alert decision. The [cost model](docs/azure-costs.md)
estimates A$430.78/month (A$438.25 for 31 days); the **A$440 monthly budget** was
created and independently verified in Azure on 10 November. Actual alerts are
50/80/100% and forecast 100%, to the founder. It is an alert, not a spending stop.

The [launch profile](infra/profiles/launch.tfvars.example.json) keeps General
Purpose PostgreSQL and HSM-backed Key Vault protection, uses 32 GiB P4 storage,
Consumption hosting, ACR Basic, LRS blobs and a small log allowance. Terraform
pins disk type/performance and can import the existing budget without duplicate
creation. The [architecture decision](docs/adr/launch-infrastructure-cost.md)
explains upgrade triggers and availability limits. These are source changes, not
an applied foundation or production certification.

The founder subsequently approved and executed the exact [bootstrap stage](infra/bootstrap/README.md).
The delivery resource group, Entra-authenticated LRS state/plan storage, four
GitHub OIDC managed identities and four container-scoped Blob Data Contributor
grants are now created. Only Storage and ManagedIdentity provider registrations
were added. Live ARM reads verify retention, HTTPS/key/anonymous-access controls,
exact trust subjects and grants; anonymous lists of both containers are denied.
A fresh Terraform plan reports no changes. The four GitHub client IDs, foundation
plan-storage variables and private backend identifiers are configured.

Azure auto-creates the default blob service; the first apply exposed that the
module must configure it with `azapi_update_resource`, not create it. The corrected
remainder plan applied successfully with no unrelated changes. Protected local
bootstrap state/evidence is retained in `.delivery/activation-2026-11-10/`;
operator data-plane access and migration of that bootstrap state are still a
separate review. The production foundation can use the new remote backend.

GitHub delivery remains disabled until foundation control-plane roles, production
credentials and a private ephemeral runner are ready. No production database,
app, production secrets or DNS have been created. The cost alert and approved
state/identity bootstrap are complete; do not request those approvals again.
Private credit/support/budget/state confirmation stays in ignored owner-only
files. Check actual eligible credit availability before each further paid stage.

The [latest full CI run](https://github.com/Orlev01/warthog/actions/runs/42734554563)
passed all six jobs on `bda2dec3364a502f7b971332a948ed4e3586191b`:
5,072 application tests, 18 delivery guards, five cost/profile checks, Terraform
schemas for both roots, types/build/runtime packaging and real PostgreSQL checks.
The subsequent bootstrap-only blob-service correction passed provider validation,
actual Azure plan/apply, independent live checks and a zero-change follow-up plan.
No application code changed after that full CI run; the final record/correction
commit skips another identical application-suite run.

All source and the existing 718-commit history are now published to the public
[Orlev01/warthog](https://github.com/Orlev01/warthog) repository, as authorized by
the founder. Only the verified personal `Orlev01` GitHub credential was used;
new commits use the personal author and SSH signing identity. Eucalyptus
authentication was not used, and global Git settings are unchanged. The existing
local `origin` remains intact; `github` is the new remote. This supersedes the
earlier publication hold below.

Added manual Azure foundation plan/apply, image publication and application release
workflows, plus the [complete setup/release guide](docs/azure-delivery.md). GitHub's
four environments require `Orlev01` review, allow only the `main` branch and forbid
administrator bypass. `AZURE_DELIVERY_ENABLED=false` keeps all cloud steps disabled.
All external contributors' fork workflow runs require maintainer approval; any
future private deployment runner must be ephemeral and reserved for an approved
production run, as detailed in the delivery guide.
The initial publication created no Azure resources. The later approved bootstrap
above now supplies state/plan storage and OIDC identities; production foundation
permissions, credentials, runner and workload execution still need their specific
approvals. No application deployment or DNS change has occurred.

Plans are private, short-lived and bound to source/input hashes; apply requires the
reviewed saved-plan SHA-256. Image publication runs the clean Linux/PG suite against
a reviewed immutable base. App updates preserve configuration and custom domains,
prove zero old replicas/free database ownership before start, verify health and
traffic, and retain an outage on failure without automatic rollback. First creation
uses the existing complete workload template with approved Key Vault references.

The [remote CI run](https://github.com/Orlev01/warthog/actions/runs/42715858437)
passed all six jobs on source commit
`bcc5b6907488eee004509b5760b7d5f761decb56`: four complete-suite shards on standard
Ubuntu/Linux AMD64 runners (**5,072 passed, zero failures/cancellations/skips**),
18 delivery regression tests and Terraform schema checks. Real PostgreSQL checks,
types, production builds and non-root runtime packaging also pass. Local Actionlint
and the workload guard pass. Publication scans
covered 718 existing commits and the complete source tree; findings were
individually reviewed synthetic fixtures/public development values, with no
detected live credential. The audit records detailed CI evidence. The following
local image/browser evidence predates publication and retains its stated limits.

## Resumed local validation

Docker Desktop and Chrome access now work. The isolated clean Node 22.23.4/Linux
ARM64 run passes **5,072 tests, zero failures/cancellations/skips**, TypeScript,
production build and runtime staging (70 migrations, 106 catalogue files). Real
PostgreSQL 16.15 passes bootstrap, migrations/idempotence, role boundaries, purge,
ownership and household/OAuth/DCR/session/activity contention. An additional real-
process check verifies duplicate refusal, exit on lost DB ownership and replacement
after connection loss/SIGKILL. This is not full production/ACA lifecycle acceptance.

The first Linux run exposed a missing public `.env.example` fixture in the Docker
context; it is now included for tests while real environment files stay excluded.
Terraform initialization/provider validation now pass after six draft schema errors
were fixed, and a provider lockfile covers Darwin ARM64 and Linux AMD64/ARM64.
The workload guard still rejects unapproved example parameters. No backend or Azure
plan was opened. AUD-026 records a scoped PostCSS 8.5.32 override; the application
lockfile audit now reports zero known vulnerabilities, with Next still at 15.5.29.
AUD-027 fixes Next retaining a live process after rejected production
instrumentation: startup now terminates explicitly with fixed nonsecret logging,
while development diagnostics remain. Both new regressions pass in the final
suite. The original 25 findings and both additions (27 total) are recorded in
`docs/audit/README.md`; final Linux evidence is
`/tmp/warthog-resume-linux-validated-20261110.log`.

The final `warthog-local-release` image builds for Linux AMD64, runs as UID 1000,
contains the expected 70/106 runtime assets and lockfile hash, excludes environment/
test/bootstrap files, and explicitly exits 1 when production configuration is
missing. Image ID and source fingerprint are in the audit register. Unused global
npm/npx were removed from the runtime stage; the final offline scan reports zero
Node-package findings. Debian OS findings still require applicability/remediation
review before image approval. The ordinary Dockerfile default remains a mutable
base tag; the new release workflow requires an explicitly reviewed immutable base.
No image has been pushed to a registry.

Chrome local smoke checks cover signup keyboard navigation, disabled pending
controls, invalid-code feedback, synthetic email verification, authenticator
fallback and a 390×844 layout. Full passkey/TOTP/vault/transfer/rules and assistive-
technology acceptance remain open. The preview, disposable DB and browser tabs
were cleaned up. No live provider message or real credential was created.

Image advisory applicability/remediation and immutable release approval remain
gates, alongside approved Terraform plan/live ARM checks, provider/full
browser acceptance, 26 MiB ingress, credit-only funding and coordinated restore/
deletion reconciliation. Purchases, credentials, deployment and exact DNS changes
retain their existing separate approvals. Source is published; no cloud release
has run. Earlier socket/Docker/browser failures below are historical, not the
current result.

Founder approval is recorded in `docs/adr/global-messaging.md`: Twilio + Resend local
integration and disclosed overseas processing approved; Warthog is global, Azure
Australia East remains primary. No approval for purchases, real credentials,
deployment, DNS or ongoing expenditure. Earlier pending-exception/AU-only notes
below are historical and superseded.

Subsequent founder approvals: production hostname and passkey RP ID are both `app.warthog.com.au`; sending domain `mail.warthog.com.au` and From `notifications@mail.warthog.com.au`; public replies/support/privacy contact `oren@nava-co.com`. Initial SMS markets AU/US/CA/GB are approved only after registration and delivery/STOP acceptance, with application caps of 200 outbound segments/month and 10/day in total. Exact DNS mutations, credentials, purchases and deployment still need separate approval. The founder confirmed sending the technical questions in response to Twilio sales; entitlement/pricing remain pending.

Latest budget direction: use available Azure sponsorship credits and retain premium features where they add value. The founder explicitly requested cost-focused infrastructure, a calculated monthly estimate and a usage alert when cost exceeds that estimate; the A$440 alert is now created. This supersedes the previous zero-cash and unresolved cash-cap/alert deliberation. Verify eligibility and shared credit availability before paid provisioning; this is not unlimited cash-fallback permission or an approval of unreviewed resources. Resend Free is selected (3,000 emails/month, 100/day), with paid upgrades/overages unapproved. Twilio allowance remains A$20/month; its complete price including sender rentals, redaction and other fees is unresolved. Earlier A$550/A$600/A$675 proposals are historical, not the current Azure estimate or approved purchases.

The founder prefers an Azure-native SMS solution if viable, including using sponsorship. Rechecked official sources: the [Twilio connector](https://learn.microsoft.com/en-us/connectors/twilio/) requires a separate Twilio account; [MCA Azure credits](https://learn.microsoft.com/en-us/azure/cost-management-billing/benefits/credits/mca-check-azure-credits-balance) generally exclude partner/third-party Marketplace services. The current [ACS retirement FAQ](https://learn.microsoft.com/en-us/azure/communication-services/acs-retirement-and-breaking-changes-guide#acs-sms) still retires SMS on 30 September 2028 and restricts number acquisition to existing customers with existing ACS phone numbers. Earlier account inspection found none. No eligible isolated Warthog ACS SMS path has been demonstrated. Marketplace procurement/MACC eligibility is not sponsorship-credit coverage. This investigation does not change providers or authorize provisioning; await the actual Twilio redaction/price response.

Approved-domain compatibility is implemented locally: `RESEND_SENDING_DOMAIN` validates the exact From domain independently of the passkey RP ID, allowing `mail.warthog.com.au` with RP `app.warthog.com.au`. `RESEND_REPLY_TO_ADDRESS` sends customer replies to the approved public contact, and the From display name is Warthog. See `deploy/production.env.example` for approved public settings; it is deliberately incomplete without the separately approved credentials and provider routes. Three regressions failed first, then all 51 affected checks passed. Current full-suite/build evidence is recorded below.

Implemented local adapters, ISO-country routing, international phone formatting,
IDNA email domains, persistent SMS segment/message/attempt limits, opt-in/out and
privacy/security copy. See `docs/production-release.md` and
`docs/global-messaging-launch.md` for current configuration and country limitations.
Google/Microsoft and push remain required. Real provider acceptance and release
image/PostgreSQL/browser checks are still outstanding. The founder authorized
the one no-cost Twilio redaction/price inquiry in `../warthog-browser-checkpoint-7.md`
and supplied all requested contact fields, including phone/job title, on 9 November.
The corrected sales-contact form was submitted once and confirmed at about
09:32 UTC / 20:32 AEDT on 9 November. Twilio's thank-you page estimates 1–2 days
for a response; no ticket ID was displayed. Marketing opt-ins stayed unchecked.
The initial form had no message/company field. The founder subsequently confirmed
sending the prepared technical questions in reply to Twilio sales. Await that
reply; do not resubmit the form or duplicate the outreach. Do not request the
inquiry authorization or supplied contact facts again.
Checkpoint 6 is complete; see `../warthog-checkpoint-6-engineering-review.md`.
Local follow-up now fixes concurrent approval collection and per-credential passkey envelopes (0097), adds draft public Terms and adjacent SMS disclosures, and prepares an isolated Linux/PostgreSQL harness. Final policy review/publication, country quiet-hour/use-case assessment (no scheduler), processor/account review and actual body-redaction entitlement/cost remain external gates. Current English code/approval
texts fit one/two conservative segments with the candidate hostname; no live send.

Household follow-up is now implemented locally: policy uses converted display totals, missing required rates fail closed, and release locks/rechecks household/member/agent budgets and current permissions in the ledger transaction. A fixed ledger instant prevents a month-end wait from checking the wrong month. Existing personal period buckets/time-zone cut-over semantics remain. A real PostgreSQL lock-contention test is prepared in the isolated harness but unexecuted.

Pre-audit baseline verification after the approved-domain changes: full run 4,966 tests, 4,948 passed, 11 socket-restricted failures and seven boot cancellations. This includes the final household timing changes and approved-domain/reply-to regressions. Earlier focused release-handler checks pass all 42 tests; household checks pass 163 tests, with a separate 35-test boundary/UI run (counts overlap). Final production build, TypeScript, runtime staging and whitespace checks pass; staging contains 68 migrations and 106 catalogue files. Docker Desktop's socket is absent and macOS could not launch it; an existing OrbStack socket was found but this session is denied access. Compose configuration and harness syntax/type checks pass, but Linux/real-PostgreSQL execution remains unverified. The read-only browser retry also failed: browser-access host unavailable, then native Chrome timeout. No account state was refreshed, and no production credential or cloud setting changed. See the detailed handoff for remaining external, validation and product-review gates.

Evidence and release gates: `docs/production-release.md`. Local Linux procedure: `docs/local-release-validation.md`.

---

# Historical production release preparation (superseded by current status)

Status: local draft, 9 November 2026; not approved to provision or launch. Work is on `codex/production-release`, based on `dddd410`; local changes remain uncommitted. Original checkout and bare main remain unchanged. Nothing published or deployed.

Confirmed scope: real email, SMS, push, Gmail/Google Calendar/Google Drive, Outlook Mail/Outlook Calendar/OneDrive. No silent deferral. Google retains its existing early-access restriction; Warthog retains public sign-up and strong sign-in.

Completed locally: notification and OAuth composition, SMS destination/segment controls, authentication and vault-possession hardening, invite quota and OAuth cleanup, nonce middleware, separate database roles/connections, ownership guard, Node 22 container packaging and local licensed fonts. Production build, TypeScript and runtime staging pass; staging includes 66 migrations and 106 catalogue entries. Focused tests pass. The full suite plus targeted fixes is documented precisely in `docs/production-release.md`; local socket restrictions prevent a green full run, real PostgreSQL and final-image/browser certification.

Checkpoint 5 is complete by founder-supplied browser report; see `../warthog-checkpoint-5-findings.md`. No isolated eligible Warthog ACS SMS path was demonstrated; the older GameHub communication resource has no numbers and disabled acquisition controls. No accessible Warthog Google project or Entra application was found. Nothing was changed. Next gate: founder decision on `docs/adr/messaging-provider-exception-proposal.md` for a limited Twilio/Resend policy exception and local integration only. Approval is pending; do not repeat checkpoint 5 or start provider setup.

Remaining engineering gates: provider decision and any adapter replacement; authorized clean Linux image/real PostgreSQL/security/browser verification; reviewed private bootstrap execution client/procedure; immutable release commit and image digest. The SQL bootstrap file exists but is not an unattended job or proof of execution. Singleton replacement still requires maintenance and real acceptance; advisory ownership is not distributed fencing.

Remaining founder approvals: final host/RP/sending domain, operator/test identities, SMS destinations/limits, gross AUD spend envelope and treatment of the older automatic-stop/US$150 requirement. A$550 remains a proposal; budgets do not stop spending. No Azure/GoDaddy mutations or purchases are authorized by this local work.

SMS proposal reconciliation: current counters measure segments/month, segments/day and segments/recipient-hour. Three messages/recipient-day, a two-segment message maximum and Australian-mobile-only validation are proposed additions, not implemented protections. The proposed A$600 envelope is not spending authorization and does not supersede the original automatic-stop requirement.
