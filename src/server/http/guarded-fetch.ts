// E06-S09 — Outbound connections pin the vetted address.
//
// A guarded fetch for user-influenced URLs (CIMD documents, provider MCP servers). The
// SSRF address guard in `../oauth/clients` resolves and classifies a host up front, but
// a bare `fetch` then resolves the host AGAIN on its own — so a DNS-rebinding server can
// answer PUBLIC to the guard's classification and PRIVATE to the connection. This module
// closes that gap: the fetch connects through a custom DNS lookup that RE-RESOLVES at
// connection time and classifies EVERY resolved address, refusing the socket (before any
// byte is sent) when any address is private, loopback or link-local.
//
// The connection-time guard is a `net.connect`/`tls.connect`-style custom lookup — the
// shape an undici Agent's `connect` lookup consumes. `undici` is not a dependency of this
// job (adding one needs an ADR; it is not in `package.json`), so the guarded fetch is
// backed by Node's built-in `https`/`http` request, whose `lookup` option takes that
// identical custom-lookup shape and dials ONLY the vetted address the lookup returns —
// there is no second, independent resolution for a rebind to exploit.
//
// The address classification is the SSRF guard's core; it lives here (the http layer)
// and is imported by `../oauth/clients` so a single source of truth governs which
// addresses are refused, whether a host is an IP literal or a resolved name.
//
// The DNS resolver is injected as a seam (conventions: external services sit behind
// interfaces with fakes; tests never touch the network), defaulting to node:dns.

import * as http from "node:http";
import * as https from "node:https";
import { lookup as dnsLookup } from "node:dns/promises";
import type { LookupFunction } from "node:net";
import { Readable } from "node:stream";

// The connection-time DNS seam: resolve a hostname to its address string(s). Returns []
// when the host does not resolve. Defaults to node:dns in production (`systemResolver`).
export type HostResolver = (hostname: string) => Promise<string[]>;

// The real resolver: node:dns. Reports every resolved address; a host that does not
// resolve yields [] (which the guard refuses) rather than throwing.
export const systemResolver: HostResolver = async (hostname) => {
  try {
    const results = await dnsLookup(hostname, { all: true });
    return results.map((r) => r.address);
  } catch {
    return [];
  }
};

// One vetted address handed back to `net` under `all: true` (the array form it requires):
// the address string plus its IP family (4 for IPv4, 6 for IPv6).
interface VettedAddress {
  readonly address: string;
  readonly family: number;
}

// The callback a `net.connect` custom lookup is handed under `all: true`.
type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  addresses?: VettedAddress[],
  family?: number,
) => void;

// A `net.connect`/`tls.connect`-style custom lookup (what undici's Agent connect option
// and Node's http/https `lookup` option both consume).
export type GuardedLookup = (
  hostname: string,
  options: unknown,
  callback: LookupCallback,
) => void;

// Build a guarded connect lookup closed over a DNS resolver. On EVERY invocation it
// re-resolves the hostname, classifies EVERY resolved address, and:
//   - refuses the connection (calls back with an error) when the host resolves to
//     nothing or ANY resolved address is private / loopback / link-local — before any
//     byte is sent;
//   - otherwise hands `net` the vetted public addresses in the `{ address, family }`
//     array form it requires under `all: true`.
// Re-resolving every time is what defeats DNS rebinding: a host that answered public once
// and private next is refused on the next connection.
export function createGuardedLookup(resolve: HostResolver): GuardedLookup {
  return function guardedLookup(hostname, _options, callback) {
    resolve(hostname).then(
      (addresses) => {
        if (addresses.length === 0) {
          callback(new Error(`host ${hostname} does not resolve to any address`));
          return;
        }
        if (addresses.some(isBlockedAddress)) {
          callback(
            new Error(`host ${hostname} resolves to a private, loopback or link-local address`),
          );
          return;
        }
        callback(
          null,
          addresses.map((address) => ({ address, family: familyOf(address) })),
        );
      },
      (err) => callback(err instanceof Error ? err : new Error(String(err))),
    );
  };
}

// The IP family `net` dials under `all: true`: 6 for an IPv6 literal (which contains a
// colon), 4 otherwise.
function familyOf(address: string): number {
  return address.includes(":") ? 6 : 4;
}

// The seams the guarded fetch depends on: the connection-time DNS resolver (injected for
// tests, default node:dns).
export interface GuardedFetchDeps {
  readonly resolve?: HostResolver;
}

// Build a `fetch`-shaped function whose connection re-resolves and classifies the host at
// connection time through the guarded lookup — never the bare global fetch's own
// resolution. A request to a host that resolves (at connection time) to a blocked address
// is refused before any byte is sent.
export function createGuardedFetch(deps: GuardedFetchDeps = {}): typeof globalThis.fetch {
  const resolve = deps.resolve ?? systemResolver;
  const lookup = createGuardedLookup(resolve);

  const guardedFetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
    new Promise<Response>((resolveResponse, rejectResponse) => {
      let url: URL;
      try {
        url = new URL(
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
        );
      } catch {
        rejectResponse(new Error("guarded fetch received an invalid URL"));
        return;
      }

      const transport =
        url.protocol === "https:" ? https : url.protocol === "http:" ? http : null;
      if (!transport) {
        rejectResponse(new Error(`guarded fetch supports only http and https, not ${url.protocol}`));
        return;
      }

      const options: http.RequestOptions = {
        method: init?.method ?? "GET",
        signal: init?.signal ?? undefined,
        // The connection-time guard: `net`/`tls` dials only the vetted address this
        // lookup returns, so there is no second resolution for a rebind to exploit.
        lookup: lookup as unknown as LookupFunction,
      };

      const request = transport.request(url, options, (response) => {
        try {
          const status = response.statusCode ?? 0;
          // Never follow a redirect — it would dial a host the address guard never
          // vetted. `redirect: "error"` refuses it (node http never auto-follows).
          if (
            init?.redirect === "error" &&
            status >= 300 &&
            status < 400 &&
            response.headers.location !== undefined
          ) {
            response.destroy();
            rejectResponse(new Error("guarded fetch refused a redirect"));
            return;
          }

          const headers = new Headers();
          for (const [name, value] of Object.entries(response.headers)) {
            if (value === undefined) continue;
            if (Array.isArray(value)) {
              for (const v of value) headers.append(name, v);
            } else {
              headers.set(name, value);
            }
          }

          const body = Readable.toWeb(response) as unknown as ReadableStream<Uint8Array>;
          resolveResponse(
            new Response(body, {
              status: status || 200,
              statusText: response.statusMessage ?? "",
              headers,
            }),
          );
        } catch (err) {
          response.destroy();
          rejectResponse(err instanceof Error ? err : new Error(String(err)));
        }
      });

      request.on("error", (err) => rejectResponse(err));
      request.end();
    });

  return guardedFetch as typeof globalThis.fetch;
}

// --- Address classification (the SSRF guard's core) --------------------------------

// True when an address string is a private, loopback, link-local or otherwise non-
// public IP literal. A non-IP string (a hostname that must be resolved first) is not
// classified here, so it returns false and the caller resolves it via DNS.
export function isBlockedAddress(raw: string): boolean {
  const addr = stripBrackets(raw.trim());

  const v4 = parseIPv4(addr);
  if (v4) return isBlockedIPv4(v4);

  if (addr.includes(":")) return isBlockedIPv6(addr);

  return false;
}

// Strip surrounding brackets from an IPv6 literal (`[::1]` → `::1`) and any zone id.
export function stripBrackets(host: string): string {
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
