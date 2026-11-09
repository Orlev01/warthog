# Authenticator enrollment during signup

9 November 2026 — accepted local audit remediation, UI-002 and signup part of UI-005.

After email verification, a person may create a passkey or enroll an authenticator.
The authenticator option uses the existing 30-minute bounded pending-signup store;
its random signup handle must be presented at every step. The pending shared
secret is issued once, returned only for enrollment, and never persisted in plain
text. Require a valid six-digit code before showing a recovery code. Allow five
verification attempts per pending enrollment; asking for its QR again must not
reset this counter or extend the signup TTL. Only one factor-enrollment operation
may run on a pending signup at a time. A completed factor cannot be replaced or
replayed to issue another recovery code.

Account confirmation still requires the saved-recovery acknowledgement. Create
the account, encrypted authenticator secret and accepted time step, recovery
verifier and session in one transaction. Reuse existing crypto envelopes and TOTP
verification; no new dependency or schema. Subsequent signin/step-up uses the shared
attempt and replay guard, so the enrollment code cannot be reused immediately.

The signup controller serializes requests and WebAuthn ceremonies, snapshots input,
and freezes edits while a transition is in flight. Failure restores an actionable
state with plain-language copy. Never retry an ambiguous email send automatically.

Tests first: complete no-passkey signup, email/Origin/expiry gates, unverified and
unacknowledged confirmation, incorrect-code limit, repeat enrollment, replay and
encrypted storage/recovery verification; client requests and deferred-submit races.
Real authenticator-device/browser acceptance remains outstanding.
