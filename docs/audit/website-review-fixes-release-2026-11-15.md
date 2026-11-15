# Website review fixes release — 15 November 2026

Application source `c00f1e99874f7897a7effc78384b7e8dadaf87ba` is live as revision
`warthog--r43644774383a1`. This is PR #27 (main `c00f1e9`). The founder asked for it to be
merged and released after a review of PR #26, the [website on the root domain](website-root-domain-release-2026-11-14.md).

## The review

Five specialist reviews looked at PR #26:
- correctness;
- security;
- architecture and performance;
- operations;
- testing and user journeys.

An independent review then checked the fixes. **Nothing exploitable was found.**
- Redirect targets cannot leave the configured origins.
- The admin prefix appears in no public HTML or JavaScript.
- Cookies, Origin checks and the rate limiter hold across the website's `308`s.

The [ADR](../adr/website-root-domain.md) now records the decisions.

| Finding | Fix |
| --- | --- |
| The website advertised the installable app, whose start URL `/home` 308s to another origin | Only the app host links the manifest and the iOS standalone tags. The website and the admin host leave them out. |
| The public pages were served on both hosts with no canonical | `/`, `/help`, `/help/compatibility`, `/privacy` and `/terms` name their website URL as canonical. |
| A signed-in member following the website's Sign up got the sign-up form | `/signup` forwards a signed-in visitor to Home or a safe `next`, as `/signin` does. |
| The public 404's way home was the app's `/`, which now means sign-in | It leads to the website (on the admin host it keeps `/`). The error screen keeps `/`, which takes a member Home. |
| Website redirects were counted as page views, so each hop counted twice | Redirects are not counted; the request they lead to is. |
| Public components imported the module that names the admin prefix, without leaking it (latent) | The link helpers moved to `src/server/http/public-links.ts` (type-only import, guard test). |
| Entry wiring was untested, and four tests failed with an `app.` base URL exported | `src/app/website-entries.test.tsx`; those four tests now pin their base URL. |
| Documentation errors | The passkey RP ID is `app.warthog.com.au`. `existingCustomDomains` must stay `[]` (a `create` refuses anything else). Rollback below `d45072c` needs the apex and www unbound first. `www` forwards to the website. |

**Deferred:**
- **Host routing trust.** A client can set `X-Forwarded-Host` to choose which host's routing its own request gets, and the ingress passes it through. This predates PR #26 and has no cross-user impact. Switching to `Host` alone first needs a header echo on a non-production revision.
- **No post-release website check.** The release checks only `/api/health` on the ingress FQDN; it does not check the apex and www.
- **Optional:**
  - a `robots.txt`;
  - the admin prefix's JSON 404 on the app host;
  - a shared derivation between `websiteFor` and `adminOriginFor`.

This was an image-only `update`. There are no migrations (still 83) and no configuration, hostname, infrastructure, workflow or delivery-script changes.

## Verification

- **Before merge:**
  - `npm test` passed: 6,106 tests, 9 of them new.
  - Typecheck and `next build` passed, with no `wh-op-` string in `.next/static`.
  - On the dev server with an `app.` base URL:
    - the website has no manifest and a correct canonical;
    - the app keeps the manifest;
    - the app 404 leads to the website, and the admin 404 keeps `/`.
  - Reverting each fix made its test fail.
- **CI:** PR #27 passed all six checks. The image run
  [43641334218](https://github.com/Orlev01/warthog/actions/runs/43641334218) repeated the
  suite before publication.
- **Image:** `…@sha256:2e4c1ce4…` carries:
  - the exact source label, journal label `v1`, linux/amd64, UID 1000, no setuid/setgid;
  - matching hashes for all 83 migrations, 106 catalogue entries and 80 brands.
- **Image scan:** 224 OS advisory pairs, none outside OS packages, against 220 last night.
  - The four added pairs are CVE-2025-6020 in `libpam-modules`, `libpam-modules-bin`, `libpam-runtime` and `libpam0g` `1.5.2-6+deb12u2` (HIGH, no Debian 12 fix yet).
  - The base image digest is unchanged, and its six base layers are identical to the previous image's. So the vulnerability database gained the advisory overnight; the image did not change, and production already carried the same package.
  - The process runs as UID 1000 with no setuid binaries and no PAM-based login.
- **Production:**
  - Run [43644774383](https://github.com/Orlev01/warthog/actions/runs/43644774383) succeeded (21:48–21:57Z).
  - Expected configuration hash: `e5936973…`, the same as the state after last night's release.
  - Independent inspection: one healthy replica running the exact image, explicit 100% traffic, zero old replicas, configuration unchanged.
- **Production probe** (62/62; 40 earlier checks plus 22 new ones):
  - Everything in the [previous probe](website-root-domain-release-2026-11-14.md#verification) still passes.
  - The website's five public pages carry no manifest or iOS standalone tags. Each names its own website URL as canonical.
  - The app's copies of those pages keep the manifest and name the website URL as canonical.
  - The app's 404 leads home to `https://warthog.com.au/` twice, through the brand and "Go to Warthog".
  - The app's `/signin` keeps the install tags, and `/signup` shows the form to a visitor.
  - Before the release, exactly the 11 checks for the new behaviour failed against production.
  - The admin host's sign-in page carries no manifest.
- **Runner:** a fresh private lease (11 reviewed creates) was destroyed after the job.
  - The first verify, destroy and cleanup attempt failed because this workstation briefly lost DNS (`login.microsoftonline.com` did not resolve).
  - All three were re-run once the network was back.

## Coordination

Session be was the sole release operator. Main was frozen from the image build to the release
dispatch.
