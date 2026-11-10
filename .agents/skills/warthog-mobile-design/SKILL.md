---
name: warthog-mobile-design
description: Build and review Warthog's phone and tablet layouts, touch controls, safe areas and mobile navigation. Use when changing responsive UI or fixing narrow-screen clipping, overflow or oversized containers.
---

# Warthog mobile design

Use [Warthog's foundations](../warthog-design-system/SKILL.md). The brief requires
usable screens from 360px upward. Test 320px reflow when relevant to zoom or very
narrow devices; never disable pinch zoom to make a layout fit.

## Layout and containment

- Start with one column. Stack page actions and label/value pairs before their
  content becomes cramped. Add columns when the content fits, not merely because
  the viewport is called a tablet. Keep DOM order equal to reading/focus order.
- Keep the established 16px horizontal gutter. A page's width cap is a ceiling;
  content must shrink below it. Avoid fixed widths on forms, cards and media.
- Put `min-w-0` on shrinking flex/grid content. Use `minmax(0,1fr)` for flexible
  grid tracks, and wrap user-entered names, addresses and identifiers deliberately.
  `overflow-wrap:anywhere` is useful for unpredictable long values.
- Fieldsets have an intrinsic minimum width: use `min-w-0` when a responsive
  group contains file inputs or long legends, including nested vault controls.
- Permit horizontal scrolling only inside content that needs it, such as exact
  code or a comparison table. Do not use global `overflow-x-hidden` to conceal a
  document-width defect, and do not truncate information needed for approval.
- Do not add another page wrapper around views that already own their width and
  gutters. Check [PageContainer](../../../src/components/shell/page-container.tsx)
  and the affected page before composing it.

## Touch, navigation and overlays

- Keep interactive targets at least 44px in each practical touch dimension.
  Shared buttons and inputs already establish the height. Small icon artwork
  belongs inside a larger target, and controls need space between them.
- Use at least 16px input text on phones; changing browser zoom is not a remedy
  for small fields. Keep labels visible and helper/error text associated with inputs.
- [AppShell](../../../src/components/shell/app-shell.tsx) shows Home, Inbox,
  Activity, Agents and More below `lg` (1024px). Preserve these destinations and
  active-state labels; the desktop navigation has the same information architecture.
- Treat bottom-navigation safe-area padding and main-content clearance together.
  A fixed toast or action must sit above navigation and device insets. Check the
  viewport configuration in [site-metadata.ts](../../../src/app/site-metadata.ts).
- `viewportFit: "cover"` requires all four safe-area insets: document content
  owns the top and side padding; sticky navigation and fixed overlays account
  for their own viewport position. Do not handle only the home-indicator edge.
- For dialogs, constrain width to the viewport gutters and height to available
  dynamic viewport space. Scroll the dialog content when necessary. Keep its
  heading, dismiss action and submit controls reachable with the keyboard open.
  Preserve the existing focus and confirmation behavior.
- Do not make essential help or actions hover-only. Honor reduced-motion and
  system colour preferences through the shared stylesheet.

## Review evidence

Inspect the affected flow at 360px and 390px, a tablet width, and a short landscape
viewport. Include a long unbroken value, an error, the empty state and any open
dialog. Check the last control above the bottom nav, focus visibility, wrapping
and document-level overflow. Browser resizing is useful evidence, but does not
establish real-device keyboard, safe-area or screen-reader acceptance by itself.
