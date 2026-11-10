---
name: warthog-desktop-design
description: Polish Warthog's desktop and wide-screen content widths, page composition, sidebar layout and keyboard access while preserving mobile reflow. Use for stretched forms, oversized cards or desktop density changes.
---

# Warthog desktop design

Use [Warthog's foundations](../warthog-design-system/SKILL.md). Extra viewport width
is available space, not an instruction to enlarge every card or form.

## Choose a width by purpose

| Surface | Existing starting point |
| --- | --- |
| Authentication and one-task entry | `max-w-sm` (24rem), as in `auth-views.tsx` |
| Focused settings, detail lists and forms | `max-w-2xl` (42rem), the `PageContainer` default |
| Dashboard, spending and broader summaries | `max-w-3xl` (48rem), as in their existing views |
| Long-form prose | A readable prose measure within its page container |

These are defaults, not reasons to normalize every existing screen. A genuinely
comparative workspace can justify more space, but document the content need and
check both narrow and wide behavior. Do not replace content caps with `w-screen`
or unrestricted `w-full` to fill the monitor.

## Compose the page

- Use one centered outer width/gutter owner. Inspect the view before adding
  [PageContainer](../../../src/components/shell/page-container.tsx); some views
  already own their container. Keep titles, section edges and primary content aligned.
- [AppShell](../../../src/components/shell/app-shell.tsx) switches to its 16rem
  sidebar at `lg` (1024px). The main flex child must be allowed to shrink with
  `min-w-0`. A wide child must not push the sidebar or document off-screen.
- Use multiple columns for related information people compare or use together.
  Keep long forms in one readable column; pair short fields only when their
  relationship is clear. Do not stretch a short action to full desktop width.
- Give grid tracks explicit shrink behavior (`minmax(0,1fr)` where appropriate).
  Make page headers wrap or stack when their title and actions compete for space.
- Preserve comfortable 24–32px section spacing. Avoid huge blank card interiors,
  arbitrary equal heights and nested containers introduced only for symmetry.
- Keep sidebar navigation and its footer reachable on short screens. For dialogs,
  cap width for the task and height for the viewport; preserve internal scrolling.
- Mouse convenience does not replace keyboard access. Actions revealed on hover
  must also be available on focus, with visible focus that is not clipped.

## Review evidence

Inspect just below and above the 1024px navigation change, then at 1440px and a
wider monitor width if the change concerns stretching. Include a short viewport,
long labels/values and browser zoom. Verify deliberate content caps and whitespace,
stable sidebar placement, reachable controls and no document-level horizontal
scroll. Recheck the mobile layout after altering any shared container or primitive.
