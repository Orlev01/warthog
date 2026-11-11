# UI, usability and accessibility bug bash

Reviewed on 2026-11-11 against `5882213` and the coordinated bug-bash changes. This
perspective used static review, injected deferred requests and rendered semantic
markup. The root agent owns the shared browser preview, full build, integration and
deployment. No production data, credentials or provider notifications were used.

## Findings and disposition

| ID | Severity | Finding and reproduction | Disposition |
| --- | --- | --- | --- |
| UX-01 | P2 | `src/components/auth/signin-flow.tsx:129`: start a passkey sign-in with a slow begin/finish response, then submit again or switch methods. The controller did not mark the passkey path busy; concurrent challenges and email changes were possible. `auth-views.tsx` also ignored the existing busy prop for that step. | Fixed. A synchronous guard covers the whole ceremony, captures the email, freezes edits/method changes, resets in `finally`, and shows a pending label. The initiating button remains focusable with `aria-disabled`; the controller enforces exclusion before React rerenders. |
| UX-02 | P2 | `src/components/auth/factor-controls.tsx:141`: rapidly request new recovery codes or add a passkey during generation. The operations had no shared pending guard. Show a code, request another, then reject the response: the previous, potentially invalid code remained visible. Server-action rejection also escaped without a visible outcome. | Fixed. One guard serializes all security operations, including step-up/resume. Errors use safe inline copy, `finally` releases pending state, and the old code is removed as soon as replacement begins. Confirmation retains exactly the change requested and resumes it once. |
| UX-03 | P2 | `src/components/auth/recover-flow.tsx:145` and `reset-flow.tsx:110`: defer an email or passkey request and activate the same action twice. Both requests/OS ceremonies start; inputs remain editable and late responses can overwrite the current step or its recovery output. | Fixed. Recovery, reset and reset-setup use synchronous exclusion, protected inputs, pending labels, safe errors and `finally` cleanup. Missing handles/options remain on a usable retry step. |
| UX-04 | P2 | `src/components/auth/device-flow.tsx:189`: let a collection request exceed the three-second polling interval. Another collection starts before the first finishes. A response belonging to an abandoned request can later navigate or stop the replacement flow. A successful response without `requestId` enters an endless waiting screen. | Fixed. One collection runs per request generation. Responses are checked against the current generation and handle, success consumes the handle, and missing handles produce a visible error on the form. Code sending and approval requests also share a pending guard. |
| UX-05 | P2 | `src/components/skills/package-editor.tsx:96`: save files, then type more while the server response is pending. The submitted files are an earlier snapshot; `onSaved` reloads the library and drops the later edits. Access saves could also overlap the package save/reload. | Fixed. All package/access operations share a synchronous guard in `package-operation.ts`. A disabled native fieldset freezes file editing, file selection/add/remove and access controls while pending. Error paths retain existing edits and unlock retry; the primary Save stays focusable. |
| UX-06 | P2 | `src/components/ui/field.tsx:43`: a server response adds a field error while keyboard focus stays on Submit. The input referenced the error, but the new message had no announcement role. | Fixed. The actual visible error text has `role="alert"`, preserving its input association and avoiding a second duplicated live message. Semantic render test added; live screen-reader behavior remains part of manual/browser verification. |
| UX-07 | P3 | `src/components/auth/auth-views.tsx:62`, `:116`, `src/components/memory/memory-view.tsx:163`, `:225`, `src/components/skills/skills-view.tsx:310`: auth fallback links, the saved-recovery checkbox label and Memory/legacy Skills disclosure labels had text-height targets rather than the mobile skill's 44px minimum. | Fixed. These targets now use `min-h-11`; disclosure controls retain explicit token-based keyboard focus styling. No palette or page-anatomy changes. |
| UX-08 | P2 | The server security review now invalidates a pending recovery when its old recovery proof was rotated or expired. Retrying registration from the passkey step cannot repair that consumed handle. | Fixed in `recover-flow.tsx:234`. `not_verified` and `unknown_recovery` return to the email/recovery start with a clear explanation, retaining the email and clearing obsolete proof/output. This matches the security agent's handler semantics. |
| UX-09 | P2 | `src/components/life-admin/life-admin-view.tsx:174`: record Add and other mutations used bare forms/buttons, allowing rapid repeated submit events and offering no pending feedback. Editing remained possible while the action could redirect away. | Fixed. Shared `ActionForm` reserves the native submit event synchronously, then guards action execution. `PendingFormFields` freezes editable values after FormData capture. Existing `FormSubmit` now supports a secondary variant and focus-preserving pending labels; Life Admin uses these for add/edit/reminder/file/delete/handoff, with pending checkbox feedback for checklist updates. Framework redirects propagate unchanged. Life Admin disclosures also now have 44px targets and explicit focus styling. |
| UX-10 | P3 | Root's synthetic Home browser pass showed raw `subscription`, `receipt_warranty`, and `renewal_appointment` in Reminders. `src/app/(portal)/(protected)/home/actions.ts:125` read only `fields.title`, whereas portal Add writes `fields.name`. | Fixed. Prefer a nonempty title, name or legacy what from the already decrypted owner-scoped record. Records without one use friendly category labels. A database-backed regression checks these cases and excludes another account's private title. |
| UX-11 | P3 | Root entered `14,typo` in reminder offsets: validation correctly retained stored offsets but returned generic retry copy, with no input-format guidance. | Fixed together with root. The view associates format help with the reminder input (whole days from 0 to 36500, comma-separated; empty turns reminders off), and root added a specific `invalid_reminders` notice in the server page. |
| UX-12 | P2 | Root's 320px browser pass opened a saved package from its library card, then pressed Escape. The dialog unmounted and keyboard focus fell to the document body instead of the card. The same lifecycle affects desktop keyboard users. | Fixed; root's final browser recheck passed for both Escape and Close, returning focus to the exact originating card. The first attempt captured `activeElement` in the modal effect and **failed both Escape and Close rechecks**: the loading state had already disabled the initiating card and moved focus to body. `SkillsView` now captures the actual clicked card before the asynchronous load, keeps it focusable with an enforced pending guard, and restores the connected target after the dismissal render. A removed opener falls back to the library heading. The native dialog closes before unmount; save/reload and pending-close protection are preserved. |
| UX-13 | P2 | Root's browser pass submitted the alternate sign-in email step. The email correctly froze but its native-disabled submit button lost keyboard focus to body and lacked `aria-busy`. | Revised pending actions retain focus through `aria-disabled`/`aria-busy`, while guarded form handlers block Enter and repeat submits as well as clicks. The sign-in, recovery, reset and device controllers already serialize these operations; signup's existing synchronous transition guard was verified before applying the same pattern there. A new red-first regression covers focusable pending markup and direct form/Enter handler exclusion. Root confirmed the final live recheck: the pending button retains focus and aria-busy while the email input freezes under 1500ms simulated latency. |

