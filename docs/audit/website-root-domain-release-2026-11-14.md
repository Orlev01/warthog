# Website on the root domain release — 14 November 2026

Application source `d45072c3bc4d282269f3c17b886daf743ebbf71d` is live as revision
`warthog--r43589445907a1`. The founder asked for `warthog.com.au` to be the marketing website,
with sign-up and sign-in on `app.warthog.com.au`, "so they can always see the marketing website
as well as their logged in portal independently". This is PR #26 (main `d45072c`)
([ADR](../adr/website-root-domain.md)):

- **[warthog.com.au](https://warthog.com.au)** always shows the front door, signed in or not.
  It also serves Help, Connect your agents, Privacy and Terms, and every account link on these
  pages is an absolute link to the app. Every other path answers `308` to the same path and
  query on the app.
- **www.warthog.com.au** answers `308` to the website.
- **[app.warthog.com.au](https://app.warthog.com.au)** behaves as before, except at `/`:
  - signed-in members still go to Home;
  - signed-out visitors now go to sign-in, instead of the front door.

  The brand on the sign-in screens leads to the website.

The website host is derived from `PUBLIC_BASE_URL`, like the admin host, so this was a plain
image-only `update`. There are no migrations (still 83) and no configuration, infrastructure,
workflow or delivery-script changes. The traffic counters gained a `site` host class.

## Hostname binding (before the release)

The founder added four GoDaddy records through a browser agent:

| Type | Name | Value |
| --- | --- | --- |
| A | `@` | `20.227.110.81` (replacing GoDaddy's two parked addresses) |
| TXT | `asuid` | the app's `customDomainVerificationId` |
| CNAME | `www` | the app's ingress FQDN (was `@`) |
| TXT | `asuid.www` | the app's `customDomainVerificationId` |

A before/after diff of every other known record against GoDaddy's nameserver showed nothing
else changed (`app`, `admin`, `asuid.app`, `asuid.admin`, `_dmarc`, `_domainconnect`). The
following were then bound with free managed certificates, both issued at once and expiring
14 May 2027:

- `warthog.com.au`, with HTTP validation (`mc-cae-warthog-pr-warthog-com-au-4151`);
- `www.warthog.com.au`, with CNAME validation (`mc-cae-warthog-pr-www-warthog-com--9884`).

All four hostnames are SNI bindings. The expected configuration hash (`cb8af1b4…`) was taken
after the binding.

Not yet recorded: `existingCustomDomains` in the private workload parameters, which matters only
for a future `create`. It should now list all four domains. `update` never needs it.

## Verification

- **CI:**
  - PR #26 passed on its branch (all six checks).
  - The image run [43586374201](https://github.com/Orlev01/warthog/actions/runs/43586374201)
    repeated the suite before publication: **6,097 tests**, zero failures.
  - The first image run, 43583739385, was refused before building because its approval reference
    contained a comma.
- **Local, dev server with `PUBLIC_BASE_URL=http://app.localhost:3107`:**
  - the website serves its five pages;
  - website `/signin?next=%2Fhome`, `/home`, `/admin` and `/api/health` answer `308` to the
    app with path and query;
  - www answers `308`;
  - the app's `/` sends a signed-out visitor to sign-in.
- **Image:** `…@sha256:1d0158ff…` carries:
  - the exact source label, journal label `v1`, linux/amd64, UID 1000, no setuid/setgid;
  - matching hashes for all 83 migrations, 106 catalogue entries and 80 brands.

  Its scan shows 220 OS advisory pairs and none outside OS packages, with none added or removed
  against the previous image.
- **Production:** run [43589445907](https://github.com/Orlev01/warthog/actions/runs/43589445907)
  succeeded. Independent inspection found:
  - one healthy replica running the exact image;
  - explicit 100% traffic and zero old replicas;
  - configuration unchanged apart from image and revision;
  - all four custom domains still bound.
- **Production probe** (40/40 checks):
  - The website's `/`, `/help`, `/help/compatibility`, `/privacy` and `/terms` answer `200`. Their
    sign-in, sign-up, recover and reset links are absolute to the app, and none are relative.
  - Build assets load on the website host.
  - Website `/signin?next=%2Fhome`, `/signup`, `/home`, `/api/health`, `/mcp`, `/admin` and
    `/recover` answer `308` with `no-store` to the same path and query on the app.
  - `//evil.test/x` stays on the app.
  - www `/`, `/help?x=1` and `/signin` answer `308` to the website.
  - The app's `/` answers `307` to `/signin`.
  - The app's `/signin`, `/signup`, `/help`, `/privacy` and `/terms` answer `200`, and the sign-in
    brand links to `https://warthog.com.au/`.
  - The app's `/admin` is still an ordinary 404, and health is ok.
  - The admin host is unchanged.
  - All four certificates match their hostnames.
- **Real browser (desktop):**
  - `www.warthog.com.au` lands on `warthog.com.au` with the front door hydrated, the diagrams
    animating (42 animations in view), no horizontal overflow and no console errors.
  - In a browser signed in to the app, the website still showed the front door, and its Sign in
    link opened the member's Home on the app.
- **Runner:** a fresh private lease (11 reviewed creates) was destroyed after the job. Cleanup
  was verified, and no GitHub runner remains.
  - The first runner plan stopped on a timed-out lock-blob call before anything was created.
  - Its own lease expired within a minute, and the retry succeeded.

## Notes

- The repository is private, so the main-head check before dispatch now uses the authenticated
  GitHub API. An anonymous `git ls-remote` gets "Repository not found".
- Members who had bookmarked `app.warthog.com.au/` while signed out will now see sign-in
  instead of the front door. The front door's address is `warthog.com.au`.

## Coordination

Session be was the sole release operator. Main was frozen from the image build to the release
dispatch.
