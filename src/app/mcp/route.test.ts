// E07-S12 — the MCP route (Streamable HTTP): `POST /mcp`, the agent connector
// endpoint and the agent auth boundary (design §6.1/§6.2, constitution 15/16).
//
// RED-first: neither the sibling factory (`./handler`, `createMcpRouteHandler`) nor
// the route entry (`./route`) exists yet, so importing them throws and every test in
// this file fails until the builder writes those modules. That absence IS the point of
// test-first — do NOT implement anything to make these pass.
//
// What ships under this task (the contract these tests define):
//
//   ./handler.ts  — the testable sibling. A Next App-Router `route.ts` may export ONLY
//     the known route keys (the HTTP verbs + framework config like `runtime`) or
//     `next build` rejects it (OBS-025), so the injectable, unit-testable seam lives
//     HERE, beside the entry. It is a factory returning the three verb handlers:
//
//       createMcpRouteHandler(seams?: {
//         verify?:   (request: Request) => Promise<BearerVerification>;          // default: verifyBearer over the composition root
//         dispatch?: (connectionId: string, request: Request) => Promise<Response>; // default: createMcpHandler + registry + pipeline
//         config?:   Config;                                                     // default: loadConfig() — the Origin allowlist source
//       }): { GET(r: Request): Promise<Response>;
//            POST(r: Request): Promise<Response>;
//            DELETE(r: Request): Promise<Response> }
//
//     POST is the one authenticated agent surface: it validates the request Origin
//     (DNS-rebinding guard, design §6.2), verifies the Bearer token, and on success
//     hands the VERIFIED connection id (never a value from the body) to `dispatch`,
//     which drives the stateless `createMcpHandler` MCP server wired to the tool
//     registry + pipeline. On a failed verification it answers `401` carrying the
//     RFC 9728 `WWW-Authenticate: Bearer resource_metadata="…", scope="warthog"`
//     challenge. GET and DELETE are not agent operations on this stateless endpoint →
//     `405` (design §6.2), never routed to the tool dispatch.
//
//   ./route.ts   — the thin entry: `export const runtime = "nodejs"` plus the three
//     verb handlers from the factory, and NOTHING else (OBS-025).
//
// These tests pin BEHAVIOUR (the HTTP outcome and what the route hands downstream for a
// given header/credential state), never the source text of any module — a later rename
// that preserves behaviour must not redden them. The auth boundary is exercised with
// the REAL, already-built `verifyBearer` over an isolated in-memory PGlite seeded
// through the real OAuth store (`createToken`, the same SHA-256 contract `/oauth/token`
// mints under); the handoff to the MCP surface is proven with a FAKE `dispatch` spy, so
// the route's own job (gate on Origin + auth + method, hand off the verified identity)
// is tested without driving the MCP wire protocol (that lives in registry/pipeline
// tests). Tests never touch the network or Azure; every db handle is closed in a
// `finally`.
//
// ─── Acceptance criteria → tests ──────────────────────────────────────────────────
//   AC1 A POST with no or an invalid Bearer token returns 401 with a
//       `WWW-Authenticate: Bearer resource_metadata=…` header.
//   AC2 A POST with a valid access token for an active connection reaches the pipeline
//       (the authenticated dispatch) under the token's connection and returns the tool
//       result.
//   AC3 GET and DELETE to /mcp return 405.
//   (+) The route validates Origin: a cross-site Origin is refused; the agent case
//       (no Origin) and a same-origin request are allowed through to dispatch.
//   (+) The route entry exports ONLY its framework fields (OBS-025) and runs on the
//       nodejs runtime.

import { test } from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";

import { createMcpRouteHandler } from "./handler";
import * as mcpRoute from "./route";

import { verifyBearer, type BearerVerification } from "../../server/oauth/verify-bearer";
import { createToken } from "../../server/oauth/store";
import { loadConfig, type Config } from "../../server/config";
import { freshDb } from "../../test/db";
import { fixedClock } from "../../server/seams/clock";
import type { Db } from "../../server/db/index";

