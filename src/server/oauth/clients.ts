// Client registration helpers for the OAuth authorization server (design §6.1):
//
//   - `createCimdFetcher` — the SSRF-guarded fetch of a Client ID Metadata Document.
//     An agent platform's `client_id` is an https URL pointing at its own metadata
//     document; Warthog fetches it to learn the client's redirect URIs and auth
//     method. Because the URL comes from an untrusted caller, the fetch is guarded
//     (constitution: outbound HTTP to user-influenced URLs goes through the SSRF
//     guard): https only, the resolved address must be public (no private, loopback
//     or link-local target — so a public-looking hostname cannot smuggle a request to
//     an internal address), a 5-second timeout, a 64 KB size cap, and a 24-hour cache.
//
//   - `createGuardedCimdFetcher` — the composition root (used by `/oauth/register`) that
//     wires `createCimdFetcher` to the connection-time guarded fetch from
//     `../http/guarded-fetch`, so the host is re-resolved and classified at connection
//     time (closing the DNS-rebinding gap), never the bare global fetch.
//
//   - `isAllowedRedirectUri` — the redirect-URI rule shared by CIMD and DCR: https on
//     any host and port is allowed; http is allowed ONLY for the two named local hosts
//     (`localhost`, `127.0.0.1`) on any port; everything else is refused.
//
//   - `createClientResolver` / `systemClientResolver` — review fix A1: the one place a
//     `client_id` on an authorize request becomes a KNOWN client with its registered
//     redirect URIs (a DCR row from `oauth_clients`, else a CIMD document fetched through
//     the guarded fetcher), or null. `/oauth/authorize` refuses anything that does not
//     resolve, so a crafted link can no longer name an arbitrary client or redirect.
//
// Outbound HTTP, DNS and the clock are injected as seams so the whole guard is unit-
// tested without a real socket or resolver (conventions: external services sit behind
// interfaces with fakes; tests never touch the network). The address classification (the
// SSRF guard's core) lives in `../http/guarded-fetch` and is imported here, so a single
// source of truth governs which addresses are refused for both the up-front lookup and
// the connection-time guard.

import { z } from "zod";

import { type Clock, systemClock } from "../seams/clock";
import { processSingleton } from "../seams/process-singleton";
import { getClient, type Registration } from "./store";
import type { Db } from "../db/index";
import {
  createGuardedFetch,
  isBlockedAddress,
  stripBrackets,
  systemResolver,
  type HostResolver,
} from "../http/guarded-fetch";

const TIMEOUT_MS = 5_000; // abort an in-flight CIMD fetch after 5 seconds
const MAX_BYTES = 64 * 1024; // refuse a CIMD document larger than 64 KB
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // cache a fetched document for 24 hours

// The seams the fetcher depends on: outbound HTTP, DNS resolution, and the clock.
export interface CimdFetcherDeps {
  // The outbound HTTP seam (the global `fetch` shape).
  readonly fetch: typeof globalThis.fetch;
  // The DNS seam: resolve a hostname to its IP address string(s).
  readonly lookup: (hostname: string) => Promise<string[]>;
  // The time seam, used for the 24-hour cache.
  readonly clock: Clock;
}

// A parsed CIMD document. The shape is validated where it is consumed; here it is
// returned as-is (the fetcher's job is to retrieve it safely, not to interpret it).
type CimdDocument = Record<string, unknown>;

interface CacheEntry {
  readonly doc: CimdDocument;
  readonly fetchedAtMs: number;
}

