// E06-S02 — the RFC 8414 authorization-server metadata endpoint
// (`/.well-known/oauth-authorization-server`).
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
//   createAuthServerMetadataHandler({ config }): (request: Request) => Response
//     • a GET returns a 200 JSON response whose body is the RFC 8414 document.
//     • `issuer` is the CONFIGURED public base URL (config.publicBaseUrl) — read
//       from config, never from the incoming request's host.
//     • `client_id_metadata_document_supported` is boolean `true`.
//     • `token_endpoint_auth_methods_supported` is exactly `["none"]`.
//
// The document is public: the handler takes only config (no session), so an
// unauthenticated GET is served (INV-101: public routes stay usable with no auth).
import { test } from "node:test";
import assert from "node:assert/strict";

import { loadConfig } from "../config";
import { createAuthServerMetadataHandler } from "../../app/.well-known/oauth-authorization-server/handler";

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
  return new Request("https://request-host.invalid/.well-known/oauth-authorization-server");
}

async function fetchMetadata(publicBaseUrl: string) {
  const handler = createAuthServerMetadataHandler({ config: configWithBaseUrl(publicBaseUrl) });
  const response = await handler(metadataRequest());
  const body = (await response.clone().json()) as Record<string, unknown>;
  return { response, body };
}

test("serves a 200 JSON authorization-server document", async () => {
  const { response } = await fetchMetadata("https://warthog.example");
  assert.equal(response.status, 200);
  const contentType = response.headers.get("content-type") ?? "";
  assert.ok(
    contentType.includes("application/json"),
    `expected a JSON content-type, got "${contentType}"`,
  );
});

test("issuer is the configured public base URL, not the request host", async () => {
  const { body } = await fetchMetadata("https://warthog.example");
  assert.equal(body.issuer, "https://warthog.example");
});

test("issuer flows from config (a different base URL yields a different issuer)", async () => {
  const a = (await fetchMetadata("https://a.example")).body;
  const b = (await fetchMetadata("https://b.example")).body;
  assert.equal(a.issuer, "https://a.example");
  assert.equal(b.issuer, "https://b.example");
  assert.notEqual(a.issuer, b.issuer);
});

test("advertises client_id_metadata_document_supported: true", async () => {
  const { body } = await fetchMetadata("https://warthog.example");
  assert.equal(body.client_id_metadata_document_supported, true);
});

test("advertises token_endpoint_auth_methods_supported: [\"none\"]", async () => {
  const { body } = await fetchMetadata("https://warthog.example");
  assert.deepEqual(body.token_endpoint_auth_methods_supported, ["none"]);
});
