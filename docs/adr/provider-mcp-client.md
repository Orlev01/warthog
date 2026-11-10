# Outbound provider MCP connections

11 November 2026. Warthog uses the pinned MCP TypeScript client SDK for outbound
Streamable HTTP services. This is separate from an external agent connecting
inbound to Warthog.

The owner completes OAuth with PKCE and issuer validation. Discovery, client
registration, verifier and tokens stay server-side. Pending state is encrypted
under the owner's DEK, bound to the initiating browser session, consumed once,
and expires after ten minutes. Recreating the runtime does not lose it. At most
five flows per person and 1,000 overall are retained; starting a flow prunes
expired entries. Connection credentials and discovered tools are encrypted.

Discovery and execution use HTTPS with socket-time DNS checks, no redirects,
caller cancellation, a fifteen-second request budget and a one-MiB response cap.
SSE is streamed rather than buffered until EOF. Discovery accepts at most 200
uniquely named tools and one MiB of declarations. The SDK handles registration,
resource indicators, token exchange, issuer binding and refresh; none of those
security checks is disabled. Refresh rotation is serialized per connection, and
a later tool failure does not roll back refreshed credentials. Reconnect refreshes
the inventory and preserves the connection ID, so agent account selections remain.

Tools are namespaced by service and available only to the agent's selected account.
Provider arguments are a bounded object under `arguments`; the provider's schema
is included in its tool description. Provider annotations are untrusted: all these
tools count as changes and always require owner approval. Never-allow rules remain
in force; message prohibitions and conditional prohibitions are conservatively
applied when a provider cannot supply trustworthy effect metadata. The approval
is bound to its account and current permissions are checked again before execution.
There is no model sampling, plugin execution, or credential passthrough.

Local acceptance covers OAuth, issuer mismatch, authenticated discovery/call,
refresh (including a failed call after rotation), encrypted storage, restart,
session isolation, replay, expiry, reconnect, streamed responses, response bounds
and policy gates. This establishes the implementation's protocol contract, not
live certification of every catalogue provider. Providers that require a
pre-registered confidential client or a different transport may decline setup.
A successful consent, authenticated tool discovery and a permitted read must be
recorded for each real provider before declaring that integration verified.

Sources: [MCP TypeScript client](https://ts.sdk.modelcontextprotocol.io/v2/api/index/@modelcontextprotocol/client/),
[tool annotation trust](https://blog.modelcontextprotocol.io/posts/2026-03-16-tool-annotations/),
[Notion MCP](https://developers.notion.com/guides/mcp/overview).
