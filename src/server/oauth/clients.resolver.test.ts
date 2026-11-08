// Review fix A1 — the authorization server resolves the client named by `client_id`
// before it will carry an authorize request anywhere (`createClientResolver` in
// `./clients`).
//
// Until this fix `/oauth/authorize` accepted ANY client_id and ANY redirect_uri: the DCR
// rows `/oauth/register` stores were never read, and the SSRF-guarded CIMD fetcher was
// built but never used, so a crafted link could send a code (or, via a `javascript:`
// redirect, script) anywhere. The resolver is the one place a client_id becomes a known
// client with its registered redirect URIs:
//
//   • a DCR (or pre-registered) client is read from `oauth_clients` by its id;
//   • otherwise an https client_id is a CIMD client: its metadata document is fetched
//     through the injected (SSRF-guarded in production) fetcher, and accepted only when
//     the document names the SAME client_id and lists its redirect URIs;
//   • anything else — unknown id, a fetch failure, a malformed or mismatched document —
//     resolves to null (fail closed).
//
// The CIMD fetcher is injected, so these tests never touch the network.

import { test } from "node:test";
import assert from "node:assert/strict";

import { createClientResolver } from "./clients";
import { createClient } from "./store";
import { freshDb } from "../../test/db";

const DCR_CLIENT = "3f1f9c1e-5d41-4c55-9a52-4cf0d5b3a001";
const DCR_REDIRECT = "https://gemini.example/oauth/callback";
const CIMD_CLIENT = "https://claude.ai/.well-known/oauth-client";
const CIMD_REDIRECT = "https://claude.ai/api/mcp/auth_callback";

// A CIMD fetcher that must not be reached (a DCR lookup, or a non-https client_id).
async function unreachableCimd(clientId: string): Promise<Record<string, unknown>> {
  throw new Error(`CIMD fetch must not happen for ${clientId}`);
}

test("a DCR client resolves from oauth_clients with its registered redirect URIs", async () => {
  const db = await freshDb();
  try {
    await createClient(db, { clientId: DCR_CLIENT, registration: "dcr", redirectUris: [DCR_REDIRECT] });
    const resolve = createClientResolver({ db, fetchCimd: unreachableCimd });

    const client = await resolve(DCR_CLIENT);
    assert.ok(client != null, "a registered DCR client resolves");
    assert.equal(client!.clientId, DCR_CLIENT);
    assert.equal(client!.registration, "dcr");
    assert.deepEqual([...client!.redirectUris], [DCR_REDIRECT]);
  } finally {
    await db.close();
  }
});

test("an unknown, non-URL client_id resolves to null without any fetch", async () => {
  const db = await freshDb();
  try {
    const resolve = createClientResolver({ db, fetchCimd: unreachableCimd });
    assert.equal(await resolve("never-registered-client"), null, "an unregistered client is unknown");
    assert.equal(await resolve("http://claude.ai/client"), null, "a plain-http client_id is never a CIMD client");
    assert.equal(await resolve(""), null, "an empty client_id is unknown");
  } finally {
    await db.close();
  }
});

test("an https client_id resolves as a CIMD client when its document names the same client_id", async () => {
  const db = await freshDb();
  try {
    const fetched: string[] = [];
    const resolve = createClientResolver({
      db,
      fetchCimd: async (clientId) => {
        fetched.push(clientId);
        return { client_id: CIMD_CLIENT, client_name: "Claude", redirect_uris: [CIMD_REDIRECT] };
      },
    });

    const client = await resolve(CIMD_CLIENT);
    assert.ok(client != null, "a CIMD client whose document matches resolves");
    assert.equal(client!.registration, "cimd");
    assert.deepEqual([...client!.redirectUris], [CIMD_REDIRECT]);
    assert.deepEqual(fetched, [CIMD_CLIENT], "the document is fetched from the client_id URL itself");
  } finally {
    await db.close();
  }
});

test("a CIMD document that names a different client_id, or is malformed, is refused", async () => {
  const db = await freshDb();
  try {
    const documents: unknown[] = [
      { client_id: "https://evil.example/client", redirect_uris: [CIMD_REDIRECT] },
      { redirect_uris: [CIMD_REDIRECT] },
      { client_id: CIMD_CLIENT },
      { client_id: CIMD_CLIENT, redirect_uris: [] },
      { client_id: CIMD_CLIENT, redirect_uris: "https://claude.ai/cb" },
      { client_id: CIMD_CLIENT, redirect_uris: [42] },
    ];
    for (const doc of documents) {
      const resolve = createClientResolver({ db, fetchCimd: async () => doc as Record<string, unknown> });
      assert.equal(await resolve(CIMD_CLIENT), null, `refused: ${JSON.stringify(doc)}`);
    }
  } finally {
    await db.close();
  }
});

test("a CIMD fetch failure (SSRF refusal, timeout, bad JSON) resolves to null — fail closed", async () => {
  const db = await freshDb();
  try {
    const resolve = createClientResolver({
      db,
      fetchCimd: async () => {
        throw new Error("CIMD host resolves to a private, loopback or link-local address");
      },
    });
    assert.equal(await resolve("https://internal.example/client"), null);
  } finally {
    await db.close();
  }
});
