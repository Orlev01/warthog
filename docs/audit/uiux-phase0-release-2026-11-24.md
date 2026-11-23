# UI/UX phase 0: approvals say what they'd do, releases end, unsaved edits are kept — 24 November 2026

Application source `8cacbd547e62f9253ea10a9bd4a19c45734c0fc0` is live as revision
`warthog--r45274398968a1`. It carries PR #54. PR #53, the audit itself, is documentation only and
was merged after the image was built.

## Why

The [member-app UI/UX audit](uiux-audit-2026-11-23/README.md) (PR #53) found three critical defects:
- **W-01: approvals with no object.** When a rule held one of Warthog's own tools (add a task, save a
  record, remember), the Inbox showed no detail. Three different tasks read as three identical
  "Claude wants to add a task" cards, so the person approved blind.
- **W-02: released requests still looked undecided.** After a card or passport was handed over,
  Approve, Deny and Ask stayed live and the request stayed under "Waiting on you" until a reload.
  "Time left" was frozen at page load.
- **W-03: silent data loss.** Unticking card access on an agent and then opening another of its tabs
  dropped the edit with no warning, so card access stayed on. On Household, saving one panel wiped
  an address typed into another.

The founder said to proceed ("Please proceed as you see fit"), then to merge and release ("Yes
please merge and release and take everything through to the end completely").

## What shipped (PR #54)

- **W-01.**
  - The approval-card summary ([approval-card truth](../adr/approval-card-truth.md)) gains a `core`
    kind for `create_task`, `save_record`, `update_record`, `update_task`, `remember` and
    `log_activity`. It is built from the call's own arguments.
  - The sentence names the task or record ("wants to add the task “Book the car service”"), with
    detail lines. `update_record` shows removed fields and says when the older form replaces every
    field. History reads the same way.
  - Requests held before this release keep their old wording.
- **W-02.**
  - A finished release is terminal: a focused "Handed over" message with no live controls.
  - If nothing is left to read, the Inbox reloads with a new `released` notice, so the request moves
    to History and the counts change.
  - If a note or a new recovery phrase is left to read or save, it stays on screen with Done.
  - "Time left" is recounted in the browser.
- **W-03.**
  - A shared `useUnsavedChanges` hook asks before a link leaves the page, before a reload, and
    before saving one form reloads away another form's edits.
  - Server forms are compared with the values the page rendered them with, and the agent's access
    form with a snapshot.
  - The question uses a new shared `ConfirmDialog` primitive: safe choice first, Escape cancels.
  - Save with nothing changed says "Nothing to save".
- **W-19.** The active sidebar link's tint bar renders again (a duplicate rule in `workspace.css`
  overrode it). The manifest theme colour is no longer the retired indigo.
- **W-44.** Reduced motion now stops looping animations and smooth scrolling.
- **No other changes.** No migrations (still 91), and no configuration, package or infrastructure
  changes. W-45 (the reminder keypad) is left to PR #52, which replaces that field.

## Verification

- **Locally.**
  - 6,650 of 6,650 tests and a clean typecheck.
  - New tests include an end-to-end Inbox test: three held `create_task` calls through the real
    pipeline under an "any change" rule.
  - A `/code-review` pass found four issues, all fixed with tests before merge.
  - Browser checks (Playwright, virtual passkey, local dev):
    - W-01: three held tasks named in the Inbox.
    - W-02: the released notice.
    - W-03 on the agent page: Save with no change, the tab-switch question, Escape keeps the edit,
      save then navigate freely, Leave without saving discards.
    - W-03 on Household: names the other panel, confirm saves and discards, no false question
      after repeated saves.
    - W-03 at 390px: the dialog's focus order.
    - W-19: the computed tint bar.
- **PR checks:** passed on PostgreSQL 16. Main `8cacbd5` has exactly the checked tree, `6bd8bc43`.
- **Image.**
  - **Run 45273786581** reused the checks. The image is `…@sha256:40cd600b…`.
  - **Checks:** linux/amd64, UID 1000, no setuid or setgid, the deletion-journal label, 91
    migrations, 107 catalogue entries and 81 brand marks. The source hashes match.
  - **Scan:** no advisories in application dependencies.
    - Against the PR #51 image, 6 OS-package advisories were added: CVE-2024-22365 in libpam, and a
      Debian TEMP entry for login and passwd.
    - They come from the scanner's database update, not this release. The base digest is the same,
      the five OS layers are byte-identical, and the package versions are unchanged. Both need
      local interactive login, which the container doesn't offer.
- **Production.**
  - **Run:** [45274398968](https://github.com/Orlev01/warthog/actions/runs/45274398968) succeeded
    on a fresh private runner. Its plan was reviewed (11 creates, no deletes), the VM was checked,
    and private PostgreSQL DNS and TLS 1.3 were confirmed without credentials.
  - **Result:** one healthy replica, explicit 100% traffic and zero old replicas.
  - **Configuration:** unchanged apart from image and revision; the hash before was `ffef7f4f…`.
  - **Probe:** 79/79 before and after. The live manifest now serves `theme_color` `#ffffff`.
  - **Runner:** destroyed. The cleanup check found nothing left.
- **Not checked in production:** a held native-tool request in a real account (it needs an "any
  change" rule on a real account), and a full card release with a saved card. Both paths are
  covered by the tests above; the release cryptography and server checks are unchanged.
