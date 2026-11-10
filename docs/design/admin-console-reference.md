# Admin console design reference

Measured on 11 November 2026 from [OpenAI Admin](https://admin.openai.com/workspace/):
Usage, Insights (Overview and Use cases), and Members; desktop and 390px mobile,
with both light and dark colour schemes. Only design measurements are recorded
here. Workspace identities, member lists, usage values and reference screenshots
are not included in this repository.

## Visual direction

A neutral workspace with a narrow, grouped sidebar; compact page chrome; horizontal
underline navigation; and restrained surfaces separated by fine dividers. The
page hierarchy is navigation group → section → view → optional sub-view. Lists
and settings use aligned rows rather than a card around every paragraph. A black
or white primary action carries emphasis; semantic colour communicates state.

The implementation source is [globals.css](../../src/app/globals.css). Keep
Warthog's name, shield mark and existing locally licensed Inter assets. The
reference uses OpenAI Sans; it is not redistributed. Inter uses the measured
type sizes and line heights. Lucide remains the icon source, with thin 18px
navigation icons and 16px inline icons.

## Measured tokens

| Role | Reference light | Reference dark |
| --- | --- | --- |
| Main canvas | `#ffffff` | `#212121` |
| Sidebar | `#f9f9f9` | `#181818` |
| Inset surface | `#f3f3f3` | `#303030` |
| Body text | `#282828` | `#dcdcdc` |
| Muted text | `#5d5d5d` | `#afafaf` |
| Primary action | `#181818` | `#f3f3f3` |
| Primary action text | `#ffffff` | `#0d0d0d` |
| Soft emphasis | `#ededed` | `#393939` |
| Divider | Black at 10% | White at 12% |
| Keyboard focus | `#0169cc` | `#0285ff` |

Warthog resolves dividers into its `line` token and retains distinct, stronger
input borders and contrast-checked semantic status colours. Do not use the
low-contrast decorative divider as the only field boundary.

| Element | Measurement / implementation |
| --- | --- |
| Desktop sidebar | 260px, separated by a 1px divider |
| Page header | 52px minimum, 18px / 24px regular title |
| Sidebar group labels | 12–13px / 20px, muted, sentence case |
| Sidebar links | 14px / 20px, 36px desktop row, 10px radius |
| Primary tabs | 14px / 20px, thin active underline, 24px gaps |
| Section heading | 24px / 28–32px, weight 600 |
| Smaller heading | 18px / 24–28px, weight 600 |
| Controls | 14px desktop, 16px mobile text inputs |
| Action shape | Pill; icon controls and inputs use 8px corners |
| Cards and dialogs | 12px corners, subtle border, minimal depth; Warthog uses a shared black 40% backdrop |
| Content gutters | 16px mobile, 32px desktop content |

## Warthog information architecture

The existing agent-first ownership model is unchanged. Navigation only changes
how its controls are organised; it never changes a grant or implies control over
external activity.

| Sidebar group | Destinations | Deeper organisation |
| --- | --- | --- |
| Workspace | Home, Agents, Inbox | Agent list and connect views; individual agent workspace |
| Account resources | Connectors, Vault, Skills, Memory, Life admin | Connected services / Catalogue; Identity / Cards; Memory / Skills & plugins; Records / Tasks |
| Insights | Activity, Spending | Persistent links between activity and aggregate spending |
| Manage | Rules & budgets, Household, Settings | Settings overview, agent defaults, security, notifications, data & privacy |
| Resources | Help | Existing help routes |

An individual agent has **Overview, Resources, Controls, Audit log** as primary
tabs. Resources contains Connectors, Vault, Skills and Memory; Controls contains
Spending, Rules and Settings. Existing `?section=` links remain valid and select
both levels. All links remain scoped to the same agent.

The skills screen separates Library, Import & create, and Preferences. Connector
setup is separate from connected-account management. Life admin uses Records /
Tasks above its record-type tabs. View URLs restore selection, including browser
Back/Forward. In-page panels retain drafts when switching views.

## Composition and responsive behaviour

- The frame owns the 260px sidebar and page header. A section's optional route
  tabs span the content area. `ResourceScope` is a compact account/agent toolbar.
- `wh-page` caps broad lists and dashboards at 1216px including gutters.
  `PageContainer` defaults to the 896px reading width; `size="form"` uses 768px
  and `size="wide"` uses the broad workspace width. Keep individual forms and
  prose narrower when the task needs it.
- Home can compare recent activity with agents/reminders in two columns when
  space permits. Small screens return to reading order in a single column.
- Below 1024px, a named menu button opens the same grouped navigation in a native
  modal drawer. Escape, backdrop dismissal, focus containment and restoration
  follow the dialog. Closing the drawer after navigation restores the page.
  The legacy `/more` route still works; it is not the primary mobile menu.
- Touch targets remain at least 44px. The reference's smaller desktop controls
  are not imposed on phones. In-page tabs scroll within their own track; they
  cannot widen the document. Text and fields wrap without global overflow hiding.
- All four safe-area insets are handled. Toasts sit above the viewport inset;
  they no longer reserve space for a bottom navigation bar. Reduced motion and
  explicit/system colour schemes remain supported.

## Interaction contracts

Cross-page tabs are normal navigation links with `aria-current="page"`. In-page
tabs use `tablist`, `tab`, `tabpanel`, associated IDs and roving keyboard focus;
Left/Right, Home and End change the selected view. Selection has an underline or
shape cue as well as colour. Active sidebar destinations carry weight and a dot.
Confirmation, pending guards, notices, clipboard outcomes and sensitive-data
boundaries retain their existing semantics.

## Extraction repositories reviewed

[design-extract](https://github.com/Manavarya09/design-extract), commit
`6050fdb470d87c14f3db42a07ba782ca93286c75`, supplies deterministic approaches to
computed-style, layout and responsive measurements. Its optional model-assisted
classification was not used.
[design-system-extractor](https://github.com/KunalKumarkkr01/design-system-extractor),
commit `1d75a8af6d3aab020dc7d694d0ef728eef8865be`, supplies a useful role-by-role
measurement checklist and implementation-reference structure. The same browser
measurements were made through the available authenticated browser connection.
Neither repository, browser credentials nor extraction runtime is shipped in
Warthog, and no new application dependency is introduced.
