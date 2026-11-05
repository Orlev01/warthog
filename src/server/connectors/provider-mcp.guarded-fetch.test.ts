// E09-S08 — Provider-hosted MCP client: the SSRF-guarded OUTBOUND FETCH every provider
// request rides on (`createGuardedProviderFetch` in `src/server/connectors/provider-mcp.ts`).
//
// RED-first: the module does not exist yet, so every test here fails at import until the
// builder writes it. That absence IS the point of test-first — do not implement anything
// to make these pass.
//
// WHY (task E09-S08 AC2; CLAUDE.md security: "Outbound HTTP to user-influenced URLs
// (CIMD documents, provider MCP servers) goes through the SSRF guard — https only, no
// private/loopback/link-local IPs, timeouts, size caps"): a `provider_mcp` connector is
// reached as an MCP client; its discovery, DCR and transport requests all go to
// provider-influenced hosts, so the single outbound fetch they share must be guarded.
//
// These tests pin BEHAVIOUR (which URLs the guarded fetch refuses before touching the
// transport, that it bounds a request with a timeout, that it caps the body), never the
// source text of the module. DNS and the inner transport are injected as seams
// (conventions: external services sit behind fakes; tests never touch the network) —
// every refusal below happens before the inner transport is called, and the address
// classification itself is reused from `../http/guarded-fetch` (one source of truth), so
// no socket is ever opened.
//
// THE PINNED CONTRACT (the builder implements exactly this):
//
//   createGuardedProviderFetch(deps?): typeof fetch
//     deps = {
//       resolve?: (hostname: string) => Promise<string[]> — the DNS seam for the up-front
//                 address classification (default: node:dns via systemResolver),
//       fetch?:   typeof fetch — the inner transport the guard delegates to once a request
//                 is allowed (default: the connection-time guarded fetch from
//                 `../http/guarded-fetch`, which re-resolves and refuses at connection time).
//     }
//     Returns a `fetch`-shaped function that:
//       • REFUSES a non-https URL (and never calls the inner transport);
//       • REFUSES a private / loopback / link-local host — an IP literal classified
//         directly, a hostname classified by EVERY resolved address — before the inner
//         transport is called (a public-looking hostname cannot smuggle a private target);
//       • passes an AbortSignal to the inner transport and ABORTS it at a timeout;
//       • CAPS the response body size, rejecting an oversized response;
//       • otherwise delegates to the inner transport and returns its response.

import { test } from "node:test";
import assert from "node:assert/strict";

import { createGuardedProviderFetch } from "./provider-mcp";

// --- seams: fakes for DNS and a spy transport --------------------------------------

// A DNS seam that always resolves to a public, routable address — the host passes the
// address guard, so the request proceeds to the inner transport.
const publicLookup = async (_hostname: string): Promise<string[]> => ["93.184.216.34"];

// A DNS seam that echoes the hostname back as its own address: for an IP-literal host
// the guard sees exactly that literal whether it classifies the literal directly or
// routes it through the resolver.
const echoLookup = async (hostname: string): Promise<string[]> => [hostname];

// Let pending microtasks drain (and the loop turn once) WITHOUT advancing the mock
// clock, so the guard reaches the inner transport and arms its timeout before we tick.
const flushAsync = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

// --- https-only: a non-https URL is refused without touching the transport ----------

const nonHttpsUrls = [
  "http://provider.example/.well-known/oauth-authorization-server",
  "http://10.0.0.1/mcp",
  "ftp://provider.example/x",
  "file:///etc/passwd",
];

for (const url of nonHttpsUrls) {
  test(`createGuardedProviderFetch refuses a non-https url and never calls the transport: ${url}`, async () => {
    let calls = 0;
    const spy: typeof fetch = async () => {
      calls++;
      return new Response("{}");
    };
    const gfetch = createGuardedProviderFetch({ fetch: spy, resolve: echoLookup });

    await assert.rejects(gfetch(url), "a non-https url must be refused");
    assert.equal(calls, 0, "a non-https url never reaches the transport");
  });
}

// --- private / loopback / link-local literals are refused ---------------------------

const blockedLiteralUrls = [
  "https://127.0.0.1/mcp", // IPv4 loopback
  "https://10.0.0.1/mcp", // private 10/8
  "https://172.16.0.5/mcp", // private 172.16/12
  "https://192.168.1.10/mcp", // private 192.168/16
  "https://169.254.169.254/mcp", // link-local / cloud metadata
  "https://[::1]/mcp", // IPv6 loopback
  "https://[fd00::1]/mcp", // IPv6 unique-local
];

for (const url of blockedLiteralUrls) {
  test(`createGuardedProviderFetch refuses a private/loopback/link-local literal and never calls the transport: ${url}`, async () => {
    let calls = 0;
    const spy: typeof fetch = async () => {
      calls++;
      return new Response("{}");
    };
    const gfetch = createGuardedProviderFetch({ fetch: spy, resolve: echoLookup });

    await assert.rejects(gfetch(url), "a blocked address literal must be refused");
    assert.equal(calls, 0, "a blocked address literal is never contacted");
  });
}

