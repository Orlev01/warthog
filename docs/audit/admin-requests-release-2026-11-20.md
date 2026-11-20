# Requests in the admin portal, and every admin page checks sign-in — 20 November 2026

Application source `3f7a8f5149d16b30c9f92d079554f6d3b64d34a9` is live as revision
`warthog--r44641742159a1`. It carries PR #40.

## Why

The founder asked for every request a person can make in the app to be recorded in the admin
portal, "with as much meaningful data about the person", instead of being emailed.

The review of that change found a security gap that was already live. Admin pages relied on the
portal layout alone to check sign-in. A client navigation tells Next which segments the browser
already has (the `Next-Router-State-Tree` header), and Next skips their layouts. A crafted
request could therefore render an admin page with no session. Before this release, production
returned the Overview's aggregates that way, and the Accounts page and its address lookup were
exposed the same way. No address list was exposed, because the Requests page wasn't live yet.

## What shipped

- **Requests page** (Product group). It shows:
  - "Request a service" and Google "Early access — ask to join" requests;
  - the requester's address, as a mail link with a subject;
  - the account facts the Accounts page already shows, plus the account currency and how many
    requests the person has made.
- **Settling requests.** A request settles itself once the service is in the catalogue for that
  person, or once the person is on the Google list. **Mark done** settles anything else, and is
  the portal's first write.
- **Overview.** Needs attention leads with the number of waiting requests.
- **No email.** Neither request is emailed to the operator any more.
- **Privacy page.** It now says the operator sees a request alongside the person's address and
  how their account is set up.
- **Sign-in on every admin page.** Each admin page calls `requireAdminPage()` before it reads
  anything, and a test fails any admin page that doesn't.
- **Changes:** migration 0115 (additive, 86 migrations in total). No configuration,
  infrastructure, package or workflow changes.

## Verification

- **PR #40:** every check passed (run
  [44620254489](https://github.com/Orlev01/warthog/actions/runs/44620254489)). The full local suite
  passed 6,273 tests.
- **Image:** image run 44641225980 reused that result for the same tree. The image is
  `…@sha256:2a323ea0…`; source, journal and hash checks passed.
- **Image scan:** 13 pairs were "added", but the package list is identical to the previous image's
  (236 name and version pairs). The new pairs come from a newer vulnerability database
  (libc6 and libgnutls30 advisories), not from a change in the image.
- **Production:**
  - Run [44641742159](https://github.com/Orlev01/warthog/actions/runs/44641742159) succeeded: one
    healthy replica, explicit 100% traffic and zero old replicas.
  - Configuration was unchanged apart from image and revision (`03ff1aae…` before).
  - Health reports the database ok, which means migration 0115 has been applied.
  - Probe: 62/62.
  - The fresh private runner was destroyed, and the cleanup check is clean.
- **The gap is closed:** the same crafted, unauthenticated request now gets only
  `NEXT_REDIRECT;replace;/signin` from Overview, Requests, Accounts (with `?email=`), Sign-ups and
  Reliability, and no data.
