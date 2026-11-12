---
name: warthog-design-system
description: Apply Warthog's measured admin-console design system, navigation hierarchy, tokens and shared primitives when building its web UI. Separate from the application's user-authored Skills feature.
---

# Warthog design system

Follow the [design decision](../../../docs/adr/admin-console-design.md) and
[measured reference](../../../docs/design/admin-console-reference.md). The founder
explicitly replaced the earlier indigo and bottom-navigation direction with the
OpenAI admin console's neutral workspace, grouped sidebar and layered views.
Keep Warthog branding, actual capabilities and the agent-first ownership model.

## Sources and primitives

[globals.css](../../../src/app/globals.css) owns tokens and workspace layout.
[fonts.css](../../../src/app/fonts.css) loads licensed local Inter; do not add
remote fonts or redistribute reference-site assets. Use existing Lucide icons.
Inspect the [UI primitives](../../../src/components/ui),
[AppShell](../../../src/components/shell/app-shell.tsx),
[PageContainer](../../../src/components/shell/page-container.tsx) and
[workspace navigation](../../../src/components/shell/workspace-navigation.ts).

| Purpose | Treatment |
| --- | --- |
| Canvas / sidebar / inset | `bg-bg`, `bg-sidebar`, `bg-surface-muted` |
| Main / supporting text | `text-fg`, `text-fg-muted` |
| Decorative dividers | `border-line`, stronger separation with `border-line-strong` |
| Form boundaries | `border-line-input`; decorative dividers are insufficient |
| Primary action | Neutral `accent`, `accent-hover`, `accent-fg`; pill shape |
| Meaningful state | `success`, `warning`, `danger`, with words and an icon |
| Focus / card / field | `focus`, `rounded-card` (12px; raised workspace groups 14px), `rounded-field` (8px) |

Use tokens in both explicit and system themes. Do not restore an indigo palette,
add a component-library dependency, or invent analytics or unavailable controls.

Never leave text loose on the canvas: every title, description, helper line, empty
state and link sits in a bounded component ([contained text](../../../docs/adr/contained-text.md)).
Use `WorkspaceHeading`, `WorkspacePanel`, `ListGroup`, `ListToolbar`, `PageNotice` and
`EmptyState` rather than hand-rolled wrappers.

Follow [workspace depth](../../../docs/design/workspace-depth.md) for signed-in
surfaces: a neutral canvas, raised groups and muted insets. Reuse
`WorkspaceHeading`, `WorkspacePanel` and the shared `Card`; texture stays in the
access-map introduction. Group resources separately from controls and evidence.
Branch lines describe navigation, never inferred live traffic or extra access.

## Hierarchy and organisation

- Group sidebar destinations by purpose. Keep every existing capability reachable.
- Use `NavigationTabs` for routes and `ViewPanels` for in-page state. Route links
  use `aria-current`; in-page tabs use the complete keyboard/ARIA tab pattern.
- Agent workspaces have Overview, Resources, Controls and Activity, with resource
  or control sub-tabs. Preserve the same agent ID and existing section parameters.
- Separate browsing, setup and preferences when a page otherwise becomes a long
  stack. Keep forms mounted across in-page tabs so drafts survive. Preserve URL
  filters and Back/Forward selection; validate view keys.
- Use a compact header, 24px phone / 28px desktop page titles, 14px interface text and 8px spacing
  rhythm. Keep body copy readable and phone inputs at 16px.
- Lists and settings use aligned rows and dividers. Cards group meaningful content;
  avoid nested cards, artificial equal heights and decorative dashboard metrics.
- Use one dominant action per active task. Preserve confirmation, validation,
  member scope, pending guards, secret handling and clear outcome feedback.

## Apply and verify

Read [mobile](../warthog-mobile-design/SKILL.md),
[desktop](../warthog-desktop-design/SKILL.md),
[feedback](../warthog-feedback/SKILL.md) or [media](../warthog-media/SKILL.md)
as relevant. Check realistic long content, empty/error states, both themes,
keyboard navigation and narrow reflow in the browser. Typecheck and existing
focused tests complement browser evidence; report exactly what was checked.
