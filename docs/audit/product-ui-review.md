# Product, UI and accessibility review

9 November 2026. Review of the current local production-release checkout, including
its uncommitted release work. Static source, requirement and controller/render-test
review only: no browser, visual, assistive-technology or production acceptance is
claimed. Root coordinates implementation and the final full-suite/build checks.

## Remediation status

The findings below describe the pre-fix behavior and retain their original evidence.
Local remediation is complete in this lane; integrated checks are coordinated by root.

| Finding | Local result | Evidence |
| --- | --- | --- |
| AUD-002 authenticator step-up | Fixed: session-only TOTP, exact Origin, shared atomic attempt/replay guard, shared confirmation UI and security-change continuation | 51 focused checks passed; `step-up-totp.test.ts`, confirmation/route/factor-control checks |
| AUD-011 (UI-002) authenticator signup | Fixed: email-verified pending enrollment, QR/manual key, five-attempt proof, encrypted enrollment, consumed TOTP step, required recovery acknowledgment | 135 signup/route/controller/render checks passed |
| AUD-013 (UI-003) device portability | Fixed: optional local protected export, local read/reseal import, strict ciphertext request, member-scoped atomic restore and owned address remap | Portability/vault regression: 121 checks passed; includes real PGlite and WebCrypto round trip, wrong key, malformed file, stale session, Origin and rollback checks |
| UI-004/AUD-020 time zones | Root/delivery agent owns shared remediation; this lane wired imported-history labels to the validated account zone | Included in touched data-page/action regression; wider timestamp evidence in delivery report |
| AUD-014 (UI-005) duplicate auth submits | Signup guard and disabled inputs implemented here; signin guard implemented by security agent | Signup deferred-request race tests; security report covers signin |
| AUD-015 (UI-006) deletion wording | Fixed: live encryption-key reference removal/access revocation, queued row purge and separate provider/backup retention | Rendered copy and data-page checks |
| AUD-021 fresh vault fallback | Fixed: explicit first-use passphrase enrollment only, minimum twelve characters, saved recovery phrase, no rekey on failed unlock or conflicting setup | Real WebCrypto setup/wrong-key/concurrent-winner tests, included in 121-check run |
| AUD-024 rule builder | Fixed: controlled draft and dependent fields, live preview, reset incompatible detail, validate amounts, pending submit guard and account-currency labels | 26 focused reducer/FormData/render checks passed |

Security peer review found no plaintext-upload or cross-account bypass in the new
transfer contract. Its follow-ups were applied: clear temporary key bytes, clear
abandoned pending vault keys, clear unwrapped transfer DEKs, and require explicit
file reselection after ambiguous import responses. This is best-effort memory
hygiene; JavaScript strings cannot be securely erased and no such guarantee is made.

Test logs: `/tmp/warthog-audit-totp-stepup-{red,green}.log`,
`/tmp/warthog-audit-signup-totp-{red,green}.log`,
`/tmp/warthog-audit-passphrase-{red,green}.log`,
`/tmp/warthog-audit-transfer-{red,green}.log`,
`/tmp/warthog-audit-transfer-ui-{red,green}.log`,
`/tmp/warthog-audit-portability-regression.log`, and
`/tmp/warthog-audit-rule-builder-{red,green}.log`. Counts overlap; do not add them
into a unique full-suite total. Some initial fixtures needed correction (boolean
recovery result, HTML case-insensitivity, valid recovery-phrase fixture); final
counts describe actual successful runs, not those intermediate results.

No full-suite/build/install, browser acceptance or external service actions were
performed in this lane. No dependency was added. Existing release changes were
preserved. ADRs: `docs/adr/authenticator-step-up.md`,
`docs/adr/authenticator-signup.md`, `docs/adr/device-local-portability.md`.

## Findings

### AUD-002 — High: authenticator users cannot reconfirm sensitive actions

Confirmed. `src/server/auth/step-up-handler.ts:193` dispatches only passkey begin and
finish; `src/components/ui/confirm-its-you.tsx:81` invokes only a passkey ceremony.
Security's `src/components/auth/factor-controls.tsx:206` duplicates that restriction.
An account with an enrolled authenticator but no available passkey can sign in, yet
after five minutes the offered controls cannot authorize export, account deletion,
high-tier/card release or security changes. Signing out and back in is an accidental
workaround, not the promised in-session flow. Brief lines 110 and 569 require either
factor.

