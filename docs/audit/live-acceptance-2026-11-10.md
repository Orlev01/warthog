# Live acceptance testing — 10 November 2026

Testing used the deployed `f406b2b` release at `app.warthog.com.au`, the founder's
authenticated browser session and clearly labelled synthetic data. The founder
separately approved one temporary Standard agent for API testing. Cards, high-tier
identity, external services and sharing learned information were off.

## Completed checks

| Area | Observed result |
| --- | --- |
| Memory UI | Create, edit, exact-label search, persisted readback and delete passed. Test note removed; empty state verified. |
| Skills UI | Create, edit, persisted readback and delete passed. Test Skill removed; empty state verified. No Skill search control exists. |
| Public boundaries | Eleven checks pass: health, signed-out Home redirect, missing/invalid MCP bearer, cross-site Origin, disabled GET/DELETE, valid signed-out OAuth and rejected missing/plain PKCE/wrong resource. |
| OAuth | Client registration, browser consent and S256 code exchange passed with an exactly registered `localhost` callback. |
| MCP | Initialize and tool discovery pass. Empty memory input is rejected. A synthetic note is saved as kept, read back exactly and attributed to the test agent in the UI. Unknown tools and an ungranted external-service tool are rejected. |
| Permission change | Turning off shared-memory access persists after navigation and immediately refuses both API memory reads and writes. No denied-write record is created. |
| Refresh | Rotation issues a new refresh token; an immediate retry returns the same successor, and its access token works. |
| Revocation | The revocation endpoint succeeds. Both original and rotated access tokens then return 401; both refresh tokens return 400 `invalid_grant`. |

The API-created note was deleted through the UI before permissions were reduced.
The temporary agent's credentials are revoked. Chrome's adapter timed out before
it could accept the disconnect confirmation, and native control could not reach
that dialog. An operator transaction then marked only the exact founder-owned
test agent disconnected, under the application's connection lock, after requiring
zero tokens, codes, access keys and pending approvals. Exactly one agent row
changed; the private evidence records this cleanup. **UI disconnection remains
unverified**; operator cleanup is not counted as a UI pass. Browser console
captures for the Memory and Skill tests contain no errors.

## Defects and source corrections

1. **Loopback OAuth callback rejected.** Next 15.5.29's URL normalization rewrites
   `127.0.0.1` inside the callback query value to `localhost`. This makes an
   otherwise valid request fail Warthog's exact registered-URI comparison. The
   rejection reproduced in production and a disposable local Node 22/Linux app;
   the deployed handler called directly accepted the unchanged request. Setting
   `skipMiddlewareUrlNormalize: true` preserves query values without weakening
   redirect validation. A real build/HTTP regression fails before the correction
   and passes afterward, including unchanged opaque state and rejection of an
   unregistered alternate callback host. The boot test explicitly uses the
   container's `0.0.0.0` bind hostname so localhost defaults cannot hide the bug.
2. **Empty Memory form shows a generic error.** The server correctly refuses the
   empty record, but the browser form has no required-field validation. Add and
   edit fields now declare `required` and the existing 20,000-character limit.

The corrected source passes 45 focused checks on Node 22/Linux: the production
build/HTTP boot suite, Memory rendering, OAuth authorization and route-handler
tests. Build/type checks and `git diff --check` pass. These source corrections
have **not been deployed**; production still runs the approved first image.

[Full CI run 42779041795](https://github.com/Orlev01/warthog/actions/runs/42779041795)
also passes all six jobs on source `0ef32390e2a3289e7d7297e96da90135af2bc382`:
5,079 application tests with zero failures, real PostgreSQL 16 checks on every
shard, runtime builds, delivery guards and Terraform provider-schema validation.

## Remaining acceptance

- Fresh sign-in and credential/recovery lifecycle, with founder interaction for
  Authenticator or device prompts. The real account has not been reset or deleted.
- Provider connection and push delivery/permission flows. No provider connection,
  external message, purchase, DNS change or infrastructure change was made here.
- Receipt uploads at the small, near-25-MiB, over-file-limit and over-request-limit
  boundaries. Synthetic fixtures are prepared and browser upload is available,
  but the current receipt UI has no delete/archive path. Establish exact test
  record/blob cleanup before this test, rather than leaving synthetic files behind.
- Coordinated restore/deletion acceptance in a reviewed isolated environment.
- The Security page's missing Authenticator status indicator and passkey-only
  recovery copy remain presentation findings from the earlier browser review.

Private screenshots, sanitized outcomes and local test logs are under the ignored
owner-only `.delivery/activation-2026-11-10/acceptance/` directory. OAuth secrets
are never committed. Existing exact image/deployment reviews, spending, credential,
public DNS and live-message approval boundaries remain in force.
