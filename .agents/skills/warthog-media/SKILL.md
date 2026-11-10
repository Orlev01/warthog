---
name: warthog-media
description: Present Warthog's QR codes, attachments, code and long values safely and responsively, and guide requested image, audio, video, table or chart UI. Use for media/content rendering and related display adaptation, without inventing new product features.
---

# Warthog media and content

Use [Warthog's foundations](../warthog-design-system/SKILL.md). Current media is
primarily authenticator QR codes, receipt attachments and code/secret displays.
Preserve those flows; new media libraries or preview services are not part of
routine design polish.

## Current content

- **Authenticator QR:** see [auth-views.tsx](../../../src/components/auth/auth-views.tsx).
  Preserve intrinsic dimensions, a square aspect ratio, the generated quiet zone
  and high-contrast background. Bound it to the available width with automatic
  height. Do not crop, invert it for dark mode or add decorative overlays. Retain
  the manual setup-key alternative and meaningful alt text; never repeat the key
  in alt text, analytics, a toast or a screenshot shared as evidence.
- **Receipt attachments:** see [life-admin-view.tsx](../../../src/components/life-admin/life-admin-view.tsx)
  and [receipt-upload.ts](../../../src/lib/receipt-upload.ts). Preserve the existing
  25 MiB size policy and encrypted-storage flow. Explain size constraints before
  upload, show pending/error results, and keep download controls reachable. Show
  filename/type only when actually available and wrap long names. Do not imply
  file-type validation or preview support that the backend does not provide.
  `GET /api/receipts/:id` is an owner-authenticated attachment download, not an
  inline-preview endpoint or public sharing URL; preserve that access boundary.
- **Settings exports:** [data-transfer.tsx](../../../src/components/settings/data-transfer.tsx)
  requests `POST /settings/data/export?device=1` and creates a device-local Blob
  download. It has no stable share/copy URL. Do not copy Blob URLs or invent public
  sharing or inline-preview endpoints for export feedback.
- **Addresses and exact code:** keep the value selectable and exact when copied.
  Use a bounded `min-w-0` container. Choose wrapping for readable addresses or
  local horizontal scrolling for code whose structure matters; never let its
  intrinsic width expand the page. Use the shared copy-feedback pattern.
- **Secrets and recovery values:** preserve explicit reveal/save/confirmation
  semantics. Do not truncate a value the person must record, add background
  persistence, or expose it in generic feedback. Use synthetic values for testing.
- **Money and summaries:** preserve currency codes, the distinction between
  approved and agent-reported amounts, and unavailable-total explanations in
  [spending-view.tsx](../../../src/components/spending/spending-view.tsx).

## When another media type is requested

- Images need intrinsic dimensions or an aspect ratio to reserve space, a width
  cap and useful alt text (empty for purely decorative images). Use `contain`
  for documents/diagrams and `cover` only where cropping preserves meaning.
- Audio/video needs keyboard-accessible controls and appropriate captions or a
  transcript. Avoid autoplay with sound. Keep playback bounded to its container
  and provide a useful loading/error state. Do not add remote loading implicitly.
- Tables are for comparisons with real row/column relationships. Preserve headers
  and semantics, and put essential wide tables in a labelled local scroll region.
  Key/value details usually reflow better as a definition list. Do not shrink text
  until a table fits or hide necessary fields on phones.
- Charts need a clear question, labelled units, textual values/summary and state
  distinctions beyond colour. Use them only when they explain the data better than
  the existing list; no chart library is needed for plain totals.

## Media preferences and review

Use the existing dark-mode and reduced-motion rules in
[globals.css](../../../src/app/globals.css). In forced-colour modes, preserve
native controls, visible boundaries and focus rather than relying only on fills.
Touch users need the same content/actions as hover users. Add print treatment only
when the requested workflow needs it; do not accidentally include hidden secrets.

Check loading, failure, long values, narrow containers, zoom and both themes.
Verify the actual media remains understandable: a responsive QR must still scan,
code must still copy exactly, and attachment controls must describe real behavior.
