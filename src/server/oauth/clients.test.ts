// E06-S03 — Client registration, part 1: the CIMD client_id fetch (SSRF-guarded)
// and the redirect-URI rules (`src/server/oauth/clients.ts`).
//
// RED-first: `./clients` does not exist yet, so every test here fails at import
// until the builder writes it. That absence IS the point of test-first — do not
// implement anything to make these pass.
//
// These tests pin BEHAVIOUR (what the fetcher DOES with a given URL, the HTTP it
// attempts or refuses to attempt, and what the predicate returns), never the source
// text of the module — a later rename that preserves behaviour must not redden them.
// Outbound HTTP, DNS and the clock are injected as seams (conventions: external
// services sit behind interfaces with fakes; tests never touch the network), so the
// whole guard is exercised without a real socket or resolver.
//
// The contract this task defines (the builder implements exactly this):
//
//   createCimdFetcher(deps): (clientId) => Promise<Record<string, unknown>>
//     deps = {
//       fetch:  typeof globalThis.fetch — the outbound HTTP seam,
//       lookup: (hostname: string) => Promise<string[]> — the DNS seam, resolves a
//               hostname to its IP address string(s),
//       clock:  Clock — the time seam, used for the 24-hour cache.
//     }
//     • Resolves to the fetched CIMD document (parsed JSON) for an https URL whose
//       host is public.
//     • REJECTS (and never even calls `fetch`) when the client_id is not https, or
//       its host is / resolves to a private, loopback or link-local address — so a
//       public-looking hostname cannot override the address guard (SSRF).
//     • Aborts an in-flight request at a 5-second timeout (via an AbortSignal it
//       passes to `fetch`), rejects a document larger than 64 KB, and caches a
//       successful document for 24 hours (a repeat within the window makes no new
//       request).
//
//   isAllowedRedirectUri(uri: string): boolean
//     • true for an https URL (any host, any port), or an http URL whose host is
//       exactly `localhost` or `127.0.0.1` (any port); false for everything else
//       (http to any other host, a private-IP http host, another scheme, or a
//       malformed URL).
//
// Acceptance criteria → tests:
//   AC1 "CIMD fetch is https-only, rejects private/loopback IPs and host overrides,
//        times out at 5 seconds, caps at 64KB and caches 24 hours." — the fetch
//        section below.
//   AC2 "DCR requires https redirect URIs (or http://localhost or 127.0.0.1 on any
//        port) and rejects others; an http or private-IP client_id is refused." —
//        the redirect-URI predicate section pins the redirect rule; the "http
//        client_id" and "private-IP client_id" refusals are pinned by the fetch
//        section (a client_id that is http, or whose host is a private IP, is never
//        fetched). The DCR endpoint itself is tested in `register.test.ts`.
import { test } from "node:test";
import assert from "node:assert/strict";

import { createCimdFetcher, isAllowedRedirectUri } from "./clients";
import { type Clock, fixedClock } from "../seams/clock";

// --- seams: fakes for DNS and a mutable clock --------------------------------------

// A DNS seam that always resolves to a public, routable address — the host passes
// the address guard, so the fetch proceeds.
const publicLookup = async (_hostname: string): Promise<string[]> => ["93.184.216.34"];

// A DNS seam that echoes the hostname back as its own address. For an IP-literal
// host this means the guard sees exactly that literal whether it classifies the
// literal directly or routes it through the resolver — either way a private literal
// is still private.
const echoLookup = async (hostname: string): Promise<string[]> => [hostname];

// A clock that can be advanced, for the 24-hour cache test.
function mutableClock(startMs = Date.parse("2026-01-01T00:00:00Z")) {
  let ms = startMs;
  const clock: Clock = { now: () => new Date(ms) };
  return {
    clock,
    advance(byMs: number) {
      ms += byMs;
    },
  };
}

// A barrier that lets every pending microtask drain (and the event loop turn once)
// WITHOUT advancing the mock clock: `setImmediate` is a macrotask that is not mocked
// here (only `setTimeout` is), so awaiting it flushes the guard's async progress up
// to a hanging fetch before we drive the clock.
const flushAsync = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

// --- AC1: https-only — a non-https client_id is refused without any request --------
//
// This also covers AC2's "an http client_id is refused": an http client_id is a
// non-https URL, so it is rejected before any outbound request.

const nonHttpsClientIds = [
  "http://claude.ai/.well-known/oauth-client", // plain http — refused (AC2)
  "http://10.0.0.1/.well-known/oauth-client",
  "file:///etc/passwd",
  "ftp://claude.ai/doc",
  "data:application/json,{}",
];