Implemented in this lane: add an exact-Origin/session-bound TOTP step-up
endpoint that reuses the shared atomic attempt/replay guard; expose the alternative
in the shared confirmation control and reuse it for security changes. Tests must
cover own-session success, cross-account input, absent/foreign Origin/session,
malformed codes, rate limiting, signin/step-up replay and client concurrency/errors.

### AUD-011 (UI-002) — High: signup has no authenticator fallback

Confirmed. `src/components/auth/signup-flow.tsx:158` always advances to passkey;
`src/components/auth/auth-views.tsx:259` offers only Create a passkey; and
`src/app/(auth)/signup/handler.ts:364` requires a registered credential before account
creation. There are no TOTP enrollment steps in this signup handler/controller.
People whose device/browser cannot create a passkey cannot create an account,
despite brief lines 74, 104 and 711 promising the authenticator alternative.

Proposed correction: an email-verified, bounded pending enrollment flow for an
authenticator, requiring successful code confirmation before account creation and
recovery-code confirmation. Preserve the existing second-factor gate; never create
an email-only account. Test successful enrollment and every rejected/expired/replayed
stage. This is separate from AUD-002 and needs coordination with the auth reviewer.

### AUD-013 (UI-003) — High: protected-data portability has no UI path

Confirmed requirement gap. `src/components/settings/data-view.tsx:99` expressly
excludes saved cards and protected details. Its export form posts directly to
`/settings/data/export`; no device-vault unlock/export controller is wired there.
`src/client/vault/export.ts` and `import.ts` exist but are not used by this screen.
Brief lines 406–414 requires device-side export/reprotection, so users cannot port
all their own data through the actual product. The native import form also sent the
whole selected file to the server, including plaintext `deviceProtected` card/identity
values from a device export, even though the old importer ignored that section. This
confirmed privacy-boundary violation raises the combined finding to High.

Proposed correction: wire optional device-held export and import to the existing
client crypto primitives after step-up, with a clear sensitive-file confirmation.
Do not export sign-in credentials, connector tokens or wrapping/auth secrets.
Test browser-controller round trips and rejected malformed files; require later
real-browser acceptance. The new opt-in copy now explains readable protected data in the downloaded file; actual browser download/re-import acceptance remains required.

### AUD-020 (UI-004) — Medium: dates use inconsistent, unlabelled time zones

Confirmed. Activity (`src/app/(portal)/(protected)/activity/actions.ts:143`), home
and inbox format UTC; push-device labels
(`src/app/(portal)/(protected)/settings/notifications/actions.ts:174`) force Sydney;
security (`src/app/(portal)/(protected)/settings/security/page.tsx:190`) uses the
server's default zone. These formatted labels omit the zone. The account already
has a time-zone preference used by spending, but these views ignore it. A global
user can see the same event as different dates/times without explanation.

Proposed correction: one display-date helper with the validated account time zone
passed by loaders; consistently label the time zone on absolute timestamps. Test
an instant spanning UTC/Sydney/Los Angeles date boundaries and invalid preference
fallback. Do not change financial period semantics as part of display formatting.

### AUD-014 (UI-005) — Medium: signup/signin have no in-flight guard

Confirmed controller behavior. `src/components/auth/signup-flow.tsx:149` and
`signin-flow.tsx:132` issue requests without busy state or duplicate-call guards.
Their views keep submission controls and account fields active. Two fast submits
can send competing email verification requests or WebAuthn challenges; changing
email during a pending signin means finish reads a different email than begin.
Other sensitive controllers already guard `working` state, so this is inconsistent.

Proposed correction: guard the entire async transition, snapshot its inputs, disable
relevant controls while working, clear busy state on every handled outcome, and
ignore stale completions after cancellation. Test deferred request races rather than
only sequential happy paths. Do not retry ambiguous message sends automatically.

### AUD-015 (UI-006) — Medium: account-deletion copy overstates immediate erasure

Confirmed copy inconsistency. `src/components/settings/data-view.tsx:169` says
everything is erased for good, while the contract is live wrapped-key removal and access revocation,
asynchronous row purge within 24 hours, and separately retained provider/backup records.
The public privacy page already explains provider retention. State clearly that
access is revoked and the live encryption-key reference is removed, rows
are scheduled for removal, and provider/backup retention follows the privacy policy.
Historical database backups can still contain an earlier wrapped DEK while the shared
wrapping key exists; live deletion does not irreversibly cryptographically erase those
backups. The public Privacy policy already stated retained backup data accurately and
Terms linked that policy; neither required a new legal assertion. Deletion confirmation
and DataView now avoid the former blanket destroyed/unreadable claim.
Keep irreversibility explicit. A focused rendered-copy check is sufficient.

