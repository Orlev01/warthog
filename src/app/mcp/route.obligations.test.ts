// E07-S12 — the MCP route, the obligation acceptance criteria
// (`src/app/mcp/route.ts` + its sibling `handler.ts`, design §6.1/§6.2;
// INV-101 admin-auth-required, INV-102 validate-and-parameterize-input,
// INV-103 secrets-from-env).
//
// RED-first: `./handler` (`createMcpRouteHandler`) does not exist yet, so importing it
// throws and every test here fails until the builder writes the module. That absence IS
// the point of test-first — do NOT implement anything to make these pass.
//
// These tests pin BEHAVIOUR, never source text. They depend on the same
// `createMcpRouteHandler({ verify, dispatch, config })` contract documented in the
// sibling `route.test.ts`. The auth boundary runs the REAL, already-built `verifyBearer`
// over an isolated in-memory PGlite (seeded through the real OAuth store); the
// input-validation obligation runs the route composed with a REAL stateless
// `createMcpHandler` as its dispatch, so an oversized/malformed POST is rejected with a
// 4xx by the real MCP serving the route wraps. Tests never touch the network or Azure;
// every db / MCP handle is closed in a `finally`.
//
//   AC [obligation:admin-auth-required] (INV-101) — the /mcp protected resource rejects
//     an unauthenticated request (401), while a public route (the protected-resource
//     metadata) is served 200 with no auth; and the caller's connection identity is
//     taken from the verified token, never from a client-supplied body value.
//   AC [obligation:validate-and-parameterize-input] (INV-102) — a malformed or oversized
//     POST is rejected with a 4xx (never a 500); tool-input validation + the SQL-probe
//     parameter-binding proof live downstream in the registry/pipeline (tested there),
//     which the authenticated dispatch composes.
//   AC [obligation:secrets-from-env] (INV-103) — the route reads its config through the
//     injected seam: the 401 challenge reflects the CONFIGURED base URL (not a baked
//     literal), and a decoy env secret never appears in a route response.

import { test } from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";

import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";

import { createMcpRouteHandler } from "./handler";
import { verifyBearer, type BearerVerification } from "../../server/oauth/verify-bearer";
import { createToken } from "../../server/oauth/store";
import { loadConfig, type Config } from "../../server/config";
import { createProtectedResourceMetadataHandler } from "../.well-known/oauth-protected-resource/handler";
import { freshDb } from "../../test/db";
import { fixedClock } from "../../server/seams/clock";
import type { Db } from "../../server/db/index";

// --- fixtures -----------------------------------------------------------------------

const NOW = new Date("2026-06-01T00:00:00.000Z");
const HOUR_MS = 60 * 60 * 1000;

const HMAC_KEY_B64 = Buffer.alloc(48, 0x2a).toString("base64");
const DEV_KEK_B64 = Buffer.alloc(32, 0x5c).toString("base64");

const PUBLIC_BASE_URL = "https://warthog.example";
const REQUEST_HOST = "https://request-host.invalid";

