// E06-S07 — Warthog's own Client ID Metadata Document (CIMD), served at
// `/oauth/client-metadata.json`.
//
// Why this exists: Warthog connects to `provider_mcp` connectors as an MCP *client*.
// Under CIMD, a client is identified by the https URL at which its metadata document
// lives — the document URL *is* the `client_id`. A provider acting as the
// authorization server fetches this document to self-register Warthog, with no
// pre-shared secret (design §6.1, §7). This endpoint serves that document.
//
// RED-first: the handler module does not exist yet, so every test here fails at
// import until the builder writes it. These tests pin BEHAVIOUR (the HTTP response a
// GET produces and the parsed JSON document it carries), never the source text of any
// module — a later rename that preserves behaviour must not redden them.
//
// Seam note: an App-Router `route.ts` may export ONLY the known route keys (the HTTP
// verbs + config); `next build` rejects any other export (OBS-025). So the testable
// injection seam lives in a SIBLING module, `handler.ts`, which `route.ts` imports and
// wires to `loadConfig()` before exporting `GET`. The task's Touches list only
// `route.ts`; the sibling handler is the seam that makes the entry thin and testable
// (mirrors `createAuthServerMetadataHandler` / `createProtectedResourceMetadataHandler`).
//
// Location note: the handler lives under `src/app/oauth/client-metadata.json/`, but
// this TEST file lives beside the OAuth server code and imports the handler by path,
// exactly as the sibling metadata-document tests do. (A `.test.ts` placed inside the
// app route directory would be type-checked by `next build`; keeping tests out of the
// route tree keeps the entry files clean.) ESM import resolution handles the dotted
// directory name fine — `.../client-metadata.json/handler` resolves `handler.ts`
// inside the `client-metadata.json` directory, never a JSON file.
//
// The contract this task defines (the builder implements exactly this):
//
//   createClientMetadataHandler({ config }): (request: Request) => Response
//     • a GET returns a 200 JSON response whose body is the CIMD document.
//     • `client_id` is the https URL at which the document is served — the CONFIGURED
//       public base URL plus `/oauth/client-metadata.json` (the defining CIMD rule:
//       the document URL is the client_id) — read from config, never from the
//       incoming request's host.
//     • `redirect_uris` is a non-empty array of https URLs, all on Warthog's own
//       (configured) host — where a provider returns the authorization code.
//     • `token_endpoint_auth_method` is exactly `"none"` (Warthog is a public client;
//       PKCE, no client secret).
//
// The document is public: the handler takes only config (no session), so an
// unauthenticated GET is served (INV-101: public routes stay usable with no auth).
import { test } from "node:test";
import assert from "node:assert/strict";

import { loadConfig } from "../config";
import { createClientMetadataHandler } from "../../app/oauth/client-metadata.json/handler";

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
  return new Request("https://request-host.invalid/oauth/client-metadata.json");
}

async function fetchMetadata(publicBaseUrl: string) {
  const handler = createClientMetadataHandler({ config: configWithBaseUrl(publicBaseUrl) });
  const response = await handler(metadataRequest());
  const body = (await response.clone().json()) as Record<string, unknown>;
  return { response, body };
}

// The CIMD document's own URL — and so, by the CIMD rule, its client_id — for a given
// configured base URL.
function expectedClientId(publicBaseUrl: string): string {
  return `${publicBaseUrl}/oauth/client-metadata.json`;
}

test("serves a 200 JSON client-metadata document", async () => {
  const { response } = await fetchMetadata("https://warthog.example");
  assert.equal(response.status, 200);
  const contentType = response.headers.get("content-type") ?? "";
  assert.ok(
    contentType.includes("application/json"),
    `expected a JSON content-type, got "${contentType}"`,
  );
});

test("client_id is the document's own served URL, not the request host", async () => {
  const { body } = await fetchMetadata("https://warthog.example");
  assert.equal(body.client_id, expectedClientId("https://warthog.example"));
});

test("client_id flows from config (a different base URL yields a different client_id)", async () => {
  const a = (await fetchMetadata("https://a.example")).body;
  const b = (await fetchMetadata("https://b.example")).body;
  assert.equal(a.client_id, expectedClientId("https://a.example"));
  assert.equal(b.client_id, expectedClientId("https://b.example"));
  assert.notEqual(a.client_id, b.client_id);
});

test("client_id is an https URL", async () => {
  const { body } = await fetchMetadata("https://warthog.example");
  assert.equal(typeof body.client_id, "string");
  const url = new URL(body.client_id as string);
  assert.equal(url.protocol, "https:");
});

test('token_endpoint_auth_method is exactly "none" (public client)', async () => {
  const { body } = await fetchMetadata("https://warthog.example");
  assert.equal(body.token_endpoint_auth_method, "none");
});

test("a public client (auth method none) carries no client_secret", async () => {
  // Scoped to the document's own property: a secret would be both a CIMD-validity
  // defect (a public client has none) and a leak. We assert the key is absent on the
  // parsed document object, not a whole-output substring search.
  const { body } = await fetchMetadata("https://warthog.example");
  assert.ok(
    !("client_secret" in body),
    "a CIMD for a public client must not carry a client_secret",
  );
});

test("redirect_uris is a non-empty array of https URLs", async () => {
  const { body } = await fetchMetadata("https://warthog.example");
  assert.ok(Array.isArray(body.redirect_uris), "redirect_uris must be an array");
  const uris = body.redirect_uris as unknown[];
  assert.ok(uris.length >= 1, "redirect_uris must list at least one URI");
  for (const uri of uris) {
    assert.equal(typeof uri, "string");
    // Warthog is a hosted client, so every redirect URI is https (the shared
    // redirect rule also permits http://localhost, but Warthog never uses that here).
    assert.equal(new URL(uri as string).protocol, "https:");
  }
});

test("redirect_uris are on Warthog's own configured host, not the request host", async () => {
  const { body } = await fetchMetadata("https://warthog.example");
  const uris = body.redirect_uris as string[];
  for (const uri of uris) {
    assert.ok(
      uri.startsWith("https://warthog.example"),
      `redirect URI ${uri} must be on the configured base URL`,
    );
  }
});

test("redirect_uris flow from config (a different base URL yields different redirect URIs)", async () => {
  const a = (await fetchMetadata("https://a.example")).body.redirect_uris as string[];
  const b = (await fetchMetadata("https://b.example")).body.redirect_uris as string[];
  for (const uri of a) {
    assert.ok(uri.startsWith("https://a.example"), `${uri} must be under base a.example`);
  }
  for (const uri of b) {
    assert.ok(uri.startsWith("https://b.example"), `${uri} must be under base b.example`);
  }
  assert.notDeepEqual(a, b);
});
