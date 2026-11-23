# Member-app UI/UX audit and redesign: 23 November 2026

Oren asked for a full UI/UX review of the Warthog member app. He is an engineer, not a designer; the app works, but its UX isn't where it needs to be. He also asked which external UI/UX skills and tools would help, and for a redesign proposal and an implementation plan. **No application code was changed.**

- **Scope:** the signed-in member app on `github/main` at `d3b7d94`.
- **Out of scope:** sign-up, sign-in, consent, the landing page, public help and the operator portal.
- **Founder decisions for this audit:**
  - navigation may be restructured freely, with brief amendments proposed for ratification;
  - the visual direction is *refined*, not replaced.

## 1. Executive summary

**The verdict.** Warthog's components are sound and accessible:
- axe-core found 0 real violations across 251 captures;
- every keyboard stop shows a visible focus;
- nothing overflows from 320px to 1920px.

What holds the UX back is **structure, not styling**:

1. **Navigation follows the data model, not the member's jobs.**
   - There are 15 destinations in groups named "Account resources", "Insights" and "Manage".
   - On a phone, where members mostly use Warthog, every destination sits behind a hamburger, and the Inbox shows no count.
2. **The core job is buried or inflated.**
   - Home puts a set-up checklist above "4 requests are waiting".
   - Each Inbox request is about one phone-screen tall and names the agent three times.
   - Requests Warthog holds for its own tools reach the person **with no object at all**, so they are approved blind.
3. **Things break right after a person acts.**
   - A released card request still shows live Approve buttons.
   - Permission edits vanish when you switch tabs; card access stays on while the person believes they turned it off.
   - Every row action jumps to the top and drops focus.
   - Form errors never name the field. This is the one WCAG 2.2 AA failure found.
4. **Too much at once.**

   | Page (390px phone) | Length | Notes |
   |---|---|---|
   | Life admin | 20 screens | 697 controls, 26 primary buttons |
   | Activity | 13 screens | A raw log of tool calls |
   | Connectors catalogue | 12 screens | |
   | Agent page | — | Two tab rows over seven separately saved sub-pages |

5. **Visually it reads as "a competent admin console, not a calm, premium security product".** The causes:
   - floating header cards that repeat the title;
   - every container raised the same way;
   - underlines and arrows everywhere;
   - repeated black and red buttons;
   - status colour on every row.

   The foundations behind them are fragmented: tokens in 5 files, about 20 conflicting selectors, and one shipped CSS bug.

**The redesign, in short:**
- Keep the look and the components.
- Reorganise navigation around what members do:
  - **Home · Inbox (count) · Activity · Agents**, then "What agents can use" and "Spending & rules";
  - a phone bottom bar, as the brief originally specified.
- Make each page lead with its one job:
  - an agent's whole access on **one page with one Save**;
  - **one home for money** and one for account settings;
  - Activity as **conversations**;
  - Life admin's agent finds as a real queue.
- Fix saving, confirming, errors and focus once, in shared code.
- Consolidate the design foundations so every later fix is cheap.

**Start here:**
1. **Phase 0 (about 3–4 days) fixes the three critical defects.** None needs a design decision.
2. **Ratify the navigation change and tree-test it with 5 members (an afternoon).**
3. **Phase 1 (about 2 weeks) restructures navigation.** Together with phase 0, it delivers most of the felt improvement.

## 2. Deliverables

