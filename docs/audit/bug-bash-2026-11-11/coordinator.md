# Comprehensive bug bash — 11 November 2026

Status: fixes integrated on main, deployed and verified. See the [release record](../bug-bash-release-2026-11-11.md) for the exact image, approvals and cleanup evidence.

Base: latest main `5882213b21fd7047f014596ef04ba027aa6f0ff6`, following the
deployed admin-console and agent-first integration. Work was isolated on
`codex/warthog-bug-bash`; the other checkouts were untouched.

## Independent perspectives

- Security: authentication, recovery, OAuth, cryptography, outbound transport,
  caller isolation and abuse boundaries. See `security.md`.
- Correctness: policy/grant consistency, transactions, resource lifecycle,
  concurrency, jobs, tasks, household and connector behavior. See `correctness.md`.
- UX/accessibility: mobile/desktop, forms, async feedback, keyboard/focus,
  navigation, media and current design-system consistency. See `ux.md`.
- Coordinator: runtime/configuration, dependency/image advisories, delivery
  safeguards, cross-layer integration and browser acceptance.

Reports distinguish reproduced defects, additional hardening and unverified
hypotheses. No production messages or destructive user-data tests are authorized
by this verification pass; behavioral tests use synthetic local fixtures.

## Coordinator findings and disposition

1. **Life-admin scheduling controls missing:** the portal add/edit forms never
   submit the supported `dueDate` metadata. A newly created portal record cannot
   schedule a reminder, and an existing date cannot be changed through the UI.
   Implemented: editable date/status, versioned metadata separated from personal fields,
   shared date/offset validation, correct selected-tab return and record anchors. Regression tests failed against the baseline and now pass. Legacy forms left open before deployment retain their personal fields and cannot accidentally overwrite scheduling metadata. Empty reminder input now disables reminders; malformed entries refuse the whole change with actionable feedback.
2. **Reminder destination lost in production push:** `createUserPushSender`
   discards `OutgoingMessage.link`; `sendNotificationPush` emits an empty payload,
   and the worker opens Home. Implemented: validate a narrowly scoped opaque
   record reference, preserve privacy, route to the corresponding record tab,
   and reject arbitrary URLs/content. The correctness reviewer separately owns
   the nonexistent reminder route and stale due-cycle marker fixes.
3. **Readiness work amplification:** concurrent public readiness requests each
   enqueue a separate database query. PostgreSQL acquisition/statement timeouts
   already bound failure modes. No exploit or production load failure was reproduced. Deferred as an unverified load-hardening hypothesis: changing probe caching/coalescing without load evidence can hide recovery or prolong stale status. No rate/load claim is made.

4. **Push sends could stall indefinitely:** confirmed by the security reviewer. Implemented a 15-second abort deadline and unconditional unused-body disposal/transport close. A stalled fake endpoint and success/failure response tests prove cancellation. No live provider receipt is claimed.
5. **Browser-driven integration fixes:** the UX reviewer corrected Home reminders displaying raw category identifiers despite having an owner-scoped record name. Actual delayed saves verified package inputs freeze and submitted content survives; keyboard rechecks drove additional focus restoration fixes. See the UX report for final results.

## Baseline checks

