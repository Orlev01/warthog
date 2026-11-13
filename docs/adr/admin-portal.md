# Add the admin portal on admin.warthog.com.au

Decision: 13 November 2026, at the founder's request for "a simple, easy to use, intuitive
admin portal" showing sign-ups, usage, traffic and the product's success and failure points,
served at `admin.warthog.com.au`, signed in with the founder's own account "with the same
security as app.warthog.com.au". The brief reserved exactly this ("a separate admin app for
user counts, connector health, errors and usage"; V1 "only records the metrics and carries
the roles"). This decision lifts that out-of-scope item into scope; everything the brief
promised about operators (principle 19: no staff role, operator tool or metrics view has any
path to a person's high-tier details, cards, memory, skills or activity contents) still holds.

The design of record is [docs/design/admin-portal.md](../design/admin-portal.md). The
decisions that shape the architecture:

1. **Same process, second host.** The portal is served by the same container on a second
   custom domain; the request proxy branches on the host only to narrow what is served
   (the member app does not exist on the admin origin; `/admin` does not exist on the app
   origin). A second deployment would double the cost of a credit-funded launch for a
   read-only page the founder opens a few times a day.
2. **The admin origin is derived, not configured.** `app.` becomes `admin.` from
   `PUBLIC_BASE_URL`; an override exists only outside production. The Azure release
   contract therefore stays image-only and the deploy script's exact hostname check is
   unchanged. Binding the hostname is a separate, approved operation.
3. **Authentication by handoff, not by a second sign-in.** Passkeys are scoped to the RP ID
   `app.warthog.com.au` (a founder decision that supersedes the parent-domain RP), so the
   admin host cannot run a ceremony, and any factor it could run alone would be weaker. The
   app host mints a single-use, 60-second handoff for a signed-in admin with a step-up
   fresher than five minutes; the admin host exchanges it once for its own host-locked
   session (12 hours absolute, 60 minutes idle) that cascades from the app session and
   re-checks the role on every request. This keeps "the same security" literally: the same
   passkey or authenticator, the same step-up, the same revocation paths.
4. **The database role is authoritative.** `users.role = 'admin'` gates the portal;
   `OPERATOR_EMAIL` (already required in production) is reconciled into that role hourly,
   promote-only. Config is never consulted at request time; nothing is hard-coded.
5. **Aggregates only, one reads module, no addresses.** All admin SQL lives in one module
   that names its columns and is statically tested against the forbidden identifiers.
   Accounts are listed by sign-up date and an opaque reference, never by email; one exact
   address lookup answers "did my friend finish sign-up?" without a browsable directory.
   This is stricter than the privacy policy requires; it can be relaxed by a later decision.
6. **New metrics stay structurally personal-content-free.** Sign-up and sign-in funnels,
   connector connect and refresh outcomes, job failures, account deletions and HTTP traffic
   are recorded through the existing guarded recorder with only the four allowlisted,
   short-label dimensions. Traffic is counted in the proxy by closed host/route/kind
   vocabularies and flushed once a minute; no path, query, address, user agent or cookie is
   ever stored. Response status codes remain in Azure ingress metrics.
7. **One design system.** The portal reuses the app shell (through one optional `chrome`
   prop), the workspace surfaces and tokens, and adds only inline-SVG data primitives; no
   new runtime dependency.

Not decided here: binding `admin.warthog.com.au` (DNS and the managed certificate), which
remains a founder-approved operation per the delivery controls; showing addresses in the
portal; cohort retention and alerting (later, once there are enough accounts).

## Amendment, 13 November 2026: no entry in the member app

After the launch the founder asked that the member app give no sign the portal exists:
"The only way to access admin portal is to type admin.warthog.com.au, there should not be a
link to it in app.warthog.com.au". So:

- Settings no longer has the "Admin portal" panel or the admin notices. It is back to its
  pre-portal form, and a test keeps "admin" out of its markup.
- The portal's routes moved from `/admin` to an internal prefix that is not a guessable
  word. On the app host, `/admin` is now simply a path the app does not have: the same
  not-found page, status and headers as any other. A first attempt answered it with a
  rewrite and a not-found page instead. It still differed (Next exposes the rewrite in an
  `x-middleware-rewrite` header, and a page-level `notFound()` kept its own title), so the
  measured differences, not intent, decided this design.
- The admin host has its own sign-in page. Its "Sign in" goes through the app's ordinary
  sign-in to `<prefix>/handoff`, a server-only route on the app host that mints the same
  single-use handoff (role, live account and five-minute step-up unchanged) and redirects.
  A stale step-up is sent to a fresh sign-in (`/signin?fresh=1`) rather than an inline
  confirmation, so no portal code or wording reaches a member's browser. A fresh sign-in
  counts as the step-up, so it takes one passkey prompt.
- The portal's stylesheet is imported only by the portal layout. It was in the root
  layout, so every member page downloaded its `.wh-admin-*` selectors.
- Decision 3 stands: passkeys remain scoped to `app.warthog.com.au`, and the admin host
  still checks no factor itself. Moving the RP ID would invalidate every member's passkeys.

Limits:
- The hostname is public by nature. Certificate Transparency logs list every issued
  certificate, including `admin.warthog.com.au`'s, and DNS answers for it. The member app
  reveals nothing, but anyone who finds the hostname reaches a sign-in page that only an
  admin can get past.
- A fresh sign-in replaces the browser's session cookie. The previous session in that
  browser stays listed under Security until it idles out (14 days), and can be signed out
  there.
