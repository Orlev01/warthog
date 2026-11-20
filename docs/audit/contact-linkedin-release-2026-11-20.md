# Contact us, your requests, arrival emails, and LinkedIn (switched off) — 20 November 2026

Application source `70c2a9f4ed51393b34f56c01cb6208a5eb64c460` is live as revision
`warthog--r44658921004a1`. It carries PR #42 and PR #41.

## Why

After PR #40, the founder asked: "Set up LinkedIn as much as you can without me. Do the optional
extras." Then they replied "release".

## What shipped

- **PR #42: requests for members** ([ADR](../adr/requests-for-members.md)).
  - **Contact us.** A new page, `/contact`, under Help. A message is a third request kind, added by
    migration 0116 (additive, 87 migrations in total). Before it's kept, codes and card numbers are
    hidden. A person can send five a day.
  - **Your requests.** Shown on Connectors' Your services tab.
  - **No duplicate asks.** Asking again while a request waits files nothing new.
  - **Arrival emails.** The hourly `request-arrivals` sweep emails a person once when a requested
    service can be connected, or when they're let into Google early access.
  - **Admin.** The Requests page shows messages.
- **PR #41: the LinkedIn connector, switched off** ([ADR](../adr/linkedin-connector.md),
  [runbook](../linkedin-launch.md)).
  - **Tools:** profile, posts that always ask the person, and Undo by deleting the post.
  - **Switched off until set up.** It stays off until the app's client ID and secret are configured
    through the separately approved `activate_linkedin` release. The Key Vault grant waits for the
    foundation variable `linkedin_secret_installed`, which defaults to false.
  - **Fixes from an independent review:**
    - the Key Vault grant and a safe activation check;
    - Undo for post ids that pass the card-number check;
    - link titles on the approval card;
    - deletes always ask;
    - posts are checked before they're held for approval.
- **No other changes.** No configuration or package changes. The infrastructure change is inactive
  until the variable is set. The release workflow gains two inputs, which were left false and empty.

## Verification

- **PR checks.** PR #42 (run 44648640388) and PR #41 (run 44650009018) passed every check.
  - **Locally, the combined tree** passed 6,326 of 6,326 tests and 77 delivery tests.
  - **Main.** Run 44657536652 checked the merged tree and passed.
- **Browser (local).** Contact us, Connectors and admin Requests at 375 px and 1280 px, light and
  dark, with no horizontal scroll. A real send stored "[sign-in code hidden by Warthog]" and
  "[card ••••1111]".
- **Image.** Image run 44658497647 reused main's result. The image is `…@sha256:db7c2089…`.
  - **Checks:** source, journal and hash checks passed, with 87 migrations, 107 catalogue entries
    and 81 brand marks.
  - **Review script:** its brand count was raised from 80 to 81 for LinkedIn's mark.
  - **Scan:** 2 "added" pairs, both a new libc advisory. The package list is identical (236 pairs),
    so the change is a database update.
  - **First dispatch:** it failed at the gate (commas in the approval reference) before doing
    anything.
- **Production.**
  - **Run:** [44658921004](https://github.com/Orlev01/warthog/actions/runs/44658921004)
    succeeded, with one healthy replica, explicit 100% traffic and zero old replicas.
  - **Configuration:** unchanged apart from image and revision. The hash before was `ca02579d…`
    and after is `f4b60bbf…`.
  - **Health:** the database reports ok, which means migration 0116 is applied.
  - **Probe:** 62/62.
  - **New routes:** `/contact` asks a signed-out visitor to sign in, the website's `/contact`
    redirects (308) to the app, and the website help page links Contact us.
  - **Admin pages:** the crafted unauthenticated request still gets only a redirect to sign-in.
  - **Runner:** destroyed, and the cleanup check is clean.
- **After release.** The first `request-arrivals` run, at boot, emails anyone whose earlier
  request had already been answered, once each.
