# Admin portal — build and verification record, 13 November 2026

Branch `claude/admin-portal` from `main` `3fb29b1`, built in an isolated worktree while
other agents worked in sibling worktrees. Decision: [docs/adr/admin-portal.md](../../adr/admin-portal.md);
design: [docs/design/admin-portal.md](../../design/admin-portal.md); launch steps:
[docs/admin-portal-launch.md](../../admin-portal-launch.md).

## How it was built

Four specialist reviews (product analytics, security and privacy, engineering and
delivery, UX and design) produced the feature set and the constraints; where they differed
the stricter option won (no address is ever listed; accounts are found by one exact
lookup). The backbone (derived admin origin, host routing, handoff, admin sessions, role
reconciliation, sweeps) was built test-first first; three parallel slices then added the
instrumentation, the allowlisted reads and loaders, and the UI against a frozen view-model
contract. The Skynet build loop was not used: the job's delivery target in Skynet is the
local bare repository that stopped at `dddd410` on 8 November, five days behind `main`.

## Automated checks (final tree)

- `npm run typecheck`: clean.
- `npm run build`: clean; `/admin`, `/admin/{signups,usage,accounts,reliability,traffic,system}`,
  `/admin/session`, `/admin/signout` and `/admin/signed-out` are dynamic routes.
- `npm test`: 5,947 tests, 5,947 pass, 0 fail, 0 cancelled, 0 skipped (final tree, `5dda126` plus these records).
- New tests cover: origin derivation and the production refusal of `ADMIN_BASE_URL`; the
  host routing matrix in the proxy (rewrite, pass-through, 404s, the shared limiter, the
  `x-admin-pathname` header, `noindex`); migrations 0110–0112 including the `created_at`
  backfill and the cascade from `sessions`; handoff mint/exchange/verify (single use, 60 s,
  12 h / 60 min, demotion, tombstone, concurrent exchange, cascade revocation); the exchange
  and sign-out handlers; operator role reconciliation; the traffic counter and flush; the
  three sweeps; every new metric hook with a fake seam and a throwing seam; the reads module's
  static forbidden-identifier guard and a seeded no-leak assertion over every loader; range
  windows across the Sydney DST change; every primitive and view by static markup, including
  a loose-text walker.

## Browser verification

`verify.mjs` drove headless Chromium against a dev server on `http://localhost:3217` with
the admin host `http://admin.localhost:3217` (Chromium resolves `*.localhost` to loopback
and treats it as a secure context, so the `__Host-` admin cookie is accepted over http
there). The operator account was created through the real sign-up with a virtual passkey,
promoted by the real `operator-role` sweep on the next scheduler tick, and signed in through
the dev sign-in-as route. Results: [results.json](results.json); screenshots beside it.

Checked and passing:

- The admin host without a session lands on `/settings?notice=admin_signin_required` on the
  app host. "Open admin portal" on Settings mints the handoff, the browser navigates to the
  admin host's `/session`, the exchange sets `__Host-wh_admin` and lands on the Overview.
- On the app host `/admin` is 404; on the admin host `/api/auth/signin` and
  `/oauth/authorize` are 404; admin responses carry `X-Robots-Tag: noindex, nofollow`.
- Eleven page states (seven pages plus a 30-day range, a today range, an account filter and
  an exact-address lookup) at light 320, 390 and 1440, dark 390 and 1440, and 844×390
  landscape: 66 captures, every one 200, with zero horizontal overflow, zero loose text,
  zero off-screen elements, zero sub-44px targets, zero sub-16px inputs, zero low-contrast
  text, zero console errors and zero unnamed charts. The only flags were the two
  intentionally visually-hidden sidebar labels ("Warthog home", the one-item "Overview"
  group) reported by the truncation heuristic on desktop.
- Range tabs are links that mark the current range; Back restores the earlier URL.
- "Sign out of admin" lands on the admin host's signed-out page, whose "Back to Settings"
  link returns to the app; the admin host then refuses with a redirect.

Found and fixed by this run: the first sign-out implementation redirected the form POST
straight to the app origin, which Chrome blocks under CSP `form-action 'self'`; the
same-origin signed-out page replaces it.

## Not verified here

- A real `admin.warthog.com.au` binding, certificate and DNS (a separate approved step).
- Production PostgreSQL: the local run used PGlite; CI runs the migrations on PostgreSQL 16.
- Screen-reader and forced-colours passes were not performed in this run; the charts carry
  `role="img"`, a `<title>` and an `aria-label`, and the stylesheet has forced-colours rules.
- The dev request log prints the handoff token in the exchange URL (dev only; the token is
  single-use and lives 60 seconds; production's server does not log requests).
