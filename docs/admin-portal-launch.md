# Admin portal launch — admin.warthog.com.au

The application code needs no new production configuration: the admin origin is derived
from `PUBLIC_BASE_URL`, the portal is gated by `users.role` (seeded hourly from the existing
`OPERATOR_EMAIL`), and the additive migrations 0110–0112 run at first use like every other.
What remains is the usual image release plus one separately approved operation: binding the
hostname. Nothing in this file authorises spending, DNS changes or a deployment; each is its
own founder decision under [the delivery controls](adr/production-delivery-controls.md).

## 1. Release the image (the usual procedure)

1. Merge `claude/admin-portal` into `main` after CI passes.
2. Run `azure-image.yml` on `main` and record the immutable digest.
3. Run `azure-release.yml` `inspect`, review the configuration hash, then `update` with the
   digest and the hash. The image-only revision copy preserves every existing custom-domain
   binding, and `validate_live` still proves `PUBLIC_BASE_URL` and the RP ID unchanged.
4. After the release: `https://app.warthog.com.au/admin` must answer 404 (the app origin
   never serves the portal), and Settings on the app shows the "Admin portal" panel for the
   operator's account within an hour (the `operator-role` sweep; restart or wait for the
   first tick after boot).

## 2. Bind the hostname (separate approval; run by the founder)

Do this before `inspect` or after `update`, never between them: a binding changes the
configuration fingerprint and `update` would refuse with "Live configuration changed"
(then simply rerun `inspect`).

With the Azure CLI signed in to the dedicated Warthog subscription (`az account set
--subscription e854f594-274f-4051-841b-78df7655d73c`; the personal "Azure subscription 1"
is the wrong one) and the resource group / app name from the delivery variables:

```sh
# a. The ownership value the TXT record carries.
az containerapp show -g "$RESOURCE_GROUP" -n "$APP_NAME" --query properties.customDomainVerificationId -o tsv
# b. The app's own FQDN the CNAME points at.
az containerapp show -g "$RESOURCE_GROUP" -n "$APP_NAME" --query properties.configuration.ingress.fqdn -o tsv
```

At GoDaddy, after a fresh zone check that preserves every existing record (thirteen at the
app launch), add exactly two records and nothing else:

| Type | Name | Value |
| --- | --- | --- |
| CNAME | `admin` | the ingress FQDN from (b), e.g. `warthog.<unique>.australiaeast.azurecontainerapps.io` |
| TXT | `asuid.admin` | the verification id from (a) |

Then bind with a free managed certificate (issuance takes minutes; poll until `Succeeded`):

```sh
az containerapp hostname add  -g "$RESOURCE_GROUP" -n "$APP_NAME" --hostname admin.warthog.com.au
az containerapp hostname bind -g "$RESOURCE_GROUP" -n "$APP_NAME" --hostname admin.warthog.com.au \
  --environment "$ENVIRONMENT_NAME" --validation-method CNAME
az containerapp hostname list -g "$RESOURCE_GROUP" -n "$APP_NAME" -o table
```

Record both bindings in the private workload parameters (`existingCustomDomains`, copied
exactly from `az containerapp show … --query properties.configuration.ingress.customDomains`)
so a future `create` operation would carry them; `update` never needs them.

Never delete the container app while the `admin` CNAME exists (subdomain takeover); remove
the record first.

## 3. Verify

- `https://admin.warthog.com.au/` redirects to `https://app.warthog.com.au/settings?notice=admin_signin_required`
  when no admin session exists; `https://admin.warthog.com.au/api/auth/signin` and
  `/oauth/authorize` are 404; the response carries `X-Robots-Tag: noindex, nofollow` and the
  same CSP/HSTS as the app.
- From the app's Settings, "Open admin portal" asks for a passkey or authenticator
  confirmation when the last one is older than five minutes, then lands on the Overview at
  `https://admin.warthog.com.au/`. Range tabs, Back/Forward and deep links work.
- "Sign out of admin" returns to Settings with "You've signed out of the admin portal."
  Signing out of the app on Security ends the admin session too.
- Traffic appears on the Traffic page within two minutes (the `traffic-flush` sweep).
- Record the binding, certificate expiry and these checks in a release note under
  `docs/audit/`, as the app launch did.