// --- fixtures -----------------------------------------------------------------------

// The frozen instant every token expiry is measured against (deterministic lifetimes).
const NOW = new Date("2026-06-01T00:00:00.000Z");
const HOUR_MS = 60 * 60 * 1000;

// A valid DEVELOPMENT environment (pglite is allowed in dev), the base `loadConfig(env)`
// builds config from. It is a pure function of this record, so no test mutates the real
// process environment. Secret values are test-only and generated at the exact lengths
// `loadConfig` requires (HMAC ≥ 32 bytes, dev KEK exactly 32).
const HMAC_KEY_B64 = Buffer.alloc(48, 0x2a).toString("base64");
const DEV_KEK_B64 = Buffer.alloc(32, 0x5c).toString("base64");

// The configured public base URL. Its ORIGIN is what the route accepts as a same-origin
// request; the REQUEST host below deliberately differs, so a challenge or an origin
// check that echoed the request host (rather than config) would be caught.
const PUBLIC_BASE_URL = "https://warthog.example";
const ALLOWED_ORIGIN = new URL(PUBLIC_BASE_URL).origin;
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

// SHA-256 hex of a value — how a token is addressed in storage (design §6.1); a seeded
// token lands under the same hash `verifyBearer` resolves it by.
function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

// Seed an unexpired ACCESS token bound to a connection, stored under its SHA-256 hash
// exactly as `/oauth/token` would, and return the RAW bearer a client presents.
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

// The REAL bearer verification seam over `db` + `config`, frozen clock — the same
// already-built `verifyBearer` the production route uses. Seeding a token (or not)
// drives its ok / 401 branches genuinely.
function realVerify(db: Db, config: Config) {
  return (request: Request): Promise<BearerVerification> =>
    verifyBearer(request, { db, config, clock: fixedClock(NOW) });
}

// A fake verification seam with a fixed outcome, for tests that must not depend on a db
// (method gating is independent of the auth store).
function fakeVerify(result: BearerVerification) {
  return async (): Promise<BearerVerification> => result;
}

// A JSON-RPC-shaped tool result the dispatch spy returns, so a test can prove the route
// surfaces the tool result the MCP surface produced (design §6.2 "returns a tool result").
const TOOL_RESULT = {
  jsonrpc: "2.0" as const,
  id: 1,
  result: { content: [{ type: "text", text: "context for the agent" }] },
};

// A `dispatch` spy: records every (connectionId, request) it is handed and returns a
// fresh tool-result Response, so a test can assert WHICH connection reached the pipeline
// and that the route returned the dispatch's response. A fresh Response per call avoids
// a consumed-body across calls.
function spyDispatch() {
  const calls: Array<{ connectionId: string; request: Request }> = [];
  const dispatch = async (connectionId: string, request: Request): Promise<Response> => {
    calls.push({ connectionId, request });
    return new Response(JSON.stringify(TOOL_RESULT), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { dispatch, calls };
}

// Build an MCP request. GET/DELETE carry no body (a GET/DELETE Request with a body is a
// TypeError in undici). `origin` omitted sends no Origin header (the non-browser agent
// case); `bearer` omitted sends no Authorization header.
function mcpRequest(
  opts: { method?: string; bearer?: string; origin?: string; body?: unknown } = {},
): Request {
  const method = opts.method ?? "POST";
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.bearer !== undefined) headers.authorization = `Bearer ${opts.bearer}`;
  if (opts.origin !== undefined) headers.origin = opts.origin;

  const init: RequestInit = { method, headers };
  if (method !== "GET" && method !== "DELETE") {
    const body = opts.body ?? {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "get_context", arguments: {} },
    };
    init.body = typeof body === "string" ? body : JSON.stringify(body);
  }
  return new Request(`${REQUEST_HOST}/mcp`, init);
}

