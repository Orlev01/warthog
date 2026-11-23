# Warthog member app — context brief for reviewers (23 Nov 2026)

Repo (github/main @ d3b7d94, read-only for you): <repo>
Running locally at http://localhost:3241 (dev server, synthetic data only).

## What Warthog is
A consumer "personal agent home" (Next.js 16, React 19, Tailwind 4, no component library, lucide icons).
Every AI agent (Claude, ChatGPT, Gemini…) connects to Warthog as ONE remote connector and gets its own
revocable, scoped access to: the person's connected services (email, calendar, 100+), identity details
(everyday vs protected tier), saved cards, skills and preferences, shared memory, life-admin records and
tasks, rules and budgets. Risky actions wait in ONE approval Inbox and reach the phone as a push
notification. Activity is a tamper-evident record of everything agents did. Households share an
address and budget. Warthog never calls an AI model itself.

## Users (brief.yaml users/design_ux — read lines 39–60 and 539–575)
- Individuals/households with 2+ AI agents; founder + 10–20 friends first, public sign-up open.
- "They use Warthog MOSTLY FROM THEIR PHONE (approving requests on the go, glancing at the activity
  feed) and from a laptop browser for set-up (connecting services, adding agents, writing skills and rules)."
- Not developers; abandon a step that doesn't say plainly what happens next; expect phone-app quality.
- Care a lot about where card/passport details go.
- Feel: calm, trustworthy, quick, "never a developer console"; neutral palette + one accent; one clear
  primary action per screen; two taps to anything from the mobile bottom nav (the brief's original spec:
  Home, Inbox, Activity, Agents, More) — the current build REPLACED the bottom nav with a hamburger drawer
  (docs/adr/admin-console-design.md).
- Key flows (brief design_ux.key_flows): sign up → identity + card → connect a service → connect Claude
  (consent) → agent works; approve on phone → review activity, dispute/undo → write a skill; shared memory →
  change address / moving → invite household → disconnect agent → export/delete.

## Founder decisions for THIS audit
1. Navigation/IA may be restructured freely (propose a brief.yaml amendment where it departs).
2. Refine the current visual direction (neutral + single indigo tint, admin-console reference, existing
   tokens) — do NOT propose a new visual language.
3. Scope: signed-in member app only (auth, consent, landing, help, admin portal out of scope except hand-offs).

## Prior work you must not re-report
docs/audit/uiux-pass-2026-11-12/review.md: 270 mechanical issues fixed on 12 Nov (contained text, 44px
targets, 16px inputs, overflow, contrast, copy naming, duplicate submits). Only report those categories on
a concrete regression. The 12 Nov pass did NOT restructure navigation or pages — structure is the focus now.

## Navigation today (src/components/shell/workspace-navigation.ts, nav.ts, app-shell.tsx)
Sidebar (≥1024px) and phone drawer (hamburger, <1024px) are identical: 15 items in 5 groups —
- Workspace: Home, Agents, Inbox
- Account resources: Connectors, Vault, Skills, Memory, Life admin
- Insights: Activity, Spending
- Manage: Rules & budgets, Household, Settings
- Help: Help (leaves the app → public /help page with Sign in/Sign up top bar), Contact us
Above: wordmark + a decorative "W · Personal workspace" box. Footer: Sign out.
No bottom tab bar on phones. No pending-count badge on Inbox anywhere in nav.
Top bar: breadcrumb (Group › Section › Sub-page), "?" icon to /help.
Route tabs (under top bar): Settings (Overview · Agent defaults · Security · Notifications · Data & privacy);
Vault (About you · Cards); Memory|Skills are route tabs of each other; Activity|Spending are route tabs of
each other (while ALSO being separate sidebar items); Agents (Your agents · Connect an agent).
Agent page /agents/[id]: two tab rows via ?section= — Overview · Resources · Controls · Activity; then
Resources → Connectors · Vault · Skills · Memory; Controls → Spending · Rules · Settings. It mirrors every
account-level resource page per agent.
In-page tabs (ViewPanels, ?view= or ?tab=): Inbox (Waiting on you | History), Connectors (Your services |
Catalogue), Rules (Your rules | New rule | Budgets), Skills (Library | Import & create | Preferences),
Life admin OUTER (Records & reminders | Tasks) + INNER (Records | Upcoming | Bookings | Moving checklist).
/more is a legacy menu page nothing links to.
Every account-resource page carries a "How access works / Manage for one agent" scope disclosure.