function configWithBaseUrl(publicBaseUrl: string): Config {
  return loadConfig({
    NODE_ENV: "development",
    PUBLIC_BASE_URL: publicBaseUrl,
    WEBAUTHN_RP_ID: "localhost",
    DATABASE_URL: "pglite:memory",
    WARTHOG_HMAC_KEY: HMAC_KEY_B64,
    WARTHOG_DEV_KEK: DEV_KEK_B64,
  } as NodeJS.ProcessEnv);
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function seedAccessToken(db: Db, connectionId: string): Promise<string> {
  const raw = `access-${randomUUID()}`;
  await createToken(db, {
    tokenHash: sha256Hex(raw),
    connectionId,
    kind: "access",
    expiresAt: new Date(NOW.getTime() + HOUR_MS),
  });
  return raw;
}

function realVerify(db: Db, config: Config) {
  return (request: Request): Promise<BearerVerification> =>
    verifyBearer(request, { db, config, clock: fixedClock(NOW) });
}

// The route composed with a REAL, stateless `createMcpHandler` as its dispatch seam:
// the authenticated connection is handed to the SDK as pass-through authInfo, so the
// route's input is served by the real MCP transport (which caps body size and rejects
// unparseable bodies). The one the production route builds internally; here it is
// injected so the obligation is proven against the real SDK without the connections
// store (E09-S05) that the production dispatch also resolves.
function realMcpDispatch() {
  const mcp = createMcpHandler(
    () => new McpServer({ name: "warthog-mcp-test", version: "0.0.0" }),
    { legacy: "stateless" },
  );
  const dispatch = async (connectionId: string, request: Request): Promise<Response> =>
    mcp.fetch(request, { authInfo: { token: "seeded", clientId: connectionId, scopes: ["warthog"] } });
  return { dispatch, close: () => mcp.close() };
}

// A POST to /mcp. `accept` adds the Streamable-HTTP Accept header a real MCP client
// sends; `body` sent verbatim when a string (for malformed JSON). No Origin header (the
// agent case → allowed), so the only reason to reject is auth / input.
function mcpPost(
  opts: { bearer?: string; body?: unknown; accept?: boolean } = {},
): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.accept) headers.accept = "application/json, text/event-stream";
  if (opts.bearer !== undefined) headers.authorization = `Bearer ${opts.bearer}`;
  const body = opts.body ?? {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "get_context", arguments: {} },
  };
  return new Request(`${REQUEST_HOST}/mcp`, {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

// =====================================================================================
// AC [admin-auth-required] — the protected resource rejects the unauthenticated; the
// public metadata route is served with no auth.
// =====================================================================================

test("[admin-auth-required] an unauthenticated POST to /mcp is rejected with 401", async () => {
  const db = await freshDb();
  try {
    const config = configWithBaseUrl(PUBLIC_BASE_URL);
    const handler = createMcpRouteHandler({
      verify: realVerify(db, config),
      dispatch: async () => new Response("should-not-be-reached", { status: 200 }),
      config,
    });

    const response = await handler.POST(mcpPost());
    assert.equal(response.status, 401, "the /mcp protected resource rejects an unauthenticated request");
    assert.ok(response.headers.get("www-authenticate"), "the 401 carries a WWW-Authenticate challenge");
  } finally {
    await db.close();
  }
});

test("[admin-auth-required] a public route (protected-resource metadata) is served 200 with no auth", async () => {
  // The metadata document is how an agent discovers HOW to get a token, so it MUST be
  // reachable with no Authorization header (INV-101: public routes stay usable). This is
  // the real, already-built public handler — no bearer, no session presented.
  const handler = createProtectedResourceMetadataHandler({ config: configWithBaseUrl(PUBLIC_BASE_URL) });
  const response = await handler(
    new Request(`${PUBLIC_BASE_URL}/.well-known/oauth-protected-resource`),
  );
  assert.equal(response.status, 200, "a public route is served 200 with no auth header or session");
});

test("[admin-auth-required] the connection identity comes from the verified token, never a client body value", async () => {
  const db = await freshDb();
  try {
    const config = configWithBaseUrl(PUBLIC_BASE_URL);
    const realConnection = randomUUID();
    const bearer = await seedAccessToken(db, realConnection);

    let seenConnectionId: string | undefined;
    const handler = createMcpRouteHandler({
      verify: realVerify(db, config),
      dispatch: async (connectionId: string): Promise<Response> => {
        seenConnectionId = connectionId;
        return new Response("ok", { status: 200 });
      },
      config,
    });

    await handler.POST(
      mcpPost({
        bearer,
        // A client trying to redirect the member scope to another connection/user.
        body: { jsonrpc: "2.0", id: 1, method: "tools/call", connectionId: "SPOOF", userId: "SPOOF" },
      }),
    );

    assert.equal(
      seenConnectionId,
      realConnection,
      "the member scope is the token's connection — a client-supplied id can never set it (INV-101/INV-102)",
    );
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC [validate-and-parameterize-input] — a malformed or oversized POST is a 4xx, served
// by the route composed with the real stateless MCP handler (never an uncaught 500).
// =====================================================================================

test("[validate-and-parameterize-input] an oversized POST body is rejected with a 4xx", async () => {
  const db = await freshDb();
  const mcp = realMcpDispatch();
  try {
    const config = configWithBaseUrl(PUBLIC_BASE_URL);
    const bearer = await seedAccessToken(db, randomUUID());
    const handler = createMcpRouteHandler({ verify: realVerify(db, config), dispatch: mcp.dispatch, config });

    // A valid token (so the only reason to reject is the body): a body past any sane cap.
    const huge = "x".repeat(5 * 1024 * 1024);
    const response = await handler.POST(mcpPost({ bearer, accept: true, body: huge }));

    assert.ok(
      response.status >= 400 && response.status < 500,
      `an oversized body must be a 4xx, got ${response.status}`,
    );
  } finally {
    await mcp.close();
    await db.close();
  }
});

test("[validate-and-parameterize-input] a malformed-JSON POST body is a 4xx, not an uncaught 500", async () => {
  const db = await freshDb();
  const mcp = realMcpDispatch();
  try {
    const config = configWithBaseUrl(PUBLIC_BASE_URL);
    const bearer = await seedAccessToken(db, randomUUID());
    const handler = createMcpRouteHandler({ verify: realVerify(db, config), dispatch: mcp.dispatch, config });

    const response = await handler.POST(mcpPost({ bearer, accept: true, body: "{ not valid json at all" }));

    assert.ok(
      response.status >= 400 && response.status < 500,
      `malformed input must be a handled 4xx, never a 500, got ${response.status}`,
    );
  } finally {
    await mcp.close();
    await db.close();
  }
});

// =====================================================================================
// AC [secrets-from-env] — config flows in through the seam; no secret is baked, and no
// ambient env value leaks into a route response.
// =====================================================================================

test("[secrets-from-env] the 401 challenge is derived from the CONFIGURED base URL, not a baked literal", async () => {
  const db = await freshDb();
  try {
    const alpha = createMcpRouteHandler({
      verify: realVerify(db, configWithBaseUrl("https://alpha.example")),
      dispatch: async () => new Response(null, { status: 200 }),
      config: configWithBaseUrl("https://alpha.example"),
    });
    const bravo = createMcpRouteHandler({
      verify: realVerify(db, configWithBaseUrl("https://bravo.example")),
      dispatch: async () => new Response(null, { status: 200 }),
      config: configWithBaseUrl("https://bravo.example"),
    });

    const challengeA = (await alpha.POST(new Request(`${REQUEST_HOST}/mcp`, { method: "POST" }))).headers.get(
      "www-authenticate",
    );
    const challengeB = (await bravo.POST(new Request(`${REQUEST_HOST}/mcp`, { method: "POST" }))).headers.get(
      "www-authenticate",
    );

    assert.ok(challengeA?.includes("alpha.example"), `challenge must reflect the configured base URL: ${challengeA}`);
    assert.ok(challengeB?.includes("bravo.example"), `challenge must reflect the configured base URL: ${challengeB}`);
    assert.notEqual(challengeA, challengeB, "a different configured base URL yields a different challenge (config, not baked)");
  } finally {
    await db.close();
  }
});

test("[secrets-from-env] a decoy env secret never appears in a route response", async () => {
  const DECOY = "sk_live_DECOY_must_never_appear_in_warthog";
  const prev = process.env.WARTHOG_DECOY_SECRET;
  process.env.WARTHOG_DECOY_SECRET = DECOY;

  const db = await freshDb();
  try {
    // Config is built from the explicit env record above (no decoy), so the route reads
    // configuration through the seam, never ambient process.env.
    const config = configWithBaseUrl(PUBLIC_BASE_URL);
    const handler = createMcpRouteHandler({
      verify: realVerify(db, config),
      dispatch: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
      config,
    });

    const unauth = await handler.POST(new Request(`${REQUEST_HOST}/mcp`, { method: "POST" }));
    const serialised =
      `${unauth.status} ${[...unauth.headers.entries()].map(([k, v]) => `${k}:${v}`).join(" ")} ${await unauth.text()}`;

    assert.ok(!serialised.includes(DECOY), "no ambient env secret is folded into a /mcp response");
  } finally {
    await db.close();
    if (prev === undefined) delete process.env.WARTHOG_DECOY_SECRET;
    else process.env.WARTHOG_DECOY_SECRET = prev;
  }
});
