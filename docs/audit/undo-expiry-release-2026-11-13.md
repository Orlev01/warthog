# Undo guard, approval expiry and Inbox marks release — 13 November 2026

Application source `81a98621567c3638248bbcf0de4b6da6e320f6e7` is live at
[app.warthog.com.au](https://app.warthog.com.au) as revision
`warthog--r43325136204a1`.

## What shipped

- **Undo runs once.** Before running a reversal, an Undo claims its entry in
  `activity_undo_claims` (migration 0108) with an atomic insert. A double-click, two
  concurrent requests or a later click on an undone entry runs and records nothing,
  and says so in a notice.
  - A refused or failed reversal releases the claim, so a retry can run.
  - A reversal held for approval records its approval id on the claim. If that
    approval is denied, expires or no longer exists, the claim is stale and Undo is
    offered again.
  - Activity shows three states: Undo, "Undo waiting for your approval" (linking
    to the approval in the Inbox) and "Undone".
  - The runtime role may insert, select and delete claims, and update only
    `approval_id`.
- **Approval expiry is a setting** (brief: default 15 minutes, adjustable from
  2 minutes to 24 hours). It is stored in `approval_settings` (migration 0109), and
  the pipeline reads it when it holds a call.
  - The setting is on Rules & budgets, Your rules tab, with presets from 2 minutes
    to 24 hours.
  - A warning shows when the expiry would leave the text or email reminder no time
    to send.
  - Each save is recorded as an account change.
  - The Inbox shows long waits in hours, and Help explains the setting.
- **Inbox agent marks:** pending requests and past decisions show the requesting
  agent's brand mark.

## Verification

- [Main CI 43315290653](https://github.com/Orlev01/warthog/actions/runs/43315290653):
  **5,739 tests**, zero failures, cancellations or skips; the
  [image run 43315354030](https://github.com/Orlev01/warthog/actions/runs/43315354030)
  repeated them before publication.
- Image `crwarthogprodauee854.azurecr.io/warthog@sha256:7c366a3ca5bc435595d1735687f4a4c9245a159d5939ede2e1a605d1dfdd2c9e`:
  exact source label, pinned base, journal label `v1`, linux/amd64, UID 1000, no
  setuid/setgid. All 80 migration, 106 catalogue and 80 brand file hashes match the
  source. Scan: the same 219 OS package/advisory pairs as the previous image, zero
  non-OS.
- [Production run 43325136204](https://github.com/Orlev01/warthog/actions/runs/43325136204)
  succeeded. Independent inspection: one healthy replica, exact image, explicit 100%
  traffic, zero old replicas. Configuration unchanged apart from image and revision;
  the deletion journal setting is unchanged.
- Public checks: health 200, public pages 200, signed-in routes redirect to sign-in,
  unauthenticated `/mcp` 401.
- The founder's signed-in Rules page shows the Approval expiry panel at its
  15-minute default.
- A local browser pass with seeded data covered all three Undo states, the expiry
  warning and the Inbox marks, in light at 1440 px and dark at 390 px, with no
  overflow or console errors.
- Runner: fresh private lease (11 reviewed creates), destroyed after the job. The
  group, resources, grants and subnet NAT were verified absent, no GitHub runner
  remains, and the ephemeral key was deleted.

## Release process change

At the founder's request, the required-reviewer rules were removed from the
`azure-images` and `azure-production` GitHub environments. Each keeps its `main`-only
deployment branch policy. The release operator now runs image publication and
production releases end to end.

Removing the rule cancelled the deployment that was then waiting (run 43320577641),
before any runner existed or anything changed. The release was dispatched again as
run 43325136204.

## Known edges

- A reversal approved by the person reads "Undone" even if the provider then fails to
  delete the event.
- An overdue pending approval reads as waiting until the expiry job marks it, within
  about a minute.
- With text reminders on but no verified mobile number, the expiry warning can show
  for a reminder that would not have been sent anyway.
