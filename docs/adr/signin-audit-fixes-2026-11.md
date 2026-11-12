# Fixes from the sign-in security audit

Decision: 13 November 2026. The founder asked for a security audit of the sign-in routes on
main 091c14a (sign-up, sign-in, recovery, reset, new-device approval, sessions, step-up and
Settings › Security), then chose to fix its three most serious findings before the next
release. All three were already live; none came from the
[security follow-ups](security-followups-2026-11.md). No new dependency, schema or migration.

## 1. Making or replacing an agent access key needs a fresh confirmation, and says so

An access key (`wh_ak_…`) is lasting access to the account: it outlives sign-out and
recovery. Before this change, any signed-in session could mint or replace one, with no
confirmation and no email, so a few minutes on an unlocked device or a copied cookie were
enough for persistent access to mail, memory and records through an agent.

- `create` and `replace` refuse with `step_up_required`, writing nothing, unless the session
  confirmed it's you in the last five minutes. The screens show "Confirm it's you" and, once
  confirmed, finish the request without another tap. The confirmation sits outside the create
  form, because its authenticator-code form must not nest inside it.
- A created key sends the existing new-agent email, and a replaced key sends a new
  "a new access key was made for <agent>" email. Neither carries the key. A failed send is
  logged and never undoes the key.
- `revoke` stays a single confirmation, like Disconnect: cutting access off should be quick.
- The dev-only agent console (refused in production by config) provisions its own dev agent's
  key as confirmed and sends no email, so it neither prompts nor mails on every load.

## 2. Return paths that normalise to another site are refused

`safeReturnPath` checked the raw `next` value for a leading `//`, but returned the parsed,
normalised path. `/.//evil.example`, `/%2e//evil.example` and `/a/..//evil.example` therefore
came back as `//evil.example`: an open redirect after sign-in, sign-up, recovery and new-device
sign-in, and the server's redirect for a visitor already signed in. The serialised value now
gets the same leading-slash checks.

## 3. A confirmed step-up rotates the session token

Step-up was a timestamp on the shared session row, so anyone holding a copy of the cookie
inherited a fresh confirmation, enough to add their own passkey in the next five minutes. A
confirmed passkey or authenticator step-up now stamps the session and replaces its token in
one write (`stepUpAndRotate`). The confirming browser gets the new `__Host-wh_session` cookie
in the response, and the old token stops verifying. The row keeps its id, so the session's
idle and absolute windows are unchanged. A refused step-up rotates nothing. Sign-in still
stamps its freshly minted session without rotating it.

A request made with the old cookie while the step-up is completing (another tab mid-load) is
refused as signed out. The browser holds the new cookie for its next request.

## Left open

These audit findings remain founder decisions:

- Recovery keeps the account's other passkeys, its authenticator app and its agent keys and
  tokens. Reset re-enrolment removes the others. An authenticator app can't be removed at all.
- If recovery stops after the new passkey is saved, other sessions stay signed in and no alert
  is sent. Those steps run only at the final step.
- After a reset completes, re-enrolment stays open for 30 days, with no alert, cancel or
  banner.
- There's no "sign out everywhere", and removing a passkey leaves the sessions it made.
- Wrong email codes and failed passkey attempts are counted per address across every purpose.
  Anyone who knows the address can keep its owner locked out of sign-in for 15 minutes at a
  time, and the passkey counter shows whether an account exists.
- Email addresses are only lower-cased and trimmed. Invisible and full-width characters get
  past the per-address limits, so a lookalike second account is possible.
- Security alerts go only to email. Failed authenticator sign-ins send none.
- Device approval has no number matching ([follow-ups §3](security-followups-2026-11.md)).

## Verification

Test-first: each fix has failing tests first.
- Access keys: refused without a fresh or recent step-up, nothing written; replace leaves the
  old key working; revoke needs none; both emails with no key in them; a failed send keeps the
  key. Both screens get controller and render tests, including that the confirmation renders
  outside the create form.
- Return paths: the four normalising payloads, plus an on-site dot segment that is kept.
- Step-up: the old token stops verifying, the new cookie keeps its attributes and carries the
  step-up, the session id is kept, and a refused step-up sets nothing. These cover both the
  passkey and authenticator paths.