## Pages (★ most important) — main components
★ /home dashboard-view.tsx (setup checklist, Inbox, Recent activity, Your agents, Reminders)
★ /inbox inbox-view.tsx (1,005 lines) + release-approve.tsx (745) — approvals; card/protected release flow
★ /activity activity-view.tsx (924) — 4 views, 6 quick filters, 4 selects, 2 dates, search, dispute/undo
★ /agents agent-list-view.tsx; ★ /agents/[id] agent-workspace.tsx, permissions-view.tsx, [id]/permissions-form.tsx
/agents/connect connect-guide.tsx; /agents/access-key access-key-flow.tsx
★ /connectors connectors-view.tsx (Your services | Catalogue of 100+)
/vault identity-view.tsx (+ high-tier, low-tier flows, recovery phrase); /vault/cards cards-view.tsx, add-card-flow.tsx
/skills skills-view.tsx, package-editor.tsx (Preferences = tone/language/time zone hidden here)
/memory memory-view.tsx
★ /life-admin life-admin-screen.tsx, life-admin-view.tsx, records-view.tsx (~4,450 lines total; most
overloaded; ANOTHER SESSION has PR #52 open restructuring it to one row: Records | Upcoming | History | Tasks
and removing the moving checklist — review the committed UI but say where #52 already addresses a finding)
/life-admin/items/[id] item-view.tsx
/rules rules-view.tsx (903) — Your rules | New rule | Budgets; approval expiry tucked under rules list
/spending spending-view.tsx — account currency form lives in its heading; budgets link to /rules
/household household-view.tsx (661) — single long scroll of up to 9 panels
/settings + agents/security/notifications/data (+ security/sign-in-requests reached only from push)
/contact contact-view.tsx

Known fragmentation: budgets in 4 places (Rules › Budgets, Spending, agent › Spending, Household);
identity in 4 (Vault, Skills › Preferences, Memory, Life admin records); currency on Spending (brief says Settings).

## Design system inventory (from code survey)
- Modelled on the OpenAI admin console (docs/design/admin-console-reference.md); refinements: workspace depth
  (canvas → panel → inset), contained text ADR, one indigo --wh-tint for wayfinding only.
- CSS: 2,080 lines across globals.css 803, surfaces.css 497, public.css 345, workspace.css 200, controls.css 138.
  ~342 bespoke .wh-* classes + Tailwind utilities. Unlayered .wh-* CSS beats Tailwind; rules redefined
  across files (.wh-page, .wh-panel-header defined twice with different values).
- No type tokens: 18 distinct px sizes hard-coded in CSS (14px×52, 12px×42, 13px×24, 15px×14, 11px×9, 10px×3).
- Radii: card 12 vs raised panel 14 vs inset 10 vs field 8, plus many hard-coded; .wh-card forced to 14px in
  workspace while rounded-card stays 12 → sibling corners differ. Shadows: one token + shadow-lg ×7.
- Dark mode OS-only; [data-theme] block never applied; 0 `dark:` utilities.
- BUG: workspace.css:26 active sidebar 3px tint bar overridden by line 84 → accent bar never shows.
- Primitives exist: Button/ButtonLink, Badge, Card, EmptyState, Field/Input/Select/Textarea, Notice/PageNotice,
  Status, Toast, CopyButton, ConfirmItsYou, SensitiveNotice, Skeleton, ViewPanels, FilterLinks, MultiSelectFilter,
  ListGroup, ListToolbar, ActionForm/FormSubmit, ServiceMark/AgentMark; shell: AppShell, WorkspaceHeading,
  WorkspacePanel, ActionBar, NavigationTabs, SectionNavigation, TabTrack, Status/Error/NotFound/Loading screens.
- MISSING: Dialog/ConfirmDialog (7 hand-built <dialog>s copying a ~300-char class string), Disclosure (40
  <summary>; ROW_DISCLOSURE defined 3×), Checkbox/Radio/Switch, IconButton, SegmentedControl, Table,
  DescriptionList (13 ad-hoc <dl>), Pagination (built 5× separately), Avatar, Stepper, Menu.
- Destructive confirmation: 4 coexisting patterns (native dialog, inline <details> reveal, client confirm state,
  deliberate one-click Disconnect).
- State shown 3 ways (Status colours text; TaskStatusBadge colours icon only; OpenedTag uses accent text).
- PageContainer used in 8 files vs raw className="wh-page" in 38.
- Icons: two sizing methods + mixed stroke widths (1.5 / 1.7 / 2).
- 155 *.test.tsx render tests with ~1,688 regex assertions on markup/copy/classes (55 files reference wh-* classes).
- Accessibility baseline is strong (ARIA tabs, native dialogs, skip link, reduced motion, forced colours).
- PWA manifest theme_color #4338ca is the retired indigo; no offline support.

## Evidence locations
Screens: <scratch>/run/<account>/shots/<config>/<key>.s<N>.jpg
  accounts: typical (3 agents incl. long-named Gemini, 25 records, tasks, 4 pending approvals, rules, household
  with pending invite, memories), firstrun (empty), worst (long names, 115 records)
  configs: light-390, light-768, light-1440, dark-390, dark-1440 (typical); light-390, light-1440 (firstrun, worst)
Metrics per capture: .../run/<account>/metrics/<config>__<key>.json (density: words, controls, surfaces,
  maxSurfaceNesting, tabs, headings; axe violations at light-390/light-1440/dark-1440; free text; overflow …)
Summary: .../run/<account>/summary.json   URL list: .../run/urls-<account>.json
Keyboard traces: .../run/typical/keyboard/<key>.json