// --- a public-looking hostname that resolves to a private IP is refused -------------

test("a hostname that resolves to a private IP is refused and never reaches the transport", async () => {
  let calls = 0;
  const spy: typeof fetch = async () => {
    calls++;
    return new Response("{}");
  };
  const gfetch = createGuardedProviderFetch({ fetch: spy, resolve: async () => ["10.1.2.3"] });

  await assert.rejects(
    gfetch("https://sneaky.example/.well-known/oauth-authorization-server"),
    "a host resolving to a private IP must be refused",
  );
  assert.equal(calls, 0, "a host resolving to a private IP is never contacted");
});

test("a hostname that resolves to a mix of public and private IPs is refused", async () => {
  let calls = 0;
  const spy: typeof fetch = async () => {
    calls++;
    return new Response("{}");
  };
  // One public, one loopback — a single blocked answer refuses the whole request.
  const gfetch = createGuardedProviderFetch({
    fetch: spy,
    resolve: async () => ["93.184.216.34", "127.0.0.1"],
  });

  await assert.rejects(
    gfetch("https://rebind.example/.well-known/oauth-authorization-server"),
    "any blocked resolved address must refuse the request",
  );
  assert.equal(calls, 0, "a host with any blocked answer is never contacted");
});

// --- an allowed https public host is delegated to the transport ---------------------

test("createGuardedProviderFetch delegates an allowed https public request to the transport and returns its response", async () => {
  const doc = { issuer: "https://provider.example", client_id_metadata_document_supported: true };
  let seenUrl: string | undefined;
  const inner: typeof fetch = async (input) => {
    seenUrl = String(input);
    return new Response(JSON.stringify(doc), { headers: { "content-type": "application/json" } });
  };
  const gfetch = createGuardedProviderFetch({ fetch: inner, resolve: publicLookup });

  const res = await gfetch("https://provider.example/.well-known/oauth-authorization-server");

  assert.equal(seenUrl, "https://provider.example/.well-known/oauth-authorization-server", "the transport is called with the url");
  assert.equal(res.status, 200, "the response status passes through");
  assert.deepEqual(await res.json(), doc, "the response body passes through");
});

// --- a timeout bounds an in-flight request ------------------------------------------

test("createGuardedProviderFetch passes an AbortSignal to the transport and aborts it at a timeout", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let signal: AbortSignal | undefined;
  // A transport that never settles on its own: the only way out is the guard's timeout
  // aborting the signal it was handed.
  const hangingInner: typeof fetch = (_input, init) =>
    new Promise<Response>(() => {
      signal = init?.signal ?? undefined;
    });
  const gfetch = createGuardedProviderFetch({ fetch: hangingInner, resolve: publicLookup });

  void gfetch("https://slow.example/.well-known/oauth-authorization-server").catch(() => {});
  await flushAsync(); // let the guard reach the transport and arm the timeout

  assert.ok(signal instanceof AbortSignal, "the request is cancellable — an AbortSignal is passed to the transport");
  assert.equal(signal?.aborted, false, "the signal is not aborted before the timeout");

  // Tick well past any reasonable budget (the exact length is not pinned here).
  t.mock.timers.tick(60_000);
  assert.equal(signal?.aborted, true, "the request is aborted once the timeout elapses");
});

test("a transport that outlives the timeout rejects the call", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const abortingInner: typeof fetch = (_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      const s = init?.signal;
      if (s?.aborted) {
        reject(new Error("aborted"));
        return;
      }
      s?.addEventListener("abort", () => reject(new Error("aborted")));
    });
  const gfetch = createGuardedProviderFetch({ fetch: abortingInner, resolve: publicLookup });

  const p = gfetch("https://slow.example/.well-known/oauth-authorization-server");
  p.catch(() => {}); // avoid an unhandled rejection before we assert on it
  await flushAsync();
  t.mock.timers.tick(60_000);

  await assert.rejects(p, "a timed-out request surfaces as a rejection");
});

// --- a size cap bounds the response body --------------------------------------------

test("createGuardedProviderFetch refuses an oversized response body", async () => {
  // 2 MiB — over any reasonable metadata/tools-list cap (64 KB / 100 KB / 1 MB).
  const big = "a".repeat(2 * 1024 * 1024);
  const oversizedInner: typeof fetch = async () =>
    new Response(big, {
      headers: {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(big, "utf8")),
      },
    });
  const gfetch = createGuardedProviderFetch({ fetch: oversizedInner, resolve: publicLookup });

  await assert.rejects(
    gfetch("https://provider.example/.well-known/oauth-authorization-server"),
    "an oversized response body must be refused",
  );
});

test("createGuardedProviderFetch is callable with no deps (the production composition wires the real guarded fetch)", () => {
  assert.equal(typeof createGuardedProviderFetch(), "function", "the production composition is callable");
});