for (const clientId of nonHttpsClientIds) {
  test(`CIMD fetch refuses a non-https client_id and makes no request: ${clientId}`, async () => {
    let fetchCalls = 0;
    const spyFetch: typeof fetch = async () => {
      fetchCalls++;
      return new Response("{}");
    };
    const resolve = createCimdFetcher({
      fetch: spyFetch,
      lookup: echoLookup,
      clock: fixedClock(new Date()),
    });

    await assert.rejects(resolve(clientId), "a non-https client_id must be refused");
    assert.equal(fetchCalls, 0, "a non-https client_id is never contacted");
  });
}

// --- AC1 / AC2: private, loopback and link-local addresses are refused -------------
//
// Each of these is an IP-literal host that must never be contacted. This covers
// AC2's "a private-IP client_id is refused" and AC1's "rejects private/loopback
// IPs".

const blockedLiteralClientIds = [
  "https://127.0.0.1/.well-known/oauth-client", // IPv4 loopback
  "https://127.0.0.53/.well-known/oauth-client", // loopback range
  "https://10.0.0.1/.well-known/oauth-client", // private (10/8)
  "https://172.16.0.5/.well-known/oauth-client", // private (172.16/12)
  "https://192.168.1.10/.well-known/oauth-client", // private (192.168/16)
  "https://169.254.169.254/.well-known/oauth-client", // link-local / cloud metadata
  "https://[::1]/.well-known/oauth-client", // IPv6 loopback
  "https://[fd00::1]/.well-known/oauth-client", // IPv6 unique-local
];

for (const clientId of blockedLiteralClientIds) {
  test(`CIMD fetch refuses a private/loopback/link-local address and makes no request: ${clientId}`, async () => {
    let fetchCalls = 0;
    const spyFetch: typeof fetch = async () => {
      fetchCalls++;
      return new Response("{}");
    };
    const resolve = createCimdFetcher({
      fetch: spyFetch,
      lookup: echoLookup,
      clock: fixedClock(new Date()),
    });

    await assert.rejects(resolve(clientId), "a blocked address must be refused");
    assert.equal(fetchCalls, 0, "a blocked address is never contacted");
  });
}

// --- AC1: "host overrides" — a public hostname that resolves to a private IP -------
//
// The address guard validates the RESOLVED address, not just the literal, so a
// public-looking hostname cannot smuggle a request to a private target (DNS
// rebinding / host override). The host cannot override the address guard.

test("a hostname that resolves to a private IP is refused and never fetched", async () => {
  let fetchCalls = 0;
  const spyFetch: typeof fetch = async () => {
    fetchCalls++;
    return new Response("{}");
  };
  const resolve = createCimdFetcher({
    fetch: spyFetch,
    lookup: async () => ["10.1.2.3"],
    clock: fixedClock(new Date()),
  });

  await assert.rejects(
    resolve("https://sneaky.example/.well-known/oauth-client"),
    "a host resolving to a private IP must be refused",
  );
  assert.equal(fetchCalls, 0, "a host resolving to a private IP is never contacted");
});

test("a hostname that resolves to a mix of public and private IPs is refused", async () => {
  let fetchCalls = 0;
  const spyFetch: typeof fetch = async () => {
    fetchCalls++;
    return new Response("{}");
  };
  const resolve = createCimdFetcher({
    fetch: spyFetch,
    // One answer is public, one is loopback — a single blocked answer must refuse
    // the whole request.
    lookup: async () => ["93.184.216.34", "127.0.0.1"],
    clock: fixedClock(new Date()),
  });

  await assert.rejects(
    resolve("https://rebind.example/.well-known/oauth-client"),
    "any blocked resolved address must refuse the request",
  );
  assert.equal(fetchCalls, 0, "a host with any blocked answer is never contacted");
});

// --- AC1: an allowed https public client_id is fetched and its document returned ----

test("CIMD fetch returns the parsed document for an https public host", async () => {
  const url = "https://claude.ai/.well-known/oauth-client";
  const doc = {
    client_id: url,
    redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
    token_endpoint_auth_method: "none",
  };
  let fetchCalls = 0;
  let fetchedUrl: string | undefined;
  const okFetch: typeof fetch = async (input) => {
    fetchCalls++;
    fetchedUrl = String(input);
    return new Response(JSON.stringify(doc), {
      headers: { "content-type": "application/json" },
    });
  };
  const resolve = createCimdFetcher({
    fetch: okFetch,
    lookup: publicLookup,
    clock: fixedClock(new Date()),
  });

  const result = await resolve(url);

  assert.equal(fetchCalls, 1, "an allowed client_id is fetched exactly once");
  assert.equal(fetchedUrl, url, "the client_id's own URL is the one contacted");
  assert.equal(result.client_id, url, "the parsed document is returned");
  assert.deepEqual(
    result.redirect_uris,
    ["https://claude.ai/api/mcp/auth_callback"],
    "the document's redirect_uris are returned intact",
  );
});

