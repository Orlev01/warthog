// E06-S09 — Outbound connections pin the vetted address: the guarded fetch whose
// CONNECTION-TIME DNS lookup classifies every resolved address and refuses private,
// loopback and link-local ones (`src/server/http/guarded-fetch.ts`).
//
// RED-first: the module does not exist yet, so every test here fails at import until
// the builder writes it. That absence IS the point of test-first — do not implement
// anything to make these pass.
//
// Why this task exists (E06-S03 reviewer veto): the CIMD guard in `../oauth/clients`
// resolves and classifies a host, then `fetch` resolves it AGAIN on its own, so a
// DNS-rebinding server can answer PUBLIC to the guard's up-front lookup and PRIVATE to
// the connection. The fix is a fetch backed by an undici Agent whose *connect* lookup
// re-resolves at connection time and classifies EVERY address, refusing the socket
// before any bytes are sent. These tests pin that BEHAVIOUR (what the guarded connect
// lookup does with a set of resolved addresses, and what the guarded fetch does with a
// host that resolves to a blocked address), never the source text — a later rename
// that preserves behaviour must not redden them.
//
// The DNS resolver is injected as a seam (conventions: external services sit behind
// interfaces with fakes; tests never touch the network), so the whole guard is
// exercised without a real resolver. Every blocked case errors BEFORE any socket is
// opened, so these tests never reach the network even when the real Agent is built.
//
// The contract this task defines (the builder implements exactly this):
//
//   // The connection-time DNS seam: resolve a hostname to its address string(s).
//   // Mirrors the existing CIMD DNS seam shape (`../oauth/clients`); defaults to
//   // node:dns in production. Returns [] when the host does not resolve.
//   type HostResolver = (hostname: string) => Promise<string[]>
//
//   createGuardedLookup(resolve: HostResolver):
//       (hostname, options, callback) => void
//     • A `net.connect`/`tls.connect`-style custom lookup (the shape undici's Agent
//       connect option consumes). net invokes it as `(hostname, { all: true, … }, cb)`.
//     • It resolves EVERY address for the hostname via `resolve`, classifies each, and:
//         - if ANY resolved address is private / loopback / link-local (or the host
//           resolves to nothing), it calls `cb(error)` — refusing the connection
//           before any byte is sent;
//         - otherwise it calls `cb(null, [{ address, family }, …])` with the vetted
//           public addresses (the array form `net` requires under `all: true`,
//           `family` 4 for IPv4 and 6 for IPv6).
//     • It re-resolves on EVERY invocation, so a host that answered public once and
//       private next is refused on the next connection (DNS rebinding).
//
//   createGuardedFetch(deps?: { resolve?: HostResolver }): typeof globalThis.fetch
//     • A `fetch`-shaped function backed by an undici Agent whose connect lookup is the
//       guarded lookup above. `resolve` is injectable for tests (default: node:dns).
//     • A request to a host that resolves (at connection time) to a blocked address
//       rejects, and the connection-time resolver IS consulted — never the bare global
//       fetch's own resolution.
//
// Acceptance criteria → tests:
//   AC1 "A host whose connection-time lookup returns a private/loopback/link-local
//        address is refused before any bytes are sent, even when an earlier
//        classification lookup returned a public address." — the blocked-address,
//        mixed-answer and rebind sections.
//   AC2 "A host that resolves only to public addresses is fetched normally …" — the
//        all-public pass-through section (the guard yields the vetted addresses). The
//        https-only / 5 s / 64 KB guarantees are CIMD-fetcher properties preserved by
//        composition — pinned in `../oauth/clients.guarded-fetch.test.ts` and
//        `../oauth/clients.test.ts`.
import { test } from "node:test";
import assert from "node:assert/strict";

import { createGuardedLookup, createGuardedFetch } from "./guarded-fetch";

// --- helpers -----------------------------------------------------------------------

