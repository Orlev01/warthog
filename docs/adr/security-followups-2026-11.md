# Authenticator set-up, the last sign-in method and approving a new device

Decision: 13 November 2026, from the open decisions of the
[UI/UX pass](../audit/uiux-pass-2026-11-12/review.md) ("authenticator set-up after sign-up",
"whether to block removing the last passkey on the server", "device approval for `/device`
sign-in"). It extends [authenticator sign-up](authenticator-signup.md) and
[authenticator step-up](authenticator-step-up.md) and the design's §5. No new dependency,
schema or migration.

## 1. Set up an authenticator app from Settings › Security

A member who signed up with a passkey can now add an authenticator app. The sign-up enrolment
rules apply, plus the step-up gate every Security change carries:

- Begin and verify each need a fresh "confirm it's you" (5 minutes).
- Begin issues a pending secret held only in the bounded, expiring process store
  (`pending-store`, 10 minutes, keyed by the session's own account). Asking again returns the
  same secret and QR, and resets neither the attempt counter nor the time-to-live. Cancel only
  hides it on screen, so it never buys more attempts.
- Five wrong codes end the pending set-up's attempts. Only one verification runs at a time.
  A malformed value is refused before it is counted.
- A matching code stores the secret through the existing DEK envelope (`totp-store`), with
  the accepted time step. The code is therefore spent for sign-in and step-up too. The insert
  never replaces an existing authenticator.
- The member is emailed a new-sign-in-method alert, best effort, as for a new passkey. It
  carries no secret or code.

Removing or replacing an authenticator is not built: no such control existed, and it needs
its own decision about the last sign-in method.

## 2. Never remove the last sign-in method

The server now refuses to remove a passkey when it is the account's only passkey and there is
no authenticator app (`last_sign_in_method`). Without this, one confirmed tap could leave an
account with nothing to sign in or confirm with, and only the recovery code or a 7-day reset
would get the member back in.

- The step-up gate still answers first. The ownership check and the "another method left" check
  run with the delete in one transaction, after locking the member's row, so two removals in
  parallel can't both succeed.
- With an authenticator app, the only passkey can still be removed and the dialog warns
  plainly. Without one, the dialog explains why removal isn't possible, offers no Remove
  button and links to "Add a passkey" and "Set up an authenticator app".
- The recovery code does not count as a sign-in method here, because it is a last-resort way
  back in, not a day-to-day one.

## 3. Approve a sign-in from another device

The request → approve (fresh step-up) → collect handshake already existed, but nothing in the
signed-in app could show or answer a request. The handshake is now complete:

- **Two ids per request.** The new device holds the collection handle, which is a bearer
  secret. The signed-in member sees and answers each request by a separate random approval id,
  so seeing a request never lets anyone collect its session.
- **Member-scoped listing.** Settings › Security › Sign-in requests lists the session's own
  pending, unexpired, unapproved requests from the in-memory store, newest first. Another
  account's requests are invisible and can't be approved or denied by id.
- **Approve** needs a fresh step-up and hands the approver no session. **Deny** discards the
  request, so the new device can't collect it. Deny needs no step-up, because it only takes
  access away, but the screen asks first. Approve also asks first and says: only approve if you
  just tried to sign in on that device yourself.
- **The label is not the requester's own text.** The server derives the label from the
  requesting browser's User-Agent into a fixed vocabulary ("Chrome on Mac", "Unknown device").
  A requester therefore can't name itself "safe to approve". The old body field is accepted
  but ignored.
- **The push** links to the requests screen and carries no request id or secret. The screen
  lists requests from the session itself. Push delivery is best effort: with no push device,
  the request still waits on the screen. Previously, a member with no push device got a server
  error. Routing a tapped push to that screen also needs `public/sw.js` and the Web Push payload
  to recognise the route; those files are outside this change and are proposed separately.
- `/device` now explains where to approve, and its waiting step names the label and the expiry
  time. Sign-in offers "Approve from another device" under "Other ways to sign in" again.

The main residual risk is a member approving a request they didn't make (approval fatigue). A
request needs the emailed code first, every approval needs a fresh step-up, and the copy is
explicit. Number matching (the new device shows a short code the approver must pick) would
reduce this further and is left as a founder decision.

## Verification

Test-first throughout: real-migration PGlite tests for enrolment, replay, attempts, expiry,
single-flight, scoping, the guarded removal (including parallel removals), listing, approve,
deny, expiry and push content; controller and render tests for each screen. Browser walk-throughs
on throwaway accounts with a virtual passkey cover set-up, sign-in with the new app, the refused
removal, and approve, deny, expiry and cross-account invisibility across two browser contexts.
