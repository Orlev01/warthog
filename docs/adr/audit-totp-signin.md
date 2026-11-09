# Require email verification before authenticator sign-in

Accepted for local implementation during the founder-authorized comprehensive audit, 9 November 2026 (AUD-005).

The current public TOTP sign-in accepts an account's email address and a six-digit authenticator code. The email identifies the account but proves no mailbox access. The separate new-device path requires an email code, yet this endpoint is callable by any device, bypassing that requirement. The remembered-device cookie is explicitly an alert-deduplication marker, not an authentication factor, so it must not create an exception.

Every unauthenticated authenticator sign-in will first send and verify a purpose-bound `signin_totp` email code through the existing rate-limited email-code service. A successful email check returns a random, bounded, ten-minute, single-use sign-in handle bound to the resolved account. The final TOTP request accepts this handle instead of a caller-supplied email/user id and uses the existing per-account failure reservation and TOTP-step replay protection. It consumes the handle before minting a session. Missing, expired, replayed or mismatched first-factor material never grants a session.

The UI guides the person through the email code and then their authenticator code, surfaces send/verification failures in plain language, and preserves their safe return path. Signed-in step-up remains a session-bound authenticator check; it does not repeat email verification. Passkey sign-in remains unchanged.

This deliberately tightens the public TOTP sign-in contract. Existing tests describing the email-as-identifier flow are updated to establish an email proof first, preserving their independent sign-in, ownership, error, replay and rate-limit assertions. No dependency or database schema change is needed. Codes and handles never reach logs or reports; only synthetic fixtures are used for validation.
