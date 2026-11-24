# MCP spec hygiene — 24 November 2026

Application source `32a8e6e89da88a51165c8d03a61eab0dfc66be54` is live as revision
`warthog--r45318664835a1`. It carries PR #59.

## Why

The founder asked whether Cloudflare's "MCP v2" post (the MCP spec 2026-07-28) matters to
Warthog. `/mcp` already serves that spec: SDK 2.4.0, stateless, CIMD, and `iss` in the authorization
response. A review against the spec found four small gaps. The founder asked for them to be fixed,
then approved the release ("merge and run the release").

## What shipped (PR #59)

- **Tests use the protocol production uses.**
  - A shared `src/test/mcp-request.ts` builds 2026-07-28 requests: the `_meta` envelope plus
    `MCP-Protocol-Version`, `Mcp-Method` and `Mcp-Name`.
  - The compose, runs, read-levels, older-clients and consent-flow tests use it.
  - The 2025 era stays covered on purpose, through `legacyMcpRequest`:
    - client details recorded at `initialize`;
    - Warthog's instructions, through both `initialize` and `server/discover`;
    - one rate-limit refusal.
- **The token endpoint checks RFC 8707 `resource`.**
  - When a request names a `resource`, it must name the code's bound resource (code exchange) or
    `https://app.warthog.com.au/mcp` (refresh). Anything else gets `invalid_target`.
  - A refresh refused this way neither rotates nor revokes.
  - Leaving `resource` out works as before.
- **`/.well-known/oauth-protected-resource/mcp`** now serves the RFC 9728 document, at the path
  derived from the resource. It is the same document as at the bare path.
- **Design doc fixes (§6.1, §6.2):**
  - removed the `X-Accel-Buffering: no` claim, which nothing set;
  - recorded the token endpoint's `resource` rule.

No migrations (95). No change to what an agent can do.

## Verification

- **Locally:** 6,828 of 6,828 tests and a clean typecheck, on the branch merged with main `63e28d8`.
  - `next build` plus the boot smoke test passed 9 of 9, including a check that both metadata paths
    serve the same document.
  - The test helper's requests were confirmed modern with the SDK's `isLegacyRequest`.
- **PR checks:** passed on PostgreSQL 16. Main `32a8e6e` has exactly the checked tree, `9a8555a4`.
- **Image:** run 45318241112 reused the checks. The image is `…@sha256:72149826…`.
  - linux/amd64, UID 1000, no setuid or setgid, the deletion-journal label.
  - 95 migrations, 107 catalogue entries and 81 brand marks, with the source hashes matching.
  - Scan: no advisories in application dependencies, and none added or removed against the PR #58
    image.
- **Production:**
  - **Run:** [45318664835](https://github.com/Orlev01/warthog/actions/runs/45318664835) succeeded on a
    fresh private runner.
    - Its plan was reviewed: 11 creates, no deletes.
    - The VM was checked.
    - Private PostgreSQL DNS and TLS were confirmed without credentials.
  - **Result:** one healthy replica, explicit 100% traffic and zero old replicas.
  - **Configuration:** unchanged apart from image and revision. The hash before was `37611778…`.
  - **Probe:** 88/88 before and 92/92 after. The four new checks:
    - both metadata paths return 200 with resource `https://app.warthog.com.au/mcp`;
    - the two paths serve the same document;
    - a credential-free token request naming another resource gets `400 invalid_target`.

    That check records one `agent.token` `invalid_target` event, at about 03:32 UTC.
  - **Agent check:** `get_context` through the founder's claude.ai connector succeeded on the new
    revision.
  - **Runner:** destroyed, and the cleanup check found nothing left.

## Not checked in production

- **A real client refreshing a token after the release.** claude.ai, ChatGPT and Claude Code
  refreshes are covered by the tests. Any `agent.token` `invalid_target` beyond the probe's event
  would mean a client sends a mismatched `resource`.
- **The dev agent console** (`src/components/dev/agent-console-view.tsx`) still sends 2025-06-18. It
  works through the fallback.
