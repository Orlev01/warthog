// Test-only: a POST to `/mcp` as a 2026-07-28 client sends it — what claude.ai, Claude Code
// and Cowork sent on every call when measured on 16 Nov (docs/adr/agent-runs.md), so tests
// drive the path production traffic takes rather than the 2025 `initialize`-era fallback.
//
// The request carries the per-request envelope in `params._meta` (protocol version, client
// capabilities and info) and the headers that mirror the body (`MCP-Protocol-Version`,
// `Mcp-Method`, and `Mcp-Name` for the methods that name a target), plus an Accept naming
// both JSON and SSE. A string body is sent verbatim with only the version header, for the
// malformed-body cases. A test that is ABOUT the 2025 era uses `legacyMcpRequest`.

export const MCP_PROTOCOL_VERSION = "2026-07-28";

// The body field each method's `Mcp-Name` header mirrors (2026-07-28, SEP-2243).
const NAME_FIELD: Record<string, string> = { "tools/call": "name", "prompts/get": "name", "resources/read": "uri", "tasks/get": "taskId", "tasks/update": "taskId", "tasks/cancel": "taskId" };

export interface McpRequestOptions {
  readonly url?: string;
  readonly headers?: Record<string, string>;
  readonly clientInfo?: { readonly name: string; readonly version: string };
}

export function mcpRequest(body: unknown, opts: McpRequestOptions = {}): Request {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": MCP_PROTOCOL_VERSION,
  };
  let payload: string;
  if (typeof body === "string") {
    payload = body;
  } else {
    const message = body as { method?: string; params?: Record<string, unknown> };
    const params = message.params ?? {};
    const meta = (params._meta ?? {}) as Record<string, unknown>;
    payload = JSON.stringify({
      ...message,
      params: {
        ...params,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": MCP_PROTOCOL_VERSION,
          "io.modelcontextprotocol/clientCapabilities": {},
          "io.modelcontextprotocol/clientInfo": opts.clientInfo ?? { name: "warthog-test", version: "1.0.0" },
          ...meta,
        },
      },
    });
    if (message.method) headers["mcp-method"] = message.method;
    const field = message.method ? NAME_FIELD[message.method] : undefined;
    if (field && typeof params[field] === "string") headers["mcp-name"] = params[field] as string;
  }
  return new Request(opts.url ?? "https://warthog.example/mcp", {
    method: "POST",
    headers: { ...headers, ...opts.headers },
    body: payload,
  });
}

// The 2025-era request (no envelope; `initialize` opens it) that the endpoint still serves
// statelessly — claude.ai's connector check sends it — for the tests about that fallback.
export function legacyMcpRequest(body: unknown, opts: Omit<McpRequestOptions, "clientInfo"> = {}): Request {
  return new Request(opts.url ?? "https://warthog.example/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-11-25",
      ...opts.headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}