// --- AC1: times out at 5 seconds ----------------------------------------------------

test("passes an AbortSignal to the fetch and aborts it at the 5-second timeout", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let signal: AbortSignal | undefined;
  // A fetch that never settles on its own: the only way out is the timeout aborting
  // the signal it was handed.
  const hangingFetch: typeof fetch = (_input, init) =>
    new Promise<Response>(() => {
      signal = init?.signal ?? undefined;
    });
  const resolve = createCimdFetcher({
    fetch: hangingFetch,
    lookup: publicLookup,
    clock: fixedClock(new Date()),
  });

  // Kick it off; it is expected to reject once aborted, so swallow that rejection
  // while we drive the mock clock.
  void resolve("https://slow.example/.well-known/oauth-client").catch(() => {});
  await flushAsync(); // let the guard reach the fetch and arm the timeout

  assert.ok(
    signal instanceof AbortSignal,
    "the request is cancellable — an AbortSignal is passed to the fetch",
  );
  assert.equal(signal?.aborted, false, "the signal is not aborted before the timeout");

  t.mock.timers.tick(4000);
  assert.equal(signal?.aborted, false, "still not aborted at 4s — the budget is 5s");

  t.mock.timers.tick(1100); // cross the 5s boundary
  assert.equal(signal?.aborted, true, "the request is aborted once 5s elapses");
});

test("a fetch that outlives the 5-second timeout rejects the call", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  // A fetch that rejects (like a real aborted fetch) when its signal fires.
  const abortingFetch: typeof fetch = (_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      const s = init?.signal;
      if (s?.aborted) {
        reject(new Error("aborted"));
        return;
      }
      s?.addEventListener("abort", () => reject(new Error("aborted")));
    });
  const resolve = createCimdFetcher({
    fetch: abortingFetch,
    lookup: publicLookup,
    clock: fixedClock(new Date()),
  });

  const p = resolve("https://slow.example/.well-known/oauth-client");
  p.catch(() => {}); // avoid an unhandled rejection before we assert on it
  await flushAsync();
  t.mock.timers.tick(5001);

  await assert.rejects(p, "a timed-out fetch surfaces as a rejection");
});

// Operator fix (E06-S03 review veto): the 5-second budget bounds the WHOLE fetch, body
// included. A hostile server can answer headers at once and then trickle (or never finish)
// the body; the timeout must still end the call. This fake's body never completes and does
// not react to the abort signal, so the guard itself must stop reading at the deadline.
test("the 5-second timeout also bounds a body that never finishes", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let signal: AbortSignal | undefined;
  const tricklingFetch: typeof fetch = async (_input, init) => {
    signal = init?.signal ?? undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"client_id":'));
        // ...and nothing more, ever.
      },
    });
    return new Response(body, { headers: { "content-type": "application/json" } });
  };
  const resolve = createCimdFetcher({
    fetch: tricklingFetch,
    lookup: publicLookup,
    clock: fixedClock(new Date()),
  });

  let outcome: "pending" | "resolved" | "rejected" = "pending";
  const p = resolve("https://trickle.example/.well-known/oauth-client");
  p.then(() => (outcome = "resolved"), () => (outcome = "rejected"));
  await flushAsync(); // headers arrive; the guard is now reading the body

  t.mock.timers.tick(4000);
  await flushAsync();
  assert.equal(outcome, "pending", "still reading at 4s — the budget is 5s");

  t.mock.timers.tick(1100); // cross the 5s boundary
  await flushAsync();
  assert.equal(signal?.aborted, true, "the request is aborted at 5s even after headers arrived");
  assert.equal(outcome, "rejected", "a body still unfinished at 5s rejects the call");
});

// --- AC1: caps at 64 KB -------------------------------------------------------------

test("CIMD fetch rejects a document larger than the 64KB cap", async () => {
  const url = "https://big.example/.well-known/oauth-client";
  // A well-formed JSON document that is ~100 KB — only its SIZE should refuse it.
  const huge = JSON.stringify({ client_id: url, padding: "a".repeat(100 * 1024) });
  const bigFetch: typeof fetch = async () =>
    new Response(huge, {
      headers: {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(huge, "utf8")),
      },
    });
  const resolve = createCimdFetcher({
    fetch: bigFetch,
    lookup: publicLookup,
    clock: fixedClock(new Date()),
  });

  await assert.rejects(resolve(url), "a document over 64KB must be refused");
});