## Verification

- Red-first deferred tests reproduced three sign-in/factor/pending-view failures and
  six recovery/reset/device/pending-view failures before their fixes. The existing
  Field test also failed first when the new announcement expectation was added.
- Deferred requests cover duplicate actions before a render, exclusion through both
  begin and finish, edits during pending work, cancellation, rejected server actions,
  retry after failure, stale recovery output, confirmation resume, stale device
  responses, and stopping collection after successful sign-in.
- Additional tests cover malformed recovery/setup responses and the new stale-proof
  restart path. Package-operation tests cover cross-operation exclusion and a lost
  save response with a safe error and a subsequent retry.
- The final combined focused run passed **262 tests**: all auth component tests,
  package operation/library/skills, Memory, Field/FormSubmit, ViewPanels, AppShell,
  Life Admin and the Home dashboard mapping. Command:

  ```sh
  node --import tsx --test 'src/components/auth/*.test.tsx' \
    src/components/skills/library.test.tsx src/components/skills/package-operation.test.ts \
    src/components/skills/skills-view.test.tsx src/components/memory/memory-view.test.tsx \
    src/components/ui/field.test.tsx src/components/ui/form-submit.test.tsx \
    src/components/ui/view-tabs.test.tsx src/components/shell/app-shell.test.tsx \
    src/components/life-admin/life-admin-view.test.tsx \
    src/components/life-admin/record-scheduling.test.tsx \
    src/components/life-admin/life-admin-tabs.test.tsx \
    src/components/life-admin/receipt-upload-policy.test.ts \
    'src/app/(portal)/(protected)/home/actions.dashboard.test.tsx'
  ```

- `git diff --check` passed. Root owns the project type check, production build, full
  suite and browser verification to avoid `.next` contention.
- The first modal focus patch passed 19 existing skills/editor tests but failed the
  real browser recheck, which exposed late opener capture after the card was disabled.
  After the revised caller capture and pending-auth changes, the focused auth/skills
  tests and diff check passed again. Lifecycle focus is verified through root's live
  browser pass rather than inferred from server-rendered markup or source-text tests.

## Coverage and design observations

Read Warthog's design-system, mobile, desktop, feedback and media skills and the
admin-console/agent-first ADRs. Reviewed the shell/drawer, page measures, route and
query tabs, safe-area CSS, form primitives, feedback/copy patterns, auth flows,
agent workspace/permission language, library/import/editor, Memory, spending,
notifications, activity, Life Admin and vault control patterns.

The neutral admin design already has useful bounded page widths, zero-minimum grid
tracks, wrapping long data, consistent semantic tokens and separate route navigation
versus local tabs. The shared tab implementation preserves mounted drafts and uses
arrow/Home/End navigation with roving focus. The mobile drawer uses a named native
modal dialog. These were preserved rather than replaced.

The Life Admin changes owned by root were reviewed separately: date values remain
`YYYY-MM-DD` through the database text cast and native date input; a blank date
explicitly clears scheduling; `field:` names separate personal fields from metadata;
return-tab values are allowlisted; server initial-tab selection exposes the linked
record before fragment navigation. Labels/help associations and the focusable record
target are appropriate. The nearby pre-existing small disclosure targets and missing
pending states on raw record-submit buttons were subsequently assigned to this
perspective and fixed as UX-09.

## Boundaries and follow-up checks

This review does not assert that every route was exercised in a real browser or
that assistive-technology announcements were manually heard. The root coordinator performed the recorded browser matrix; additional device acceptance can
include 320/375px phones, tablet and wide desktop; long names/URLs; keyboard tab and
drawer operation; active URL tabs after Back/Forward; sign-in cancellation/retry;
package editing while a save is pending; and Life Admin due-date/return-tab behavior.
Native WebAuthn hardware ceremonies and production provider sends were not invoked.

The package editor's disabled-fieldset wiring was statically reviewed alongside
guard tests and server-rendered editor tests; root verified the live pending interaction under simulated latency and confirmed saved content afterward. Broad changes to every legacy server-action
form, account-currency control placement, or general copy were not bundled into this
pass without a concrete failure and coordinated ownership. Root's browser report
contains the observed combined-flow results; this report distinguishes those
delegated checks from this perspective's controller and markup evidence.
