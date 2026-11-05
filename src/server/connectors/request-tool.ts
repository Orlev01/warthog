// E09-S09 — General request tool (design §7 "Connector engine"). Every connected
// service not covered by a curated tool is reachable through ONE authenticated request
// tool scoped to that service: `<id>__request {method, path, query, body}`. The host is
// taken ONLY from the catalogue entry's `base_url` — never a caller value (CLAUDE.md
// security: "Connector requests never take a host from the caller"), so a caller-supplied
// absolute URL or a path that tries to override the host is refused: there is no SSRF.
//
// GET/HEAD are classified reads; anything else makes a change (so the call follows the
// agent's change-making setting), with an unknown verb getting the stricter gate. The
// upstream call is bounded by a 20 s timeout and the response is truncated to ~100 KB
// before it reaches an agent.
//
// The credentials of the OWNED connection are resolved member-scoped by the SESSION's
// `userId` (never a client value) through `../db/connections`, decrypted under the owner's
// DEK, and presented to the upstream: the entry's templated header for a generic
// self-contained (api_key/basic) connection, or a Bearer access token for an oauth2 /
// provider_mcp connection — so BOTH connector shapes resolve through this one tool
// (OBS-046). The DB and the HTTP fetch (SSRF-guarded in production, recorded in tests) are
// injected seams, so this module reads no `process.env` and holds no ambient secret
// (INV-103); every read is parameterized through the `Db` seam (INV-102).

import type { CatalogueEntry } from "../../domain/catalogue/schema";
import { getConnectionCredentials } from "../db/connections";
import type { Db } from "../db/index";
import { HttpError } from "../http/validate";

// Abort an in-flight upstream request after 20 s (design §7).
const TIMEOUT_MS = 20_000;
// Truncate a response over ~100 KB before it reaches an agent (design §7).
const MAX_RESPONSE_BYTES = 100 * 1024;

// The injected seams: the parameterizing data access (member-scoped reads) and the HTTP
// fetch (SSRF-guarded in production, recorded in tests).
export interface RequestToolDeps {
  readonly db: Db;
  readonly fetch: typeof fetch;
}

// What one request through the tool needs. The HOST (base_url) and the auth kind come from
// `entry`, never from a caller; `userId` is always the session's id (never a client value);
// `connectionId` names which OWNED connection's credentials to present.
export interface ConnectorRequestInput {
  readonly entry: CatalogueEntry;
  readonly userId: string;
  readonly connectionId: string;
  readonly dek: Uint8Array;
  readonly method: string;
  readonly path: string;
  readonly query?: Record<string, string>;
  readonly body?: string;
}

// The upstream status and body (truncated to ~100 KB), passed back to the agent.
export interface ConnectorRequestResult {
  readonly status: number;
  readonly body: string;
  readonly truncated: boolean;
}

// GET / HEAD (any case) are reads; ANYTHING ELSE makes a change — so an unknown verb gets
// the stricter "makes changes" gate (it follows the agent's change-making setting).
export function requestMakesChange(method: string): boolean {
  const normalized = method.trim().toUpperCase();
  return !(normalized === "GET" || normalized === "HEAD");
}

// Join a RELATIVE path onto the entry's base URL and append the query parameters. REJECTS
// (4xx `HttpError`) any attempt to override the host — an absolute URL (a scheme present),
// a protocol-relative `//host`, or anything that resolves to a different host — so the host
// is always the entry's.
export function resolveRequestUrl(
  baseUrl: string,
  path: string,
  query?: Record<string, string>,
): URL {
  // Syntactic guard: an absolute URL (scheme present) or a protocol-relative authority
  // would steer the request off the entry host — refuse it before resolving.
  if (path.startsWith("//") || /^[a-z][a-z0-9+.-]*:/i.test(path)) {
    throw new HttpError(400, "the connector host cannot be overridden");
  }

  const base = new URL(baseUrl);
  const url = new URL(path, base);

  // Defence in depth: whatever the relative path resolved to, the host and scheme must
  // still be the entry's (catches e.g. backslash-authority tricks the syntactic guard
  // alone would miss) — otherwise refuse.
  if (url.host !== base.host || url.protocol !== base.protocol) {
    throw new HttpError(400, "the connector host cannot be overridden");
  }

  if (query) {
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, value);
    }
  }
  return url;
}

