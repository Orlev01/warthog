// E07-S12 — the MCP route (Streamable HTTP): `POST /mcp`, the agent connector endpoint
// and the agent auth boundary (design §6.1/§6.2, constitution 15/16).
//
// The injection seam lives HERE, in a SIBLING of `route.ts`: a Next App-Router
// `route.ts` may export ONLY the known route keys (the HTTP verbs + framework config
// like `runtime`) or `next build` rejects it (OBS-025). So the factory that lets the
// handler be unit-tested with injected `verify` / `dispatch` / `config` cannot live in
// the entry — `route.ts` imports `createMcpRouteHandler` and exports just the verbs.
//
// The route's own job (the only thing it owns; the MCP wire protocol lives in the
// registry/pipeline the dispatch drives):
//   - POST validates the request `Origin` (the DNS-rebinding guard, design §6.2): a
//     cross-site Origin is refused; the non-browser agent (no Origin) and a same-origin
//     request pass. The allowed origin is the CONFIGURED public base URL, never the
//     request host, so a spoofed Host cannot widen it.
//   - POST then verifies the Bearer token. On failure it answers `401` carrying the
//     RFC 9728 / RFC 6750 `WWW-Authenticate: Bearer resource_metadata="…", scope="warthog"`
//     challenge (built by `verifyBearer` from the configured base URL).
//   - On success the VERIFIED connection id — the session identity, NEVER a value from
//     the body — is handed to `dispatch`, which drives the stateless `createMcpHandler`
//     MCP server, and the route returns the tool result it produces.
//   - GET and DELETE are not agent operations on this stateless endpoint → `405`, never
//     routed to the tool dispatch (design §6.2).
//
// A server module built from its INJECTED seams: it reads configuration through the
// `config` seam and holds no secret (INV-103). Every seam has a production default,
// resolved LAZILY per request so importing `route.ts` stays side-effect-free (next build
// evaluates route modules where runtime config is absent): `verifyBearer` over the
// process-wide db, and a stateless `createMcpHandler` built once per process.

import { createMcpHandler, McpServer, type McpHttpHandler } from "@modelcontextprotocol/server";

import { verifyBearer, type BearerVerification } from "../../server/oauth/verify-bearer";
import { loadConfig, type Config } from "../../server/config";
import { getServerDb } from "../../server/db/server";
import { systemClock } from "../../server/seams/clock";
import { processSingleton } from "../../server/seams/process-singleton";

// The injectable seams. Each is optional with a production default; the tests supply all
// three so the route's own gating is exercised without the db or the MCP wire protocol.
export interface McpRouteSeams {
  // Resolve the request's Bearer credential to a connection, or a 401 challenge.
  readonly verify?: (request: Request) => Promise<BearerVerification>;
  // Drive the MCP server for the VERIFIED connection and return its HTTP response.
  readonly dispatch?: (connectionId: string, request: Request) => Promise<Response>;
  // The Origin allowlist + challenge source.
  readonly config?: Config;
}

export interface McpRouteHandlers {
  GET(request: Request): Promise<Response>;
  POST(request: Request): Promise<Response>;
  DELETE(request: Request): Promise<Response>;
}

// This resource requires the `warthog` scope (design §6.1/§6.2).
const MCP_SCOPE = "warthog";

// The stateless MCP server's identity (design §6.2 — one handler per process).
const MCP_SERVER_NAME = "warthog";
const MCP_SERVER_VERSION = "0.1.0";

// JSON responses carry no credential, so they must not be cached.
const JSON_HEADERS = { "content-type": "application/json", "cache-control": "no-store" };

// The raw bearer from an `Authorization: Bearer <token>` header, or null when absent /
// not the Bearer scheme (matched case-insensitively, as RFC 7235 permits).
function readBearer(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (header == null) return null;
  const space = header.indexOf(" ");
  if (space === -1) return null;
  if (header.slice(0, space).toLowerCase() !== "bearer") return null;
  const token = header.slice(space + 1).trim();
  return token === "" ? null : token;
}

