// E09-S08 — Provider-hosted MCP client (CIMD / DCR). Design §6.1, §7 ("Connector
// engine"). A `provider_mcp` connector (GitHub, Notion, …) is reached as an MCP
// *client*. It is always connectable because Warthog self-registers: it presents its
// own Client ID Metadata Document URL (`/oauth/client-metadata.json`) as its
// `client_id` when the provider advertises CIMD support, and falls back to Dynamic
// Client Registration (RFC 7591) when it does not — then lists the provider's tools.
//
// Two responsibilities live here:
//
//   1. `createGuardedProviderFetch` — the SSRF-guarded outbound fetch every provider
//      request (discovery, DCR, the MCP transport) rides on. CLAUDE.md security:
//      "Outbound HTTP to user-influenced URLs (CIMD documents, provider MCP servers)
//      goes through the SSRF guard — https only, no private/loopback/link-local IPs,
//      timeouts, size caps." It classifies the host up front (an IP literal directly,
//      a hostname by EVERY resolved address) AND delegates to the connection-time
//      guarded fetch from `../http/guarded-fetch` (which re-resolves at connection
//      time), so a DNS-rebinding host that answers public to the up-front classifier
//      and private to the socket is still refused. The address classification is the
//      SSRF guard's core from `../http/guarded-fetch` (one source of truth).
//
//   2. `connectProviderMcp` — discovers the provider's authorization-server metadata,
//      registers (CIMD or DCR), lists the provider's tools, and stores the connection
//      DEK-encrypted on a NEW connection owned by the session's `userId` through the
//      SAME `../db/connections` record store the generic (api_key/oauth2) connectors
//      use (so both connector shapes resolve through one store).
//
// The provider HOST is taken ONLY from the catalogue entry's `base_url` and the
// provider's own discovery metadata — never a value from the caller (CLAUDE.md:
// "Connector requests never take a host from the caller"). The operator-configured
// CIMD identity is INJECTED from config (the one env reader, INV-103); this module
// reads no `process.env` and holds no ambient secret. The DB, the clock (connected-at,
// never Date.now()), the HTTP fetch and the MCP transport are all injected seams, so
// tests freeze time and record requests without touching the network.

import type { CatalogueEntry } from "../../domain/catalogue/schema";
import { createConnection, type Connection } from "../db/connections";
import type { Db } from "../db/index";
import type { Clock } from "../seams/clock";
import {
  createGuardedFetch,
  isBlockedAddress,
  stripBrackets,
  systemResolver,
  type HostResolver,
} from "../http/guarded-fetch";
import { connectCallbackUrl } from "../http/routes";

// ===========================================================================
// 1. The SSRF-guarded outbound fetch.
// ===========================================================================

const TIMEOUT_MS = 10_000; // abort an in-flight provider request after 10 seconds
const MAX_BYTES = 1024 * 1024; // refuse a provider response larger than 1 MiB

// The seams the guarded provider fetch depends on, both optional so the production
// composition can wire the real ones by calling with no argument:
//   - `resolve`: the DNS seam for the up-front address classification (default node:dns);
//   - `fetch`:   the inner transport delegated to once a request is allowed (default the
//                connection-time guarded fetch, which re-resolves and refuses at the socket).
export interface GuardedProviderFetchDeps {
  readonly resolve?: HostResolver;
  readonly fetch?: typeof globalThis.fetch;
}

