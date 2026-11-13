# Fixes from the sign-in security audit

Decision: 13 November 2026. The founder asked for a security audit of the sign-in routes on
main 091c14a (sign-up, sign-in, recovery, reset, new-device approval, sessions, step-up and
Settings › Security), then chose to fix its three most serious findings before the next
release. All three were already live; none came from the
[security follow-ups](security-followups-2026-11.md). No new dependency, schema or migration.
The same day the founder decided three of the findings left open; they are §4–§6, also with no
new dependency, schema or migration.

## 1. Making or replacing an agent access key needs a fresh confirmation, and says so

An access key (`wh_ak_…`) is lasting access to the account: it outlives sign-out and
recovery. Before this change, any signed-in session could mint or replace one, with no
confirmation and no email, so a few minutes on an unlocked device or a copied cookie were
enough for persistent access to mail, memory and records through an agent.

- `create` and `replace` refuse with `step_up_required`, writing nothing, unless the session
  confirmed it's you in the last five minutes. The screens show "Confirm it's you" and, once
  confirmed, finish the request without another tap. The confirmation offers only the ways the
  person can confirm, and sits outside the create form, because its authenticator-code form
  must not nest inside it.
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

## 4. Recovery removes the lost sign-in methods when the new passkey is saved

Founder decision, 13 November 2026. Recovery (email code, recovery code, new passkey) kept every
other passkey and the authenticator app, and signed other devices out and alerted only at the
final step, so a recovery abandoned after its passkey was saved did neither.

- The register-passkey step does everything in the transaction that saves the new passkey and
  replaces the recovery code, in re-enrolment's lock order (account row first, then the factor
  and session rows). It removes every other passkey and the authenticator app, deletes every
  session, and records an "Account recovered" activity entry. Re-enrolment now uses the same
  eviction helper, and takes the recovery code row straight after the account row, so the two
  can't deadlock. Both also discard the account's pending "approve from another device"
  requests, so one approved from a session that no longer exists can't be collected, and any
  half-finished authenticator set-up, so its secret is never handed to the owner afterwards.
- The account-recovered alert is sent from that step, once it commits. Only the recovery holding
  the current recovery code can commit, and committing replaces the code, so a duplicate,
  retried or competing passkey step sends nothing. `finish` only mints the new session and sets
  the cookies; it sends nothing and ends no session (one made since with the new passkey is the
  person's own). The alert says the old passkeys and authenticator app were removed and every
  device signed out, and gives `SUPPORT_EMAIL`. Then it names the connected agents as still
  connected, quoted, shortened and capped at five ("and N more"), because whoever connected an
  agent chose its name and must not be able to crowd out the fixed copy.
- Agent access keys and OAuth connections are kept. For two weeks after a recovery, Home shows
  a contained notice naming the agents connected at the time that still are. Each links to its
  Settings (Replace key), and one link goes to Agents, where an agent is disconnected; the
  agent's Settings has no Disconnect. The notice never says an agent was removed.
- Notice mechanism, no schema change: it is derived from the recovery's activity entry (kind,
  time and entry hash only, never the payload). It disappears 14 days after the newest recovery.
  Dismiss sets an HttpOnly cookie naming that entry, read on the server, so it hides that notice
  on that browser only, and a later recovery shows a fresh one. The cookie is set only if the
  entry on screen is still the newest, so a recovery after the page loaded isn't hidden unseen.

## 5. A completed reset alerts, closes after 7 days and can be closed sooner

Founder decision, 13 November 2026. A completed reset stayed re-enrollable for 30 days, sent
nothing, and the banner and cancel covered only pending resets.

- Re-enrolment is open for 7 days after completion. No completion time is stored: completing
  moves `requested_at` to exactly 7 days before the job ran, and the window is measured from
  `requested_at` + 7 days, so a completion job that ran late still leaves the full 7 days.
- Completion alerts push, email and each verified mobile, as a request does, once it commits.
  Only the call that claims the reset sends, so a retried timer sends nothing; a failed send is
  logged without the recipient and never undoes the completion.
- While a reset is completed and not re-enrolled, every signed-in screen shows a contained
  banner: when it finished, until when it can be used, and "This wasn't me — close
  re-enrolment". Closing posts to `/api/auth/reset/close`, takes the person from the session
  cookie alone and needs a fresh step-up; the banner shows "Confirm it's you" and then closes
  without another tap. It is cancel's status-guarded update, `done` → `closed`, so a close and
  a re-enrolment racing for the same row can't both succeed.
- After a close no set-up code is emailed, and a set-up already under way is refused with
  `409 reset_closed`: "This reset was closed from a device that's signed in to the account…
  ask for a new reset." `closed` is a new value in the unconstrained `status` column. No reset
  step records activity, so closing doesn't either.

## 6. The authenticator app can be removed from Settings › Security

Founder decision, 13 November 2026.

- "Remove" on the authenticator app row opens the same in-page danger confirmation as removing
  a passkey. The action needs a fresh step-up and is scoped to the session's account.
- Under the `users FOR UPDATE` lock that passkey removal takes, it refuses when the account has
  no passkey (`last_sign_in_method`), so removing the only passkey and the app in parallel
  leaves one of them. With no passkey the dialog says why, offers no Remove button and links to
  Add a passkey; the refusal notice talks about the app, not a passkey.
- A removal emails the member, alongside the "authenticator added" alert; a failed send never
  undoes it. Passkey removal and authenticator set-up record no activity, so this doesn't either.

## Left open

These audit findings remain founder decisions:

- Resolved by §4–§6 (founder decisions of 13 November 2026): recovery keeping the other
  passkeys and the authenticator app; abandoned recoveries keeping other sessions and sending
  no alert; completed resets staying re-enrollable for 30 days with no alert, cancel or banner;
  and the authenticator app being impossible to remove. Recovery still keeps agent keys and
  tokens, by decision, and names the agents for review instead.
- The eviction isn't serialised against a sign-in, passkey add or authenticator set-up already
  under way on a lost device. Recovery and re-enrolment take the account row `FOR SHARE`, as
  `createSession` does, and adding a factor takes no account lock. A sign-in that checked its
  passkey just before the eviction can still mint a session just after it. The window is the
  milliseconds between those two statements. Closing it means taking a stronger account lock
  for the eviction and re-checking the credential, under that lock, when a sign-in session is
  minted or a factor is added.
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

The full suite passed except one composed step-up route test that still read the retired
token; it was updated and passes. A real-browser run used Chromium with a virtual passkey
against a local `next dev`:
- Sign-up gives a session with no step-up. Create access key then asked to confirm, and
  confirming made and showed the key with no second tap.
- The session cookie changed. A copy of the old cookie was redirected to sign-in, while the
  confirming browser stayed signed in.
- The new-agent email reached the dev outbox without the key.
- Replace within the window made a new key with no prompt, and sent its email.
- A signed-in `/signin?next=/.//evil.example` redirected to `/home`.