// Assert a response carries the RFC 9728 / RFC 6750 Bearer challenge the design mandates.
function assertChallengeShape(response: Response): void {
  const header = response.headers.get("www-authenticate");
  assert.ok(header, "a 401 from /mcp must carry a WWW-Authenticate header");
  assert.match(header!, /^Bearer\b/, `the challenge must use the Bearer scheme: ${header}`);
  assert.match(header!, /resource_metadata=/, `the challenge must carry resource_metadata=: ${header}`);
  assert.match(header!, /scope="warthog"/, `the challenge must carry scope="warthog": ${header}`);
}

// ===================================================================================
// AC1 — a POST with no / an invalid Bearer token returns 401 with the WWW-Authenticate
// Bearer challenge.
// ===================================================================================

test("AC1: a POST with no Authorization header returns 401 with a WWW-Authenticate Bearer challenge", async () => {
  const db = await freshDb();
  try {
    const config = configWithBaseUrl(PUBLIC_BASE_URL);
    const { dispatch, calls } = spyDispatch();
    const handler = createMcpRouteHandler({ verify: realVerify(db, config), dispatch, config });

    // No bearer, no Origin (the agent case) — the one reason to reject is the missing credential.
    const response = await handler.POST(mcpRequest());

    assert.equal(response.status, 401, "an unauthenticated MCP POST must be 401");
    assertChallengeShape(response);
    assert.equal(calls.length, 0, "an unauthenticated POST never reaches the tool dispatch/pipeline");
  } finally {
    await db.close();
  }
});

test("AC1: a POST with an unknown/invalid Bearer token returns 401 with the Bearer challenge", async () => {
  const db = await freshDb();
  try {
    const config = configWithBaseUrl(PUBLIC_BASE_URL);
    const { dispatch, calls } = spyDispatch();
    const handler = createMcpRouteHandler({ verify: realVerify(db, config), dispatch, config });

    const response = await handler.POST(mcpRequest({ bearer: `no-such-token-${randomUUID()}` }));

    assert.equal(response.status, 401, "an invalid bearer must be 401");
    assertChallengeShape(response);
    assert.equal(calls.length, 0, "an invalid bearer never reaches the tool dispatch/pipeline");
  } finally {
    await db.close();
  }
});

test("AC1: the 401 challenge is built from configured public base URL, not the request host", async () => {
  const db = await freshDb();
  try {
    const config = configWithBaseUrl(PUBLIC_BASE_URL);
    const handler = createMcpRouteHandler({ verify: realVerify(db, config), dispatch: spyDispatch().dispatch, config });

    const response = await handler.POST(mcpRequest());
    const header = response.headers.get("www-authenticate") ?? "";

    assert.ok(header.includes(PUBLIC_BASE_URL), `the challenge must reference the configured base URL: ${header}`);
    assert.ok(
      !header.includes("request-host.invalid"),
      `the challenge must not echo the request host: ${header}`,
    );
  } finally {
    await db.close();
  }
});

// ===================================================================================
// AC2 — a POST with a valid access token for an active connection reaches the pipeline
// (the authenticated dispatch) under the token's connection and returns the tool result.
// ===================================================================================

