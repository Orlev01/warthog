// E06-S02 — the RFC 9728 protected-resource metadata endpoint
// (`/.well-known/oauth-protected-resource`).
//
// RED-first: the handler module does not exist yet, so every test here fails at
// import until the builder writes it. These tests pin BEHAVIOUR (the HTTP response
// a GET produces and the parsed JSON document it carries), never the source text of
// any module — a later rename that preserves behaviour must not redden them.
//
// Seam note: an App-Router `route.ts` may export ONLY the known route keys (the HTTP
// verbs + config); `next build` rejects any other export (OBS-025). So the testable
// injection seam lives in a SIBLING module, `handler.ts`, which `route.ts` imports
// and wires to `loadConfig()` before exporting `GET`. The task's Touches list only
// `route.ts`; the sibling handler is the seam that makes the entry thin and testable.
//
// Location note: the handler lives under `src/app/.well-known/...`, but this TEST
// file does NOT — the gate's discovery glob `src/**/*.test.ts` does not descend into
// a dot-directory (`.well-known`), so a test placed there would silently never run.
// It therefore lives beside the OAuth server code and imports the handler by path
// (ESM import resolution handles the dot-directory fine). If the project later
// teaches the test runner to see the dot-directory, this file can move next to the
// handler unchanged.
//
// The contract this task defines (the builder implements exactly this):
//
//   createProtectedResourceMetadataHandler({ config }): (request: Request) => Response
//     • a GET returns a 200 JSON response whose body is the RFC 9728 document.
//     • `resource` is the configured MCP resource — the public base URL plus `/mcp`
//       (design §6.1: resource = https://<public host>/mcp) — read from config,
//       never from the incoming request's host.
//     • `authorization_servers` lists the configured issuer (the public base URL),
//       so an agent can discover Warthog's authorization server from the resource.
//
// The document is public: the handler takes only config (no session), so an
// unauthenticated GET is served (INV-101: public routes stay usable with no auth).
import { test } from "node:test";
import assert from "node:assert/strict";

import { loadConfig } from "../config";
import { createProtectedResourceMetadataHandler } from "../../app/.well-known/oauth-protected-resource/handler";

// Build a real Config with a chosen public base URL, via the one env seam. A minimal
// DEVELOPMENT env (pglite is allowed in dev) so constructing config never needs a
// fully-populated production environment.
function configWithBaseUrl(publicBaseUrl: string) {
  return loadConfig({
    NODE_ENV: "development",
    PUBLIC_BASE_URL: publicBaseUrl,
    WEBAUTHN_RP_ID: "localhost",
    DATABASE_URL: "pglite:memory",
    // Server secrets are required since E04-S20 (test-only values).
    WARTHOG_HMAC_KEY: "ERERERERERERERERERERERERERERERERERERERERERE=",
    WARTHOG_DEV_KEK: "IiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiI=",
  } as NodeJS.ProcessEnv);
}

// A request whose host deliberately DIFFERS from the configured base URL, so a test
// that asserts a config-sourced value fails if the handler echoes the request host.
function metadataRequest() {
  return new Request("https://request-host.invalid/.well-known/oauth-protected-resource");
}

async function fetchMetadata(publicBaseUrl: string) {
  const handler = createProtectedResourceMetadataHandler({
    config: configWithBaseUrl(publicBaseUrl),
  });
  const response = await handler(metadataRequest());
  const body = (await response.clone().json()) as Record<string, unknown>;
  return { response, body };
}

test("serves a 200 JSON protected-resource document", async () => {
  const { response } = await fetchMetadata("https://warthog.example");
  assert.equal(response.status, 200);
  const contentType = response.headers.get("content-type") ?? "";
  assert.ok(
    contentType.includes("application/json"),
    `expected a JSON content-type, got "${contentType}"`,
  );
});

test("resource is the configured public base URL plus /mcp, not the request host", async () => {
  const { body } = await fetchMetadata("https://warthog.example");
  assert.equal(body.resource, "https://warthog.example/mcp");
});

test("resource flows from config (a different base URL yields a different resource)", async () => {
  const a = (await fetchMetadata("https://a.example")).body;
  const b = (await fetchMetadata("https://b.example")).body;
  assert.equal(a.resource, "https://a.example/mcp");
  assert.equal(b.resource, "https://b.example/mcp");
  assert.notEqual(a.resource, b.resource);
});

test("authorization_servers lists the configured issuer (the public base URL)", async () => {
  const { body } = await fetchMetadata("https://warthog.example");
  assert.ok(
    Array.isArray(body.authorization_servers),
    "authorization_servers must be an array of issuer identifiers",
  );
  assert.ok(
    (body.authorization_servers as unknown[]).includes("https://warthog.example"),
    "authorization_servers must include the configured issuer",
  );
});
