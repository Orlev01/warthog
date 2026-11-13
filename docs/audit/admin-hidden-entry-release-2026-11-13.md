# Hidden admin entry releases — 13 November 2026

Application source `2366ed6964725097967035ffb546f588ef0f65f5` is live at
[app.warthog.com.au](https://app.warthog.com.au) as revision
`warthog--r43435987370a1`. It carries two changes made at the founder's request: "The
only way to access admin portal is to type admin.warthog.com.au, there should not be a
link to it in app.warthog.com.au. I don't want people to know the admin portal exists."
Decision record: the amendment in [admin-portal](../adr/admin-portal.md).

## What shipped

1. **PR #22, main `f78216e`, revision `warthog--r43425801828a1`:**
   - Settings lost the "Admin portal" panel and notices.
   - The admin host got its own sign-in page, which goes through the app's ordinary sign-in.
   - Expired handoffs and admin sign-out land on the admin host.
2. **PR #23, main `2366ed6`, revision `warthog--r43435987370a1`:** the production check of
   #22 found three ways the app still told the portal's paths apart, and this release
   closes them.
   - **The tells:**
     - Next exposed the `/admin` rewrite in an `x-middleware-rewrite` header;
     - a non-admin's `/handoff` 404 was titled "Continue · Warthog";
     - the root layout shipped the portal's stylesheet to every member page.
   - **The fixes:**
     - the portal's routes moved to an internal prefix that is not a guessable word, so
       `/admin` on the app host is an ordinary unknown path;
     - the handoff is a server-only route under that prefix, with no page or client code;
       a stale step-up goes to a fresh sign-in (`/signin?fresh=1`);
     - the portal stylesheet is imported only by the portal layout.

No migrations (still 83), dependencies, infrastructure, workflows or delivery scripts
changed. Both releases were image-only `update`s and kept both hostname bindings.

## Verification

- **CI:** PR #22 and PR #23 passed on their branches and on main. The image runs
  [43423023862](https://github.com/Orlev01/warthog/actions/runs/43423023862) and
  [43433331770](https://github.com/Orlev01/warthog/actions/runs/43433331770) repeated the
  suite before publication. The final suite was **6,016 tests** with zero failures.
- **Real browser, dev server with virtual passkeys:** all 18 checks passed on the final tree.
  - For an anonymous visitor and a member, `/admin`, `/admin/usage` and `/handoff` match
    an ordinary missing page: status, title, header names, and no admin wording.
  - The handoff route answers a bare 404 to anyone who is not an admin.
  - Stale step-up: admin host → fresh passkey sign-in → Overview.
  - Fresh step-up: signing out of admin and back in needs no prompt.
  - App sign-out ends the admin session.
  - A fresh passkey sign-in from the admin host lands on the Overview.
  - An expired handoff shows its notice.
  - Settings is clean for both accounts.
- **Build scan:** only the portal layout's script and the portal stylesheet contain portal
  wording. None of the 65 member route manifests references either, and the webpack
  runtime does not name them.
- **Images:**
  - `…@sha256:d8e39763…` (f78216e) and `…@sha256:0a8c38e2…` (2366ed6) both have the exact
    source label, journal label `v1`, linux/amd64, UID 1000 and no setuid/setgid;
  - all 83 migration, 106 catalogue and 80 brand hashes match the source;
  - the same 219 OS advisory pairs as the previous image, none added, zero non-OS.
- **Production:** runs
  [43425801828](https://github.com/Orlev01/warthog/actions/runs/43425801828) (expected
  configuration `9b23db42…`) and
  [43435987370](https://github.com/Orlev01/warthog/actions/runs/43435987370) (`b5432f29…`)
  succeeded. Each time, independent inspection found one healthy replica, the exact image,
  explicit 100% traffic, zero old replicas, and configuration unchanged apart from image
  and revision. Both custom domains stayed bound.
- **Production probe after 2366ed6:**
  - `/admin`, `/admin/usage` and `/handoff` on `app.warthog.com.au` returned the same
    status (404), the same response header names and the same body as a random missing
    path, after normalising nonces, element ids and the echoed path. No admin wording.
  - The app's stylesheets contain no portal selectors.
  - `admin.warthog.com.au/` redirects to its `/signin`, whose link is the app's ordinary
    sign-in with the handoff as `next`.
  - An expired handoff lands on `/signin?notice=expired`.
  - Health is ok.
- **Runners:** fresh private leases (11 reviewed creates each), destroyed after each job.
  Cleanup was verified, and no GitHub runner remains.

## Limits

- `admin.warthog.com.au` is public by nature: Certificate Transparency logs list its
  certificate, and DNS answers for it. The member app reveals nothing, but anyone who finds
  the hostname reaches a sign-in page only an admin can get past.
- A fresh sign-in replaces the browser's session cookie. The previous session in that
  browser stays listed under Security until it idles out, and can be signed out there.