// Build a `fetch`-shaped function that refuses a non-https URL and a private / loopback
// / link-local host before the inner transport is ever called, bounds the request with a
// timeout, caps the response body size, and otherwise delegates to the inner transport
// and returns its response. Production passes no deps (real node:dns + the real guarded
// fetch); tests inject a DNS seam and a spy transport.
export function createGuardedProviderFetch(
  deps: GuardedProviderFetchDeps = {},
): typeof globalThis.fetch {
  const resolve = deps.resolve ?? systemResolver;
  // The SAME resolver backs the up-front classifier and the connection-time guard, so a
  // host that classifies as public up front but connects to a private address is refused.
  const inner = deps.fetch ?? createGuardedFetch({ resolve });

  const guarded = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = toUrl(input);

    // https-only: a non-https URL is refused before any resolution or transport call.
    if (url.protocol !== "https:") {
      throw new Error(`provider fetch supports only https, not ${url.protocol}`);
    }

    // Address guard: an IP-literal host is classified directly; a hostname is resolved and
    // EVERY resolved address classified, so a public-looking hostname cannot smuggle a
    // private target and a single blocked answer refuses the whole request.
    const hostname = stripBrackets(url.hostname);
    if (isBlockedAddress(hostname)) {
      throw new Error("provider host is a private, loopback or link-local address");
    }
    const addresses = await resolve(hostname);
    if (addresses.length === 0) {
      throw new Error("provider host does not resolve to any address");
    }
    if (addresses.some(isBlockedAddress)) {
      throw new Error("provider host resolves to a private, loopback or link-local address");
    }

    // Bound the request (and the body read) within one timeout budget: a hostile server
    // can send headers at once and trickle the body, so the timer stays armed until the
    // body is fully read.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await inner(input, { ...init, signal: controller.signal });
      const text = await readBodyCapped(response, MAX_BYTES, controller.signal);
      // Keep null distinct from an empty string: 204/205/304 and HEAD are
      // bodyless, and reconstructing them with text can turn success into error.
      return new Response(response.body === null ? null : text, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } finally {
      clearTimeout(timer);
    }
  };

  return guarded as typeof globalThis.fetch;
}

// Normalise a fetch input to a URL for the up-front protocol / host checks.
function toUrl(input: RequestInfo | URL): URL {
  if (typeof input === "string") return new URL(input);
  if (input instanceof URL) return new URL(input.href);
  return new URL((input as Request).url);
}

// Read a response body, enforcing the byte cap as we go so an oversized (or lying)
// response is refused without being buffered whole. A declared content-length over the
// cap short-circuits before a single byte is read. When `signal` aborts (the timeout),
// the reader is cancelled so a pending read settles and the call rejects.
async function readBodyCapped(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<string> {
  const declared = response.headers.get("content-length");
  if (declared !== null && Number(declared) > maxBytes) {
    throw new Error("provider response exceeds the size cap");
  }

  const reader = response.body?.getReader();
  if (!reader) {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > maxBytes) {
      throw new Error("provider response exceeds the size cap");
    }
    return text;
  }

  const timedOut = () => new Error("provider fetch timed out");
  if (signal.aborted) {
    await reader.cancel().catch(() => {});
    throw timedOut();
  }
  const onAbort = () => {
    reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", onAbort, { once: true });

  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (signal.aborted) throw timedOut();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel();
          throw new Error("provider response exceeds the size cap");
        }
        chunks.push(value);
      }
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
  return Buffer.concat(chunks).toString("utf8");
}

// ===========================================================================
// 2. The provider-hosted MCP client (CIMD / DCR).
// ===========================================================================

// One MCP tool the provider exposes.
export interface ProviderTool {
  readonly name: string;
  readonly description?: string;
}

// The MCP-client seam: list the provider's tools over the (SSRF-guarded) fetch, given
// the provider server URL and Warthog's resolved client_id. The transport never runs in
// tests (a recording stand-in captures the params).
export type ListProviderTools = (params: {
  serverUrl: string;
  clientId: string;
  fetch: typeof fetch;
}) => Promise<ProviderTool[]>;

// The operator-configured CIMD identity, injected from config (the one env reader,
// INV-103). `clientMetadataUrl` is the https URL Warthog presents as its `client_id`
// under CIMD; it points at `/oauth/client-metadata.json` on Warthog's own host. Warthog
// never fetches this URL — the provider does; Warthog only presents it.
export interface ProviderMcpConfig {
  readonly clientMetadataUrl: string;
}

// The injected seams: parameterizing data access, the clock (connected-at), the
// SSRF-guarded HTTP fetch, and the MCP-client transport.
export interface ProviderMcpDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly fetch: typeof fetch;
  readonly listTools: ListProviderTools;
}

// What connecting a provider_mcp entry needs. `userId` is always the session's id (never
// a client value); the host comes only from `entry`.
export interface ConnectProviderMcpInput {
  readonly entry: CatalogueEntry;
  readonly config: ProviderMcpConfig;
  readonly userId: string;
  readonly accountLabel: string;
  readonly dek: Uint8Array;
}

// The created connection (WITHOUT credentials) plus the provider's listed tools.
export interface ConnectProviderMcpResult {
  readonly connection: Connection;
  readonly tools: ProviderTool[];
}