test("CIMD fetch accepts a small document (well under the 64KB cap)", async () => {
  const url = "https://small.example/.well-known/oauth-client";
  const doc = { client_id: url, redirect_uris: ["https://small.example/cb"] };
  const okFetch: typeof fetch = async () =>
    new Response(JSON.stringify(doc), { headers: { "content-type": "application/json" } });
  const resolve = createCimdFetcher({
    fetch: okFetch,
    lookup: publicLookup,
    clock: fixedClock(new Date()),
  });

  const result = await resolve(url);
  assert.equal(result.client_id, url, "a within-cap document is returned");
});

// --- AC1: caches 24 hours -----------------------------------------------------------

test("caches a fetched document for 24 hours; a repeat within the window makes no new request", async () => {
  const url = "https://claude.ai/.well-known/oauth-client";
  const doc = { client_id: url, redirect_uris: ["https://claude.ai/cb"] };
  let fetchCalls = 0;
  const okFetch: typeof fetch = async () => {
    fetchCalls++;
    return new Response(JSON.stringify(doc), { headers: { "content-type": "application/json" } });
  };
  const { clock, advance } = mutableClock();
  const resolve = createCimdFetcher({ fetch: okFetch, lookup: publicLookup, clock });

  const first = await resolve(url);
  assert.equal(fetchCalls, 1, "the first resolve fetches");

  advance(23 * 60 * 60 * 1000); // 23 hours later — still within the 24h window
  const second = await resolve(url);
  assert.equal(fetchCalls, 1, "a repeat within 24h is served from cache (no new request)");
  assert.deepEqual(second, first, "the cached document is the same document");

  advance(2 * 60 * 60 * 1000); // now 25 hours since the first fetch — expired
  await resolve(url);
  assert.equal(fetchCalls, 2, "after 24h the entry expires and a fresh request is made");
});

test("caches per client_id — a different URL is fetched separately", async () => {
  const urlA = "https://a.example/.well-known/oauth-client";
  const urlB = "https://b.example/.well-known/oauth-client";
  let fetchCalls = 0;
  const okFetch: typeof fetch = async (input) => {
    fetchCalls++;
    return new Response(JSON.stringify({ client_id: String(input) }), {
      headers: { "content-type": "application/json" },
    });
  };
  const resolve = createCimdFetcher({
    fetch: okFetch,
    lookup: publicLookup,
    clock: fixedClock(new Date()),
  });

  await resolve(urlA);
  await resolve(urlB);
  assert.equal(fetchCalls, 2, "two distinct URLs are each fetched");

  const againA = await resolve(urlA);
  assert.equal(fetchCalls, 2, "the first URL is still cached (no third request)");
  assert.equal(againA.client_id, urlA, "the cached document for A is A's");
});

// --- AC2: the DCR redirect-URI rule (a pure predicate) ------------------------------
//
// https is always allowed (any host, any port); http is allowed ONLY for the two
// named local hosts (`localhost`, `127.0.0.1`) on any port; everything else is
// refused.

const allowedRedirectUris = [
  "https://claude.ai/api/mcp/auth_callback",
  "https://chatgpt.com/connector_platform_oauth_redirect",
  "https://example.com:8443/cb", // https on a non-default port
  "http://localhost/cb",
  "http://localhost:3000/cb",
  "http://localhost:52017/callback",
  "http://127.0.0.1/cb",
  "http://127.0.0.1:8080/cb",
];

for (const uri of allowedRedirectUris) {
  test(`isAllowedRedirectUri allows ${uri}`, () => {
    assert.equal(isAllowedRedirectUri(uri), true, `${uri} should be allowed`);
  });
}

const rejectedRedirectUris = [
  "http://example.com/cb", // http to a non-local host
  "http://warthog.com.au/cb",
  "http://10.0.0.1/cb", // private-IP http host
  "http://192.168.1.10/cb",
  "http://169.254.169.254/cb",
  "http://localhost.evil.com/cb", // "localhost" as a subdomain label, not the host
  "http://127.0.0.1.evil.com/cb", // not actually 127.0.0.1
  "http://notlocalhost/cb",
  "ftp://localhost/cb", // not http(s)
  "javascript:alert(1)", // not a navigable http(s) URL
  "not a url", // malformed
  "", // empty
  "https://", // no host
];

for (const uri of rejectedRedirectUris) {
  test(`isAllowedRedirectUri rejects ${JSON.stringify(uri)}`, () => {
    assert.equal(isAllowedRedirectUri(uri), false, `${JSON.stringify(uri)} should be rejected`);
  });
}
