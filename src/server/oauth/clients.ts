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
//   - `isAllowedRedirectUri` — the redirect-URI rule shared by CIMD and DCR: https on
//     any host and port is allowed; http is allowed ONLY for the two named local hosts
//     (`localhost`, `127.0.0.1`) on any port; everything else is refused.
//
// Outbound HTTP, DNS and the clock are injected as seams so the whole guard is unit-
// tested without a real socket or resolver (conventions: external services sit behind
// interfaces with fakes; tests never touch the network).

import type { Clock } from "../seams/clock";

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

    // Fetch, cancellable at the 5-second timeout via the AbortSignal we hand to fetch.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let response: Response;
    try {
      response = await deps.fetch(clientId, {
        signal: controller.signal,
        // Never follow a redirect to a new host — it would bypass the address guard.
        redirect: "error",
      });
    } finally {
      clearTimeout(timer);
    }

    const text = await readBodyCapped(response, MAX_BYTES);
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

// Read a response body, enforcing the byte cap as we go so an oversized (or lying)
// response is refused without being buffered whole. A declared content-length over
// the cap short-circuits before a single byte is read.
async function readBodyCapped(response: Response, maxBytes: number): Promise<string> {
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

  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
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
  return Buffer.concat(chunks).toString("utf8");
}

// --- Address classification (the SSRF guard's core) --------------------------------

// True when an address string is a private, loopback, link-local or otherwise non-
// public IP literal. A non-IP string (a hostname that must be resolved first) is not
// classified here, so it returns false and the caller resolves it via DNS.
function isBlockedAddress(raw: string): boolean {
  const addr = stripBrackets(raw.trim());

  const v4 = parseIPv4(addr);
  if (v4) return isBlockedIPv4(v4);

  if (addr.includes(":")) return isBlockedIPv6(addr);

  return false;
}

// Strip surrounding brackets from an IPv6 literal (`[::1]` → `::1`) and any zone id.
function stripBrackets(host: string): string {
  let h = host;
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  const zone = h.indexOf("%");
  if (zone !== -1) h = h.slice(0, zone);
  return h;
}

// Parse a dotted-quad IPv4 literal to its four octets, or null when not one.
function parseIPv4(s: string): [number, number, number, number] | null {
  const parts = s.split(".");
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    octets.push(n);
  }
  return octets as [number, number, number, number];
}

function isBlockedIPv4([a, b]: [number, number, number, number]): boolean {
  if (a === 0) return true; // 0.0.0.0/8 "this host"
  if (a === 10) return true; // 10.0.0.0/8 private
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 private
  return false;
}

// Eight 16-bit groups — a fully-expanded IPv6 address.
type Groups8 = [number, number, number, number, number, number, number, number];

function isBlockedIPv6(s: string): boolean {
  const g = expandIPv6(s);
  if (!g) return false;

  // An IPv4-mapped (::ffff:a.b.c.d) address is classified by its embedded IPv4.
  const mappedV4 = g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0xffff;
  if (mappedV4) {
    return isBlockedIPv4([g[6] >> 8, g[6] & 0xff, g[7] >> 8, g[7] & 0xff]);
  }

  if (g.every((part) => part === 0)) return true; // :: unspecified
  if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0 && g[6] === 0 && g[7] === 1) {
    return true; // ::1 loopback
  }

  if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
  if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  return false;
}

// Expand an IPv6 literal (with optional `::` and optional trailing IPv4) to its eight
// 16-bit groups, or null when it is not a well-formed IPv6 address.
function expandIPv6(input: string): Groups8 | null {
  let s = input.toLowerCase();

  // A trailing dotted-quad (e.g. `::ffff:1.2.3.4`) becomes two hex groups.
  const lastColon = s.lastIndexOf(":");
  const tail = s.slice(lastColon + 1);
  if (tail.includes(".")) {
    const v4 = parseIPv4(tail);
    if (!v4) return null;
    const hi = ((v4[0] << 8) | v4[1]).toString(16);
    const lo = ((v4[2] << 8) | v4[3]).toString(16);
    s = `${s.slice(0, lastColon + 1)}${hi}:${lo}`;
  }

  const halves = s.split("::");
  if (halves.length > 2) return null;

  const toGroups = (part: string): number[] | null => {
    if (part === "") return [];
    const out: number[] = [];
    for (const group of part.split(":")) {
      if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
      out.push(parseInt(group, 16));
    }
    return out;
  };

  const head = toGroups(halves[0] ?? "");
  if (!head) return null;

  let groups: number[];
  if (halves.length === 1) {
    groups = head;
  } else {
    const rest = toGroups(halves[1] ?? "");
    if (!rest) return null;
    const fill = 8 - head.length - rest.length;
    if (fill < 0) return null;
    groups = [...head, ...new Array<number>(fill).fill(0), ...rest];
  }

  if (groups.length !== 8) return null;
  return groups as Groups8;
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