test("AC2: a valid access token reaches the dispatch under the token's connection and returns the tool result", async () => {
  const db = await freshDb();
  try {
    const config = configWithBaseUrl(PUBLIC_BASE_URL);
    const connectionId = randomUUID();
    const bearer = await seedAccessToken(db, connectionId);

    const { dispatch, calls } = spyDispatch();
    const handler = createMcpRouteHandler({ verify: realVerify(db, config), dispatch, config });

    // No Origin header — the realistic non-browser agent request.
    const request = mcpRequest({ bearer });
    const response = await handler.POST(request);

    // The authenticated tool surface was reached exactly once, for the token's connection.
    assert.equal(calls.length, 1, "a valid token must reach the tool dispatch/pipeline");
    assert.equal(
      calls[0]!.connectionId,
      connectionId,
      "the dispatch runs under the connection the TOKEN resolves to (session identity, never the body)",
    );
    assert.equal(calls[0]!.request, request, "the original request is forwarded to the dispatch unchanged");

    // The route returns the tool result the dispatch produced.
    assert.equal(response.status, 200, "an authenticated tool call returns the dispatch's success response");
    const body = (await response.json()) as { result?: { content?: unknown } };
    assert.ok(body.result, "the response carries a tool result (design §6.2)");
  } finally {
    await db.close();
  }
});

test("AC2: a valid per-process access-token identity is taken from the credential, not a body value", async () => {
  const db = await freshDb();
  try {
    const config = configWithBaseUrl(PUBLIC_BASE_URL);
    const realConnection = randomUUID();
    const bearer = await seedAccessToken(db, realConnection);

    const { dispatch, calls } = spyDispatch();
    const handler = createMcpRouteHandler({ verify: realVerify(db, config), dispatch, config });

    // The body tries to spoof a different connection/user; the route must ignore it.
    const response = await handler.POST(
      mcpRequest({
        bearer,
        body: {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "get_context", arguments: {} },
          connectionId: "SPOOFED-CONNECTION",
          userId: "SPOOFED-USER",
        },
      }),
    );

    assert.equal(response.status, 200);
    assert.equal(calls.length, 1);
    assert.equal(
      calls[0]!.connectionId,
      realConnection,
      "the connection comes from the verified token, never from a client-supplied body field",
    );
    assert.notEqual(calls[0]!.connectionId, "SPOOFED-CONNECTION", "a spoofed body id can never set the member scope");
  } finally {
    await db.close();
  }
});

// ===================================================================================
// AC3 — GET and DELETE to /mcp return 405 (and never reach the tool dispatch), even
// without a credential: the stateless endpoint has no GET/DELETE agent operations.
// ===================================================================================

test("AC3: a GET to /mcp returns 405 and never reaches the tool dispatch", async () => {
  const config = configWithBaseUrl(PUBLIC_BASE_URL);
  // A verify that would reject (no credential): method gating must win → 405, not 401.
  const reject: BearerVerification = { ok: false, status: 401, wwwAuthenticate: 'Bearer scope="warthog"' };
  const { dispatch, calls } = spyDispatch();
  const handler = createMcpRouteHandler({ verify: fakeVerify(reject), dispatch, config });

  const response = await handler.GET(mcpRequest({ method: "GET" }));

  assert.equal(response.status, 405, "GET /mcp must be 405 (design §6.2), not 401 and not a tool result");
  assert.equal(calls.length, 0, "GET never routes to the authenticated tool dispatch");
});

test("AC3: a DELETE to /mcp returns 405 and never reaches the tool dispatch", async () => {
  const config = configWithBaseUrl(PUBLIC_BASE_URL);
  const reject: BearerVerification = { ok: false, status: 401, wwwAuthenticate: 'Bearer scope="warthog"' };
  const { dispatch, calls } = spyDispatch();
  const handler = createMcpRouteHandler({ verify: fakeVerify(reject), dispatch, config });

  const response = await handler.DELETE(mcpRequest({ method: "DELETE" }));

  assert.equal(response.status, 405, "DELETE /mcp must be 405 (design §6.2)");
  assert.equal(calls.length, 0, "DELETE never routes to the authenticated tool dispatch");
});

// ===================================================================================
// Origin validation (design §6.2 "validates Origin"; §5 "every route checks Origin") —
// the DNS-rebinding guard. A same-origin request and the agent case (no Origin) pass
// through; a cross-site Origin is refused before any tool dispatch.
// ===================================================================================

