// Review fix F3 — the guarded fetch sends what the caller asked it to send.
//
// createGuardedFetch is the inner transport for the CIMD fetcher and every provider request
// (discovery, Dynamic Client Registration, API-key verification, the oauth4webapi code
// exchange). It used to build the outgoing request from the method alone, so every header
// (Authorization, Content-Type, Accept) and every body (DCR's JSON, the token exchange's form)
// was silently dropped. These tests run the REAL transport against a local http server and
// assert what arrives on the wire.
//
// The address guard refuses loopback whatever the resolver says, so dialling the local server
// needs the guard's classification seam (`isBlocked`) relaxed — in THIS test only. The last
// tests prove the default classification still refuses loopback, including an IP-literal host
// (which Node dials without ever calling the custom lookup), before a connection is opened.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";

import { createGuardedFetch } from "./guarded-fetch";

interface Received {
  readonly method: string;
  readonly url: string;
  readonly headers: IncomingMessage["headers"];
  readonly body: string;
}

let server: Server;
let port = 0;
let connections = 0;
const received: Received[] = [];

before(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      received.push({
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      res.writeHead(201, { "content-type": "application/json", "x-echo": "yes" });
      res.end(JSON.stringify({ client_id: "abc" }));
    });
  });
  server.on("connection", () => connections++);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  port = (server.address() as AddressInfo).port;
});

after(async () => {
  server.close();
  await once(server, "close");
});

// A guarded fetch that resolves every host to the local server and, for these wire tests only,
// classifies no address as blocked.
function wireFetch(): typeof globalThis.fetch {
  return createGuardedFetch({ resolve: async () => ["127.0.0.1"], isBlocked: () => false });
}

function last(): Received {
  const r = received[received.length - 1];
  assert.ok(r, "the server received a request");
  return r;
}

test("a JSON POST arrives with its method, headers and exact body", async () => {
  const body = JSON.stringify({ client_name: "Warthog", redirect_uris: ["https://w.test/cb"] });
  const response = await wireFetch()(`http://provider.test:${port}/register`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer x", accept: "application/json" },
    body,
  });

  assert.equal(response.status, 201);
  assert.equal(response.headers.get("x-echo"), "yes");
  assert.deepEqual(await response.json(), { client_id: "abc" });

  const r = last();
  assert.equal(r.method, "POST");
  assert.equal(r.url, "/register");
  assert.equal(r.headers["content-type"], "application/json");
  assert.equal(r.headers.authorization, "Bearer x");
  assert.equal(r.headers.accept, "application/json");
  assert.equal(r.headers["content-length"], String(Buffer.byteLength(body)));
  assert.equal(r.body, body);
});

test("a URLSearchParams body arrives form-encoded with the form content type", async () => {
  const form = new URLSearchParams({ grant_type: "authorization_code", code: "c0de", code_verifier: "v" });
  await wireFetch()(`http://provider.test:${port}/token`, { method: "POST", body: form });

  const r = last();
  assert.match(String(r.headers["content-type"]), /^application\/x-www-form-urlencoded/);
  assert.equal(r.body, form.toString());
});

test("a binary body arrives byte for byte", async () => {
  const bytes = new TextEncoder().encode("café ✓");
  await wireFetch()(`http://provider.test:${port}/bin`, {
    method: "PUT",
    headers: { "content-type": "application/octet-stream" },
    body: bytes,
  });

  const r = last();
  assert.equal(r.method, "PUT");
  assert.equal(r.body, "café ✓");
});

test("a Request passed as the input keeps its method, headers and body", async () => {
  const request = new Request(`http://provider.test:${port}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer req" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  await wireFetch()(request);

  const r = last();
  assert.equal(r.method, "POST");
  assert.equal(r.url, "/mcp");
  assert.equal(r.headers.authorization, "Bearer req");
  assert.equal(r.body, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }));
});

test("a GET sends its headers and no body", async () => {
  await wireFetch()(`http://provider.test:${port}/.well-known/oauth-authorization-server`, {
    headers: { accept: "application/json" },
  });

  const r = last();
  assert.equal(r.method, "GET");
  assert.equal(r.headers.accept, "application/json");
  assert.equal(r.body, "");
});

test("transport-owned headers are never forwarded (the transport cannot decode a compressed reply)", async () => {
  await wireFetch()(`http://provider.test:${port}/plain`, {
    headers: { "accept-encoding": "gzip, br", host: "evil.example", accept: "application/json" },
  });
  const r = last();
  assert.equal(r.headers["accept-encoding"], undefined, "no encoding is requested");
  assert.equal(r.headers.host, `provider.test:${port}`, "the Host is the URL's, never the caller's");
  assert.equal(r.headers.accept, "application/json");
});

test("every request is vetted afresh: no pooled socket skips the connection-time lookup", async () => {
  let resolved = 0;
  const guarded = createGuardedFetch({
    resolve: async () => {
      resolved++;
      return ["127.0.0.1"];
    },
    isBlocked: () => false,
  });
  await (await guarded(`http://pooled.test:${port}/one`)).text();
  await (await guarded(`http://pooled.test:${port}/two`)).text();
  assert.equal(resolved, 2, "each request re-resolved and re-classified its host");
});

test("the default classification still refuses a host resolving to loopback before connecting", async () => {
  const before = connections;
  const guarded = createGuardedFetch({ resolve: async () => ["127.0.0.1"] });
  await assert.rejects(guarded(`http://provider.test:${port}/register`, { method: "POST", body: "{}" }));
  assert.equal(connections, before, "no connection was opened");
});

test("an IP-literal loopback host is refused before connecting (Node never calls the lookup for it)", async () => {
  const before = connections;
  let resolved = 0;
  const guarded = createGuardedFetch({
    resolve: async () => {
      resolved++;
      return ["93.184.216.34"];
    },
  });
  await assert.rejects(guarded(`http://127.0.0.1:${port}/`), /private|loopback|blocked/i);
  await assert.rejects(guarded(`http://[::ffff:127.0.0.1]:${port}/`), /private|loopback|blocked/i);
  assert.equal(connections, before, "no connection was opened");
  assert.equal(resolved, 0, "an IP literal is classified directly, not resolved");
});
