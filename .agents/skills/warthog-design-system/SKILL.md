---
name: warthog-design-system
description: Apply Warthog's existing design tokens, typography, component primitives and content density when building or polishing its web UI. Use for Warthog UI work, not for the application's user-authored Skills feature.
---

# Warthog design system

Preserve the calm, practical interface in [brief.yaml](../../../brief.yaml) and
[technical-design.md §11](../../../docs/design/technical-design.md#11-look-and-feel).
Improve hierarchy, sizing and feedback without replacing the visual identity.

## Sources and primitives

[globals.css](../../../src/app/globals.css) is the visual token source;
[fonts.css](../../../src/app/fonts.css) loads local Inter. Use the existing
[UI primitives](../../../src/components/ui), [PageContainer](../../../src/components/shell/page-container.tsx)
and [AppShell](../../../src/components/shell/app-shell.tsx) before introducing another pattern.
Inspect nearby callers and the current component API rather than copying class strings blindly.

| Purpose | Existing tokens / treatment |
| --- | --- |
| Canvas, raised surface, inset surface | `bg-bg`, `bg-surface`, `bg-surface-muted` |
| Main and supporting text | `text-fg`, `text-fg-muted` |
| Decorative dividers | `border-line`; use `border-line-strong` when stronger separation is needed |
| Form boundaries | `border-line-input`; the faint divider token is insufficient for an input boundary |
| Primary action / selected emphasis | `accent`, `accent-hover`, `accent-fg`, `accent-soft` |
| Meaningful state | `success`, `warning`, `danger`, always with words and, where helpful, a Lucide icon |
| Focus / corner shape | `focus`, `rounded-card` (0.75rem) |

The brand is zinc neutrals with one indigo accent. Keep colours token-based so both
explicit and system dark mode work. Do not add raw colour values, an unrelated icon
family, remote fonts or a component-library dependency for routine polish.

## Hierarchy and density

- Use the existing page-title treatment (`text-2xl font-semibold tracking-tight`),
  section headings (`text-lg font-semibold`) and field/list labels (`text-sm font-medium`).
  Compact flow titles may use `text-xl`. Keep one clear page heading.
- Use the 8px spacing rhythm: 16px card padding, 24–32px section gaps and 16px mobile
  / 24px larger-screen page gutters are established defaults. Small 4–6px gaps belong
  between a label and its help or an icon and text.
- Match width to the task: auth is narrow, settings/forms use a readable column,
  dashboards may be wider. Preserve one outer page container; do not double-pad a view.
- Use `Card` for a meaningful group, not every paragraph. Prefer spacing and a subtle
  divider to repeated nested borders. Keep helper copy subordinate but readable.
- Use one dominant primary action in the active task region. Secondary actions use
  the neutral variant; destructive actions need explicit wording and the existing
  confirmation flow. Colour does not replace consequences or confirmation.
- Reuse `Field`, `Input`, `Select`, `Status`, `EmptyState`, `Skeleton`, `Notice` and
  `CopyButton` for their existing purposes. Keep loading, empty, error and success
  states deliberate. A layout change must not weaken a sensitive-data boundary.

## Apply and verify

Read [mobile](../warthog-mobile-design/SKILL.md) or
[desktop](../warthog-desktop-design/SKILL.md) for layout work,
[feedback](../warthog-feedback/SKILL.md) for interactions, and
[media](../warthog-media/SKILL.md) for content-specific treatment.
Check the affected screen in light and dark mode with realistic long content and
keyboard focus. Use existing focused tests and typecheck; browser evidence is needed
to claim that a visual or responsive defect is fixed. State exactly what was checked.
