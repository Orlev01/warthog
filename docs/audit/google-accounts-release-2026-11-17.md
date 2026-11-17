# Google published; several accounts of one service — 17 November 2026

Application source `407f2907611bf57b936a5296de710d20348e594d` is live as revision
`warthog--r43992933196a1`. It carries PR #38 ([ADR](../adr/google-published-and-accounts.md)). The
founder wants all their Gmail accounts, plus several Outlook and Notion accounts, in Warthog, and
asked for the changes to be made in the app and in the Google console.

## Google console (done before the release)

- Project `warthog-prod-e854`, Google Auth Platform:
  - **Branding:** the home page, privacy policy and terms of service now link to
    `https://warthog.com.au`, `/privacy` and `/terms`. Publishing requires these. The app name
    ("Warthog") and the authorised domain (`warthog.com.au`) were already set.
  - **Audience:** the app was **published** ("In production"), without verification. Google
    allows this for personal use with fewer than 100 people.
- **What that means for people:**
  - Any Google account can now connect; nobody needs adding as a test user first.
  - New connections no longer end after 7 days.
  - Each person sees Google's "Google hasn't verified this app" screen while connecting.
  - At most 100 people can ever connect a Google account (a lifetime cap Google never resets).
    Warthog's early-access list keeps anyone else from using up those places.
- **Not changed:** the developer contact email and the support email. No logo was uploaded,
  because a logo needs verification.

## What shipped

- **No 7-day clock.** Warthog no longer reminds, lapses or refuses a renewal at 7 days. A Google
  connection lasts until Google refuses a renewal, which already shows "Reconnect needed" with one
  notice. Connections made before publishing still end at 7 days on Google's side; reconnecting
  them once gives a lasting connection.
- **Google tiles** say: "Google will say it hasn't verified Warthog yet. To continue, choose
  Advanced, then Go to warthog.com.au."
- **The same account renews in place.**
  - Reconnect (shown when it's needed) goes straight to that account and renews the row clicked.
  - Connecting an account Warthog already has updates it instead of adding a copy.
  - A new connect shows the account chooser.
- **A second account keeps agents working:** agents stay on the account they use today.
- **Rename** works for Notion and key-based accounts.
- **Approval cards name the account** when the person has several of that service.

No migrations (still 85), no configuration, hostname, infrastructure, package or workflow changes.

## Verification

- **Pull request:** #38 passed every check (run
  [43990965491](https://github.com/Orlev01/warthog/actions/runs/43990965491)) on tree `7e613ad`.
  The full local suite passed 6,261 tests, and the type-check was clean.
  - An independent review found one must-fix: Reconnect could renew the oldest of two rows for
    the same account.
  - It also found two should-fixes: a second renewal chain, and a race with a running refresh.
  - All three were fixed and tested before merging.
- **Browser:** the Connectors page was checked at 375 px and on desktop, in light and dark, with no
  sideways scroll.
- **Main:** run [43992252958](https://github.com/Orlev01/warthog/actions/runs/43992252958) reused
  the PR's result for the same tree. The merge commit kept the tree.
- **Image:** run [43992390529](https://github.com/Orlev01/warthog/actions/runs/43992390529) reused
  it too.
  - The image is `…@sha256:83688d20…`. It carries the exact source label and journal label `v1`.
  - It is linux/amd64, UID 1000, with no setuid/setgid.
  - All 85 migrations, 106 catalogue entries and 80 brands match by hash.
  - Its scan has 226 OS advisory pairs, identical to the previous image's.
- **Production:**
  - Run [43992933196](https://github.com/Orlev01/warthog/actions/runs/43992933196) succeeded.
  - Expected configuration hash: `396cd77b…`, the same as after the
    [previous release](README.md).
  - One healthy replica running the exact image, explicit 100% traffic, zero old replicas, and
    configuration unchanged apart from image and revision.
- **Production probe:** 62/62.
- **Runner:** a fresh private lease (11 reviewed creates) was destroyed after the job. The cleanup
  check found nothing left.

## Follow-ups

- **One agent using several accounts of one service** at once. Today an agent is set to one
  account per service.
- **Rules for a single account**, and **disconnecting one of several accounts** without removing
  the service from agents that had no account chosen.
- **Google verification**, if Warthog grows past about 100 people. It needs a security assessment
  every year.
