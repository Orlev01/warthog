# Member-app UI/UX audit: findings

Part of the [member-app UI/UX audit, 23 November 2026](README.md). The redesign that answers these findings is in [redesign.md](redesign.md).

## Contents
1. [How the audit was run](#1-how-the-audit-was-run)
2. [Scorecard](#2-scorecard)
3. [What works and must be kept](#3-what-works-and-must-be-kept)
4. [Audit by lens](#4-audit-by-lens)
5. [Prioritised issue register](#5-prioritised-issue-register)
   - [Critical](#critical)
   - [High](#high)
   - [Medium](#medium)
   - [Low](#low)

---

## 1. How the audit was run

**Scope.** The signed-in member app, on `github/main` at `d3b7d94`. Sign-up, consent, the landing page, public help and the operator portal are out of scope, except where a member journey hands off to them.

**Data.** Three synthetic accounts were seeded on a local dev server (PGlite, virtual passkey). They were filled through Warthog's real `/mcp` tools and the real OAuth consent flow; no production data was touched. Scripts are in [`tools/seed/`](tools/seed/).

| Account | Contents |
|---|---|
| **typical** | 3 agents (Claude; ChatGPT; and Gemini, given a 46-character name), 25 life-admin records, 6 tasks, 10 memories, 2 rules, a card budget, a household with a pending invite, 4 live approvals and about 60 activity entries |
| **firstrun** | Signed up, nothing connected |
| **worst** | `break-ui` data: a 135-character agent name, a 52-character person name, 115 records, unbroken strings and mixed currencies |

**Evidence.**
- **Captures.** [`tools/capture.mjs`](tools/capture.mjs), extended from the 12 November harness, made 381 captures with 0 failures (plus 15 re-captures of Home and Inbox once fresh requests had been raised):
  - 65 member URLs × 5 configurations (390, 768 and 1440 in light; 390 and 1440 in dark);
  - the first-run and worst-case accounts at 390 and 1440.
- **What each capture records:**
  - layout checks (free text, overflow, clipping, targets, contrast);
  - new density metrics: words, controls, primary-styled buttons, surfaces, nesting depth, tabs and disclosures;
  - **axe-core 4.11.0** (WCAG 2.2 A/AA) at 390 and 1440 light and 1440 dark.
- **Keyboard trace.** A keyboard focus trace ran on 15 key pages.

Results are in [`tools/metrics-overview.md`](tools/metrics-overview.md) and `tools/capture-summary-*.json`.

**Reviewers.** Seven reviewer agents ran in parallel, each under a shared brief ([`tools/review-brief/`](tools/review-brief/)). They were read-only on the code. They made live Playwright checks, ran saving and destructive tests only in the worst account, and wrote structured findings ([`tools/findings/*.json`](tools/findings/)):

| Lens | Method | Findings |
|---|---|---|
| UX and usability (first-time and phone-first personas) | Impeccable critique rubric: Nielsen 0–4, cognitive load, emotional journey, persona walks | 24 |
| Information architecture (experienced user) | Task-based card sort of 29 tasks; navigation inventory; distill method | 21 |
| Visual design (senior product designer) | Impeccable rubric (visual), layout, typeset, quieter | 23 |
| Interaction design | Live interaction tests, keyboard traces, harden and clarify methods | 21 |
| Design system and frontend architecture | Code survey verified against screenshots; audit and extract methods | 21 |
| Responsive, plus a "dense interfaces are hard" persona | Live at 320, 390, 768, 844×390, 640×450 (200% zoom), 1024, 1440 and 1920 | 17 |
| Accessibility specialist | axe results, then the AccessLint WCAG-EM method and checkpoints, live | 17 |
| Code rules (Vercel Web Interface Guidelines) | `file:line` pass over the member-app components | 34 |

**Consolidation.** The 178 raw findings were merged into **55 issues**: 3 critical, 17 high, 27 medium and 8 low groups. Each issue lists its source IDs (for example `UX-01`, `IXD-03`) so it can be traced to the raw JSON. Every critical and high issue was re-checked against the code or a screenshot before it went into the register. Where a finding duplicated work already fixed on main, it was dropped.

---

## 2. Scorecard

| Measure | Result |
|---|---|
| **Nielsen heuristics** (UX lens, 0–4) | **23 / 40.** Visibility of status 3 · Real-world match 3 · User control 2 · Consistency 2 · Error prevention 2 · Recognition 2 · Efficiency 2 · Minimalism 2 · Error recovery 3 · Help 2 |
| **Visual quality** (visual lens, 0–4; 4 = best-in-class calm security product) | **2 overall.** Colour and contrast 3 · Dark-mode parity 2.5 · Typography 2 · Spacing 2 · Consistency 2 · Visual hierarchy 1.5 · Surfaces and depth 1.5 · Density 1.5 |
| **Automated accessibility** (axe-core, 251 captures) | **0 real violations.** The 2 hits came from one capture that met a transient dev-server 500. |
| **WCAG 2.2 AA manual sample** | **1 fail:** 3.3.1 Error Identification (W-15). **Partial:** 2.4.3, 3.3.3, 3.3.7, 1.4.10, 1.4.11. **Not determined:** 4.1.3, which needs a screen reader. **Pass:** everything else sampled, including 2.4.11 Focus Not Obscured (about 2,900 stops checked). |
| **Keyboard** | Visible focus on every stop of 15 pages; a skip link on every page; 20–26 stops to reach main content without it |
| **Page length on a phone** (390×844) | Life admin **20.0 screens** · Activity **13.2** · Connectors catalogue **11.9** · Memory 4.8 · Home 3.8 · Agent › Settings 3.8 |
| **Density, worst page** | Life admin at 390: 1,997 words, **697 controls**, **26 primary-styled buttons**, 27 disclosures |
| **Navigation weight** | 15 sidebar or drawer destinations in 5 groups; up to 3 tab rows on one page; 4 tab mechanisms |

**Bottom line.** The *components* are sound and accessible. The *product structure* is the problem:
- navigation follows the data model;
- the phone gets the desktop console in one column;
- the core job (decide on a request) is buried on Home and inflated in the Inbox;
- the moments after a person acts (release, save, confirm) are where things break.

---

## 3. What works and must be kept

The reviewers agreed on these; the redesign keeps every one of them.

- **Accessible foundations.** Full ARIA tab pattern (arrows, Home/End, URL-synced, drafts kept); native `<dialog>` with safe-choice autofocus and focus return; visible focus on every stop; skip links; reduced-motion and forced-colours support; 44px touch targets; 16px phone inputs; 0 axe violations.
- **Security moments are deliberate.** Step-up, device-side release, vault unlock, "nothing goes ahead until you approve it", the `Reported by` and `Claude says “…”` framing, the one-click service Disconnect the brief asks for, and agent Disconnect with a dialog that names consequences.
- **Copy.** Plain Australian English, no protocol jargon on primary screens, "one name for each thing", and clear pending labels ("Approving…").
- **The push deep link.** `/inbox?approval=<id>` centres the request with Approve on screen at every size tested. The best phone path in the app.
- **Robust forms.** Double-submit guards, pending states, and drafts kept across in-page tabs.
- **Primitives worth building on.** Button, Badge (all 117 measured instances render identically), Field, EmptyState, Notice, ViewPanels, ListGroup and WorkspacePanel.
- **Before-agent Home.** With no agent yet, Home has one clear primary action ([screens/phone-firstrun-home.jpg](screens/phone-firstrun-home.jpg)).
- **Nothing breaks.** No horizontal overflow from 320px to 1920px, long names wrap rather than clip, and the 12 November containment rule still holds.

---

## 4. Audit by lens

### 4.1 UX and usability

> *"The individual moments are strong; the journeys between them break on the core jobs."* (UX lens)

- **Decide on a request (phone).**
  - A push notification lands perfectly.
  - Without one, the member opens the hamburger and finds Inbox as item 3 of 15 with no count (W-04), or scrolls Home past a setup checklist to a single "4 requests are waiting" line (W-05).
  - After deciding, the page jumps to the top and the notice doesn't say which request was affected (W-14).
- **Card or passport release.**
  - The emotional peak of the product. It starts calmly ("Claude wants to use your card for $240.00 at Mazda Parramatta", Claude's own words, time left).
  - Then it falls into valleys:
    - a prerequisite chain with no way back: no card, then no postal address (W-07);
    - three vault-unlock methods in jargon;
    - a lapsed step-up that clears the security code and makes the person do it twice.
  - It ends with a small "Handed over" line beside still-live Approve buttons (W-02).
- **Held requests for Warthog's own tools** ("add a task", "save a record") arrive with **no object**. Three different tasks looked identical and were approved blind (W-01).
- **Set-up after the first agent stalls.**
  - Home's checklist shows four equal "To do" rows, no recommended step and no primary button.
  - The "Popular" services (Gmail, Calendar, Drive) are early-access only.
  - Connecting a service gives no agent access until the person visits each agent's page (W-11).
- **Control.** Edits on the agent page are lost silently on a tab switch, including turning card access off (W-03). Disconnect isn't on the agent's own page (W-08).

**Cognitive load** fails 4 of 8 checklist items on Home and on Inbox, and 5 on Life admin (fully expanded queue, 26 equal primaries).

**Step counts** for brief key flow 3 ("connect a service and let agents use it"): about 5 + 5 × (number of agents) taps.

### 4.2 Information architecture

> *"The IA follows the data model, not what members are trying to do."* (IA lens)

**Destinations.** There are 15 destinations in 5 groups named after concepts: Workspace, Account resources, Insights, Manage, Help.

The card sort of 29 tasks found 11 tasks split across two or more places. The worst are:

| Task | Where it is today |
|---|---|
| Cap an agent's monthly spend | Spending → Rules › Budgets (a list of links) → agent › Controls › Spending. Three hops. |
| Change the time zone | Skills › Preferences, which won't save until all six preference fields are filled. Vault's "Time zone" detail looks like the same setting and does nothing. |
| Change currency | Spending's heading **and** Household |
| Stop an agent using cards | Under agent › Controls › Spending. Vault › Cards' "Manage for one agent" link goes to a section without the setting. |
| Let only Claude use Gmail | A visit to every agent's page (W-11) |
| Find help | Leaves the app for a public page that offers "Sign in" (W-24) |

**Three levels of navigation on one page.** The agent page has two tab rows over seven separately saved sub-pages (W-08). Activity|Spending and Memory|Skills are route tabs *of each other* and sidebar items too (W-22).

**Overloaded pages.** Life admin, Activity and the Connectors catalogue show everything at once (W-12, W-13, W-27).

**The agent-first model is right but buried.** Every account page carries a "How access works / Manage for one agent" row (W-23), while the agent page mirrors every account page.

### 4.3 Visual design

> *"It reads as a competent admin console, not a calm, premium security product. The causes are mostly structural, not colour."* (visual lens)

**Page heading.** Every page opens with a raised **heading card** that repeats the title already in the top bar; on a phone the name appears three times (W-17). The card is 244–313px tall on phones.

**Box soup.** The heading, tabs, toolbar, list and form actions all share one raised style, stacked 24px apart. Toolbars and tabs therefore float away from the lists they control.

**Noise floor** (W-18):
- 152 `underline` uses, often paired with a chevron or arrow;
- indigo icon tiles on 70 of 107 panels;
- 26 black primaries on Life admin;
- red Disconnect and Delete on every row;
- status colour on every row (W-20).

**What matters most looks least important** (W-05, W-06):
- Money is 14px regular in a definition list.
- Pending approvals sit below a checklist.
- Spending has no figure style.

**Type ladder.** Four roles collapse to 16px; weight 500 is everywhere (W-33).

**Colour, contrast and dark mode** are the strongest scores. The neutral palette and single tint are the right foundation.

### 4.4 Interaction design

> *"The foundation is solid, but how controls behave varies from page to page, and the approval and editing paths have real gaps."* (interaction lens)

**Patterns that behave differently per page:**
- **Five destructive-confirmation patterns**, not matched to risk (W-16):
  - "Not mine" permanently deletes attached files in one tap.
  - Pausing a protective rule is one tap with **no Resume**.
  - A low-risk delete gets a dialog.
- **About 40 disclosures in at least 7 styles**, many styled as buttons (W-38).
- **Four tab mechanisms** that look alike but differ in keyboard model, draft retention and URL behaviour (W-39).

**After a person acts** (W-14, W-15):
- Every row action reloads the page to the top and drops focus.
- Errors arrive as generic page banners.
- Saves report "Saved" even when nothing changed.

**Release form (W-07):**
- It isn't a `<form>`, so Enter does nothing.
- The security code isn't validated before a one-shot release.
- Identity is checked *after* the vault unlock, so the passkey can be asked for three times.

**Activity:** answering "what did Claude change today?" takes 7 interactions and 2 page loads across three overlapping filter systems (W-13).

### 4.5 Design system

> *"A real design system in its primitives, but not in its foundations."* (design-system lens)

**Tokens and CSS** (W-19):
- Tokens are declared in five stylesheets with two theming mechanisms and two grey ramps. `--wh-surface` is declared three times with different values.
- About 20 selectors are redefined across files.
  - One clash ships a bug: **the active sidebar accent bar never renders** (`workspace.css:84` overrides `:26`).
- Unlayered `.wh-*` CSS silently beats Tailwind utilities written in components.
- The explicit theme (`data-theme`) is dead code.

**Inconsistent patterns:**
- State is shown five ways; the same "Done" appears as green text, a tinted pill and neutral text (W-20).
- Recurring patterns have no primitive (W-40): Dialog (7 copies of a 300-character class string), Disclosure, Switch/Checkbox, DescriptionList (13 ad-hoc `<dl>` in 9 layouts) and Pagination (built 4 ways).

**Guidance drift.** The contributor design skills contradict the code and each other in 15 places (W-43). For example, "do not restore an indigo palette" sits beside the indigo tint ADR.

### 4.6 Responsive design and the dense-interface persona

> *"The app never breaks, but it scales up and down instead of adapting."* (responsive lens)

**Phones get the desktop admin console in one column:**
- **Navigation:** a top-left hamburger, with Inbox two taps away and no count (W-04).
- **Heading band:** 37–81% of the first screen on short viewports (W-17).
- **Inbox cards:** 460–560px tall each (W-06).

**Tablets and wide desktops:**
- At 768px, tablets get the phone layout stretched.
- At 1440 and 1920px, long single-column pages sit beside empty canvas, and Activity rows stretch to 1,150px (W-34).

**The dense-interface persona** (older, low vision at 200% zoom, or easily overloaded):
- has to read 113 words before the first Approve on an Inbox card;
- meets 119 "View details" links on Activity;
- faces a 20-screen Life admin queue.

Type sizes of 12–14px for metadata are small for a phone-first product (W-33).

### 4.7 Accessibility (WCAG 2.2 AA)

> *"The basics are strong, but the gaps all appear after a person acts."* (accessibility lens)

**One outright fail: 3.3.1 Error Identification (W-15).** Server-detected errors never name the field and often discard input. Example: the currency "ZZ" on a card budget gives "that request wasn't valid", below the fold. No member-app form uses the existing `Field` error wiring for server errors.

**Partial (2.4.3 Focus Order).** Focus falls to `<body>` after Approve, Deny, permission saves and record adds (W-14). On phones, dialogs tab bottom-to-top because of `flex-col-reverse` (W-16).

**Other gaps:**

| Gap | Issue |
|---|---|
| Outcome notices are inserted with their text already in place, so screen readers may not announce them | W-14 |
| Disabled submits hide their reason | W-15 |
| Filter chips reset focus to the top | W-39 |
| Long-name chips can't be read at 320px | W-36 |
| Help leaves the workspace (3.2.6 Consistent Help) | W-24 |
| Life admin's cognitive load: 139 Tab stops before "Confirm all" | W-12 |

**Needs a human.** A VoiceOver/NVDA pass on Inbox decisions and release (4.1.3), and true browser zoom.

### 4.8 Code-level interface rules

**Rules pass:** 34 findings, of which 2 are high.
- The released-request state is one; it is part of W-02.
- The other: iPhone users can't enter several reminder days, because the comma-separated field opens a numeric keypad with no comma (W-45).

**Medium:**
- reduced-motion doesn't stop looping animations;
- live regions are mounted with their text, so may not be announced;
- refused forms reset;
- five local money formatters skip `Intl`;
- Skills filters aren't in the URL;
- no unsaved-changes guard anywhere;
- the Inbox never refreshes, so "time left" freezes;
- service Disconnect has no undo.

**Strong areas:**
- no icon-only control without a name;
- no clickable `<div>`s;
- no `transition: all`;
- typographic ellipses throughout;
- dates formatted on the server.

---

## 5. Prioritised issue register

**Severity.**
- **Critical:** blocks or endangers a core job, or causes a false belief about access or money.
- **High:** substantial confusion or waste on a frequent path, or a structural problem across many pages.
- **Medium:** friction or inconsistency on a less frequent path.
- **Low:** polish.

**Effort.** S is under half a day; M is 1–3 days; L is more than 3 days.

**Type.**
- Structural: information architecture or page structure.
- Visual: styling.
- Functional: behaviour or data flow.

### Critical

#### W-01 · Requests held for Warthog's own tools have no object, so they are approved blind
- **Location:** `/inbox`. `PendingItem` (`src/components/inbox/inbox-view.tsx:404-512`); `detailLines()`/`extraLines()` in `src/app/(portal)/(protected)/inbox/actions.ts:315-375`.
- **Problem:** When a rule holds `create_task`, `update_task`, `save_record`, `update_record` or `remember`, the card reads only "Claude wants to add a task · Your rule … · Claude gave no reason". Detail rows exist only for messages, amounts, merchants and identity fields, and arguments only for third-party tools. Three different tasks showed as three identical cards. History and the approve notice ("Approved. The agent can go ahead.") are just as blank. Verified live and in code ([screens/phone-inbox-identical-holds.jpg](screens/phone-inbox-identical-holds.jpg)).
- **Why:** An approval with no object isn't a decision. This defeats the "Ask me first" promise (brief design_ux.copy: "Approvals read as one sentence a person can decide on in a glance").
- **Impact:** Every member who sets "Ask me before … makes any change" approves without knowing what they approve. Trust in the core feature is at stake.
- **Recommendation:**
  - Give each native tool a headline and detail lines:
    - `create_task`: title, assignee.
    - `update_task`: task, change.
    - `save_record`: type, name, and the first 3 fields.
    - `update_record`: record, then field: old → new.
    - `remember`: the text and who can read it.
  - Fall back to the provider-argument preview for any unmapped tool.
  - Put the object in the sentence ("Claude wants to add the task “Book the car service”") and in the decision notice.
  - Add a render test asserting that 3 same-tool requests differ.
- **Effort / type:** M · functional. **Sources:** IXD-01.

#### W-02 · A released card or passport request still looks undecided, and the Inbox never refreshes
- **Location:** `/inbox`. `ReleaseApprove` is mounted without `onReleased` (`inbox-view.tsx:492-502`); the action row renders whatever the status (`release-approve.tsx:698-740`).
- **Problem:** After a successful release, one small line reads "Handed over. The agent can collect it once." Below it, **Approve and release, Deny and Ask for more detail stay live**. The request stays under "Waiting on you (4)" and the count doesn't change until a manual reload. "Time left" is a server string that never updates, and expired requests still show Approve.
- **Why:** This breaks visibility of system status at the highest-stakes moment (money or a passport). People will press again, or deny after releasing.
- **Impact:** All members, every card or protected-detail release. It erodes trust and invites contradictory actions.
- **Recommendation:**
  - Treat `released` as terminal: replace the fields and actions with a success block ("Handed over to Claude. It can collect it once. · See it in History") and focus it.
  - Pass `onReleased` and call `router.refresh()` so the row moves to History and the counts update.
  - Re-render time left on the client, and swap expired rows to "Expired" without the actions.
- **Effort / type:** S · functional. **Sources:** UX-01, IXD-03, code-rules (release-approve.tsx:698, inbox-view.tsx:466).

#### W-03 · Permission edits are silently lost, and Save reports success when nothing changed
- **Location:** `/agents/[id]?section=*` (`permissions-form.tsx:103-233`, `permissions-view.tsx:520-545`); `/household` forms; no `beforeunload` or link guard anywhere in `src`.
- **Problem:**
  - Each agent section is a separate form reached by plain links. Unticking "Let it ask to use a card" and then tapping the Rules sub-tab discards the change with no warning. On return, card access is **still on**. Verified live twice.
  - On Household, saving the budget wiped a typed but unsaved address.
  - Save is always enabled and reports "Saved" with no changes.
- **Why:** Silent data loss (Nielsen 3, user control). Worse, the person believes they removed card access when they didn't.
- **Impact:** Any member tightening an agent's access. A security-relevant false belief.
- **Recommendation:**
  - Add a shared `use-dirty-form` hook. While dirty: show a sticky ActionBar ("Unsaved changes · Discard · Save"), intercept tab, sub-tab and sidebar links with the shared ConfirmDialog, and add `beforeunload`.
  - Disable Save until something changes.
  - Merge Household's forms per region.
  - The redesign's single Access tab with one Save bar removes most of the cross-section risk (W-08).
- **Effort / type:** M · functional. **Sources:** UX-14, IXD-07, IA-02 (part), code-rules (unsaved changes).

### High

#### W-04 · On phones the everyday jobs are hidden behind a hamburger, with no Inbox count
- **Location:** All member pages under 1024px. `src/components/shell/app-shell.tsx:223-301`, `workspace-navigation.ts:21-30`. Screens: [phone-drawer.jpg](screens/phone-drawer.jpg), [landscape-drawer.jpg](screens/landscape-drawer.jpg).
- **Problem:**
  - The only navigation is a top-left menu button opening a 15-item drawer. Inbox is item 3; Activity is item 9, under "Insights".
  - **No pending count appears anywhere in the chrome.**
  - The drawer list is 896px tall in a 699px area at 390×844, so Household, Settings, Help and Contact sit under the fold. In landscape only 245px of the list shows.
  - The desktop sidebar also runs past 900px and hides Help.
- **Why:**
  - The brief: "used mostly from their phone"; "everything reachable in two taps from the mobile bottom navigation (Home, Inbox, Activity, Agents, More)".
  - Hamburger-only navigation lowers discoverability and engagement for primary destinations.
  - A top-left button is the hardest place for a thumb to reach.
- **Impact:** All phone members, many times a day.
- **Recommendation:**
  - Under 1024px, add a fixed bottom bar: Home · Inbox (count badge) · Activity · Agents · More. It needs targets of 56px or more, safe-area padding and `aria-current`.
  - "More" opens a regrouped `/more`, reusing `MoreMenu`, which already exists and already has a phone Sign out.
  - Add the count badge to the desktop sidebar too.
  - Load the count once in `(protected)/layout.tsx`.
  - Pin Household, Settings, Help and Sign out to a sidebar footer that never scrolls.
- **Effort / type:** M · structural. **Sources:** IA-01, RWD-01, UX-11, RWD-17. *Reverses part of the 11 November admin-console ADR; see [redesign §2.4](redesign.md#24-decisions-for-the-founder).*

#### W-05 · Home buries the decision under set-up, then repeats it without letting you act
- **Location:** `/home`. `dashboard-view.tsx:218-300, 566-588`; `src/domain/home/checklist.ts`. Screens: [phone-home.jpg](screens/phone-home.jpg), [desktop-home.jpg](screens/desktop-home.jpg).
- **Problem:**
  - The order is greeting card → a 5-row "Finish setting up" checklist (still 1 of 5 for a member with 3 agents; can't be dismissed; four equal "To do" rows; no recommended step) → Inbox panel.
  - The Inbox panel shows only "4 requests are waiting for your approval": at y≈690 on a phone, and off the first screen at 320px, in landscape and at 200% zoom.
  - The same requests reappear in Recent activity as "Waiting for you" entries linking to Activity, not Inbox.
  - Typical Home has **0** primary-styled actions.
- **Why:** The brief's Home is "what needs your decision, what your agents have done and what's coming up". Today set-up outranks decisions, and the next step is never named.
- **Impact:** Every visit. First-time members don't know what to do after connecting an agent.
- **Recommendation:**
  - When requests are pending, put a "Needs you" panel first. It lists up to 3 requests as compact rows (sentence, amount or detail, time left, Deny and Review), then "See all".
  - Collapse set-up to one row naming the next step with a reason ("Next: connect your email so Claude has something to work with"), with a "Hide for now".
  - Group "What your agents did today" by conversation.
  - Add "Coming up" from Life admin.
  - Wireframe: [wireframes/home-desktop.png](wireframes/home-desktop.png).
- **Effort / type:** M · structural. **Sources:** RWD-02, VIS-03, UX-09, UX-10, IA-08.

#### W-06 · Inbox request cards are long, repetitive, and put Approve below the fold
- **Location:** `/inbox`. `PendingItem` (`inbox-view.tsx:404-512`) and group headings (`:571-588`). Screens: [phone-inbox-1.jpg](screens/phone-inbox-1.jpg), [desktop-inbox.jpg](screens/desktop-inbox.jpg).
- **Problem:**
  - On a phone each request is 460–560px tall:
    - a per-agent group heading;
    - a sentence naming the agent again;
    - a facts list repeating the sentence ("Amount $240.00", "Merchant Mazda Parramatta");
    - "<agent> says …", the name a third time;
    - Details;
    - a notice;
    - two rows of buttons.
  - The first Approve sits at y=803 on an 844px screen, after 113 words.
  - The amount is 14px regular.
  - A disabled grey "Approve and release" is the most prominent button when no card exists.
  - "Ask for more detail" quietly closes the request.
  - The request sentence is a `<p>`, so screen-reader users can't jump between requests.
- **Why:** This works against the brief's "one sentence a person can decide on in a glance" and makes the phone job slow.
- **Impact:** Every decision on a phone, and members who find dense interfaces hard.
- **Recommendation:**
  - Use one row anatomy:
    - line 1: AgentMark plus the sentence, with the object in bold;
    - line 2: the agent's quote (clamped to 2 lines) · time left;
    - then **one** button row: Deny · Review/Approve, where the primary is the action that unblocks.
  - Drop facts the sentence already states.
  - Keep "Ask for more detail" behind a disclosure, and say it ends the request.
  - Make each request's sentence an `h3`.
  - Use a short agent name (W-36).
  - Show the amount as a figure inside the request view.
  - Wireframe: [wireframes/inbox-phone.png](wireframes/inbox-phone.png).
- **Effort / type:** M · structural. **Sources:** RWD-04, VIS-03, UX-19, IXD-05, A11Y-10, code-rules (inbox-view.tsx:427).

#### W-07 · The card and protected-detail release journey has detours with no way back, and asks for too much at the peak moment
- **Location:** `/inbox` → `/vault/cards` → `/vault`. `release-approve.tsx:253-306, 504-566, 580-680`; `add-card-flow.tsx`.
- **Problem:**
  - **(a) Detours.** With no saved card, "Add a card" leads to Vault › Cards. There, adding a card is refused because no postal address exists ("Add a postal address in About you, then come back"). Neither page links back to the request. The default approval expiry is **15 minutes**.
  - **(b) Too many controls.** The release step shows 8 controls, including a three-way "How would you like to unlock your vault?" radio (passkey, vault passphrase, vault recovery phrase).
  - **(c) Repeated identity checks.** Identity is checked *after* the vault unlock. A lapsed step-up refuses after Approve, clears the security code and makes the person confirm, retype and approve again. The passkey can be requested three times.
  - **(d) No form behaviour.** The fields aren't in a `<form>` (Enter does nothing), and the security code isn't validated before a one-shot release.
  - **(e) Wrong reassurance.** The protected-detail release reassures about the wrong thing, and doesn't show what will be handed over.
- **Why:** This is the peak-end moment of the product. Error prevention and recognition both fail here.
- **Impact:** Every first card request, and every release.
- **Recommendation:**
  1. Carry `returnTo=/inbox?approval=<id>` on every detour, and show "Card saved. Back to Claude's request" after saving.
  2. Collect a billing address inline when none exists, and keep it with the card only — never save it as a postal address in About you, where agents read it as an everyday detail (done 24 November 2026; see [../../adr/card-billing-addresses.md](../../adr/card-billing-addresses.md)).
  3. Check step-up freshness when the control mounts, before the unlock. Keep the security code across a refusal.
  4. Default to the passkey and put the other unlock methods under "Other ways to unlock".
  5. Use a `<form>` with a validated code (`[0-9]{3,4}`).
  6. For protected details, show "Claude will receive: Passport · ending 4821 · for Qantas check-in".
  7. Show the request summary (amount, payee, budget left, expiry) as in [wireframes/inbox-phone.png](wireframes/inbox-phone.png) panel 2.
  8. Ask the founder whether 15 minutes is the right default for phone-first approvals (W-46).
- **Effort / type:** M–L · functional. **Sources:** UX-02, UX-03, IXD-04, UX-21, A11Y-15, code-rules (release-approve.tsx:597).

#### W-08 · The agent page has three levels of navigation that mirror every account page, and no Disconnect
- **Location:** `/agents/[id]`. `workspace-navigation.ts:133-161`, `agent-workspace.tsx`, `permissions-view.tsx`, `[id]/permissions-form.tsx`. Screens: [desktop-agent-overview.jpg](screens/desktop-agent-overview.jpg), [phone-agent-overview.jpg](screens/phone-agent-overview.jpg), [desktop-agent-settings.jpg](screens/desktop-agent-settings.jpg).
- **Problem:**
  - Overview · Resources (Connectors · Vault · Skills · Memory) · Controls (Spending · Rules · Settings) · Activity. That is two tab rows, seven separately saved sub-pages, and an 8-card "access map" on Overview that repeats the tabs.
  - Reviewing one agent's whole access takes 7 visits and up to 7 saves.
  - "Vault" and "Settings" mean different things here than on the account pages.
  - Card access sits under Controls › Spending, not with cards.
  - Controls › Settings is a 3,200px checklist where every record is a bordered checkbox even when "All my records" is chosen, and Save comes only at the end.
  - The page exposes four nav landmarks.
  - **There is no Disconnect button on the agent's own page.** It exists only on the `/agents` list (brief key flow 10).
- **Why:** The agent-first model is right, but surfacing it as a mirror of every resource page creates the deepest hierarchy in the app and the W-03 data-loss trap.
- **Impact:** Every set-up and control task. People open an agent to stop it and hit a dead end.
- **Recommendation:**
  - Use one tab row: **Overview · Access · Limits · Activity**, with Disconnect in the header.
  - **Overview:** status, a plain-language summary of what it can do, tasks assigned to it, pending requests, recent conversations, and a Connection panel (name, key, disconnect).
  - **Access:** one form with a section index (Services, Your details, Life admin and tasks, Memory, Skills, Advanced) and one Save bar. `PermissionsSection` already supports `all`.
  - **Limits:** card access and budget, this agent's rules, request limit.
  - Hide per-record checkboxes unless "Only the ones I choose" is selected.
  - Wireframe: [wireframes/agent-access-desktop.png](wireframes/agent-access-desktop.png).
- **Effort / type:** L · structural. **Sources:** IA-02, IA-03, UX-15, RWD-07, RWD-14, VIS-15, IA-15, IXD-17, A11Y-13.

#### W-09 · Money is spread over four places, joined by signpost links, with no monthly total
- **Location:**
  - `/spending` (`spending-view.tsx:394-427`)
  - `/rules?view=budgets` (`rules-view.tsx:577-620`)
  - `/agents/[id]?section=spending` (`permissions-view.tsx:340-420`)
  - `/household`
  - `/vault/cards` (`resource-scope.tsx:25-30`)
  - Screens: [desktop-spending.jpg](screens/desktop-spending.jpg), [desktop-rules-budgets.jpg](screens/desktop-rules-budgets.jpg), [desktop-agent-spending.jpg](screens/desktop-agent-spending.jpg).
- **Problem:**
  - Spending's "Card budgets" link goes to Rules › Budgets, a tab of links ("Set Claude's budget") that doesn't show the current amount, which then goes to the agent page.
  - The household budget is shown in one panel and edited in another, two panels down.
  - Vault › Cards' "Manage for one agent" goes to a section without card settings.
  - Spending never shows "this month: $X".
  - The budget form:
    - takes free-text currency;
    - repeats the period;
    - says "Defaults to AUD200 per month" but won't save until a budget is typed (the disabled Save gives no reason);
    - prints "AUD200" with no space.
  - Spending figures are sentences, with no figure style.
- **Why:** This fails consistency and recognition, and it's a core control job ("control money").
- **Impact:** Any member setting or checking limits.
- **Recommendation:**
  - Make **Spending** the money hub:
    - a "This month" total per currency;
    - per-agent rows ("$0 of $300 · Change"), deep-linking to the agent's Limits tab;
    - a household budget and limits card.
  - Remove the Rules › Budgets tab and rename "Rules & budgets" to "Rules".
  - Pre-fill the stated default budget.
  - Use a currency `<Select>`.
  - Give amounts a tabular figure style.
- **Effort / type:** M · structural. **Sources:** IA-05, UX-12, UX-13, IXD-08, VIS-17.

#### W-10 · Time zone, language and currency have no home, and Settings holds none of them
- **Location:**
  - `/skills?view=preferences` (`skills-view.tsx:141, 703-710`)
  - Vault "Add a detail" (`low-tier-detail-flow.tsx:86-87`)
  - the `/spending` heading
  - `/household`
  - `settings-index.tsx`
  - Screen: [desktop-skills-preferences.jpg](screens/desktop-skills-preferences.jpg).
- **Problem:**
  - The account time zone drives budget periods and every displayed time.
  - It's a free-text field in Skills › Preferences, beside tone and length, and the form won't save until all six fields are filled.
  - Vault offers "Language" and "Time zone" details that look identical and change nothing.
  - Currency is set on Spending and again on Household.
  - Settings is a list of links (Agent defaults, Security, Notifications, Data) plus a link back to Skills for Preferences.
  - Approval expiry is tucked under the rules list.
- **Why:** There's "one name for each thing", but not one *place* for each thing. Brief: "Settings with Security and Preferences"; "money … configurable in Settings".
- **Impact:** Wrong times and budget periods for members outside Sydney; fruitless hunting.
- **Recommendation:**
  - Add **Settings › General** (time zone as a select defaulted from the browser, language, units, account currency), each saved on its own.
  - Add **Settings › Notifications & approvals** (alerts, reminder delay, approval expiry).
  - Rename Skills' Preferences to "How agents write for you" (tone, length, briefing), with no all-six rule.
  - Remove Vault's no-op Language and Time zone kinds, migrating any values.
  - Spending's heading shows "Amounts in AUD · Change".
- **Effort / type:** M · structural. **Sources:** IA-04, IA-12.

#### W-11 · Connecting a service gives no agent access, and the second step is hidden on each agent's page
- **Location:** `/connectors` (`connectors/notices.ts:15`, `connectors-view.tsx:647, 728`). Screen: [phone-firstrun-connectors.jpg](screens/phone-firstrun-connectors.jpg).
- **Problem:**
  - After connecting, the notice says "turn it on for the agents that should use it, on each agent's page", but offers no controls.
  - Overviews keep showing "0 services allowed".
  - The set-up checklist marks "Connect a service" done anyway.
  - In a new account, the "Popular" trio (Gmail, Calendar, Drive) are all "Early access — ask to join".
- **Why:** This is a hidden required step (recognition over recall), and it makes the product look broken after set-up.
- **Impact:** Brief key flow 3 for every member: about 5 + 5 × (number of agents) taps.
- **Recommendation:**
  - On the connected notice and on each "Your services" row, add "Which agents can use Gmail?", a checklist of agents with one Save. It posts to the existing grant action.
  - Count the set-up step done only when an agent can use the service.
  - Under "Popular", show connectable services first, or label early access clearly.
  - The "On for new agents" switch stays as it is.
- **Effort / type:** M · structural. **Sources:** UX-04, IA-18.

#### W-12 · Life admin's "To check" queue is a 20-screen wall with 26 primary buttons
- **Location:** `/life-admin` Records. `records-view.tsx:118-340` (`ToCheckPanel`, `SuggestionItem`). Screens: [phone-life-admin-1.jpg](screens/phone-life-admin-1.jpg), [phone-life-admin-3.jpg](screens/phone-life-admin-3.jpg), [desktop-life-admin.jpg](screens/desktop-life-admin.jpg).
- **Problem:**
  - All 25 agent-found records are fully expanded: every field, "Added by", and Confirm (black primary), Not mine and Edit.
  - The page is 16,859px tall at 390 (20 screens; 33.5 at 320), with 697 controls and 1,997 words.
  - Each Confirm reloads to the top (verified: scroll 1063 → 0).
  - "Confirm all 25" sits about 9,200px down, after the list.
  - The type is repeated three times per card ("Restaurant: Dinner at Firedoor" / "Restaurant · Starts …").
  - **PR #52 (open) collapses the tabs to Records · Upcoming · History · Tasks but keeps this queue at the top of Records.**
- **Why:** Cognitive overload; recognition; efficiency. The member's own records are pushed 20 screens down.
- **Impact:** Every member with an agent filing from email. It's the newest and most actively developed area.
- **Recommendation:**
  - Turn To check into a compact queue: one line per record (name · key date · "Added by ChatGPT"), with secondary Confirm and Not mine and the fields behind a disclosure.
  - Show the first 5, then "Review all 25", a one-at-a-time review with Confirm, Not mine, Skip and "n of 25".
  - Put "Confirm all" (and "Confirm all from ChatGPT") in the panel header as the single primary.
  - Act in place, with focus moving to the next row.
  - On Home and the Records tab, show "25 to check" as a single entry point.
  - Wireframe: [wireframes/life-admin-more-phone.png](wireframes/life-admin-more-phone.png).
- **Effort / type:** M · structural. **Sources:** IA-06, RWD-05, UX-16, IXD-11, A11Y-08, VIS-04 (part).

#### W-13 · Activity is a raw log of tool calls, not a record of what agents did
- **Location:** `/activity`. `activity-view.tsx:466-923`; `src/domain/activity/evidence.ts:353-361`; `activity/organise.ts:162-176`. Screens: [phone-activity-1.jpg](screens/phone-activity-1.jpg), [phone-activity-2.jpg](screens/phone-activity-2.jpg), [desktop-activity.jpg](screens/desktop-activity.jpg).
- **Problem:**
  - **What a row says:**
    - Rows read like "Add a task · Done · Changes · ChatGPT · Agent's reason: Keeping track".
    - What was done ("Find a dog sitter for Biscuit") is hidden behind "View details".
    - "Add a task · Keeping track" repeats 12 times in a row, and every agent report appears twice.
    - Waiting approvals duplicate the Inbox.
  - **How much there is:**
    - One day holds 59 entries and 119 disclosures: 11,154px on a phone (13 screens).
    - On desktop, each row stretches to 1,150px.
  - **How hard it is to filter:**
    - "What did Claude change today?" takes 7 interactions and 2 page loads across three overlapping taxonomies: type chips, Event and Outcome selects, and views.
    - There's no "Today" or "This week" filter.
    - Search covers only the loaded page.
  - **Hidden actions:** Undo and Dispute are hidden inside each entry. Dispute is a dead end with no outcome (W-29).
- **Why:** The brief's job is "glance at the activity feed". Today it's an audit log.
- **Impact:** A daily glance, and trust.
- **Recommendation:**
  - **Group the default view by conversation (run).** Each run is one row ("Claude · Sorting out the car registration · 9 actions · 1 waiting") that expands to its steps.
  - **Write each step's headline from its main parameter** ("Added task: Find a dog sitter …") and show the agent's reason as a muted second line.
  - **Collapse repeats** ("12 × Add a task").
  - **Hide reads and the duplicate report call** by default ("Show reads").
  - **Add chip rows** for Agent and When (Today · 7 days · All).
  - **Make the row itself the disclosure.**
  - **Cap the reading measure** at about 900px.
- **Effort / type:** L · structural. **Sources:** IA-07, UX-05, UX-06, RWD-06, VIS-11, IXD-12, IXD-13, code-rules (activity-view.tsx:591).

#### W-14 · Every row action reloads to the top, drops focus, and the notice doesn't name the item
- **Location:**
  - Inbox decisions (`inbox/page.tsx:96-157`);
  - Life admin Confirm and Not mine;
  - Memory delete;
  - Rules pause;
  - agent permission saves;
  - `PageNotice` (`notice.tsx:25-56`).
- **Problem:**
  - Each action redirects to `?notice=…`. Scroll resets to 0, `document.activeElement` becomes `<body>`, and a generic banner appears at the top ("Approved. The agent can go ahead."; "Confirmed.").
  - On Household the confirmation is off-screen.
  - Live regions are mounted with their text already in place, so screen readers may not announce them. Only Toast uses the reliable pattern.
- **Why:** WCAG 2.4.3 is partial, and 4.1.3 is likely affected. People lose their place in a list after every decision.
- **Impact:** Keyboard and screen-reader users most of all; everyone working through a queue.
- **Recommendation:**
  - Add a shared `focus-target` helper. Pass `?focus=<next row id>` on redirect, scroll that row to the centre and focus it.
  - Name the item in the notice ("Denied: Claude paying $64.90 to Mad Paws").
  - Mount live regions empty, then set their text.
  - Offer Undo where the action is reversible.
- **Effort / type:** M · functional. **Sources:** IXD-02, A11Y-02, A11Y-03, IXD-15, code-rules (notice.tsx:25).

#### W-15 · Form errors never name the field and often discard what was typed (WCAG 3.3.1 fail)
- **Location:**
  - agent `?section=spending` (budget);
  - `/rules?view=new` (`rules/page.tsx:94`);
  - `/connectors/key`;
  - `/contact`;
  - Life admin record forms;
  - disabled submits in `rules-view.tsx:711` and `data-view.tsx:86`.
- **Problem:**
  - Server-detected errors redirect with a page-level banner ("That request wasn't valid"; "Some details were left out") that doesn't identify the field. Examples: the card-budget currency "ZZ", and invalid record values that were silently dropped.
  - A refused rule resets the builder. A Contact error clears the message.
  - A rejected service key sends the person to another page and makes them disconnect and retype.
  - "Add rule" and card-budget Save are disabled with no reason, and skipped by Tab.
- **Why:** A WCAG 2.2 AA failure (3.3.1), partial on 3.3.3 and 3.3.7. Error recovery heuristic.
- **Impact:** Anyone who makes a mistake, especially keyboard and screen-reader users.
- **Recommendation:**
  - Return field errors from server actions and render them with `Field`'s existing `aria-invalid`/`aria-describedby` wiring.
  - Keep submitted values on refusal.
  - Keep submit buttons enabled and validate on submit with an error summary that links to the fields.
  - Let a key be corrected in place.
- **Effort / type:** M · functional. **Sources:** A11Y-01, A11Y-04, A11Y-16, IXD-19, code-rules (forms).

#### W-16 · Destructive actions get confirmation according to the page, not the risk
- **Location:**
  - dialogs: `disconnect-confirm.tsx`, `remove-passkey.tsx`, `delete-skill.tsx` and others;
  - inline reveals: `memory-view.tsx:267`, `rules-view.tsx:381`, `record-row.tsx:170`;
  - one-tap: "Not mine" and rule Pause.
  - Screen: [dialog-disconnect.jpg](screens/dialog-disconnect.jpg).
- **Problem:** Five patterns coexist:
  - native dialog;
  - inline `<details>` reveal with no Cancel;
  - client-side confirm state;
  - typed confirmation;
  - one tap.

  Their weight doesn't match the risk:
  - "Not mine" permanently deletes attached receipt files in one tap.
  - **Pausing a protective rule is one tap and can't be undone.** There is no Resume and rules can't be edited; focus then lands on Delete.
  - Disconnect shows "Disconnecting…" behind its dialog before confirmation.
  - Phone dialogs tab bottom-to-top.
  - Service Disconnect has no undo.
- **Why:** Error prevention; consistency.
- **Impact:** Accidental loss of protections or files; unpredictable behaviour.
- **Recommendation:**
  - Add one `ConfirmDialog` primitive (W-40) and one rule:
    - irreversible loss of data or access uses ConfirmDialog with the consequence named;
    - reversible actions are one tap with Undo in the notice;
    - the service Disconnect stays one tap, as the brief requires, plus Undo.
  - Add Resume for rules and make rules editable.
  - Fix the pending label and the tab order.
- **Effort / type:** M · functional. **Sources:** IXD-09, IXD-06, DS-05, A11Y-09, A11Y-12, code-rules (connectors-view.tsx:414).

#### W-17 · The page header is a floating card that repeats the title and eats the first screen
- **Location:** Every page. `WorkspaceHeading` (`workspace-surfaces.tsx:27-70`); `.wh-page-heading` (`surfaces.css:210-241`); "box soup" rules (`.wh-tabstrip`, `.wh-toolbar`, `.wh-list-group`, `.wh-form-actions`). Screens: [phone-memory.jpg](screens/phone-memory.jpg), [phone-activity-1.jpg](screens/phone-activity-1.jpg), [desktop-memory.jpg](screens/desktop-memory.jpg).
- **Problem:**
  - Each page opens with a 14px-radius raised card holding the h1 (already in the top bar), a 72ch description, the scope disclosures and a tab row.
  - On phones, the page name appears three times: top bar, route tab and h1.
  - Top bar plus heading take 37–66% of a 320×568 screen and 49–81% in landscape.
  - Below the header, every container shares one raised style, stacked 24px apart, so tabs and toolbars float away from the lists they control. Memory stacks four separate cards before its first memory, at y=916.
- **Why:** Aesthetic and minimalist design; this pushes content below the fold.
- **Impact:** Every page, every visit, worst on phones.
- **Recommendation:**
  - Make a flat **page header region** (no radius or shadow, joined to the top bar, contained on `--wh-surface`, so the contained-text ADR holds):
    - h1 at 28/34 (24/30 on phones);
    - a description of at most 2 lines and 60ch, hidden on daily pages once populated;
    - one tab row.
  - Remove the duplicate title from the phone top bar.
  - Raise only content panels. A list's toolbar and tabs live *inside* its panel.
  - See [redesign §6](redesign.md#6-design-system).
- **Effort / type:** M · structural/visual. **Sources:** VIS-01, VIS-02, RWD-03.

#### W-18 · A high visual noise floor: repeated primaries and red, underlines everywhere, decorative icon tiles
- **Location:**
  - 152 `underline` class uses in 34 files (e.g. `.wh-panel-action a`, `workspace.css:107`);
  - `WorkspacePanel` icon tiles (70 of 107 panels);
  - row actions in `records-view.tsx:135`, `agent-list-view.tsx`, `rules-view.tsx`.
  - Screens: [desktop-home.jpg](screens/desktop-home.jpg), [desktop-agents.jpg](screens/desktop-agents.jpg), [desktop-rules.jpg](screens/desktop-rules.jpg).
- **Problem:**
  - Row titles, panel actions, disclosures and meta links are all underlined, often with a chevron or arrow too ("Connect an agent ✓ Done ›"). Activity renders 174 underlined elements.
  - Life admin has 26 black primaries.
  - The agents list shows nine equal pills for three agents, including three red Disconnects.
  - Every rule has a red Delete.
  - Indigo icon tiles on panel headers spend the single accent on decoration. 37 underlined links have no hover state.
- **Why:** "One clear primary action per screen" and "a single accent … reserved" (brief design_ux.feel). Underline-plus-arrow is the strongest "developer console" signal.
- **Impact:** A perceived lack of polish and trust; nothing reads as *the* action.
- **Recommendation:**
  - **Links: three roles.**
    - Prose links are underlined.
    - Row links have no underline, a whole-row hover and one muted chevron.
    - Panel actions are ghost buttons.
  - **Buttons.**
    - Repeated row actions are secondary or ghost `sm`.
    - Add a `ghost-danger` variant for repeated Delete and Disconnect.
    - Allow at most one filled primary in the first viewport.
  - **Panel icons:** drop the tiles, or make them neutral.
- **Effort / type:** M · visual. **Sources:** VIS-04, VIS-05, VIS-08, IXD-20, code-rules (filter-links.tsx:93).

#### W-19 · Design foundations are fragmented, and a CSS clash ships a visible bug
- **Location:** `src/app/globals.css:8-109, 345, 460-789`; `workspace.css:6-26, 84`; `surfaces.css`; `public.css:14-28`; `document-shell.tsx`.
- **Problem:**
  - **Tokens:**
    - They're declared in five places with two theming mechanisms and two grey ramps.
    - `--wh-surface` is declared three times with different values.
    - The Tailwind bridge exposes about half of them.
    - The contrast test checks values the app never renders.
  - **Selectors:**
    - About 20 are redefined across files.
    - The clash at `workspace.css:84` removes the active sidebar tint bar the brand ADR requires. Computed style on `/home` confirms it.
    - Unlayered `.wh-*` CSS silently beats Tailwind utilities written in components: for example `text-xl` on the agent h1 is ignored, and 5 inline `style` workarounds exist.
  - **Dead code:** the explicit `data-theme` and `dark:` variant never fire.
  - **Shadows and colour roles:** shadows mix the token with Tailwind's black `shadow-lg`, and the info blue nearly equals the focus blue.
  - **Manifest:** `theme_color` is still the retired indigo.
- **Why:** Every visual fix costs more than it should, and agents following the guidance reintroduce drift.
- **Impact:** Indirect but broad: consistency, dark mode, maintenance.
- **Recommendation:**
  - Fix the sidebar bug now: delete `workspace.css:84`.
  - Add `tokens.css` as the only place `--wh-*` is declared, using `light-dark()`.
  - Declare cascade layers: `@layer theme, base, wh-base, components, wh-shell, wh-primitives, wh-features, utilities, wh-a11y`.
  - Give each CSS file one owner.
  - Add a `design-lint` test that fails on duplicate selectors and on token declarations outside `tokens.css`.
  - Set the manifest colour.
  - See [redesign §6](redesign.md#6-design-system).
- **Effort / type:** M · structural. **Sources:** DS-01, DS-02, DS-03, DS-14, DS-15, DS-18, VIS-13, VIS-21.

#### W-20 · State is shown five different ways, and status colour is everywhere
- **Location:**
  - `ui/status.tsx:30-48`
  - `setup-checklist.tsx:58`
  - `activity-view.tsx:240` (`OutcomeBadge`)
  - `tasks-view.tsx:155-170`
  - `rule-badges.tsx:27-39`
  - `inbox-view.tsx:344` (`OpenedTag`)
  - Screens: [desktop-home.jpg](screens/desktop-home.jpg), [desktop-activity.jpg](screens/desktop-activity.jpg), [desktop-dark-home.jpg](screens/desktop-dark-home.jpg).
- **Problem:**
  - "Done" renders as green text (Home), a tinted pill (Activity) and neutral text with a green icon (Tasks).
  - `Status` colours its text, against the brand ADR ("text stays neutral").
  - Every Activity row carries a green "Done" pill, which turns badges into wallpaper.
  - Selected chips rely on bold plus a 1.1–2.9:1 fill.
  - Dark-mode soft tones go muddy.
- **Why:** Consistency; colour must mean "look here".
- **Impact:** Harder scanning; a less calm feel.
- **Recommendation:**
  - Add one `state.ts` registry (key → label, icon, tone) and a `<StatusBadge variant="pill|inline">`: neutral text, a tone icon, and a pill only for states that need attention.
  - Success is quiet (inline), or not shown at all on routine rows.
  - Give selected chips a 3:1 border.
- **Effort / type:** M · visual. **Sources:** DS-04, VIS-09, A11Y-07.

### Medium

| ID | Location | Problem | Why / impact | Recommendation | Effort · type | Sources |
|---|---|---|---|---|---|---|
| **W-21** | Sidebar (`workspace-navigation.ts:21-30`), breadcrumb (`app-shell.tsx:150-190`) | Groups named after system concepts ("Workspace", "Account resources", "Insights", "Manage"). A decorative "W · Personal workspace" box with no function. Breadcrumbs start with group names you can't click and leave out the agent. | Labels don't match mental models; the sidebar is busier than the content | Groups become "What agents can use" and "Spending & rules". Remove the workspace box. Breadcrumb Section › Item, both linked, including the agent name. | S · structural | IA-09, IA-21, VIS-12 |
| **W-22** | Route tabs (`workspace-navigation.ts:101-112`) | Activity\|Spending and Memory\|Skills are route tabs of each other **and** separate sidebar items | A third navigation layer and two paths to one place | Remove these cross route tabs | S · structural | IA-10 |
| **W-23** | `resource-scope.tsx:18-113` on 6–7 page headers | A "How access works / Manage for one agent" underlined disclosure row repeats the page description | Noise in every header; the agent-first model is explained instead of shown | Replace with an "Used by: Claude, Gemini" line on the objects themselves (e.g. each service row) linking to the agent's Access | S · structural | IA-11, VIS-16 |
| **W-24** | Top bar "?" and sidebar Help (`app-shell.tsx:302-311`) → public `/help` | Help leaves the workspace for a page offering "Sign in / Sign up" with no way back. Help and Contact are separate, below the sidebar fold. | WCAG 3.2.6 Consistent Help; the member feels logged out | An in-shell `/support` page: the help content plus the Contact form and your messages. The public `/help` stays for signed-out people. | M · structural | IA-17, UX-18, A11Y-11 |
| **W-25** | `/household` (`household-view.tsx:332-650`) | One long scroll of up to 9 panels in an order that separates related things (budget shown, then edited two panels down). Invites can't be resent or cancelled. The member-limit form doesn't show the current limit. | Infrequent but high-stakes admin; hard to scan | Order: Members (with pending invites, Resend/Cancel) → Shared address → Budget and limits (one panel) → "Ownership and leaving" disclosure. Show current limits inline. | M · structural | IA-13, IXD-18 |
| **W-26** | Vault protected details (`identity-view.tsx`) vs Life admin `id.*` records | The same passport, licence, rego or address lives in two unlinked places | A duplicate source of truth; the "when does my licence expire?" question has two answers | Cross-link: a Vault detail shows "Expiry tracked in Life admin" and the Life admin record shows "Number kept in your Vault" | M · structural | IA-14 |
| **W-27** | `/connectors?view=catalogue` (`connectors-view.tsx:335-764`). Screen: [desktop-connectors-catalogue.jpg](screens/desktop-connectors-catalogue.jpg) | Opens on 103 equal grey tiles under a three-row wall of 18 category chips. Search reloads the page. The "Popular" services are early access only. 11.9 screens on a phone, 34 at 200% zoom. | Catalogue fatigue; hides what works | Lead with search and "Popular you can connect now"; categories as a select; client-side filter over the 103 loaded items; tile grid by container query | M · structural | IA-16, VIS-20, RWD-12, IXD-21 |
| **W-28** | Agent Overview (`agent-workspace.tsx:98-210`); Home | Tasks assigned to an agent appear on neither the agent's page nor Home | The hand-over model (stewardship) is invisible | "Working on" list on agent Overview; "Tasks" count in Home's Agents panel | S · structural | IA-19 |
| **W-29** | Activity entry (`activity-view.tsx:370-420`) | Dispute has no stated audience, outcome or next step. Undo and Dispute are hidden inside "View details", and the list doesn't show which entries can be undone. | A dead end in key flow 6 | Show "Undo available until …" on the row; Dispute explains who sees it and lists open disputes with their state | M · functional | UX-07, IXD-13 |
| **W-30** | Home and Activity "Needs attention" (`src/domain/activity/attention.ts`) | Counts refusals and other items that need no action ("16 need attention") | False alarms train people to ignore warnings | Count only items with an action; rename the rest "Blocked" | S · functional | UX-08 |
| **W-31** | `/life-admin?tab=upcoming`; Life admin empty state | Upcoming flags "Not checked yet" with no way to check, and repeats its tab name. The empty state's only per-category action is negative, and its best action is at the bottom. | Dead ends | "Check" link to the queue; empty state leads with "Ask your agent to fill this in" | S · functional | UX-17, UX-24 |
| **W-32** | `spending-view.tsx:143` and 4 other local helpers; `permissions-view.tsx:372` | Money appears as "$240.00", "NZD 180.00", "AUD 0.00", "AUD200" and "A$". No digit grouping; proportional figures. | Consistency; amounts are hard to compare | One `formatMoney` (Intl) everywhere: currency symbol for the account currency, code for others, `tabular-nums` | S · visual | UX-20, code-rules (Intl, tabular-nums) |
| **W-33** | CSS type sizes (18 distinct px values); `surfaces.css:225-239`; `workspace.css:122, 147` | No type tokens. Four roles collapse to 16px and weight 500 is everywhere. Metadata at 12px, too small for phone-first and low-vision users. | Weak hierarchy; readability | The type scale in [redesign §6.2](redesign.md#62-typography): 28 / 20 / 16 / 14 / 13 / 12 with named roles; minimum 13px for meta on phones | M · visual | VIS-06, DS-10, RWD-13 |
| **W-34** | Page measures (`workspace-navigation.ts:47-67`, `surfaces.css:34-95`) | The left edge and width jump between sibling pages (1216 / 896 / 768). Tablets at 768 get the phone layout stretched. 1440–1920 leaves empty canvas beside single-column lists. | Frame instability; wasted space | One measure per page *type*, with the frame and left edge fixed; a 2-column layout from 1200px for Home, Spending and Agent Overview; a tablet layout using the sidebar from 900px | M · structural | VIS-07, RWD-10, RWD-08, RWD-09 |
| **W-35** | `permissions-view.tsx:117-140` (Toggle), connector modules, access-map nodes | Card-in-card: options are bordered boxes inside panels (29 on one agent page). Selected looks barely different from unselected. Inset radii render at 8, 10 or 12px. | "Box soup" at the component level | Rows with dividers inside panels; Switch and Checkbox rows; one radius per level | M · visual | VIS-10, DS-07, DS-06 |
| **W-36** | Agent names everywhere (`agent-list-view.tsx`, inbox, chips). Screen: [phone-worst-agent-overview.jpg](screens/phone-worst-agent-overview.jpg) | Long names wrap into paragraphs, repeat across lists, and make filter chips (429px in a 262px track) unreadable at 320px or 400% zoom | WCAG 1.4.10 partial; layout noise | A short display name (first segment before "—", or a user-set short name), clamped to 1–2 lines with the full name in the accessible name and on the agent's own page | S · visual | VIS-14, RWD-11, A11Y-06 |
| **W-37** | `/vault` (`identity-view.tsx`). Screen: [desktop-vault.jpg](screens/desktop-vault.jpg) | About you reads as an open form of editable inputs, not a vault of protected things | The sensitive-moment feel the brief asks for is missing | Read-only description rows with Edit per row; protected details masked, with a lock and "Last released to Gemini, 2 days ago" | M · visual | VIS-19 |
| **W-38** | About 40 `<summary>` elements (`memory-view.tsx:178`, `skills-view.tsx:222`, `record-row.tsx:217`, …) | Seven-plus disclosure styles; many look like buttons; `ROW_DISCLOSURE` defined three times | Unpredictable affordances | A `Disclosure` primitive with 4 variants (link, button, section, row) and one chevron rule | M · visual | IXD-10, DS-08 |
| **W-39** | `section-navigation.tsx`, agent `?section=` links, `view-tabs.tsx`, `filter-links.tsx` | Four tab mechanisms look alike but differ in keyboard model, draft retention and URL behaviour. Filter chips reload and send focus to the top (22–28 Tab presses to return). Actions presented as tabs ("New rule", "Import & create", "Connect an agent"). | Consistency; keyboard efficiency | Two mechanisms only: route tabs (links) and in-page tabs (ViewPanels), visibly different from filter chips (a segmented control). Actions become buttons that open a panel or sheet. Chips keep focus. | M · functional | IXD-14, DS-09, IA-20, A11Y-05 |
| **W-40** | `src/components/ui` | Missing primitives: Dialog/ConfirmDialog (7 copies of the class string), Switch/Checkbox/Radio/ChoiceGroup, DescriptionList (13 ad-hoc `<dl>`, 9 layouts), Pagination (4 implementations), IconButton, SegmentedControl. `PageContainer` bypassed in 35 files. Two icon-sizing APIs and mixed stroke widths. | Drift multiplies; every fix is repeated | Add the primitives in [redesign §6.5](redesign.md#65-components), one per PR, keeping existing class hooks | L · structural | DS-11, DS-12, DS-13, DS-16, DS-19 |
| **W-41** | `confirm-its-you.tsx:189-191`; `/settings/data` | "Confirm it's you" appears in different places and works differently per flow; it offers authenticator codes to people without one. Data & privacy asks for confirmation before any action is chosen. | Predictability at sensitive moments | Ask only when an action needs it, in the same place (next to the action) each time; offer only the factors the person has | S · functional | IXD-16, UX-23 |
| **W-42** | Page descriptions, scope rows, panel descriptions on every page | Pages ask members to read a lot before the first action, with competing emphasis (113 words before the first Approve) | Dense-interface persona | Descriptions only in empty states and set-up; one-line panel descriptions at most | S · visual | RWD-15 |
| **W-43** | `.agents/skills/warthog-*`, `docs/design/admin-console-reference.md`, ADRs | 15 contradictions between contributor guidance, ADRs and code (e.g. "do not restore indigo" vs the indigo tint; 8px rhythm vs 20px padding; `PageContainer` sizes that never apply) | Agents following the guidance reintroduce drift | Rewrite the skill alongside the token work ([roadmap phase 1](redesign.md#7-implementation-roadmap)) | S · structural | DS-20 |
| **W-44** | `globals.css:152`; `document-shell.tsx:35` | Reduced motion sets duration only, so spinners and skeleton loops may jitter instead of stopping | WCAG 2.3.3 (AAA) intent; comfort | Add `animation-iteration-count: 1` and `scroll-behavior: auto` to the reduced-motion reset | S · functional | code-rules |
| **W-45** | `record-row.tsx:72` | "Remind me (days before)" asks for comma-separated days but opens a numeric keypad with no comma on iPhone | Can't enter more than one reminder on iOS | `inputMode="text"` with a pattern, or a multi-select of 1 / 7 / 14 / 30 days | S · functional | code-rules (high) |
| **W-46** | `src/domain/approvals/state-machine.ts:53` (`DEFAULT_EXPIRY_MINUTES = 15`) | Requests expire 15 minutes after they're raised; the reminder delay can exceed it | Phone-first members away from the phone miss requests; a security trade-off for the founder | **Founder decision.** Consider 60 minutes, or "until tonight", for card and detail requests; keep the warning when reminders come too late | S · functional | UX-02 (part) |
| **W-47** | `skills-view.tsx:382`; Activity search | Skills library search, filters and page live in React state, not the URL; Activity search covers only the loaded page | Back and reload lose state; search misses results | URL-backed state via the existing `useQueryView` pattern; server-side search | S · functional | code-rules, IXD-12 |

### Low

| ID | Issue | Sources |
|---|---|---|
| **W-48** | **Polish of individual components:** <ul><li>disabled primary buttons look broken in light mode and enabled in dark mode (VIS-18);</li><li>brand tiles glare in dark mode (VIS-22);</li><li>one-off headings on Life admin item pages (VIS-23);</li><li>no tap feedback on buttons (IXD-19);</li><li>no `touch-action: manipulation`;</li><li>iOS grey tap highlight.</li></ul> | VIS-18, VIS-22, VIS-23, IXD-19, code-rules |
| **W-49** | **Spacing:** no spacing tokens, with off-grid 6/10/14/18/22px values; one generic loading skeleton for every route. | DS-17, DS-21 |
| **W-50** | **Activity heading:** puts "Check integrity", a technical audit action, first. Move it to an overflow menu. | UX-22 |
| **W-51** | **Package editor dialog:** the sticky header partly covers buttons, the view toggles are unnamed `aria-pressed` buttons, "Remove file" has no undo, and there's no `overscroll-behavior`. | A11Y-14, code-rules (×4) |
| **W-52** | **Titles and names:** identical "Life admin item" page titles; "View details" repeated 59 times without context; 142-character sr-only button names in the Inbox. | A11Y-17, A11Y-10 |
| **W-53** | **Form attributes:** `autocomplete="off"` on non-auth fields; no `spellCheck={false}` on emails or codes; card fields without `autocomplete="cc-*"`; `type="number"` for expiry; about 30 placeholders mixing instructions and examples; "(s)" plurals. | code-rules (×6) |
| **W-54** | **Links:** no `next/link` (full page loads between sections); `translate="no"` missing on the brand and codes; `CountBadge` without `Intl`. | code-rules (×3) |
| **W-55** | **Life admin:** a type label repeated three times per card; a "handled by no one" phrase. | RWD-05 (part), UX lens |