// Build a CIMD fetcher closed over its seams. Each fetcher keeps its own 24-hour
// cache keyed by client_id, so a repeat fetch within the window makes no new request.
export function createCimdFetcher(
  deps: CimdFetcherDeps,
): (clientId: string) => Promise<CimdDocument> {
  const cache = new Map<string, CacheEntry>();

  return async function resolve(clientId: string): Promise<CimdDocument> {
    // Serve a still-fresh cached document without re-resolving or re-fetching.
    const cached = cache.get(clientId);
    if (cached && deps.clock.now().getTime() - cached.fetchedAtMs < CACHE_TTL_MS) {
      return cached.doc;
    }

    // https-only: a non-https (or malformed) client_id is refused before any request.
    let url: URL;
    try {
      url = new URL(clientId);
    } catch {
      throw new Error("CIMD client_id is not a valid URL");
    }
    if (url.protocol !== "https:") {
      throw new Error("CIMD client_id must be an https URL");
    }

    // Address guard: an IP-literal host is classified directly; a hostname is resolved
    // and EVERY resolved address classified, so a public-looking hostname cannot
    // override the guard (DNS rebinding / host override) and a single blocked answer
    // refuses the whole request.
    const hostname = stripBrackets(url.hostname);
    if (isBlockedAddress(hostname)) {
      throw new Error("CIMD host is a private, loopback or link-local address");
    }
    const addresses = await deps.lookup(hostname);
    if (addresses.length === 0) {
      throw new Error("CIMD host does not resolve to any address");
    }
    if (addresses.some(isBlockedAddress)) {
      throw new Error("CIMD host resolves to a private, loopback or link-local address");
    }

    // Fetch AND read the body inside one 5-second budget. The timer stays armed until the
    // body is fully read: a hostile server can send headers at once and then trickle the
    // body, so clearing the timer when headers arrive would leave the read unbounded.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let text: string;
    try {
      const response = await deps.fetch(clientId, {
        signal: controller.signal,
        // Never follow a redirect to a new host — it would bypass the address guard.
        redirect: "error",
      });
      text = await readBodyCapped(response, MAX_BYTES, controller.signal);
    } finally {
      clearTimeout(timer);
    }
    let doc: unknown;
    try {
      doc = JSON.parse(text);
    } catch {
      throw new Error("CIMD document is not valid JSON");
    }
    if (typeof doc !== "object" || doc === null) {
      throw new Error("CIMD document is not a JSON object");
    }

    const parsed = doc as CimdDocument;
    cache.set(clientId, { doc: parsed, fetchedAtMs: deps.clock.now().getTime() });
    return parsed;
  };
}

// The composition root for the CIMD fetcher (used by `/oauth/register`): it wires
// `createCimdFetcher` to the CONNECTION-TIME guarded fetch from `../http/guarded-fetch`
// — an outbound HTTP that re-resolves the host at connection time — NEVER the bare
// global fetch. The SAME resolver backs both the up-front classification (the `lookup`
// seam) and the connection-time guard inside the guarded fetch, so a DNS-rebinding
// client_id that classifies as public up front but connects to a private address is
// refused before any byte is sent. https-only, the 5-second timeout and the 64 KB cap
// are `createCimdFetcher` properties this factory composes unchanged. Production passes
// no deps (real node:dns + the real guarded fetch); tests inject the DNS and clock seams.
export function createGuardedCimdFetcher(
  deps: { readonly clock?: Clock; readonly resolve?: HostResolver } = {},
): (clientId: string) => Promise<CimdDocument> {
  const clock = deps.clock ?? systemClock;
  const resolve = deps.resolve ?? systemResolver;
  return createCimdFetcher({
    fetch: createGuardedFetch({ resolve }),
    lookup: resolve,
    clock,
  });
}

// Read a response body, enforcing the byte cap as we go so an oversized (or lying)
// response is refused without being buffered whole. A declared content-length over
// the cap short-circuits before a single byte is read. When `signal` aborts (the
// timeout), the reader is cancelled so a pending read settles and the call rejects —
// without relying on the fetch implementation to error the body stream itself.
async function readBodyCapped(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<string> {
  const declared = response.headers.get("content-length");
  if (declared !== null && Number(declared) > maxBytes) {
    throw new Error("CIMD document exceeds the size cap");
  }

  const reader = response.body?.getReader();
  if (!reader) {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > maxBytes) {
      throw new Error("CIMD document exceeds the size cap");
    }
    return text;
  }

  const timedOut = () => new Error("CIMD fetch timed out");
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
          throw new Error("CIMD document exceeds the size cap");
        }
        chunks.push(value);
      }
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
  return Buffer.concat(chunks).toString("utf8");
}

