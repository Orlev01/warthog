# Member-app redesign proposal

Part of the [member-app UI/UX audit, 23 November 2026](README.md). It answers the issues in [findings.md](findings.md); `W-nn` numbers refer to that register.

**In one paragraph.** Keep Warthog's look (neutral palette, one indigo tint for wayfinding, Inter, the admin-console reference) and keep its components. Change how the product is *organised* and how pages *behave*:
- **Navigation follows what members do.** Decide, glance, manage agents, then the things agents can use, then money and rules.
- **The phone gets a phone navigation:** the bottom bar the brief originally specified, with an Inbox count.
- **Each page leads with its one job.**
  - Home leads with decisions.
  - Inbox requests fit on a screen.
  - Activity reads as conversations.
  - Life admin's queue becomes a queue.
- **An agent's whole access lives on one page** with one Save.
- **Money has one home.**
- **Shared behaviours are fixed once for the whole app:** saving, confirming, errors and focus after actions.
- **The design foundations are consolidated** so every later fix is cheap.

## Contents
1. [Principles](#1-principles)
2. [Information architecture](#2-information-architecture)
3. [Page redesigns](#3-page-redesigns)
4. [Wireframes](#4-wireframes)
5. [Shared interaction patterns](#5-shared-interaction-patterns)
6. [Design system](#6-design-system)
7. [Implementation roadmap](#7-implementation-roadmap)
8. [Risks and considerations](#8-risks-and-considerations)

---

## 1. Principles

1. **Decisions first.** Anything waiting on the person is the most prominent thing wherever it appears: Home, the navigation badge and the agent page. Everything else is secondary.
2. **One home per thing, links everywhere else.**
   - Each setting, list or control lives in exactly one place.
   - Other pages *show* its state and link to it ("$0 of $300 · Change"). They never hold a second copy of the control.
3. **Agent-first, shown not explained.**
   - An agent's effective access is managed on the agent's page.
   - Account pages show "Used by Claude, Gemini" on each object instead of a "How access works" disclosure.
4. **The phone is the primary device.**
   - Bottom navigation, thumb-reach actions and one decision per screen-height.
   - Desktop adds width (two columns, a section index); it doesn't add concepts.
5. **Summary first, detail on demand.**
   - Queues show 5, then "Review all".
   - Timelines show conversations, then steps.
   - Catalogues show what you can connect now.
6. **One loud thing per screen.**
   - At most one filled primary button in the first viewport.
   - Repeated row actions are quiet.
   - Red appears at the moment of risk, not on every row.
7. **After every action, say what happened to *what*, and keep the person where they were.**
   - The notice names the item.
   - Focus moves to the next item.
   - Undo is offered when the action can be reversed.
8. **Refine, don't replace.**
   - Keep the tokens, primitives, class hooks and ARIA that tests rely on.
   - Change the CSS behind them, and add the missing primitives once.

---

## 2. Information architecture

### 2.1 Today

```
Sidebar / phone drawer (15 items, 5 groups)          Agent page (/agents/[id])
├── Workspace                                         ├── Overview  (8-card access map)
│   ├── Home                                          ├── Resources
│   ├── Agents  [Your agents | Connect an agent]      │   ├── Connectors   (own Save)
│   └── Inbox   [Waiting on you | History]            │   ├── Vault        (own Save)
├── Account resources                                 │   ├── Skills       (own Save)
│   ├── Connectors [Your services | Catalogue]        │   └── Memory       (own Save)
│   ├── Vault      [About you | Cards]                ├── Controls
│   ├── Skills     [Memory|Skills] › [Library | Import & create | Preferences]
│   ├── Memory     [Memory|Skills]                    │   ├── Spending     (card access + budget, own Save)
│   └── Life admin [Records & reminders | Tasks]      │   ├── Rules
│                    › [Records | Upcoming | Bookings | Moving checklist]
├── Insights                                          │   └── Settings     (tasks/records, rate limit, key)
│   ├── Activity   [Activity|Spending] › 4 views     └── Activity
│   └── Spending   [Activity|Spending]                (no Disconnect)
├── Manage
│   ├── Rules & budgets [Your rules (+expiry) | New rule | Budgets]
│   ├── Household  (9 stacked panels)
│   └── Settings   [Overview | Agent defaults | Security | Notifications | Data & privacy]
└── Help
    ├── Help  → leaves the app (public page)
    └── Contact us
/more  (legacy menu, unlinked)
```

### 2.2 Proposed

**Desktop sidebar (≥1024px).** 11 destinations, plus a pinned footer that never scrolls away.

```
WARTHOG
├── Home                      what needs you · what agents did · coming up
├── Inbox            (4)      [Waiting on you | History]
├── Activity                  [Conversations | By agent | By service] + Agent/When chips
├── Agents                    [Your agents | Defaults for new agents]   + "Connect an agent" button
│   └── <agent>               [Overview | Access | Limits | Activity]   + Disconnect in header
│
├── What agents can use
│   ├── Services              [Your services | Catalogue]        (was "Connectors")
│   ├── Vault                 [About you | Cards]
│   ├── Life admin            [Records | Upcoming | History | Tasks]   (PR #52 tabs)
│   ├── Memory
│   └── Skills                [Library | How agents write for you]     + "New skill" button
│
├── Spending & rules
│   ├── Spending              this month · per agent (budget) · household
│   └── Rules                 your rules + "New rule" button     (was "Rules & budgets")
│
└── (pinned footer)
    ├── Household
    ├── Settings              [General | Security | Notifications & approvals | Data & privacy]
    ├── Help & support        in-app help + contact form + your messages
    └── Alexandra Nguyen · Sign out
```

**Phone (<1024px).** A bottom bar plus a More page. Every destination is reachable in two taps.

```
Bottom bar:  [ Home ]  [ Inbox (4) ]  [ Activity ]  [ Agents ]  [ More ]

More
├── (you) Alexandra Nguyen · Nguyen household
├── What agents can use:  Services · Vault · Life admin · Memory · Skills
├── Spending & rules:     Spending · Rules
└── Household · Settings · Help & support · Sign out
```

The top bar on a phone keeps only: a back arrow on sub-pages, the page title (once) and a contextual action (e.g. "+ Add"). It loses the hamburger.

### 2.3 What goes where, and why

| Decision | Items | Rationale |
|---|---|---|
| **Main navigation** (bottom bar and top of the sidebar) | Home, Inbox, Activity, Agents | The daily jobs: decide, glance, manage agents. Same order on both devices. Inbox carries the waiting count everywhere. |
| **Grouped secondary destinations** | Services, Vault, Life admin, Memory, Skills under "What agents can use"; Spending and Rules under "Spending & rules" | Group names say what's inside in the member's words, not the code's ("Account resources", "Insights", "Manage"). |
| **Pinned footer** (set once, always visible) | Household, Settings, Help & support, account | Infrequent but must never scroll out of reach (the sidebar runs past 900px today). |
| **Separate pages** | Each sidebar item; the agent page; a Life admin item; a request review (`/inbox?approval=<id>`, existing) | Things a person bookmarks, is sent to by a notification, or returns to. |
| **Tabs** (one row maximum on any page) | Inbox (Waiting / History), Agents (Your agents / Defaults), Agent (Overview / Access / Limits / Activity), Services (Yours / Catalogue), Vault (About you / Cards), Life admin (Records / Upcoming / History / Tasks), Skills (Library / How agents write for you), Settings (4) | Parallel views of one subject. Never two rows; never actions as tabs. |
| **Becomes a button that opens a panel or sheet** | "New rule", "Import & create" → "New skill", "Connect an agent" | They're actions, not views (W-39). |
| **Moved** | | |
| | Time zone, language, units, currency | **Settings › General**. Account-wide, and they drive budgets and all displayed times (W-10). |
| | Approval expiry, reminder delay | **Settings › Notifications & approvals**. One place for "how and when you get asked" (W-10). |
| | Tone, length, briefing | **Skills › How agents write for you**. Instructions to agents, like a style skill; the all-six-fields rule is dropped (W-10). |
| | Budgets (Rules › Budgets) | **Spending**, as per-agent rows linking to the agent's Limits. Budgets sit next to what was spent (W-09). |
| | Agent defaults (Settings) | **Agents › Defaults for new agents**. They're about agents (W-10). |
| | Card access | **Agent › Limits**, alongside the budget. Vault › Cards lists "Agents that can ask to use a card" (W-09). |
| | Tasks and records access (Agent › Controls › Settings) | **Agent › Access** (W-08). |
| | Disconnect | **Agent header and Overview.** The list button stays too (W-08). |
| | Help | **Help & support, inside the shell.** Public `/help` stays for signed-out people (W-24). |
| **Collapsed or progressively disclosed** | Life admin "To check" (first 5, then a one-at-a-time review); Activity steps inside conversations, with reads hidden by default; agent Access sections behind a section index; Inbox technical details; Household ownership and leaving; release unlock methods ("Other ways to unlock"); page descriptions (empty states only) | Summary first (principle 5). |
| **Removed** | Activity\|Spending and Memory\|Skills cross route tabs; the "How access works / Manage for one agent" header row (replaced by "Used by …" on objects); the decorative "Personal workspace" box; the hamburger drawer on phones; the duplicate phone title; Vault's no-op Language and Time zone details; Rules › Budgets tab; the Settings overview index (General replaces it); the 8-card access map | Duplicates, decoration or dead ends (W-21, W-22, W-23). |
| **Renamed** | Connectors → **Services** (route stays `/connectors`); Rules & budgets → **Rules**; Help + Contact us → **Help & support**; Activity's first view Timeline → **Conversations** | "Connector" already means Warthog itself in agent set-up; the page already says "services". |

### 2.4 Decisions for the founder

1. **Bring back the phone bottom bar.** This partly reverses the 11 November [admin-console ADR](../../adr/admin-console-design.md), which replaced the brief's bottom navigation with a drawer at your request. The evidence for reversing:
   - Inbox is 2 top-of-screen taps away with no count.
   - The drawer and sidebar overflow and hide Help.
   - Three reviewers independently flagged it as high.

   The admin-console *visual language* is untouched. **Recommendation:** adopt the bar. Record it as an ADR that amends the admin-console ADR's navigation clause only.
2. **Rename Connectors to Services** in the navigation. The route stays.
3. **Default approval expiry** (W-46). It is 15 minutes today, so phone members away from the phone miss requests. Consider 60 minutes, or longer for card and detail requests.
4. **Short agent names** (W-36). Allow a short display name (default: the text before " — "), with the full name kept on the agent's page.
5. **Validate the IA before building.** Run a 10-minute first-click or tree test with 5–8 friends of the founder, using 8 tasks from [findings §4.2](findings.md#42-information-architecture) (the PNG wireframes suffice). It costs an afternoon and de-risks phases 1–2.

### 2.5 Proposed `brief.yaml` amendment (for ratification)

`design_ux.feel`, replace the sentence from "Everything reachable in two taps…" to the end of the paragraph with:

> Everything reachable in two taps from the mobile bottom navigation (Home, Inbox with the number of requests waiting, Activity, Agents, More), where More holds, in plain-language groups: What agents can use (Services, Vault, Life admin, Memory, Skills), Spending & rules (Spending, Rules), then Household, Settings (General, Security, Notifications & approvals, Data & privacy) and Help & support. Desktop uses a left sidebar with the same order and groups, and a pinned footer for Household, Settings, Help & support and signing out. Each page has at most one row of tabs; an agent's page has Overview, Access, Limits and Activity, and the Disconnect switch is on the agent's own page.

`users.accessibility` gains one clause: "…and errors name the field and keep what the person typed."

---

## 3. Page redesigns

Each page has a box with a **Today** row and an **Issues** row, then the proposed structure, hierarchy, layout, components and actions, and why it is better. Component names refer to [§6.5](#65-components).

### 3.1 Home

| | |
|---|---|
| **Today** | Greeting card → 5-row set-up checklist → Inbox count line + Recent activity (raw entries) → Your agents → Reminders. 3.8 phone screens; 0 primary actions. |
| **Issues** | W-05, W-30, W-17 |

- **Structure and hierarchy.**
  1. A flat page header: "Good evening, Alexandra", with one line of status ("4 requests need you · 3 things due in 2 weeks").
  2. **Needs you:** up to 3 compact request rows (agent mark, sentence with the object in bold, time left) with Deny and Review, then "See all 4". It disappears when empty.
  3. **What your agents did today:** one row per conversation ("Claude · Sorting out the car registration · 9 actions · 1 waiting").
  4. **Coming up:** the next 3 dated Life admin items, plus "25 records to check".
  5. **Agents:** name, last active, spend of budget, status.
  6. **Finish setting up:** collapsed to one row naming the next step and why, with "Hide for now".
- **Layout.**
  - Phone: a single column in that order.
  - Desktop (≥1200px): two columns. Left: Needs you, then today. Right: Coming up, Agents, Set-up.
- **Components:** `PageHeader`, `WorkspacePanel` with divider rows, `AgentMark`, `StatusBadge` (pill only for "waiting"), `Button sm`.
- **Actions.**
  - Primary: Review (opens the request).
  - Secondary: Deny inline (one tap, Undo for 10 seconds).
  - Card and detail releases always open Review.
- **Why it's better:** the phone job is visible on the first screen at 320px; set-up stops outranking decisions; activity reads as stories.
- **Wireframe:** [wireframes/home-desktop.png](wireframes/home-desktop.png).

### 3.2 Inbox and request review

| | |
|---|---|
| **Today** | A header card, tabs, then per-agent groups of 460–560px cards that repeat the agent name 3× and the sentence's facts, with two rows of buttons; a disabled primary when no card exists. Released requests stay live. |
| **Issues** | W-01, W-02, W-06, W-07, W-14 |

- **Inbox list.**
  - No per-agent group headings until there are more than 6 requests.
  - Each request is one compact block:
    - line 1: agent mark + sentence with the object in bold ("Pay **$240.00** to Mazda Parramatta", "See your **passport**", "Add the task **Book the car service**");
    - line 2: short agent name · the agent's words, clamped to 2 lines · time left;
    - one button row: Deny · *the action that unblocks* ("Review and pay", "Add licence", "Approve").
  - Each sentence is an `h3`.
- **Request review** (`/inbox?approval=<id>`, also the push target):
  - The amount as a large figure, then the payee.
  - "Claude says …" in an inset.
  - Description rows: card budget left, expires, conversation link.
  - "What happens when you approve": 1. Confirm it's you · 2. Choose a card · 3. Released for this payment only.
  - A sticky bottom bar: Deny · **Approve $240.00**.
  - The step-up runs *first*, inside the same tap. Unlock methods default to the passkey, with "Other ways to unlock" disclosed.
  - Missing prerequisites are collected inline, or via detours that carry `returnTo`.
- **After a decision:** the request leaves the list with a named notice ("Approved: Claude adds the task “Book the car service”"). Focus moves to the next request. A release ends with a success block, and the row moves to History.
- **Components:** `AgentMark`, `DescriptionList`, `Inset`, `Button`, `ConfirmItsYou` (moved earlier), `focus-target`, `Field` errors on the security code.
- **Why it's better:**
  - A request fits in about 180px on a phone, so 3–4 are visible at once.
  - The object is always present.
  - The release is one predictable sequence with no repeats.
- **Wireframe:** [wireframes/inbox-phone.png](wireframes/inbox-phone.png).

### 3.3 Activity

| | |
|---|---|
| **Today** | A header card with "Check integrity", 4 views, 6 quick filters, a Filters disclosure (4 selects, 2 dates), search; 59 full-size rows per day, each with "View details"; 13 phone screens. |
| **Issues** | W-13, W-29, W-30, W-50 |

```
Activity                                                    [⋯ Check integrity · Export]
[ Conversations | By agent | By service ]
Agent: (All) (Claude) (Gemini) (ChatGPT)     When: (Today) (7 days) (All)     [Search]
┌───────────────────────────────────────────────────────────────────────────────────┐
│ Today                                                                             │
│ (C) Sorting out the car registration and insurance      9 actions · 1 waiting  ›  │
│     Filed 4 records · asked to use a card ($240) · compared 3 insurance quotes    │
│ (G) Planning the Queenstown trip                       12 actions · booked  ›     │
│ (G) Weekly household admin                             14 actions · Done   ›      │
│ ── expanded ──                                                                    │
│   11:41 pm  Added task “Find a dog sitter for Biscuit”        Changes · Undo ⓘ    │
│   11:41 pm  6 × Added task                                     ›                  │
│   11:40 pm  Saved record “Netflix · $18.99 a month”            Changes            │
│   (4 reads hidden · Show)                                                         │
└───────────────────────────────────────────────────────────────────────────────────┘
```

- **Structure.**
  - Conversations (runs) are the default view.
  - Each step's headline comes from its main parameter, with the agent's reason as a muted second line.
  - Repeats collapse.
  - Reads and the duplicate "Add a note" call are hidden by default.
  - The row is itself the disclosure, with evidence inside.
  - "Undo available until …" shows on the row.
  - Dispute explains who sees it and what happens next, and open disputes are listed.
- **Layout:** a reading measure of about 900px on desktop. On phones, the chips are one row each and the search sits behind an icon.
- **Components:** `SegmentedControl` (views), `FilterLinks` chips (Agent, When) that keep focus, `Disclosure variant="row"`, `StatusBadge inline`, `Pagination`.
- **Why it's better:** answers "what did Claude do today?" in 1 tap instead of 7. A phone page drops from 13 screens to about 3 for a typical day.

### 3.4 Agents (list) and the agent page

| | |
|---|---|
| **Today** | List: 9 equal pills for 3 agents, red Disconnects. Agent: 2 tab rows, 7 separately saved sub-pages, an 8-card map that repeats the tabs, a 3,200px Settings checklist, no Disconnect, edits lost on tab switch. |
| **Issues** | W-03, W-08, W-18, W-28, W-36 |

- **List.**
  - Rows: agent mark, name (2-line clamp), status, last active, spend of budget, waiting count.
  - The row title links to the agent.
  - "View activity" is a ghost button; Disconnect is `ghost-danger` behind ConfirmDialog.
  - "Connect an agent" is a header button. The connect guide becomes a page reached from it.
  - The "Defaults for new agents" tab moves here from Settings.
- **Agent header:** mark, name, status, "since …", "active …", and **Disconnect**.
- **Overview.**
  - "What Claude can do through Warthog": a plain-language list of chips.
  - Waiting requests from this agent.
  - Tasks it's working on.
  - Recent conversations.
  - A "Connection" panel (name, platform, access key replace/revoke, what Disconnect does).
- **Access.**
  - One form with a sticky section index: Services · Your details · Life admin and tasks · Memory · Skills · Advanced.
  - Each section summarises itself ("0 services · Connect a service").
  - Services use a per-account `SegmentedControl` for Read (Off/Allow) and Changes (Off/Ask me/Allow).
  - Binary settings are `Switch` rows.
  - Per-record checkboxes appear only for "Only the ones I choose".
  - One sticky Save bar appears when dirty, with a navigation guard.
- **Limits.** Card access (Switch) with a monthly limit pre-filled at the default, the currency from Settings, spent-of-budget; rules that apply to this agent (with "New rule for Claude"); request rate limit.
- **Activity:** the Activity page filtered to this agent, as conversations.
- **Why it's better:**
  - The whole of an agent's access is reviewed and saved in one place.
  - Navigation drops from 3 levels to 1.
  - Stopping an agent is where people look for it.
- **Wireframe:** [wireframes/agent-access-desktop.png](wireframes/agent-access-desktop.png).

### 3.5 Services (today "Connectors")

| | |
|---|---|
| **Today** | Your services / Catalogue (103 tiles, 18-chip wall, search reloads); connecting gives no agent access. |
| **Issues** | W-11, W-27, W-23 |

- **Your services.** Each account row shows: service mark, account, status, "Used by Claude, Gemini" with "Change", "On for new agents" (a `Switch`) and Disconnect (one tap + Undo).
  - "Change" opens **Which agents can use Gmail?**, a checklist of agents with one Save. The same panel appears right after connecting.
- **Catalogue.**
  - Search first, filtering the loaded list client-side.
  - "Popular you can connect now".
  - Categories as a `Select` on phones and a single chip row on desktop.
  - Early-access services are grouped and labelled.
  - The tile grid uses a container query.
- **Why it's better:** connecting a service ends with agents actually able to use it. The catalogue is a search, not a wall.

### 3.6 Vault

| | |
|---|---|
| **Today** | About you reads as an open form. Protected details and cards are separate; Language and Time zone details do nothing. |
| **Issues** | W-26, W-37, W-10 |

- **About you.**
  - Read-only `DescriptionList` rows grouped as Names, Contact, Addresses (with the moving date) and Other, each with Edit.
  - **Protected details:** masked rows with a lock, "Ask before sharing", "Last shared with Gemini, 2 days ago", and "Expiry tracked in Life admin ›" where a record exists.
  - Recovery phrase sits under a "Vault security" disclosure.
- **Cards:** card rows (brand, last 4, expiry), plus "Agents that can ask to use a card: Claude ($300/month), Gemini ($300/month) · Change".
- **Why it's better:** it looks like a place where valuables are kept. It answers who used what. Sensitive moments slow down with one plain sentence (brief design_ux.feel).

### 3.7 Life admin

| | |
|---|---|
| **Today** | Two nested tab rows (being fixed by PR #52), then a queue of 25 fully expanded agent finds with 26 primaries, then filters, the monthly cost, per-category panels and "Fill in the rest". 20 phone screens. |
| **Issues** | W-12, W-31, W-26, W-45 |

- **Records** (after PR #52's tabs: Records · Upcoming · History · Tasks).
  1. **To check:** one compact panel, "25 records found by your agents · Check", with "Confirm all" as the panel's primary and per-agent "Confirm all from ChatGPT".
     - "Check" opens a one-at-a-time review (`?review=1`): Confirm / Not mine (ConfirmDialog when files exist) / Skip, and "n of 25".
  2. Filter chips (category with counts) and the monthly cost line.
  3. **Due soon:** 3–5 rows with countdown badges.
  4. Groups by anchor (Car · Mazda CX-5; Queenstown trip) as compact rows.
  5. "Fill in the rest" and Add at the end, plus a header "+ Add".
- **Items:** unchanged structure. A unique page title per item.
- **Why it's better:** about 4 phone screens for the typical account instead of 20; the person's records come first; checking is fast and keeps your place.
- **Wireframe:** [wireframes/life-admin-more-phone.png](wireframes/life-admin-more-phone.png).
- **Coordinate with PR #52:** build on its tabs; don't touch them.

### 3.8 Memory and Skills

| | |
|---|---|
| **Today** | Memory and Skills are route tabs of each other. Skills also has Library / Import & create / Preferences, with Preferences holding the account time zone. Memory stacks four cards before its first memory. |
| **Issues** | W-22, W-10, W-47, W-17 |

- **Memory.**
  - The header has "+ Add a memory", which opens a panel.
  - One panel holds the search, the "Saved by" and "Shared" chips and the date-grouped rows.
  - Each row shows source and sharing; Edit and Delete are ghost buttons (ConfirmDialog for delete).
- **Skills.**
  - Library (URL-backed search and filters), with a "New skill" button (create or import).
  - "How agents write for you" (tone, length, briefing; each saved on its own).

### 3.9 Spending and Rules

| | |
|---|---|
| **Today** | Spending: a currency form in the heading, per-agent sentences, a "Card budgets" link to Rules › Budgets (a list of links) → agent page; no total. Rules: Your rules (+ approval expiry) / New rule (tab) / Budgets; Pause is one-way. |
| **Issues** | W-09, W-16, W-32 |

```
Spending                                                       Amounts in AUD · Change
┌ This month ─────────────────────────────────────────────────────────────────────┐
│  $520.12 approved            3 card releases            $780 of budget left     │
└─────────────────────────────────────────────────────────────────────────────────┘
┌ Agents ─────────────────────────────────────────────────────────────────────────┐
│ (C) Claude      $120.00 of $300 ▓▓▓▓░░░░░░  Mazda Parramatta, Service NSW   Change │
│ (G) Gemini      NZD 412.50 (≈$380) of $300 ▓▓▓▓▓▓▓▓▓▓ over  Avis           Change │
│ (G) ChatGPT     No card access                                       Turn on      │
└─────────────────────────────────────────────────────────────────────────────────┘
┌ Household · Nguyen ──────────────────────────────────────────────────────────────┐
│ $1,200 budget · you $520 · Sam $0                                         Manage  │
└─────────────────────────────────────────────────────────────────────────────────┘
```

- **Spending:** totals use the figure style; "Change" deep-links to Agent › Limits; Household links to Household.
- **Rules.**
  - Grouped by "All agents" and per agent.
  - Each rule reads as a sentence.
  - Pause/Resume is a toggle with Undo; Edit opens the builder pre-filled; Delete uses ConfirmDialog.
  - "New rule" is a header button that opens the builder in a panel.
  - Approval expiry moves to Settings.

### 3.10 Household

| | |
|---|---|
| **Today** | 9 stacked panels; budget shown and edited in different places; invites can't be resent or cancelled; saving one form wipes another. |
| **Issues** | W-25, W-03 |

- **Order:**
  1. Members, with roles, limits and pending invites (Resend / Cancel), and an Invite button.
  2. Shared address.
  3. Budget and limits: one panel showing the current values with Change.
  4. A disclosure: "Ownership and leaving" (transfer, close or leave, via ConfirmDialog).
- One form per region, with the dirty guard.

### 3.11 Settings, and Help & support

- **Settings tabs:** General · Security · Notifications & approvals · Data & privacy.
  - **General:** time zone (a select with browser detection), language, units, account currency.
  - **Security:** passkeys, authenticator, sessions, sign-in requests (as a section, also reachable from push).
  - **Notifications & approvals:** push, install, text fallback, reminder delay, approval expiry.
  - **Data & privacy:** export, import, delete. The step-up is asked only when an action is chosen.
- **Help & support** (in the shell): searchable help topics (the same content as public `/help`), "Contact us" (the form) and "Your messages". The top-bar "?" goes here.

---

## 4. Wireframes

Static HTML mockups. They use Warthog's real colour tokens and font plus the type scale in §6.2. They're in [`wireframes/`](wireframes/) and are rendered with `wireframes/render.mjs`. Pink dashed boxes annotate the changes. They show *structure and hierarchy*, not final visual design.

| Wireframe | Shows |
|---|---|
| [Home, desktop](wireframes/home-desktop.png) ([html](wireframes/home-desktop.html)) | New sidebar groups, pinned footer and Inbox badge; Needs you with inline decisions; conversations; Coming up; compact set-up |
| [Inbox and request review, phone](wireframes/inbox-phone.png) ([html](wireframes/inbox-phone.html)) | Bottom bar with count; one-block requests; a missing-data request with one clear next step; the review screen with the amount first, steps and a sticky decision bar |
| [Agent › Access, desktop](wireframes/agent-access-desktop.png) ([html](wireframes/agent-access-desktop.html)) | One tab row; Disconnect in the header; plain-language summary; section index; Read and Change segmented controls per account; switches; one save bar |
| [Life admin and More, phone](wireframes/life-admin-more-phone.png) ([html](wireframes/life-admin-more-phone.html)) | The To check queue as one entry point; chips; Due soon; anchored groups; the More page grouped in plain words |

ASCII wireframes for Activity and Spending are in §3.3 and §3.9.

---

## 5. Shared interaction patterns

Fix these once, in shared code. Most W-issues then disappear from every page at the same time.

| Pattern | Rule | Implementation | Fixes |
|---|---|---|---|
| **Row actions** (approve, deny, confirm, delete, pause) | The notice names the item. Focus moves to the next row (or the list heading). Scroll position is kept. Undo is offered when the action is reversible. | `ui/focus-target.ts`: the redirect carries `?focus=<id>`, which generalises the existing `focusApprovalElement()`. Notice copy takes the item label. | W-14 |
| **Saving** | Save is disabled until something changes. "Unsaved changes" appears in a sticky ActionBar. Leaving asks first. One form per region. | `ui/use-dirty-form.ts`, plus a guard on tab and sidebar links and `beforeunload` | W-03 |
| **Errors** | Server actions return field errors, rendered by `Field` (`aria-invalid` and `aria-describedby`). Submitted values are kept. A summary at the top links to the fields. Submit buttons stay enabled. | `ActionForm` gains an `errors` channel | W-15 |
| **Confirmation by risk** | <ul><li>Irreversible loss of data or access: `ConfirmDialog` that names the consequence, with the safe choice first.</li><li>Reversible actions: one tap plus Undo.</li><li>Service Disconnect: one tap plus Undo (brief).</li><li>Pending labels show only after confirming.</li></ul> | `ui/dialog.tsx` | W-16 |
| **Announcements** | Live regions are mounted empty, then filled. | `Notice` and `PageNotice` reuse the Toast pattern | W-14 |
| **Tabs vs filters vs actions** | <ul><li>Route tabs are links.</li><li>In-page views use ViewPanels.</li><li>Filters are chips that keep focus.</li><li>Actions are buttons.</li><li>Never more than one tab row.</li></ul> | Consolidated `Tabs` with a `count`; `SegmentedControl` | W-39 |
| **Detours** | Any link that leaves a task to fix a prerequisite carries `returnTo`. The destination shows "Back to …" after success. | A `returnTo` param, validated against same-origin paths | W-07 |
| **Step-up** | Asked once, next to the action, before any other prompt. Only factors the person has are offered. | `ConfirmItsYou` is called before the unlock | W-07, W-41 |
| **Live data** | Countdown text updates on the client. The Inbox and the nav badge refresh after a decision and on focus. | `router.refresh()`; a client time-left component | W-02 |

---

## 6. Design system

Refine the existing system: same tokens, same primitives, same class hooks. The reference CSS is in [`proposed-tokens.css`](proposed-tokens.css). The full component APIs and migration plan are in `tools/findings/design-system.json` → `proposal`.

### 6.1 Visual principles

1. **Say the page title once.** A flat header region carries the h1; chrome never repeats it.
2. **Chrome is flat, content is raised.** Top bar, page header and the single tab row form one band; only content groups are panels.
3. **One container per job.** A list's tabs, filters, search and rows live in one panel.
4. **Rows, not cards.** Inside a panel, items and options are divider rows; insets are fills, never bordered boxes.
5. **Proximity before boxes.** 8px within a group, 16px between related blocks, 24px between panels.
6. **Hierarchy by size, then weight, then colour.**
7. **Colour is the exception.**
   - Neutral by default.
   - Indigo tint only for "where am I / what's selected".
   - Semantic colour only for states needing attention.
   - Success is quiet.
8. **Links look like links only in prose.**
9. **One loud thing per screen.**
10. **Numbers are first-class.** Use tabular figures and a figure style for money, counts and time left.
11. **Clamp names; don't wrap them into paragraphs.** The full name goes in the accessible name.
12. **Same frame, same edge.** The left edge never moves between sections.
13. **Design dark; don't invert it.**

### 6.2 Typography

Inter (local, unchanged). Named roles replace 18 ad-hoc pixel sizes.

| Role | Token | Size / line-height | Weight | Use |
|---|---|---|---|---|
| Page title | `--wh-text-title-page` | 28/34 (24/30 under 640px), −0.02em | 600 | One h1 per page |
| Figure (large) | `--wh-text-figure-lg` | 32/38, tabular | 600 | The amount on a request review |
| Section | `--wh-text-title-section` | 18/28 | 600 | Section and dialog titles |
| Figure | `--wh-text-figure` | 20/28, tabular | 600 | Totals, counts |
| Group | `--wh-text-title-group` | 16/24 | 600 | Panel titles |
| Item | `--wh-text-title-item` | 16/24 | 500 | Row titles (request, record, conversation) |
| Body | `--wh-text-body` | 14/20 | 400 (500 for labels, buttons, tabs) | UI text |
| Body long | `--wh-text-body-long` | 14/22 | 400 | Descriptions and notices, max 60–72ch |
| Meta | `--wh-text-caption` | **13/18** | 400, muted | Time, source, helper text (13, not 12, for phone-first and low-vision readers) |
| Label | `--wh-text-label-sm` | 12/16 | 500 | Badges, counts, group labels |
| Input | — | 16 (14 only on fine-pointer desktop) | 400 | Fields |

### 6.3 Colour

- **Keep the existing palette.** Consolidate it into one `light-dark()` ramp in `tokens.css`: canvas `#f5f6f7/#191a1c`, sidebar, surface `#fff/#252628`, surface-muted, raised, line, edge, line-strong, line-input, fg and fg-muted.
- **Primary action:** neutral black/white (`--wh-accent`), unchanged.
- **Indigo `--wh-tint`** is used only for:
  - the active nav item (restore the 3px bar, W-19);
  - the selected tab underline;
  - selected chips and checkboxes.

  Not for panel icon tiles or text.
- **Semantic tones:** success, warning and danger are unchanged. Info moves away from the focus blue (cyan `#0e7490 / #5ccfe6`). Soft fills move to `:root` so dialogs and toasts share them.
- **Dark mode** builds depth from surface lightness (canvas < sidebar < surface < raised < inset), with no decorative gradient. Brand tiles are toned in dark.

### 6.4 Spacing, layout, surfaces

- **Spacing:** a 4px base. Tokens run `--wh-space-1…12` (4, 8, 12, 16, 20, 24, 32, 40, 48), with role tokens:

  | Role token | Value |
  |---|---|
  | `--wh-pad-panel` | 16, rising to 20 from 640px |
  | `--wh-row-pad-block` | 12 |
  | `--wh-gap-section` | 16, rising to 24 from 640px |
  | `--wh-gutter` | 16, rising to 32 from 640px |

- **Layout and grid:**
  - **Phone:** one column with 16px gutters, a bottom bar of 56px plus the safe area, and a sticky top bar of 52px.
  - **Tablet (640–1023px):** one column with 32px gutters. Lists with details may use a 2-pane layout from 900px.
  - **Desktop (≥1024px):** a 248px sidebar and one content frame with a fixed left edge. Two measures:
    - "reading" at about 880px for lists, forms and Inbox;
    - "wide" at about 1120px for Home, Spending and the agent Overview, with a 12-column grid that becomes 2 columns (1.6fr / 1fr) from 1200px.
- **Surfaces (four levels):**

  | Level | Treatment |
  |---|---|
  | Chrome band | Flat `--wh-surface` with a bottom divider |
  | Panel | `--wh-surface`, 1px `--wh-edge`, radius 12, `--wh-shadow-1` (one quiet layer) |
  | Divider rows | Inside panels, 1px `--wh-line` |
  | Inset | `--wh-surface-muted`, radius 8, no border |

- **Radii:** xs 6 · field 8 · inset 8 · panel 12 · pill. This reconciles the design-system and visual reviews: one radius per level, and 12 matches the measured reference.
- **Elevation:** shadow-1 for panels, shadow-2 for toast and popover, shadow-3 for dialog and drawer. No Tailwind `shadow-lg`.

### 6.5 Components

**Existing components to keep, adjusting their styles:**
- **Button:** primary, secondary, ghost, danger, danger-solid, plus a new **ghost-danger**. Sizes sm (36 desktop / 44 touch), md, lg. Pill shape. A pressed state. Disabled buttons show their reason as helper text.
- **Badge** and **CountBadge** (Intl).
- **Field**, **Input**, **Select** and **Textarea**, which gain server error wiring.
- **EmptyState** variants: page, inline, row, and filtered (with "Clear filters").
- **Notice** and **PageNotice** (live-region fix), **Toast**, **ViewPanels**, **ListGroup**, **ListToolbar** (renders inside its panel), **WorkspacePanel** (icon tile optional and neutral), and **WorkspaceHeading → PageHeader** (flat region; leading mark, status and back slots).

**To add** (one per PR; they emit the existing `wh-*` hooks):

| Component | API sketch | Replaces |
|---|---|---|
| `Dialog` / `ConfirmDialog` | `<ConfirmDialog trigger title description confirmLabel cancelLabel tone action pendingLabel>`. The safe choice is autofocused and the real form is inside the dialog. | 7 hand-built dialogs; inline delete reveals |
| `Disclosure` | `variant: link \| button \| section \| row`, one chevron rule, 44px on touch | ~40 `<summary>` recipes |
| `Checkbox` / `Radio` / `Switch` / `ChoiceGroup` | Native inputs; 44px label rows; Switch only for settings that save immediately | The Toggle card, the default-for-agents switch, radio cards |
| `SegmentedControl` | Links when given `href`, otherwise radios | Activity views; per-service Read and Change |
| `DescriptionList` | `layout: columns \| stacked \| facts` | 13 ad-hoc `<dl>` |
| `DataList` (table) | Caption, columns (numeric alignment), rows, empty | Spending rows; future admin tables |
| `Pagination` | `newer` / `older` / `position` | 4 implementations |
| `StatusBadge` + `state.ts` | `state`, `variant: pill \| inline`; neutral text with a tone icon | 5 status renderers |
| `IconButton`, `Icon`, `IconTile`, `AgentMark` | One sizing API (12 / 16 / 18), one stroke rule | Mixed `h-4` vs `size`, strokes 1.5, 1.7 and 2 |
| `Skeleton` patterns | `Band`, `Panel rows`, `Rows` | One generic loading screen |
| Hooks | `use-dirty-form`, `focus-target`, `returnTo` | See §5 |

**Navigation patterns.**
- **Bottom bar:** 5 items, each an icon over a label, with a count badge on Inbox.
- **Sidebar:** groups with plain labels, the active item marked by the tint bar and tinted icon, and a pinned footer.
- **Breadcrumb:** Section › Item, both linked. Desktop only.
- **One tab row maximum.**
- **Back arrow** in the phone top bar on sub-pages.

**Lists and tables.**
- Default to divider rows inside a panel.
- Use `DataList` only when columns are compared (Spending, admin).
- Rows: title (item style), meta line, at most one trailing quiet action or chevron, and a whole-row hover.

**Forms.**
- Label above, helper below, error below in danger with an icon.
- Group related fields in a section with a heading.
- One Save per form region, sticky when the form is long.

**Empty states.** Say what will appear and why it's empty, and give one next action. For example: "No requests waiting. When an agent asks to do something you've set to Ask me first, it appears here." Filtered-empty states offer "Clear filters".

**Loading states.**
- A route-shaped skeleton: band, panel and rows.
- Pending labels on buttons, which already exist.
- No spinners over 1s without text.
- The reduced-motion fix (W-44).

### 6.6 CSS architecture and guardrails

- **`tokens.css`** is the only file that declares `--wh-*`.
- **Cascade layers:** `theme, base, wh-base, components, wh-shell, wh-primitives, wh-features, utilities, wh-a11y`. Utilities now win deliberately; accessibility overrides always win.
- **File ownership:**

  | File | Owns |
  |---|---|
  | `globals.css` | Layer order, Tailwind and the bridge |
  | `shell.css` | Sidebar, top bar, bottom bar, breadcrumb |
  | `primitives.css` | One block per primitive |
  | `features.css` | Feature-specific styles |
  | `public.css` | Public pages |

  A selector is declared in exactly one file and one layer.
- **`design-lint.test.ts`** fails on:
  - duplicate selectors;
  - `--wh-*` declarations outside `tokens.css`;
  - raw hex, `shadow-lg`, `rounded-[…]` or `dark:` in components;
  - `<dialog>`, `<summary>` or `<dl>` outside primitives (with an allowlist that may only shrink).
- **Rewrite `.agents/skills/warthog-design-system/SKILL.md`** as a role → token → utility → primitive table, and fix the 15 contradictions (W-43). A docs test checks that cited names exist.

---

## 7. Implementation roadmap

The phases follow the requested priority: information architecture → navigation and usability → structural pages → design system → polish → accessibility and responsiveness → QA. Two exceptions:
- **Phase 0** fixes the three critical defects first, because they are cheap and independent.
- **Foundations (phase 3A)** can run in parallel with phases 1–2, because it changes CSS only.

**Effort:** S is under half a day, M is 1–3 days, L is more than 3 days. Totals are rough, for one engineer with an agent.

### Phase 0 · Safety fixes (about 3–4 days; no design decisions needed)

| Task | Issue | Effort | Notes |
|---|---|---|---|
| Native-tool detail lines and headline in Inbox cards, History and notices, plus a test with 3 same-tool requests | W-01 | M | `inbox/actions.ts` `detailLines` |
| A released request becomes terminal; `onReleased` and `router.refresh()`; client countdown; expired state | W-02 | S | `inbox-view.tsx`, `release-approve.tsx` |
| `use-dirty-form`, navigation guard and sticky save bar on agent sections and Household | W-03 | M | Ships before the agent-page rebuild and is reused by it |
| Restore the sidebar tint bar (delete `workspace.css:84`); manifest `theme_color` | W-19 | S | CSS only |
| Reminder-days keypad; reduced-motion loop | W-45, W-44 | S | |

### Phase 1 · Information architecture and navigation (about 1.5–2 weeks)

**Depends on:** founder ratification of §2.4 and §2.5; ideally the 5-person tree test.

| Task | Issue | Effort |
|---|---|---|
| ADR "navigation for a phone-first product" (amends the admin-console ADR's nav clause) and the brief amendment | — | S |
| Bottom bar under 1024px with Inbox count; count in the sidebar; pending count loaded in `(protected)/layout.tsx` | W-04 | M |
| Sidebar regroup and relabel, pinned footer, remove the workspace box, breadcrumb Section › Item | W-21 | S |
| `/more` rebuilt as the phone More page (reuse `MoreMenu`) | W-04 | S |
| Remove the cross route tabs; actions-as-tabs become buttons | W-22, W-39 | S |
| Settings › General (time zone, language, units, currency) and › Notifications & approvals (expiry); migrate Vault's no-op details; Skills › "How agents write for you" | W-10 | M |
| Agents › "Defaults for new agents" tab | W-10 | S |
| Help & support in the shell (help content, contact, messages); "?" points there | W-24 | M |
| Replace the scope disclosure rows with "Used by …" on objects | W-23 | S |
| Rename Connectors → Services in labels and copy (routes unchanged) | — | S |

**Test impact:** navigation tests (`nav.test.ts`, `workspace-navigation` tests, `app-shell` tests) and copy assertions on the renamed labels. Keep the `wh-sidebar-link` and `wh-tab` hooks.

### Phase 2 · Core journeys: structural page redesigns (about 3–4 weeks)

| Order | Page | Issues | Effort | Depends on |
|---|---|---|---|---|
| 1 | **Inbox and request review**: row anatomy, review screen, release reorder, `returnTo` detours, inline billing address, named notices, focus-target | W-06, W-07, W-14 (Inbox) | L | `focus-target`, `DescriptionList` (build them just in time) |
| 2 | **Home**: Needs you, conversations, Coming up, compact set-up | W-05, W-30 | M | Activity run grouping (server) |
| 3 | **Agent page**: Overview / Access / Limits / Activity, Disconnect, one Save; redirect old `?section=` links | W-08, W-28 | L | `use-dirty-form` (phase 0), `Switch`, `SegmentedControl`, `ConfirmDialog` |
| 4 | **Spending as the money hub**; remove Rules › Budgets; card access in Limits; Vault › Cards agent list | W-09 | M | Agent › Limits |
| 5 | **Services**: "Which agents can use …" after connecting and on each row; checklist logic | W-11 | M | — |

**Test impact:** the largest. Inbox (`inbox-view`, `release-approve`), dashboard, agent workspace and permissions tests assert copy and structure. Rewrite them per page in the same PR, keeping ARIA and hooks where the markup survives.

### Phase 3 · Design system and component consistency (about 2–3 weeks, partly in parallel)

- **3A (parallel with phases 1–2; CSS only):**
  - `tokens.css`;
  - de-duplicate selectors;
  - cascade layers;
  - Tailwind bridge;
  - the `design-lint` test;
  - rewrite `form-contrast.test.tsx` to read `tokens.css`;
  - rewrite the contributor skill (W-19, W-43).
- **3B, one primitive per PR**, in this order:
  1. `StatusBadge` and the state registry (W-20);
  2. `ConfirmDialog` (W-16);
  3. `Inset` and `DescriptionList`;
  4. `Disclosure` (W-38);
  5. `Choice` (W-35);
  6. Tabs with counts and `SegmentedControl` (W-39);
  7. `Pagination`;
  8. `IconButton` and `Icon`;
  9. the Page and PageHeader codemod;
  10. `DataList`;
  11. Skeletons (W-40).

  Each primitive keeps the class hooks the tests assert, migrates one feature folder per commit, and deletes the old helper in the same PR.
- **3C:** field-level server errors via `ActionForm` (W-15), live-region fix (W-14), Rules Resume and Edit (W-16).

### Phase 4 · Remaining page redesigns (about 2–3 weeks)

| Page | Issues | Effort | Notes |
|---|---|---|---|
| Activity by conversation; headlines from parameters; chips; row disclosure; Undo and Dispute visible | W-13, W-29, W-50 | L | Server-side run grouping and the headline map in `evidence.ts` |
| Life admin To check queue and one-at-a-time review; Due soon; compact rows | W-12, W-31 | M | **After PR #52 merges**; coordinate with that session |
| Household regroup; invite resend and cancel | W-25 | M | |
| Vault read-only rows, protected masks, "last shared", cross-links to Life admin | W-37, W-26 | M | |
| Services catalogue search-first | W-27 | M | |
| Memory and Skills panels; URL-backed Skills state | W-47, W-17 | S | |

### Phase 5 · Visual polish (about 1–1.5 weeks)

- Flat page header region and the end of box soup (W-17).
- Link roles, button weights, `ghost-danger`, neutral panel icons (W-18).
- The type scale applied (W-33).
- Rows instead of card-in-card (W-35).
- Short names and clamps (W-36).
- One money formatter with tabular figures (W-32).
- Dark-mode pass: brand tiles, soft fills (W-48).
- Reading load: descriptions only in empty states (W-42).

### Phase 6 · Accessibility and responsive (about 1 week)

- Focus management everywhere (W-14).
- Phone dialog tab order (W-16).
- Filter chips keep focus (W-39).
- Long-name chips at 320px (W-36).
- Screen-reader names (W-52).
- Form attributes (W-53).
- Tablet layout from 900px and wide-desktop two columns (W-34).
- Landscape: a compact header under 500px tall.
- **Human screen-reader pass** (VoiceOver iOS and NVDA) on Inbox decisions, release and agent Access (WCAG 4.1.3).

### Phase 7 · QA and validation (about 3–4 days, then after each phase)

**1. Re-run the harness** on all three accounts, against these targets:

| Measure | Today | Target |
|---|---|---|
| Phone screens: Life admin (typical) | 20.0 | ≤ 5 |
| Phone screens: Activity (typical day) | 13.2 | ≤ 4 |
| Phone screens: Home | 3.8 | ≤ 2.5, with the first request above the fold at 320×568 |
| Inbox: px to the first decision button at 390 | 803 | ≤ 300 |
| Primary-styled buttons in the first viewport, any page | up to 26 | ≤ 1 |
| Max nav levels on a page | 3 | 1 tab row |
| Taps from Home to Inbox on a phone | 2 (top of screen) | 1 (bottom bar) |
| "What did Claude change today?" | 7 interactions, 2 loads | ≤ 2 taps |
| axe violations | 0 | 0 |
| WCAG 3.3.1 | Fail | Pass |

**2. Run the tools before every PR:**
- the keyboard trace on the changed pages;
- `/web-design-guidelines` on the changed files;
- `/impeccable critique <page>`, with the Warthog design-system skill loaded first.

**3. Usability check.** 5 members, the 8 tasks from §2.4 (5), first-click success at least 80%.

**4. Keep the brief, ADRs and the contributor skill in step**, and record each release as the audit README describes.

**Overall:** roughly 12–16 weeks of focused work for one engineer with an agent. Phase 0 and phase 1 deliver most of the felt improvement in about 2–3 weeks.

---

## 8. Risks and considerations

| Risk | Mitigation |
|---|---|
| **PR #52 is open** and restructures Life admin tabs (another session) | Phase 4's Life admin work starts only after #52 merges, building on its tabs. Phase 0–3 work avoids `src/components/life-admin/*` except shared primitives. Coordinate before touching it. |
| **Tests lock markup and copy** (about 1,688 regex assertions; 49–55 files assert `wh-*` classes; CSS-reading tests) | Keep class hooks and ARIA stable and change the CSS behind them. One primitive per PR, updating tests in the same commit. Phase 2 rewrites page tests deliberately. Run the full suite (about 4 min) per PR. |
| **Ratified documents** (the brief's design_ux nav spec, the admin-console ADR, the contained-text ADR) | §2.5 amendment text and a new nav ADR for the founder's ratification. The flat page header keeps text on `--wh-surface`, so the contained-text rule holds. |
| **Push notifications and deep links** (`/inbox?approval=<id>`, `/settings/security/sign-in-requests`, `/a/[token]`) | Keep these routes and their behaviour. The request review *is* the deep-link target. Add tests for them. |
| **Old agent links** (`?section=connectors\|vault\|skills\|memory\|spending\|rules\|settings`) in emails, notices and bookmarks | Map old sections to the new tabs and anchors (resources → Access#…, spending and rules → Limits, settings → Overview#connection). Keep validating section keys. |
| **Agent-first model and enforcement** | The IA changes are presentation only. Grants, rules, policy enforcement, MCP tools and member scoping are untouched. "Used by …" lines read the same grant data the agent pages use. |
| **Security flows** (step-up, device-side release, vault unlock, one-click service Disconnect) | The release *order* changes (step-up first), not the cryptography or the server checks. Agent Disconnect keeps its dialog. Service Disconnect stays one click plus Undo, as the brief requires. Get a security review of the release reorder. |
| **No new runtime dependencies** | All proposals use existing primitives, native elements and CSS. No shadcn, Radix or virtualisation library. |
| **Activity grouping cost** | Group by run server-side with the existing indexes. Cap the page at about 25 conversations. Measure on a large account first. |
| **Several sessions work in this repo at once** | Small PRs per phase item. Rebase often. Message active sessions before touching the shell and navigation (phase 1), which every page imports. |
| **The IA is a reasoned proposal, not research** | Run the tree test (§2.4) before building phases 1–2. |
| **The 12 Nov mechanical gains** (contained text, 44px targets, 16px inputs, 0 overflow) | Re-run the 12 Nov checks through the same harness after each phase. |
