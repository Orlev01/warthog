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
- **The app host** (`app.warthog.com.au`) behaves as before, except at `/`:
  - signed-in members still go to Home;
  - signed-out visitors now go to `/signin` instead of the front door.

  Help, compatibility, privacy and terms stay on the app host too, so the workspace's Help link
  and the account screens' policy links never leave the app.
- **Links.**
  - On the website, every sign-in, sign-up, recover and reset link is an absolute link to the app,
    and the brand links to the website.
  - The account screens' brand and "Back to home" lead to the website, so they never loop back
    to sign-in.
  - Without a separate host, all of these stay relative.
- **Traffic.** Website requests are counted under their own host class, `site`, labelled
  "Website" on the admin Traffic page.

## Rules

- Only the proxy branches on the host, and only to narrow what a host serves. Every redirect
  target is an origin derived from configuration, never the request's own `Host`. The path is set
  as a pathname, so `//elsewhere` cannot change the target host.
- **Redirects** are permanent (`308` keeps the method) and sent with `cache-control: no-store`, so
  browsers don't remember them if this changes.
- **Sessions.** The session cookie is `__Host-` (host-only), so the website never receives it.
  Passkeys keep the RP ID `warthog.com.au`, which covers both hosts, so existing passkeys are
  unaffected.
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

Certificate renewal needs the A record to keep pointing at the environment's IP; a new environment
would need the record updated. As with `app` and `admin`, never delete the container app while
these records point at it.