// --- Redirect-URI rule (shared by CIMD and DCR) ------------------------------------

// True for an https URL (any host, any port), or an http URL whose host is exactly
// `localhost` or `127.0.0.1` (any port); false for everything else (http to any other
// host, another scheme, or a malformed URL).
export function isAllowedRedirectUri(uri: string): boolean {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  if (url.protocol === "https:") return true;
  if (url.protocol === "http:") {
    return url.hostname === "localhost" || url.hostname === "127.0.0.1";
  }
  return false;
}

// --- Client resolution (review fix A1) ---------------------------------------------

// A client the authorization server knows: its id, how it registered, and the redirect
// URIs it registered. An authorize request's redirect_uri must EXACTLY equal one of these.
export interface ResolvedClient {
  readonly clientId: string;
  readonly registration: Registration;
  readonly redirectUris: readonly string[];
}

// Resolve a client_id to the client it names, or null when it names none.
export type ClientResolver = (clientId: string) => Promise<ResolvedClient | null>;

// The fields a CIMD document must carry for Warthog to trust it as a client: its own
// client_id (compared with the URL it was fetched from) and its redirect URIs. Bounded,
// so a hostile document can't hand back an unbounded list. Other metadata is ignored.
const MAX_CIMD_REDIRECT_URIS = 20;
const MAX_REDIRECT_URI_LENGTH = 2048;
const cimdDocumentSchema = z.object({
  client_id: z.string(),
  redirect_uris: z
    .array(z.string().min(1).max(MAX_REDIRECT_URI_LENGTH))
    .min(1)
    .max(MAX_CIMD_REDIRECT_URIS),
});

// True when a client_id is shaped like a CIMD client id (an https URL).
function isCimdClientId(clientId: string): boolean {
  try {
    return new URL(clientId).protocol === "https:";
  } catch {
    return false;
  }
}

// Build a resolver over the db (DCR and pre-registered clients) and a CIMD fetcher. A
// client registered in `oauth_clients` wins; otherwise an https client_id is fetched as a
// CIMD document and accepted only when the document names the SAME client_id and lists
// its redirect URIs. Every failure — an unknown id, a refused or failed fetch, a
// malformed or mismatched document — resolves to null, so authorize fails closed.
export function createClientResolver(deps: {
  readonly db: Db;
  readonly fetchCimd: (clientId: string) => Promise<Record<string, unknown>>;
}): ClientResolver {
  return async function resolveClient(clientId: string): Promise<ResolvedClient | null> {
    if (clientId === "") return null;

    const registered = await getClient(deps.db, clientId);
    if (registered != null) {
      return {
        clientId: registered.clientId,
        registration: registered.registration,
        redirectUris: registered.redirectUris,
      };
    }

    if (!isCimdClientId(clientId)) return null;
    let doc: Record<string, unknown>;
    try {
      doc = await deps.fetchCimd(clientId);
    } catch {
      return null;
    }
    const parsed = cimdDocumentSchema.safeParse(doc);
    if (!parsed.success || parsed.data.client_id !== clientId) return null;
    return { clientId, registration: "cimd", redirectUris: parsed.data.redirect_uris };
  };
}

// The production resolver: the process-wide guarded CIMD fetcher (held through
// processSingleton so its 24-hour cache is shared by every route, page and action and
// survives across requests) over the given db.
export function systemClientResolver(db: Db): ClientResolver {
  const fetchCimd = processSingleton("oauth.cimdFetcher", () => createGuardedCimdFetcher());
  return createClientResolver({ db, fetchCimd });
}