// The callback shape a `net.connect` custom lookup is handed.
type LookupCallback = (err: unknown, addresses?: unknown, family?: unknown) => void;
type GuardedLookup = (hostname: string, options: unknown, callback: LookupCallback) => void;

interface LookupResult {
  readonly err: unknown;
  readonly addresses: unknown;
  readonly family: unknown;
}

// Drive a guarded lookup the way `net.connect`/`tls.connect` do (verified empirically:
// Node calls the custom lookup with `{ all: true, hints }`), and resolve once it calls
// back. A buggy lookup that never calls back trips the per-test timeout, not a hang.
function runLookup(lookup: GuardedLookup, hostname: string): Promise<LookupResult> {
  return new Promise((resolve) => {
    let settled = false;
    lookup(hostname, { all: true, hints: 0 }, (err, addresses, family) => {
      if (settled) return;
      settled = true;
      resolve({ err, addresses, family });
    });
  });
}

// The address string of each returned entry, tolerating `{ address }` objects (the
// form `net` requires under `all: true`) or bare strings.
function addressesOf(res: LookupResult): string[] {
  const a = res.addresses;
  if (Array.isArray(a)) {
    return a.map((x) => (typeof x === "string" ? x : (x as { address: string }).address));
  }
  if (typeof a === "string") return [a];
  return [];
}

const expectedFamily = (addr: string): number => (addr.includes(":") ? 6 : 4);

// --- AC1: a resolved private / loopback / link-local address is refused -------------
//
// Each string below is what the CONNECTION-TIME resolver returns for a host. A guarded
// connect lookup must refuse the connection (call back with an error) rather than hand
// `net` an address to dial.

const blockedResolvedAddresses = [
  "0.0.0.0", // 0.0.0.0/8 "this host"
  "127.0.0.1", // IPv4 loopback
  "127.0.0.53", // loopback range (systemd-resolved)
  "10.0.0.1", // private 10/8
  "172.16.0.5", // private 172.16/12 (low edge)
  "172.31.255.255", // private 172.16/12 (high edge)
  "192.168.1.10", // private 192.168/16
  "169.254.169.254", // link-local / cloud metadata endpoint
  "::1", // IPv6 loopback
  "fc00::1", // IPv6 unique-local (fc00::/7)
  "fd00::1", // IPv6 unique-local (fc00::/7)
  "fe80::1", // IPv6 link-local (fe80::/10)
  "::ffff:127.0.0.1", // IPv4-mapped loopback
  "::ffff:10.0.0.1", // IPv4-mapped private
];

for (const addr of blockedResolvedAddresses) {
  test(`guarded connect lookup refuses a host that resolves to ${addr}`, { timeout: 10_000 }, async () => {
    let calls = 0;
    const resolve = async (_hostname: string): Promise<string[]> => {
      calls++;
      return [addr];
    };
    const lookup = createGuardedLookup(resolve);

    const res = await runLookup(lookup, "blocked.test");

    assert.ok(res.err instanceof Error, `a resolved ${addr} must refuse the connection`);
    assert.equal(addressesOf(res).length, 0, `no address is handed to the socket for ${addr}`);
    assert.ok(calls >= 1, "the connection-time resolver is consulted");
  });
}

test("guarded connect lookup refuses a host whose answers mix public and blocked", { timeout: 10_000 }, async () => {
  // One public, one loopback — a single blocked answer refuses the whole connection.
  const resolve = async (): Promise<string[]> => ["93.184.216.34", "127.0.0.1"];
  const lookup = createGuardedLookup(resolve);

  const res = await runLookup(lookup, "rebind.test");

  assert.ok(res.err instanceof Error, "any blocked resolved address refuses the connection");
  assert.equal(addressesOf(res).length, 0, "a mixed answer hands no address to the socket");
});

test("guarded connect lookup refuses a host that resolves to nothing", { timeout: 10_000 }, async () => {
  const resolve = async (): Promise<string[]> => [];
  const lookup = createGuardedLookup(resolve);

  const res = await runLookup(lookup, "empty.test");

  assert.ok(res.err instanceof Error, "an unresolvable host must be refused, not dialled");
});