// The slice of the provider's authorization-server metadata this client reads. Every
// other field (issuer, endpoints, …) is ignored here — the host is never taken from it.
interface AuthServerMetadata {
  readonly client_id_metadata_document_supported?: boolean;
  readonly registration_endpoint?: string;
}

// Connect a provider_mcp entry: discover the provider's metadata, register (CIMD when the
// provider advertises it, else DCR), list the provider's tools, and store the connection
// DEK-encrypted on a NEW connection owned by `userId`. Returns the Connection (without
// credentials) and the listed tools.
export async function connectProviderMcp(
  input: ConnectProviderMcpInput,
  deps: ProviderMcpDeps,
): Promise<ConnectProviderMcpResult> {
  const metadata = await discoverMetadata(input.entry, deps.fetch);

  // CIMD when the provider advertises it (present `config.clientMetadataUrl`, make NO DCR
  // request); otherwise fall back to DCR (POST the metadata's registration endpoint and
  // use the issued client_id). An absent flag is treated as unsupported.
  let registrationMethod: string;
  let clientId: string;
  if (metadata.client_id_metadata_document_supported === true) {
    registrationMethod = "cimd";
    clientId = input.config.clientMetadataUrl;
  } else {
    registrationMethod = "dcr";
    clientId = await registerViaDcr(metadata, input.config, deps.fetch);
  }

  // List the provider's tools through the MCP transport, handing it the provider server
  // URL (the entry's host only), the resolved client_id and the SAME SSRF-guarded fetch
  // so the transport's own requests are guarded too.
  const tools = await deps.listTools({
    serverUrl: input.entry.base_url,
    clientId,
    fetch: deps.fetch,
  });

  // Store the registration DEK-encrypted on a new connection owned by the session user,
  // through the same record store the generic connectors use. A dynamic (DCR) client_id
  // must persist; a CIMD client_id is stored too so both shapes resolve uniformly.
  const connection = await createConnection(
    deps.db,
    {
      userId: input.userId,
      connectorId: input.entry.id,
      accountLabel: input.accountLabel,
      credentials: { registration: registrationMethod, client_id: clientId },
      status: "connected",
    },
    input.dek,
    deps.clock,
  );

  return { connection, tools };
}

// Discover the provider's authorization-server metadata over the guarded fetch. The
// discovery URL is built at the ENTRY's origin only (host from the entry, never a caller
// value). Throws (never silently) on a non-2xx response or a non-object document.
async function discoverMetadata(
  entry: CatalogueEntry,
  fetchFn: typeof fetch,
): Promise<AuthServerMetadata> {
  const url = new URL("/.well-known/oauth-authorization-server", entry.base_url);
  const response = await fetchFn(url.href, {
    method: "GET",
    headers: { accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`provider ${entry.id} discovery failed (HTTP ${response.status})`);
  }
  const doc = (await response.json()) as unknown;
  if (typeof doc !== "object" || doc === null) {
    throw new Error(`provider ${entry.id} returned invalid discovery metadata`);
  }
  return doc as AuthServerMetadata;
}

// Register via Dynamic Client Registration (RFC 7591): POST a public-client metadata
// document to the metadata's `registration_endpoint` (at the provider's host) and return
// the issued client_id. No client secret is sent (a public client authenticates with
// "none"); no ambient env value is folded into the request.
async function registerViaDcr(
  metadata: AuthServerMetadata,
  config: ProviderMcpConfig,
  fetchFn: typeof fetch,
): Promise<string> {
  const endpoint = metadata.registration_endpoint;
  if (!endpoint) {
    throw new Error("provider does not support CIMD and advertises no registration endpoint");
  }

  const body = {
    client_name: "Warthog",
    client_uri: new URL(config.clientMetadataUrl).origin,
    redirect_uris: [connectCallbackUrl(config.clientMetadataUrl)],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  };

  const response = await fetchFn(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`provider dynamic client registration failed (HTTP ${response.status})`);
  }
  const doc = (await response.json()) as unknown;
  if (
    typeof doc !== "object" ||
    doc === null ||
    typeof (doc as Record<string, unknown>).client_id !== "string"
  ) {
    throw new Error("provider dynamic client registration returned no client_id");
  }
  return (doc as { client_id: string }).client_id;
}
