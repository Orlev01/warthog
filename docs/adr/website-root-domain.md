# The website on the root domain

Decision: 14 November 2026. The founder asked for `warthog.com.au` to be the marketing website,
with sign-up and sign-in on `app.warthog.com.au`, "so they can always see the marketing website as
well as their logged in portal independently". Before this, the front door was the signed-out `/`
of `app.warthog.com.au`, and a signed-in member could not see it. The root domain showed a GoDaddy
Website Builder placeholder.

## What changed

- **Hosts.** The website host is derived from `PUBLIC_BASE_URL` (`app.<domain>` → `<domain>`), in
  the same way as the admin host (`src/server/http/website.ts`). Production needs no new setting, and
  the deploy script's exact `PUBLIC_BASE_URL` and RP ID checks still hold. Any other public base
  URL (localhost, a bare domain) has no separate website and behaves as before.
- **The website host** (`warthog.com.au`) serves:
  - `/`, which always shows the front door, signed in or not, without opening the database;
  - `/help`, `/help/compatibility`, `/privacy`, `/terms`;
  - build assets.

  Every other path answers `308` to the same path and query on the app. Old links and bookmarks,
  such as `/signin?next=…`, therefore still land in the right place.
- **`www.<domain>`** answers `308` to the website, keeping the path and query.
- **The app host** (`app.warthog.com.au`) behaves as before, except:
  - at `/`, signed-out visitors now go to `/signin` instead of the front door (signed-in
    members still go to Home);
  - a signed-in member who opens Sign up (the website shows it to everyone) goes to Home, or
    their safe `next`, as Sign in already does. `/signin?fresh=1` is unaffected.

  Help, compatibility, privacy and terms stay on the app host too, so the workspace's Help link
  and the account screens' policy links never leave the app.
- **Links.**
  - On the website, every sign-in, sign-up, recover and reset link is an absolute link to the app,
    and the brand links to the website.
  - The account screens' brand and "Back to home" lead to the website, so they never loop back
    to sign-in.
  - The public 404's brand and "Go to Warthog" lead to the website too, not the app's `/` (it is
    shown to visitors who aren't signed in); on the admin host they keep `/`. The error screen
    keeps `/`: it also catches errors in the signed-in workspace, and `/` takes a member Home.
  - Without a separate host, all of these stay relative.
  - The link helpers live in `src/server/http/public-links.ts`, which has no runtime imports, so
    the public components never import the admin routing module (and its internal prefix), even
    if one becomes a client component.
- **Metadata.**
  - On the website and admin hosts, the root metadata leaves out the web app manifest and the
    iOS standalone tags (`apple-mobile-web-app-capable`), so installing from either cannot create
    an app on the wrong origin (the manifest starts at `/home`, which the website forwards to the
    app and the admin host does not have). Only the app host keeps them.
  - `/`, `/help`, `/help/compatibility`, `/privacy` and `/terms` declare a canonical URL on the
    website origin, on both hosts, so search engines index the website rather than the app
    host's copies.
- **Traffic.** Requests the website serves itself are counted under their own host class, `site`,
  labelled "Website" on the admin Traffic page. Its redirects (www → website, website → app) are
  not counted; the request they lead to is, so a visit counts once.

## Rules

- **Host checks** only narrow what a host serves, or which links and metadata a page shows
  (today in the proxy, the root page, the root metadata and the 404 page). Every redirect target
  and absolute URL comes from configuration, never the request's own `Host`. The path is set as a
  pathname, so `//elsewhere` cannot change the target host.
- **The request host is not a security boundary.** It is read from `x-forwarded-host`, else
  `host` (`requestHostname` in `src/server/admin/origin.ts`). Azure Container Apps ingress passes
  a client-supplied `X-Forwarded-Host` through, so a non-browser client can choose which host's
  routing applies to its own request: in production, `X-Forwarded-Host: evil.example` sent to
  `warthog.com.au/signin` serves the app's sign-in page. The host split is a routing convenience,
  and nothing security-relevant may depend on it. Cookies are `__Host-`, Origin checks compare
  against configured origins, and responses are `no-store` (no cache keeps a response routed by a
  forged header). Open item: reading only `Host` may be better, but first verify with a header
  echo on a non-production revision what the ingress puts in `Host`.
- **Redirects** are permanent (`308` keeps the method) and sent with `cache-control: no-store`, so
  browsers don't remember them if this changes.
- **Sessions.** The session cookie is `__Host-` (host-only), so the website never receives it.
  Passkeys keep the RP ID `app.warthog.com.au`, so existing passkeys are unaffected. The website
  never runs a passkey ceremony and, like the admin host, cannot use members' passkeys, so sign-in
  has to stay on the app host.
- **The admin portal stays hidden.** The website serves none of its paths, and anything else on
  the website forwards to the app. There, `/admin` is an ordinary missing page.
- `Strict-Transport-Security: …; includeSubDomains` is now also sent from the root domain. Every
  name under `warthog.com.au` must serve HTTPS, which is true today (`app`, `admin`, `www`).

## Hostname binding (separate from the release)

The website needs two more custom domains on the container app, with free managed certificates.
They are bound before the image release: the bindings change the configuration fingerprint, so
the release's expected configuration hash is taken afterwards.

| Type | Name | Value | Validation |
| --- | --- | --- | --- |
| A | `@` | the environment's static IP (`az containerapp env show … --query properties.staticIp`) | HTTP |
| TXT | `asuid` | the app's `customDomainVerificationId` | |
| CNAME | `www` | the app's ingress FQDN | CNAME |
| TXT | `asuid.www` | the app's `customDomainVerificationId` | |

```sh
az containerapp hostname add  -g "$RESOURCE_GROUP" -n "$APP_NAME" --hostname warthog.com.au
az containerapp hostname bind -g "$RESOURCE_GROUP" -n "$APP_NAME" --hostname warthog.com.au \
  --environment "$ENVIRONMENT_NAME" --validation-method HTTP
az containerapp hostname add  -g "$RESOURCE_GROUP" -n "$APP_NAME" --hostname www.warthog.com.au
az containerapp hostname bind -g "$RESOURCE_GROUP" -n "$APP_NAME" --hostname www.warthog.com.au \
  --environment "$ENVIRONMENT_NAME" --validation-method CNAME
```

Both certificates expire on 14 May 2027; check before then that they have renewed. The apex's
certificate uses HTTP validation. Its first issuance succeeded while the previous image, which
answers the validation paths with `404`, served the apex, so the platform ingress answers the
validation, not the app, and the website's `308`s don't affect renewal. Renewal needs the A
record to keep pointing at the environment's IP; a new environment would need the record updated.
As with `app` and `admin`, never delete the container app while these records point at it.

## Releases and rollback

- The website shares the app's single replica, so every release's stop-before-start window also
  takes the front door down.
- **Prefer fixing forward.** An image older than `d45072c`, with the apex and www still bound,
  serves the whole app on `warthog.com.au` and `www`: its proxy routes every host but the admin
  host as the app. Sign-in there fails, because the Origin check answers `403` and the RP ID
  `app.warthog.com.au` covers neither name. Its admin Traffic page also drops `site.*` rows
  from the breakdowns, while the request total includes them.
- To go below `d45072c`, first remove both hostnames
  (`az containerapp hostname delete -g "$RESOURCE_GROUP" -n "$APP_NAME" --hostname …`) and take
  the expected configuration hash afterwards, or accept a broken front door for the window. Bind
  them again, as above, once a later image is back.
