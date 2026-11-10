---
name: warthog-desktop-design
description: Compose Warthog's admin-console desktop frame, bounded workspace content, grouped navigation and route/sub-view tabs while preserving mobile reflow.
---

# Warthog desktop design

Use the [foundations](../warthog-design-system/SKILL.md) and
[measured reference](../../../docs/design/admin-console-reference.md).

## Frame and width

- `AppShell` owns a 260px sidebar at 1024px and above. Its navigation scrolls
  independently; the brand and account footer remain reachable on short screens.
- The shared 52px header and optional route tabs span the main area. The main
  flex child must have `min-width: 0`; large content must not move the sidebar.
- `wh-page` owns gutters and caps broad lists/dashboards at 1216px. Use one outer
  width owner, never a page container nested inside another page container.
- `PageContainer` defaults to the 896px reading width. Use `size="form"` for a
  768px focused flow, or `size="wide"` for a comparative workspace/library.
  Individual forms and prose may need a narrower local maximum.
- Do not override these unlayered workspace CSS classes with contradictory
  Tailwind width/padding utilities. Use the explicit size/modifier API.

## Composition

- Start with grouped navigation, a page heading and one clear active task.
  Use real route tabs to coordinate related screens; use an in-page panel when
  the same loaded workspace switches views. Keep link and tab semantics distinct.
- Agent resource and control sub-tabs stay within the same agent. Account-level
  resource scope is a compact toolbar; do not obscure which grants are edited.
- Use 32px desktop content gutters, 24–32px section gaps, subtle dividers and
  aligned rows. Avoid a border around every paragraph or excessive nested cards.
- Additional columns must support comparison or adjacent tasks. Use shrinking
  tracks such as `minmax(0,1fr)`; preserve reading order when columns collapse.
- Short actions stay compact. Long names wrap. Tables use labelled local scrolling
  when necessary; the document itself must not scroll horizontally.
- Active tabs have a visible underline or shape cue. Hover-only actions must also
  work on focus. Preserve focus visibility at every container boundary.

## Verification

Check 1023px, 1024px, 1440px and a wider monitor, plus a short viewport and zoom.
Confirm intended width caps, sidebar/footer reachability, tab overflow containment
and deliberate whitespace. Recheck phones after changing shared primitives.
