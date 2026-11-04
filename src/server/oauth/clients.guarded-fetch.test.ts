// E06-S09 — Outbound connections pin the vetted address: the composition root that
// builds the CIMD fetcher with the CONNECTION-TIME guarded fetch, never the bare
// global fetch (`src/server/oauth/clients.ts`).
//
// RED-first: the production factory does not exist yet, so every test here fails at
// import until the builder writes it. That absence IS the point of test-first — do not
// implement anything to make these pass.
//
// Seam note: an App-Router `route.ts` may export ONLY the known route keys; `next
// build` rejects any other export (OBS-025). So the composition factory that wires the
// guarded fetch lives in `./clients` (the task's touch), which the `/oauth/register`
// route imports — these tests import that factory directly rather than locking a
// non-framework export onto the route entry file.
//
// These tests pin BEHAVIOUR (what the production CIMD fetcher DOES with a given
// client_id and a given connection-time resolution), never source text — a later
// rename that preserves behaviour must not redden them. The connection-time DNS seam
// is injected so the guard is exercised without a real resolver (conventions: external
// services sit behind fakes; tests never touch the network). Every case below refuses
// before any socket is opened, so no bytes leave even when the real Agent is built.
//
// The contract this task defines (the builder implements exactly this):
//
//   createGuardedCimdFetcher(deps?): (clientId: string) => Promise<Record<string, unknown>>
//     deps = {
//       clock?:   Clock — the time seam for the 24-hour cache (default: systemClock),
//       resolve?: (hostname: string) => Promise<string[]> — the DNS seam used BOTH for
//                 the up-front classification AND the connection-time guard (default:
//                 node:dns). A production call passes no deps.
//     }
//     • Builds `createCimdFetcher` with the outbound HTTP set to the guarded fetch from
//       `../http/guarded-fetch` (an undici Agent with the guarded connect lookup) —
//       NEVER the bare global fetch. The connection-time guard re-resolves the host, so
//       a DNS-rebinding client_id that classifies as public up front but connects to a
//       private address is refused before any bytes are sent.
//     • https-only, the 5-second timeout and the 64 KB cap still apply (they are
//       `createCimdFetcher` properties this factory composes unchanged — the timeout /
//       cap are pinned in `./clients.test.ts`; https-only is re-pinned here on the
//       production fetcher).
//
// Acceptance criteria → tests:
//   AC3 "The /oauth/register composition root builds the CIMD fetcher with the guarded
//        fetch, never the bare global fetch." — the rebind test proves the
//        connection-time guarded fetch is wired (the global fetch would never consult
//        the connection-time resolver and would dial the rebound private address).
//   AC2 "…https-only still applies." — the https-only refusal on the production fetcher.
import { test } from "node:test";
import assert from "node:assert/strict";

import { createGuardedCimdFetcher } from "./clients";
import { fixedClock } from "../seams/clock";

// --- AC3: the production fetcher uses the CONNECTION-TIME guarded fetch --------------
//
// A DNS-rebinding client_id: the up-front classification resolves PUBLIC (so the
// existing app-level guard passes it), but the connection-time resolution — the one the
// guarded fetch performs inside its undici Agent — rebinds to loopback. A fetcher built
// on the guarded fetch re-resolves and refuses; one built on the bare global fetch would
// never consult our resolver a second time and would dial the private address.

test("the production CIMD fetcher refuses a host that rebinds to a private address at connection time", { timeout: 15_000 }, async () => {
  let calls = 0;
  // Call 1 = the up-front classification (public → passes the app-level guard).
  // Call 2 = the connection-time lookup inside the guarded fetch (rebinds to loopback).
  const rebinding = async (_hostname: string): Promise<string[]> => {
    calls++;
    return calls === 1 ? ["93.184.216.34"] : ["127.0.0.1"];
  };
  const fetcher = createGuardedCimdFetcher({
    resolve: rebinding,
    clock: fixedClock(new Date()),
  });

  await assert.rejects(
    fetcher("https://rebind.example/.well-known/oauth-client"),
    "a client_id that rebinds to a private address must be refused",
  );
  assert.ok(
    calls >= 2,
    "the connection-time resolver was consulted a second time — proving the guarded " +
      "fetch (not the bare global fetch) performs the connection",
  );
});

test("the production CIMD fetcher refuses a host that resolves only to a private address", { timeout: 15_000 }, async () => {
  const resolve = async (_hostname: string): Promise<string[]> => ["10.1.2.3"];
  const fetcher = createGuardedCimdFetcher({ resolve, clock: fixedClock(new Date()) });

  await assert.rejects(
    fetcher("https://internal.example/.well-known/oauth-client"),
    "a host resolving to a private address must be refused",
  );
});

// --- AC2 / https-only: the production fetcher refuses a non-https client_id ----------
//
// Built with no deps (real DNS + the real guarded fetch) — a non-https client_id is
// refused before any DNS resolution or connection, so this reaches no network.

const nonHttpsClientIds = [
  "http://claude.ai/.well-known/oauth-client",
  "http://10.0.0.1/.well-known/oauth-client",
  "file:///etc/passwd",
];

for (const clientId of nonHttpsClientIds) {
  test(`the production CIMD fetcher refuses a non-https client_id: ${clientId}`, { timeout: 15_000 }, async () => {
    const fetcher = createGuardedCimdFetcher();
    await assert.rejects(fetcher(clientId), "https-only still applies on the production fetcher");
  });
}

// --- the production fetcher refuses a private/loopback IP-LITERAL client_id ----------
//
// Built with no deps — a private/loopback literal is classified directly, before any
// DNS resolution or connection, so this too reaches no network.

const blockedLiteralClientIds = [
  "https://127.0.0.1/.well-known/oauth-client",
  "https://169.254.169.254/.well-known/oauth-client", // cloud metadata endpoint
  "https://[::1]/.well-known/oauth-client",
];

for (const clientId of blockedLiteralClientIds) {
  test(`the production CIMD fetcher refuses a blocked IP-literal client_id: ${clientId}`, { timeout: 15_000 }, async () => {
    const fetcher = createGuardedCimdFetcher();
    await assert.rejects(fetcher(clientId), "a blocked IP-literal client_id must be refused");
  });
}

test("createGuardedCimdFetcher returns a resolver function", () => {
  assert.equal(typeof createGuardedCimdFetcher(), "function", "the production composition is callable");
});