## Reviewed patterns and limits

Reviewed auth controllers/views and request wiring; the shared confirmation control;
data export/import/delete; notifications and push registration; connector controls;
field/label composition; life-admin tabs; account timestamp formatting; protected
vault interfaces and public privacy/terms copy. Existing strengths include labelled
inputs, native disabled controls with explanations, roving keyboard tabs, tokenized
colours, status text/icons and plain-language result notices.

The broad use of framework-free controllers and server-render tests is useful but
does not verify DOM interaction, focus restoration, browser WebAuthn/PRF behavior,
responsive layouts, screen-reader announcements or visual contrast in practice.
These are acceptance gaps, not asserted defects. No claim that every path is fully
reviewed or that source inspection proves WCAG conformance. Source-text/markup-scan
tests and repeated button-class strings are maintainability concerns; prioritize
behavioral tests and shared primitives when touching those components, without a
cosmetic rewrite during launch preparation.

### AUD-021 — High: a fresh authenticator-only vault had no usable setup path

The browser's `unlockWithPassphrase` could only unwrap an already-existing method;
first vault creation existed only in the PRF passkey branch. A new TOTP-only account
or passkey without PRF therefore could not save protected details even after the
new signup fallback. Corrected in `src/client/vault/device-vault.ts` and the shared
vault key step: a new passphrase may create a key only when explicitly requested
and the server's one-use possession challenge reports an empty vault. Existing
vaults never regenerate keys after a failed unwrap. A concurrent compatible winner
is adopted; an incompatible winner remains untouched and causes a safe failure.
Export passes `createIfMissing:false`. See the portability ADR and race tests.

### AUD-024 — High: rule builder choices did not drive their dependent fields

The former `RulesView` used immutable `draft=DEFAULT_DRAFT`, `defaultChecked` and
`defaultValue` with no state transitions. Selecting a specific tool or service did
not expose its required name field; selecting a condition did not expose its detail
field. The displayed preview continued describing the initial rule while native
FormData could represent different choices. Corrected in
`src/components/rules/rules-view.tsx`: controlled state updates the action/channel,
condition/detail, template and scope together; changing a condition clears its old
value. Empty names, invalid/negative amounts and empty merchant lists cannot submit.
The live preview uses the actual draft and the account currency is explicitly
labelled. `useFormStatus` disables the form while its action is pending. New tests
exercise transitions and the existing server FormData parser; this does not replace
an actual browser keyboard/form acceptance pass.

## Remaining acceptance work

Local browser follow-up, 10 November 2026: Chrome control now works. Against a
loopback-only development server with in-memory PGlite and the development outbox,
the coordinator verified the landing page, signup keyboard focus from name to
email to Continue, keyboard submission, disabled pending controls, an invalid
email-code error, successful synthetic email verification and the authenticator
enrollment screen. At a 390×844 viewport, email-code and authenticator-signin
screens rendered without clipped controls; authenticator sign-in correctly began
with email verification. Screenshot: `/tmp/warthog-local-mobile-signin-20261110.jpg`.
The viewport was reset, test tabs closed and preview stopped. No provider message,
real credential or external account was used. This did not complete authenticator
enrollment, passkey ceremonies, protected-account flows, screen-reader testing or
the transfer/rules matrix below. It was development-mode browser evidence, not a
production-browser certification.

The code and focused synthetic checks do not establish browser or accessibility
acceptance. Run the release matrix in a real browser before launch: email + TOTP
signup through recovery acknowledgment; passkey and authenticator step-up; wrong,
expired and replayed codes; non-PRF passkey and TOTP-only vault creation; passphrase
and recovery unlock; actual local download/re-import between two accounts/devices;
interrupted transfer and refresh; rules keyboard selection, dependent-field focus,
preview announcements and submission. Inspect network requests to confirm protected
plaintext and unlock material remain device-local. Verify screen-reader labels/live
regions, keyboard traversal, mobile layouts and readable errors. Do not infer WCAG
conformance or complete cross-browser behavior from static render tests.

Final post-type-correction focused UI rerun: 33/33 passed in
`/tmp/warthog-audit-ui-final-focused.log`. Scoped `git diff --check` passed. Root owns
integrated typecheck/full-suite/build results and any resulting final corrections.