test("origin: a same-origin POST with a valid token is allowed through to the dispatch", async () => {
  const db = await freshDb();
  try {
    const config = configWithBaseUrl(PUBLIC_BASE_URL);
    const bearer = await seedAccessToken(db, randomUUID());
    const { dispatch, calls } = spyDispatch();
    const handler = createMcpRouteHandler({ verify: realVerify(db, config), dispatch, config });

    const response = await handler.POST(mcpRequest({ bearer, origin: ALLOWED_ORIGIN }));

    assert.equal(response.status, 200, "a same-origin authenticated POST is served");
    assert.equal(calls.length, 1, "a same-origin request reaches the tool dispatch");
  } finally {
    await db.close();
  }
});

test("origin: a POST with no Origin header (the non-browser agent) is allowed through", async () => {
  const db = await freshDb();
  try {
    const config = configWithBaseUrl(PUBLIC_BASE_URL);
    const bearer = await seedAccessToken(db, randomUUID());
    const { dispatch, calls } = spyDispatch();
    const handler = createMcpRouteHandler({ verify: realVerify(db, config), dispatch, config });

    // Non-browser MCP clients send no Origin; the route must not refuse them.
    const response = await handler.POST(mcpRequest({ bearer }));

    assert.equal(calls.length, 1, "a request with no Origin reaches the tool dispatch (agents send no Origin)");
    assert.equal(response.status, 200);
  } finally {
    await db.close();
  }
});

test("origin: a cross-site Origin is refused with a 4xx before any tool dispatch, even with a valid token", async () => {
  const db = await freshDb();
  try {
    const config = configWithBaseUrl(PUBLIC_BASE_URL);
    // A valid token, so the ONLY reason to refuse is the foreign Origin (DNS-rebinding guard).
    const bearer = await seedAccessToken(db, randomUUID());
    const { dispatch, calls } = spyDispatch();
    const handler = createMcpRouteHandler({ verify: realVerify(db, config), dispatch, config });

    const response = await handler.POST(mcpRequest({ bearer, origin: "https://evil.example" }));

    assert.ok(
      response.status >= 400 && response.status < 500,
      `a cross-site Origin must be refused with a 4xx, got ${response.status}`,
    );
    assert.equal(calls.length, 0, "a cross-site request never reaches the tool dispatch/pipeline");
  } finally {
    await db.close();
  }
});

// ===================================================================================
// Route entry (OBS-025) — the entry exports ONLY its framework fields and runs on the
// nodejs runtime. Importing it must be side-effect-free (no config/db at module load),
// which keeps it build-safe; a leaked factory/seam export would break `next build`.
// ===================================================================================

test("the /mcp route entry exports only its HTTP verb handlers (OBS-025: the seam lives in the sibling)", () => {
  assert.equal(typeof mcpRoute.POST, "function", "the entry must export a POST handler");
  assert.equal(typeof mcpRoute.GET, "function", "the entry must export a GET handler");
  assert.equal(typeof mcpRoute.DELETE, "function", "the entry must export a DELETE handler");

  // The ONLY function-typed exports are the three verbs — no `createMcpRouteHandler`
  // (or any other seam) is re-exported from the entry (OBS-025).
  const fnExports = Object.entries(mcpRoute)
    .filter(([, value]) => typeof value === "function")
    .map(([key]) => key)
    .sort();
  assert.deepEqual(
    fnExports,
    ["DELETE", "GET", "POST"],
    "the entry exports only the HTTP verb functions — no factory/seam leaked (OBS-025)",
  );
  assert.ok(
    !("createMcpRouteHandler" in mcpRoute),
    "the injection factory lives in the sibling handler.ts, never on the route entry",
  );
});

test("the /mcp route entry declares the nodejs runtime (design §6.2)", () => {
  assert.equal(
    (mcpRoute as { runtime?: unknown }).runtime,
    "nodejs",
    "the MCP route runs on the nodejs runtime (createMcpHandler, stateless)",
  );
});