| # | Deliverable | Where |
|---|---|---|
| 1 | Application overview | [§3 below](#3-application-overview) |
| 2 | Repository and skill evaluation | [skills-evaluation.md](skills-evaluation.md) |
| 3 | Selected skills and tools | [skills-evaluation.md › Selected set](skills-evaluation.md#selected-set-and-roles) · [§4 below](#4-selected-skills-and-tools) |
| 4 | Comprehensive UI/UX audit (7 lenses + code rules) | [findings.md §4](findings.md#4-audit-by-lens) |
| 5 | Prioritised issue list (55 issues: 3 critical, 17 high, 27 medium, 8 low) | [findings.md §5](findings.md#5-prioritised-issue-register) · [§5 below](#5-top-issues) |
| 6 | Proposed information architecture | [redesign.md §2](redesign.md#2-information-architecture) |
| 7 | Page-by-page redesign | [redesign.md §3](redesign.md#3-page-redesigns) |
| 8 | Design system proposal | [redesign.md §6](redesign.md#6-design-system) · [proposed-tokens.css](proposed-tokens.css) |
| 9 | Implementation roadmap | [redesign.md §7](redesign.md#7-implementation-roadmap) |
| 10 | Visual examples and wireframes | [wireframes/](wireframes/) (4 rendered mockups) · ASCII in redesign.md §3.3 and §3.9 · evidence in [screens/](screens/) |
| 11 | Risks and considerations | [redesign.md §8](redesign.md#8-risks-and-considerations) · [§7 below](#7-risks-in-brief) |
| 12 | Recommended next steps | [§6 below](#6-recommended-next-steps) |

**Supporting evidence:**
- [tools/findings/](tools/findings/): raw reviewer findings, 178 in total, with scores.
- [tools/metrics-overview.md](tools/metrics-overview.md): density and axe results per page.
- [tools/capture.mjs](tools/capture.mjs) and [tools/seed/](tools/seed/): the reproducible harness.
- [tools/review-brief/](tools/review-brief/): the reviewer instructions.

## 3. Application overview

### What Warthog is for

Warthog is a **personal agent home**. A person connects every AI agent they use (Claude, ChatGPT, Gemini, Grok and others) to Warthog as a single remote connector. Each agent gets its own revocable, scoped access to what the person keeps there:
- connected services (email, calendar, files and 100+ others);
- identity details in two tiers (everyday and protected);
- saved cards;
- skills and preferences;
- a shared memory;
- life-admin records and tasks;
- rules and budgets.

Anything risky waits in one **Inbox** and reaches the phone as a notification. **Activity** is a tamper-evident record of what agents did. Households share an address and a budget. Warthog never calls an AI model itself.

### Who uses it, and how

| User | How they use it | Source |
|---|---|---|
| Members (individuals with 2+ agents; the founder and 10–20 friends first) | **Mostly from their phone**: approving requests on the go and glancing at activity. From a laptop for set-up: connecting services and agents, writing skills and rules. Not developers. Abandon a step that doesn't say what happens next. Expect phone-app quality. | `brief.yaml` users |
| Household members | Each has their own account and agents. An owner invites others; they share an address, a budget and per-member limits. | `brief.yaml` users |
| AI agents | Call Warthog's tools: context, memory, records, tasks, card and detail requests, reports. They are a separate class of "user" whose actions the member reviews. | `docs/adr/agent-first-management.md` |
| Operator | A separate admin portal. **Out of scope** for this audit. | `docs/design/admin-portal.md` |

**Jobs, in order of frequency:**
1. Decide on an agent's request quickly, often from a push notification.
2. Glance at what agents did, and dispute or undo it.
3. Check what's coming up (rego, bookings, renewals) and confirm what agents filed.
4. Set up: connect agents and services, and decide what each agent may do.
5. Control money: card access, budgets and household limits.
6. Keep identity, preferences, skills and memory in one portable place.

### Technology and constraints

- **Stack:** Next.js 16 (App Router, webpack), React 19, Tailwind CSS 4 and lucide-react. No component library; runtime dependencies are pinned, and adding one needs an ADR. Postgres, with PGlite locally.
- **Styling:** about 2,080 lines of CSS across 5 files, with about 342 bespoke `.wh-*` classes plus Tailwind utilities. Tokens are in `src/app/globals.css` and `workspace.css`.
- **Primitives:** `src/components/ui` (Button, Badge, Card, EmptyState, Field, Notice, Status, Toast, ViewPanels, FilterLinks, ListGroup, ListToolbar, ConfirmItsYou and others) and `src/components/shell` (AppShell, WorkspaceHeading, WorkspacePanel, NavigationTabs, SectionNavigation).
- **Tests:** 155 render tests make about 1,688 regex assertions on markup, copy and class names. A redesign must budget for updating them.
- **Design governance:**
  - the measured admin-console reference (`docs/adr/admin-console-design.md`);
  - workspace depth (canvas → panel → inset);
  - the contained-text rule (no text loose on the canvas);
  - one indigo tint for wayfinding;
  - five contributor design skills in `.agents/skills/`.
- **Responsive approach:** mobile-first CSS. Below 1024px, a sticky top bar plus a hamburger drawer. From 1024px, a 260px sidebar. Three content widths: wide 1216, reading 896, form 768. The app installs as a PWA with push notifications, but has no offline support.

### Map of the member app

| Area | Route(s) | What's on it today | Size (code; phone page height in the typical account) |
|---|---|---|---|
| ★ Home | `/home` | Greeting band, a 5-step "Finish setting up" checklist, Inbox summary, Recent activity, Your agents, Reminders | ~1,150 lines; 3,234px (3.8 screens) |
| ★ Inbox | `/inbox` (+ `?view=history`) | Waiting on you / History. Requests grouped by agent, each with Approve (and release), Deny, Ask for more detail, and Details. The card and protected-detail release flow. | ~1,980 lines; 2,388px for 4 requests |
| ★ Activity | `/activity` | Check integrity; views (Timeline, By agent, By type, By service); 6 quick filters; Filters (agent, service, event, outcome, dates); search; entries with Dispute and Undo; paging | ~1,100 lines; **11,154px (13 screens)**, 119 disclosures |
| ★ Agents | `/agents`, `/agents/connect`, `/agents/access-key` | Your agents (list) · Connect an agent (guide) · access key for agents without OAuth | ~1,220 lines |
| ★ Agent | `/agents/[id]?section=` | Header + two tab rows: Overview · Resources (Connectors, Vault, Skills, Memory) · Controls (Spending, Rules, Settings) · Activity | ~2,490 lines |
| Connectors | `/connectors` (+ `/connectors/key`) | Your services (accounts, tools, "On for new agents") / Catalogue (100+ services, search, categories, requests) | ~1,250 lines; 10,051px for the catalogue on a phone |
| Vault | `/vault`, `/vault/cards` | About you (everyday details, protected details, vault recovery phrase) · Cards | ~3,100 lines |
| Skills | `/skills` | Library / Import & create / Preferences (tone, language, units, time zone) | ~1,480 lines |
| Memory | `/memory` | Add a memory, search, sharing and source filters, date groups | ~750 lines |
| ★ Life admin | `/life-admin`, `/life-admin/items/[id]` | Outer tabs: Records & reminders / Tasks. Inner tabs: Records / Upcoming / Bookings / Moving checklist. Records stack: To check → filters → monthly cost → per-category panels → Fill in the rest → Add a record. | **~4,450 lines; 16,859px (20 screens), 697 controls, 26 primary-styled buttons** |
| Rules & budgets | `/rules` | Your rules (+ Approval expiry) / New rule / Budgets | ~1,250 lines |
| Spending | `/spending` | Account currency form · per agent and merchant · Household totals | ~600 lines |
| Household | `/household` | Up to 9 stacked panels: members, addresses, budget, invite, limits, transfer, close | ~1,090 lines |
| Settings | `/settings/*` | Overview · Agent defaults · Security (+ sign-in requests) · Notifications · Data & privacy | ~3,700 lines |
| Help, Contact us | `/help` (public page), `/contact` | Help leaves the workspace shell; Contact is in the shell | — |
| More | `/more` | A legacy grouped menu; no navigation links to it | ~130 lines |

★ = most important or most frequently used, judged from the brief, the push-notification targets (`public/sw.js` opens `/inbox?approval=`) and recent development activity.

**Data people handle:**
- agents and their connections and conversations;
- per-agent grants (services and tools, details, card access and budget, skills, memory, records, rate limit);
- service connections and accounts;
- identity fields (two tiers);
- cards;
- approvals;
- activity entries (disputes, undo, integrity);
- rules (ask first, never allow, expiry);
- budgets (per agent, household);
- memories;
- skills and preferences;
- life-admin records (standing items, bookings, cases), journals, tasks and suggestions;
- household members and invites;
- account security (passkeys, authenticator, sessions, recovery);
- export and import.

**Functionality that must be preserved:**
- the security flows: step-up "Confirm it's you", device-side card and protected-detail release, the vault passphrase;
- the deliberately one-click Disconnect;
- the member scoping, redaction and the activity hash chain;
- the agent-first model (an agent's effective access is separate from account-owned resources);
- URL-addressable views (`?view=`, `?section=`, filters) with Back/Forward;
- forms that stay mounted across in-page tabs;
- every existing capability, which must stay reachable.

## 4. Selected skills and tools

Eight named repositories and four others were evaluated by reading their actual skill files; see [skills-evaluation.md](skills-evaluation.md).

| Tool | Role | Why chosen |
|---|---|---|
| **Impeccable** (pbakaus/impeccable): critique rubric, audit, and later distill, clarify, layout and harden | UX and IA critique method now; page-by-page refinement later | The strongest evaluation method found: Nielsen scoring, cognitive load, persona walks, and "refinement preserves" for existing apps |
| **Vercel web-design-guidelines** | Code-level interface rules with a `file:line` backlog | Checkable, pinned, no runtime dependencies |
| **axe-core + the AccessLint WCAG-EM method** | WCAG 2.2 AA evidence: automated, plus a manual checklist | Industry standard and pinnable. AccessLint's own engine runs unpinned `npx` |
| **Emil Kowalski `break-ui` catalogue** | Worst-case seed data | Makes the evidence honest about long names and volume |

**How they are installed:**
- Impeccable (skill folder only, no hooks, never `live`) and web-design-guidelines are pinned at user level in `~/.claude_oren/skills/`. **Not in the repo.**
- axe-core lives in a scratch tool directory and is passed to the harness with `AXE=`. **It is not a Warthog dependency.**

**Rejected:** taste-skill, Hallmark, ui-ux-pro-max, the shadcn skill and MCP, and Anthropic frontend-design. Their reasons, in short:
- they generate new visual identities, or force new dependencies or hooks;
- or they conflict with Warthog's own design system, which stays the authority for every fix.

## 5. Top issues

| # | Issue | Severity | Effort |
|---|---|---|---|
| W-01 | Requests held for Warthog's own tools (add task, save record, remember) show no object, so they are approved blind | **Critical** | M |
| W-02 | A released card or passport request still shows live Approve, Deny and Ask; the Inbox never refreshes | **Critical** | S |
| W-03 | Agent permission edits are silently lost on a tab switch; card access stays on while the person thinks it's off | **Critical** | M |
| W-04 | Phone navigation is a hamburger with no Inbox count; the drawer and sidebar overflow and hide Help | High | M |
| W-05 | Home puts set-up above decisions and shows only a count of waiting requests | High | M |
| W-08 | The agent page has 3 levels of navigation and 7 separately saved sub-pages, and no Disconnect | High | L |
| W-07 | The card release has detours with no way back, too many controls, and repeated identity checks | High | M–L |
| W-12 | Life admin's "To check" is a 20-screen wall of 25 expanded cards; "Confirm all" sits 9,200px down | High | M |
| W-13 | Activity is a raw tool-call log: 13 phone screens, and 7 interactions to filter | High | L |
| W-15 | Form errors never name the field and discard input (WCAG 3.3.1 fail) | High | M |

The other high issues:
- money spread over four places (W-09);
- account settings with no home (W-10);
- connecting a service doesn't grant any agent (W-11);
- focus lost after every action (W-14);
- confirmation not matched to risk (W-16);
- header cards and box soup (W-17);
- visual noise (W-18);
- fragmented foundations (W-19);
- status shown five ways (W-20).

**Evidence:** [phone Home](screens/phone-home.jpg), [phone Inbox](screens/phone-inbox-1.jpg), [identical held requests](screens/phone-inbox-identical-holds.jpg), [phone Life admin](screens/phone-life-admin-1.jpg), [phone Activity](screens/phone-activity-2.jpg) and [phone drawer](screens/phone-drawer.jpg).

## 6. Recommended next steps

1. **Ship phase 0 now** (about 3–4 days), [roadmap](redesign.md#phase-0--safety-fixes-about-34-days-no-design-decisions-needed):
   - native-tool detail lines in the Inbox (W-01);
   - make a released request terminal and refresh the Inbox (W-02);
   - an unsaved-changes guard on agent sections and Household (W-03);
   - restore the sidebar tint bar;
   - the reminder keypad and reduced-motion fixes.
2. **Decide on the navigation** ([redesign §2.4](redesign.md#24-decisions-for-the-founder)): bring back the phone bottom bar, rename Connectors to Services, the approval expiry default and short agent names. Then ratify the brief amendment in [§2.5](redesign.md#25-proposed-briefyaml-amendment-for-ratification).
3. **Tree-test the proposed navigation** with 5 members, using the wireframes (an afternoon).
4. **Build phase 1** (navigation and settings homes), with **phase 3A** (tokens, layers, design-lint; CSS only) in parallel.
5. **Then phase 2**, in this order: Inbox and request review → Home → Agent page → Spending → Services.
6. **Hold the Life admin queue work until PR #52 merges**, then build on its tabs.

## 7. Risks in brief

- **PR #52** (Life admin tabs) is open in another session. Build on it.
- **About 1,688 render-test assertions** lock copy and markup. Keep hooks and ARIA stable; update tests in the same PR.
- **The navigation change reverses part of the 11 November admin-console ADR.** Founder ratification is needed.
- **Old `?section=` agent links and push deep links must keep working.** Map them to the new tabs.
- **Security flows:**
  - the release *order* changes (step-up first) and gets a security review;
  - the cryptography and server checks don't change;
  - the service Disconnect stays one click.
- **No new runtime dependencies are proposed.**

Full table: [redesign.md §8](redesign.md#8-risks-and-considerations).

## 8. How this was done, and how to reproduce it

**What was done:**
- Three synthetic accounts were seeded on a local dev server through the real agent tools and consent flow ([tools/seed/](tools/seed/)): first-run, typical, and worst-case data.
- 381 captures (plus 15 re-captures) were taken at 390, 768 and 1440 in light and dark, with axe and density metrics, using [tools/capture.mjs](tools/capture.mjs).
- Keyboard traces were run.
- Seven parallel specialist reviewers ran read-only against the code, plus a code-rules pass. Saving and destructive tests ran in the worst-case account only.
- The findings were consolidated and every critical and high issue was re-verified.
- Production was never touched.

**To reproduce:**

1. **Start the dev server:**
   ```sh
   cp .env.example .env.local
   # set PUBLIC_BASE_URL=http://localhost:3241
   npx next dev --webpack -p 3241
   ```
2. **Seed:**
   ```sh
   PLAYWRIGHT_MODULE=<playwright> node tools/seed/signup-agents.mjs typical "Alexandra Nguyen" "Claude|ChatGPT|Gemini — family travel and household research assistant"
   ```
   Then run `grant.mjs`, `seed-content.mjs`, `seed-tasks.mjs`, `seed-ui.mjs` and `fresh-approvals.mjs`. Seed state (local passkeys and tokens) is written to `tools/seed/state/`. Don't commit it.
3. **Capture:**
   ```sh
   STATE=… URLS=… OUT=… AXE=<axe.min.js> node tools/capture.mjs discover
   # then
   … capture all light-390,light-768,light-1440,dark-390,dark-1440
   # then
   … keyboard
   ```
4. **Render the wireframes:**
   ```sh
   node wireframes/render.mjs
   ```