// Is the request's Origin allowed (the DNS-rebinding guard, design §6.2)? A request with
// no Origin header is the non-browser agent case and is allowed; a browser request must
// match the CONFIGURED public origin exactly, never the request host.
function isAllowedOrigin(request: Request, config: Config): boolean {
  const origin = request.headers.get("origin");
  if (origin === null) return true;
  try {
    return origin === new URL(config.publicBaseUrl).origin;
  } catch {
    return false;
  }
}

// A cross-site Origin is refused before any auth or tool dispatch (the DNS-rebinding
// guard, design §6.2).
function forbiddenOrigin(): Response {
  return new Response(JSON.stringify({ error: "origin_not_allowed" }), {
    status: 403,
    headers: JSON_HEADERS,
  });
}

// The RFC 9728 / RFC 6750 challenge the client sees on a failed verification: a 401
// carrying the `WWW-Authenticate` header `verifyBearer` built from the configured base
// URL (never a baked literal, INV-103).
function unauthorized(verification: Extract<BearerVerification, { ok: false }>): Response {
  return new Response(JSON.stringify({ error: "unauthorized" }), {
    status: verification.status,
    headers: { ...JSON_HEADERS, "WWW-Authenticate": verification.wwwAuthenticate },
  });
}

// GET / DELETE are 2025 session operations the stateless endpoint has no use for
// (design §6.2) — refused with 405 before any auth or tool dispatch.
function methodNotAllowed(): Response {
  return new Response(JSON.stringify({ error: "method_not_allowed" }), {
    status: 405,
    headers: { ...JSON_HEADERS, Allow: "POST" },
  });
}

// The production MCP server: a stateless `createMcpHandler` built once per process
// (Next splits route/page module graphs, so a bare module-level instance would split —
// hence `processSingleton`). The verified connection is handed to the SDK as
// pass-through `authInfo`; the SDK caps the body size and rejects an unparseable body,
// so a malformed/oversized POST is a handled 4xx (INV-102). The tool registry + pipeline
// wiring the server serves is a downstream integration task.
function defaultMcpHandler(): McpHttpHandler {
  return processSingleton("mcp.handler", () =>
    createMcpHandler(() => new McpServer({ name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION }), {
      legacy: "stateless",
    }),
  );
}

export function createMcpRouteHandler(seams: McpRouteSeams = {}): McpRouteHandlers {
  // Config is resolved per request, never at module load, so importing `route.ts` is
  // side-effect-free (next build evaluates route modules where runtime config is absent).
  function resolveConfig(): Config {
    return seams.config ?? loadConfig();
  }

  async function verify(request: Request, config: Config): Promise<BearerVerification> {
    if (seams.verify) return seams.verify(request);
    const db = await getServerDb();
    return verifyBearer(request, { db, config, clock: systemClock });
  }

  async function dispatch(connectionId: string, request: Request): Promise<Response> {
    if (seams.dispatch) return seams.dispatch(connectionId, request);
    return defaultMcpHandler().fetch(request, {
      authInfo: {
        token: readBearer(request) ?? connectionId,
        clientId: connectionId,
        scopes: [MCP_SCOPE],
      },
    });
  }

  return {
    async POST(request: Request): Promise<Response> {
      const config = resolveConfig();

      // 1. Origin — the DNS-rebinding guard, before auth or any tool dispatch.
      if (!isAllowedOrigin(request, config)) return forbiddenOrigin();

      // 2. Bearer — resolve the credential to its connection, or challenge with 401.
      const verification = await verify(request, config);
      if (!verification.ok) return unauthorized(verification);

      // 3. Hand the VERIFIED connection (never a body value) to the tool dispatch and
      //    return the tool result it produces (design §6.2).
      return dispatch(verification.connectionId, request);
    },

    async GET(): Promise<Response> {
      return methodNotAllowed();
    },

    async DELETE(): Promise<Response> {
      return methodNotAllowed();
    },
  };
}
