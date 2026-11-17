# Notion connects: Warthog's client document names it — 17 November 2026

Application source `2c306f7aee1099ebf02e41b8f6998d17b06ef7ec` is live as revision
`warthog--r44003796746a1`. It carries PR #39.

## Why

Connecting Notion failed at Notion's sign-in with `{"error":"invalid_request","error_description":"Invalid client_id"}`.
- Notion advertises "Client ID Metadata Document" support, so Warthog presents
  `https://app.warthog.com.au/oauth/client-metadata.json` as its client id.
- Notion's sign-in runs Cloudflare's OAuth provider library, which refuses a document without a
  `client_name`. Warthog's document had none.
- The library also grants only the grant types a document lists, so renewals would have failed
  without `refresh_token`.

## What shipped

- The document now carries:
  - `client_name: "Warthog"`;
  - `grant_types: ["authorization_code", "refresh_token"]`;
  - `response_types: ["code"]`.
- These match the metadata Warthog already sends when it registers by DCR.
- An amendment is added to the [provider MCP ADR](../adr/provider-mcp-client.md).
- No migrations, configuration, infrastructure, package or workflow changes.

## Verification

- **PR #39:** passed every check (run
  [44002133138](https://github.com/Orlev01/warthog/actions/runs/44002133138)). The full local suite
  passed 6,262 tests.
- **Main and image:** main run 44003250942 and image run 44003330763 both reused that result for
  the same tree.
  - The image is `…@sha256:a48cfe2a…`, with source, journal and hash checks passing (85
    migrations).
  - Its scan is identical to the previous image's: 226 OS pairs, none added.
- **Production:**
  - Run [44003796746](https://github.com/Orlev01/warthog/actions/runs/44003796746) succeeded: one
    healthy replica, explicit 100% traffic, zero old replicas, and configuration unchanged apart
    from image and revision.
  - Probe: 62/62. The fresh private runner was destroyed, and the cleanup check is clean.
- **Notion:** the same authorize request that failed now returns 302 to Notion's own sign-in
  (`api.notion.com/v1/oauth/authorize`).
