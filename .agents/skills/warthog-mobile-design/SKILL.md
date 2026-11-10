---
name: warthog-mobile-design
description: Build and review Warthog's phone/tablet drawer navigation, tabs, touch controls, safe areas and responsive content under the admin-console design system.
---

# Warthog mobile design

Use the [foundations](../warthog-design-system/SKILL.md). The brief requires 360px
upward; include 320px reflow for narrow devices and zoom. Never disable pinch zoom.

## Navigation and layered views

- Below 1024px, the named header menu opens the same grouped navigation as desktop
  in a native modal drawer. This supersedes the old mobile bottom bar; `/more`
  remains a compatibility route. Destinations are still within two taps.
- Preserve drawer focus containment, Escape/backdrop dismissal and focus return.
  Navigation closes the drawer; resizing to desktop closes it as well. The drawer
  must scroll and keep sign-out reachable on short screens.
- Main tabs can scroll in their own track. Sub-tabs can wrap when brief. Neither
  may widen the document or clip focus. Do not shrink labels to fit a long row.
- `ViewPanels` preserves drafts and URL selection. Check keyboard arrows,
  Home/End, refresh and browser Back/Forward after altering its behaviour.

## Content, controls and safe areas

- Start with one column and 16px gutters. Use `min-w-0` on shrinking flex/grid
  children and fieldsets, including file controls. Stack actions and label/value
  pairs before they compete for space; keep reading and focus order aligned.
- Wrap unpredictable values with `overflow-wrap:anywhere`. Preserve exact code
  in a bounded local scroll region when wrapping would obscure it. Never hide a
  document-width defect with global `overflow-x-hidden`.
- Keep touch targets at least 44px and text inputs at least 16px. Compact desktop
  controls do not justify smaller phone targets. Icons need named controls.
- `viewportFit: "cover"` requires all four safe-area insets. The document owns
  top/side padding; the fixed drawer, dialogs and toasts account for their own
  positions. Toasts use viewport clearance, with no old bottom-nav offset.
- Constrain dialogs to safe gutters and dynamic viewport height. Keep heading,
  cancellation and submit controls reachable with the keyboard open. Preserve
  existing sensitive-action confirmation and imperative dialog behaviour.
- Keep essential help available by touch and keyboard; respect reduced motion
  and system or explicit colour preferences.

## Verification

Check 320, 360, 390 and 768px, short landscape, long labels, an error/empty view,
open navigation and a dialog. Verify no document overflow, reachable last controls
and visible focus. Simulate actual safe-area insets; resizing alone does not prove
real-device keyboard or screen-reader acceptance.