// Send ONE authenticated request to the entry's host at the resolved relative path,
// presenting the OWNED connection's credentials. Resolves for BOTH a generic
// self-contained (api_key/oauth2) connection AND a curated/registry-linked (provider_mcp)
// one. A host-override path is refused BEFORE any credential read or request; a connection
// that is not the session user's resolves no credentials and is refused — no request is
// sent in either case. The response is truncated to ~100 KB and the call aborts at 20 s.
export async function sendConnectorRequest(
  input: ConnectorRequestInput,
  deps: RequestToolDeps,
): Promise<ConnectorRequestResult> {
  // Resolve the URL first: a host-override path throws here, so no credential read and no
  // upstream request ever happen for it.
  const url = resolveRequestUrl(input.entry.base_url, input.path, input.query);

  // Member-scoped credential read: `userId` is the session's id, bound as a parameter. A
  // connection that is not this person's resolves null → refuse, send nothing.
  const credentials = await getConnectionCredentials(
    deps.db,
    input.userId,
    input.connectionId,
    input.dek,
  );
  if (!credentials) {
    throw new HttpError(404, "connection not found");
  }

  const headers = presentCredentials(input.entry, credentials);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const init: RequestInit = { method: input.method, headers, signal: controller.signal };
    // A body only rides on a change method (GET/HEAD carry none).
    if (input.body !== undefined && requestMakesChange(input.method)) {
      init.body = input.body;
    }

    const response = await deps.fetch(url.href, init);
    const raw = await response.text();
    return truncate(response.status, raw);
  } finally {
    clearTimeout(timer);
  }
}

// Build the outbound auth header(s) from the stored credentials by the entry's auth kind:
// a generic self-contained (api_key/basic) connection uses the entry's templated header;
// an oauth2 / provider_mcp connection presents its access token as a Bearer. The secret
// rides in a header only — never in the URL.
function presentCredentials(
  entry: CatalogueEntry,
  credentials: Record<string, unknown>,
): Record<string, string> {
  const headers: Record<string, string> = {};
  if (entry.auth_kind === "api_key" || entry.auth_kind === "basic") {
    const header = buildTemplatedHeader(entry.auth.header, credentials);
    if (header) headers[header.name] = header.value;
  } else {
    const token = credentials.access_token;
    if (typeof token === "string") {
      headers["Authorization"] = `Bearer ${token}`;
    }
  }
  return headers;
}

// Fill the entry's `Name: value` header template, injecting the person's key in place of
// the `{api_key}` placeholder. Split on the first colon so a value that itself contains a
// colon survives. Returns null when the entry declares no template.
function buildTemplatedHeader(
  template: string | undefined,
  credentials: Record<string, unknown>,
): { name: string; value: string } | null {
  if (!template) return null;
  const colon = template.indexOf(":");
  if (colon < 0) return null;
  const name = template.slice(0, colon).trim();
  const apiKey = typeof credentials.api_key === "string" ? credentials.api_key : "";
  const value = template.slice(colon + 1).trim().split("{api_key}").join(apiKey);
  return { name, value };
}

// Return the upstream body whole when it is within the cap; otherwise keep the leading
// ~100 KB (content-preserving truncation, not corruption) and flag it truncated.
function truncate(status: number, raw: string): ConnectorRequestResult {
  const bytes = Buffer.from(raw, "utf8");
  if (bytes.byteLength <= MAX_RESPONSE_BYTES) {
    return { status, body: raw, truncated: false };
  }
  return { status, body: bytes.subarray(0, MAX_RESPONSE_BYTES).toString("utf8"), truncated: true };
}
