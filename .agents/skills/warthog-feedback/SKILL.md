---
name: warthog-feedback
description: Implement Warthog's icons, contextual help, inline notices, copy feedback, toasts and accessible interaction states. Use when changing feedback or action affordances, preserving sensitive-data and confirmation behavior.
---

# Warthog feedback

Use [Warthog's foundations](../warthog-design-system/SKILL.md) and the current
[UI primitives](../../../src/components/ui). Read `Notice`, `CopyButton`, `Toast`,
`Status`, `Field` and `ConfirmItsYou` before composing their equivalent behavior.

## Choose the feedback surface

| User need | Treatment |
| --- | --- |
| Understand a field | Visible label and concise associated help |
| Correct submitted data | Persistent inline error near the field, `aria-invalid` and an associated description |
| Understand a section's caveat | Contextual `Notice` with readable words and a matching icon |
| See a connection/approval state | Existing `Status` text and icon; never colour alone |
| Know a simple action succeeded | Brief nearby status or shared toast after confirmed success |
| Resolve a failed action | Persistent actionable feedback; keep entered data where safe |
| Approve a sensitive/destructive action | Existing explicit confirmation and step-up flow |

Do not move security warnings, one-time-save instructions, important failures or
required decisions into an auto-expiring toast. Do not announce success before the
operation completes or show raw exception text to the user.

## Icons, help and interaction

- Use `lucide-react`: 16px for inline status/action icons and 18px for desktop navigation
  are the established sizes. Keep stroke/style consistent and icons `shrink-0`.
- Icons next to visible labels are decorative (`aria-hidden`). An icon-only
  control needs a specific accessible name and a 44px touch target. A `title`
  attribute alone is insufficient essential help.
- Put important explanations directly beside the relevant decision. Optional
  detail may use a labelled disclosure that works by touch and keyboard.
- Use `CopyButton` for clipboard operations (`value`, optional `successMessage`).
  It awaits acceptance, blocks duplicate attempts and keeps failures inline with
  a manual-copy instruction. Preserve a way to select the original value.
  Feedback says what happened without echoing the access key, setup secret,
  recovery phrase or other copied content.
- Preserve existing pending guards and disable duplicate submissions. Keep the
  action label understandable while waiting; a spinner alone is insufficient.
- Use polite status announcements for routine completion; reserve alerts for
  urgent/new failures. Avoid announcing the same message from nested live regions.
  Use `Notice announce={false}` for static explanatory help that is not a new
  action outcome; it remains visible without an unnecessary live-region role.
- The shared `Toast` takes `message` and `onDismiss`, keeps its polite announcer
  mounted, and deliberately has no auto-dismiss timer. Its arrival does not steal
  focus; copy-toast dismissal returns focus to Copy. Preserve wrapping, mobile
  viewport/safe-area clearance and reduced-motion behavior. Essential recovery
  must remain available elsewhere after dismissal.

## Verify behavior

Exercise success, rejection and unavailable-browser-API paths, rapid repeated
activation, keyboard operation and dismissal. Check what is announced and whether
focus remains with the task. Existing controller/render tests support these checks;
they do not by themselves verify live-region announcements or dialog focus behavior.