The current official Node22 Bookworm slim manifest still resolves to reviewed digest `5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d` (11 November recheck). Debian continues to mark the critical minizip source finding as not built into the affected Bookworm zlib binaries; this is component applicability, not suppression or a zero-risk claim. [Vendor record](https://security-tracker.debian.org/tracker/CVE-2023-45853).

Fresh npm audits reported zero vulnerabilities in both runtime-only and full
dependency trees. This is not a zero-vulnerability claim for the container:
the deployed image retains its separately reviewed OS advisories. The release
candidate received a fresh immutable-image scan before deployment; results are in
the [release record](../bug-bash-release-2026-11-11.md).

29 delivery-safety tests and 5 cost-model tests passed; approved-profile calculation agrees. TypeScript checks passed after accurately typing the reusable software authenticator now used in real PostgreSQL contention tests.

Current runtime review confirms non-root standalone packaging, an allowlisted
Docker context, production configuration guards, separate ownership checks,
nonce-based CSP, private receipt downloads and unchanged protected deployment
gates. This review does not certify every code path.

## Completed browser coverage

Synthetic local data only, using a separate PGlite directory and localhost:3087. No real provider messages, account deletion, vault destruction or credential changes were performed.

- 14 primary portal routes at 320, 768, 1023, 1440 and 1920 CSS pixels: 70 route/width checks.
- Four nested settings pages at 320 and 1440: 8 checks.
- 14 portal routes plus five authentication pages at 390 in light mode: 19 checks.
- These 97 checks showed no document overflow, missing page heading or application error; baseline route navigation produced no console warnings/errors.
- Long synthetic identifiers and agent names wrapped; horizontal tabs remained contained within their scroll region.
- Created a scheduled receipt for leap-day 2028; edited/cleared a different record date without changing its personal field named dueDate; verified receipt-tab returns and unchanged records after invalid reminder input; empty input disabled reminders.
- A notification-style record URL selected the matching tab and scrolled to the record anchor at 320px.
- Created and edited an initially disabled synthetic skill at 320px; under 1500ms simulated latency, the editor froze fields, preserved the submitted content, and retained the Save control during pending work.
- Final keyboard rechecks passed: Escape and Close return from the package dialog to the exact originating card; the alternate sign-in email submit retains focus while pending and freezes the email field. The first dialog fix failed browser verification and was corrected by capturing the caller before asynchronous loading.
- Final record creation after adding form-version compatibility persisted the selected date.
- Light mode and reduced-motion emulation were exercised. Real iOS delivery, hardware passkeys and assistive-technology speech remain outside these browser checks. One development Fast Refresh reload warning occurred while code changed; no application console errors were observed. All temporary viewport, media and network overrides were reset and the test tab closed.

Screenshots use synthetic local fixtures: [mobile scheduling](mobile-record.png), [saved mobile record](mobile-record-saved.png), [desktop home](desktop-home.png).

## Migration and operational impact

Migration 0105 adds a nullable OAuth client-binding column. New grants, rotations and retries retain the validated client. Legacy refresh tokens cannot be safely backfilled and return `invalid_grant`; existing access tokens remain valid until their normal expiry. Reauthorization creates a new agent connection through the existing consent flow: review/reapply custom grants and remove the obsolete connection after the replacement works. Static access keys and provider connector credentials are unaffected. The additive schema supports old-runtime reads/inserts, but rolling back the code restores the binding defect and may create new unbound tokens. See the [migration decision](../../adr/oauth-refresh-client-binding.md).

## Validation and release

Completed before release: three independent reviews and cross-reviews; all confirmed findings accepted above; targeted regressions; TypeScript; optimized Linux production build; 97 responsive/theme route checks and the recorded interactions; dependency audits; delivery/cost guards; latest-main fetch still at the stated baseline. No new runtime dependency, service, spend tier or deployment permission was introduced.

Complete Linux validation passed: **5,225 tests, zero failures/skips**, optimized build, TypeScript and real PostgreSQL16. The database checks cover all 76 migrations and idempotence, runtime/migration/purge role separation, exclusive ownership, household budgets, OAuth client binding/replay/legacy tokens, both recovery generation lock orders, agent claims/quotas/audiences/package revisions, receipt locking and cascade purge. Runtime staging verified 106 catalogue entries. The disposable containers and internal network were removed.

Release completed from `9a7de2e58e9ed3bede61d65bbb9716d0a2214900`. Main and pinned-image CI each passed all 5,225 tests. Both protected GitHub environments were approved by the founder. The immutable image was independently inspected and freshly scanned; the same 215 reviewed OS findings remain, with no additions or non-OS findings. Production has one healthy replica and 100% traffic. All 16 public checks and five authenticated desktop/mobile browser cases passed. Temporary cloud-runner teardown was independently verified. See the [release record](../bug-bash-release-2026-11-11.md) for evidence, compatibility impact and verification limits.
