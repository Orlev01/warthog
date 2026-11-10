import assert from "node:assert/strict";
const serverUrl = "https://service.example.test/mcp",
  issuer = "https://auth.example.test";
export function providerFixture() {
  const calls: Request[] = [];
  let expired = false;
  let refreshes = 0;
  let failCall = false;
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    calls.push(req.clone());
    const url = new URL(req.url);
    if (url.pathname.includes("oauth-protected-resource"))
      return Response.json({
        resource: serverUrl,
        authorization_servers: [issuer],
      });
    if (
      url.pathname.includes("oauth-authorization-server") ||
      url.pathname.includes("openid-configuration")
    )
      return Response.json({
        issuer,
        authorization_endpoint: issuer + "/authorize",
        token_endpoint: issuer + "/token",
        registration_endpoint: issuer + "/register",
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
      });
    if (url.pathname === "/register")
      return Response.json(
        {
          client_id: "registered",
          redirect_uris: ["https://warthog.example.test/connect/callback"],
          token_endpoint_auth_method: "none",
        },
        { status: 201 },
      );
    if (url.pathname === "/token") {
      const params = new URLSearchParams(await req.text());
      if (params.get("grant_type") === "refresh_token") refreshes++;
      return Response.json({
        access_token: refreshes ? "renewed" : "access",
        refresh_token: "refresh",
        token_type: "Bearer",
        expires_in: 3600,
      });
    }
    if (url.pathname === "/mcp") {
      if (expired && req.headers.get("authorization") === "Bearer access")
        return new Response(null, {
          status: 401,
          headers: {
            "www-authenticate": `Bearer resource_metadata="https://service.example.test/.well-known/oauth-protected-resource"`,
          },
        });
      assert.ok(
        ["Bearer access", "Bearer renewed"].includes(
          req.headers.get("authorization") ?? "",
        ),
      );
      if (req.method !== "POST") return new Response(null, { status: 405 });
      const msg = (await req.json()) as {
        id?: number;
        method: string;
        params?: { protocolVersion: string };
      };
      if (msg.id === undefined) return new Response(null, { status: 202 });
      if (msg.method === "tools/call" && failCall)
        return new Response(null, { status: 503 });
      const result =
        msg.method === "initialize"
          ? {
              protocolVersion: msg.params!.protocolVersion,
              capabilities: { tools: {} },
              serverInfo: { name: "fixture", version: "1" },
            }
          : msg.method === "tools/list"
            ? {
                tools: [
                  {
                    name: "search",
                    description: "Search documents",
                    inputSchema: {
                      type: "object",
                      properties: { query: { type: "string" } },
                      required: ["query"],
                    },
                  },
                ],
              }
            : { content: [{ type: "text", text: "fixture result" }] };
      return Response.json({ jsonrpc: "2.0", id: msg.id, result });
    }
    return new Response(null, { status: 404 });
  }) as typeof globalThis.fetch;
  return {
    fetch,
    calls,
    failCalls: (value: boolean) => {
      failCall = value;
    },
    expire: () => {
      expired = true;
    },
    refreshes: () => refreshes,
  };
}
export const settings = {
  serverUrl,
  publicBaseUrl: "https://warthog.example.test",
  state: "opaque-state",
};
