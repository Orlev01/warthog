# Authenticator confirmation for sensitive actions

9 November 2026 — accepted local audit remediation, AUD-002.

An enrolled authenticator must be usable wherever a fresh passkey confirmation is
accepted. Add `POST /api/auth/step-up/totp`, taking only a six-digit `totp` value.
Identity comes from the current verified session and exact configured Origin.
Read the same encrypted secret store used by signin, and reuse `checkTotpSignIn`
for the shared account-level attempt limit and single-use step. A code consumed by
signin cannot be reused for step-up, or vice versa. Invalid or missing factors must
never create a confirmation timestamp. Successful verification updates only the
current session. No new credential, dependency or database schema.

The shared ConfirmItsYou control offers a labelled authenticator-code form in
addition to the existing passkey control. Both share one in-flight guard and report
plain-language errors without codes/secrets. Security factor changes reuse this
control; successful confirmation resumes only the explicitly requested change.

Validation is test-first: real database handler tests for identity/Origin/session,
success, rate limits and replay; controller tests for request shape, failures and
duplicate submission; rendered labelled form; existing passkey/factor tests.
Actual browser/device acceptance remains a separate release gate.