// --- AC2: a host that resolves only to public addresses passes the guard ------------
//
// The guard yields the vetted public addresses in the `{ address, family }` array form
// that `net` requires under `all: true`, so the connection proceeds normally.

const publicResolvedAnswers: string[][] = [
  ["93.184.216.34"], // a single public IPv4
  ["8.8.8.8"], // another public IPv4
  ["93.184.216.34", "8.8.8.8"], // several public IPv4
  ["2606:2800:220:1:248:1893:25c8:1946"], // a public IPv6
  ["2001:4860:4860::8888"], // another public IPv6
];

for (const answer of publicResolvedAnswers) {
  test(`guarded connect lookup passes an all-public answer through: ${answer.join(",")}`, { timeout: 10_000 }, async () => {
    const resolve = async (): Promise<string[]> => answer;
    const lookup = createGuardedLookup(resolve);

    const res = await runLookup(lookup, "public.test");

    assert.ok(!res.err, "an all-public answer must not be refused");
    assert.ok(Array.isArray(res.addresses), "net requires the array form under all:true");
    assert.deepEqual(
      [...addressesOf(res)].sort(),
      [...answer].sort(),
      "every vetted public address is handed to the socket",
    );
    // Each returned entry carries its IP family (the form `net` dials under all:true).
    for (const entry of res.addresses as unknown[]) {
      assert.ok(
        entry !== null && typeof entry === "object",
        "each vetted address is an { address, family } object (what net dials under all:true)",
      );
      const { address, family } = entry as { address: string; family: number };
      assert.equal(family, expectedFamily(address), `the family of ${address} is reported correctly`);
    }
  });
}

// --- AC1: the connect lookup RE-RESOLVES every connection (DNS rebinding) ------------
//
// "…even when an earlier classification lookup returned a public address." The guard
// resolves afresh on every invocation, so a host that answers public once and private
// next is refused on the next connection — the bytes never leave.

test("guarded connect lookup re-resolves every time: a rebind to a private address is refused after a public answer", { timeout: 10_000 }, async () => {
  let n = 0;
  // First resolution is public (an earlier classification would have passed it); the
  // next resolution — the one at connection time — rebinds to loopback.
  const rebinding = async (): Promise<string[]> => (++n === 1 ? ["93.184.216.34"] : ["127.0.0.1"]);
  const lookup = createGuardedLookup(rebinding);

  const first = await runLookup(lookup, "rebind.test");
  assert.ok(!first.err, "the first (public) resolution is allowed");

  const second = await runLookup(lookup, "rebind.test");
  assert.ok(second.err instanceof Error, "the rebind to a private address is refused");
  assert.equal(addressesOf(second).length, 0, "the rebinding connection is handed no address");
});

// --- createGuardedFetch: the guard is wired into the fetch ---------------------------

test("createGuardedFetch returns a fetch-shaped function", () => {
  assert.equal(typeof createGuardedFetch(), "function", "the guarded fetch is callable like fetch");
  assert.equal(typeof createGuardedFetch({ resolve: async () => ["93.184.216.34"] }), "function");
});

test("createGuardedFetch refuses a host that resolves to loopback at connection time (no bytes sent)", { timeout: 10_000 }, async () => {
  let calls = 0;
  const resolve = async (_hostname: string): Promise<string[]> => {
    calls++;
    return ["127.0.0.1"]; // the connection-time answer is loopback — refuse, do not dial
  };
  const guardedFetch = createGuardedFetch({ resolve });

  await assert.rejects(
    guardedFetch("https://rebind.test/.well-known/oauth-client"),
    "a host resolving to a blocked address must be refused by the connection-time guard",
  );
  assert.ok(
    calls >= 1,
    "the connection-time resolver is consulted — not the bare global fetch's own resolution",
  );
});
