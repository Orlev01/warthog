// E06-S08 — MCP bearer verification for the protected resource (`/mcp`),
// `src/server/oauth/verify-bearer.ts` (design §6.1).
//
// RED-first: `./verify-bearer` does not exist yet, so importing it throws — every
// test here fails at import until the builder writes the module. That absence IS the
// point of test-first; do not implement anything to make these pass.
//
// These tests pin BEHAVIOUR (what verification RETURNS for a given Authorization
// header and stored credential state), never the source text of any module — a later
// rename that preserves behaviour must not redden them. A "valid token" is proven by
// seeding it through the already-built OAuth store (`createToken`, the same SHA-256
// contract `/oauth/token` mints under) and an access key through `issueAccessKey`, then
// presenting the raw bearer and checking the connection it resolves to; the "public
// route needs no bearer" property is shown by invoking the real, already-built
// protected-resource metadata handler with no Authorization header.
//
// Seam note: the MCP route (`src/app/mcp/route.ts`, design §6.2) does not exist yet and
// is NOT this task — bearer verification is the server seam a later MCP route will call
// around `createMcpHandler`. A `route.ts` may export ONLY the known route keys, so the
// verification logic lives in the server module the task's Touches name
// (`src/server/oauth/verify-bearer.ts`); these tests import it directly.
//
// Connection note: `connectionId` is an OPAQUE uuid here (the connections table lands
// in a later migration, E09-S05), exactly as E06-S01's store and the token seam treat
// it. Disconnect deletes a connection's tokens and keys (design §6.1), so a credential
// that still resolves is, by construction, one of an active connection.
//
// The contract this task defines (the builder implements exactly this):
//
//   verifyBearer(request: Request, deps: VerifyBearerDeps): Promise<BearerVerification>
//     deps:   { db: Db; config: Config; clock: Clock }
//     result (a discriminated union, the repo idiom):
//       { ok: true;  connectionId: string }
//     | { ok: false; status: 401; wwwAuthenticate: string }
//
//     • The bearer is read from the request's `Authorization: Bearer <token>` header.
//       A missing header, a non-Bearer scheme, or a token that resolves to no active
//       credential yields the 401 branch.
//     • The 401 branch carries a `WWW-Authenticate` challenge value of the RFC 9728 /
//       RFC 6750 shape `Bearer resource_metadata="<url>", scope="warthog"`, where
//       `<url>` is the configured protected-resource metadata URL (derived from
//       `config.publicBaseUrl`, never the request host).
//     • A valid, unexpired access token (kind "access") resolves to the connection it
//       is bound to. An expired token, or a refresh token presented as a bearer, is
//       rejected. A valid per-agent access key (`wh_ak_…`) also resolves as a bearer to
//       its connection (design §6.1: access keys verify as bearers for platforms that
//       only send a static Bearer header).
//
// Acceptance criteria → tests:
//   AC1 "A request with no or an invalid bearer to the protected resource returns 401
//        with WWW-Authenticate: Bearer resource_metadata and scope warthog." — a bare
//        request, an unknown bearer and a non-Bearer scheme each yield the 401 branch
//        whose challenge carries a config-derived resource_metadata URL and
//        scope="warthog".
//   AC2 "A valid token resolves to its active connection and a public route needs no
//        bearer." — a seeded access token (and access key) resolves to its bound
//        connection; the protected-resource metadata is served 200 with no bearer.
//
// Every db handle is closed in a `finally` so node:test leaves no open handle; each
// db-backed test uses its own `freshDb()` (an isolated in-memory PGlite with the real
// migrations), so tests share no state. Tests never touch the network or Azure.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";

import { verifyBearer } from "./verify-bearer";
import { createToken } from "./store";
import { issueAccessKey } from "./access-key";
import { createProtectedResourceMetadataHandler } from "../../app/.well-known/oauth-protected-resource/handler";
import { loadConfig } from "../config";
import { freshDb } from "../../test/db";
import { fixedClock } from "../seams/clock";
import { systemRandom } from "../seams/random";
import type { Db } from "../db/index";

// The frozen instant every expiry is measured against, so token lifetimes are
// exercised deterministically with no wall-clock dependence.
const NOW = new Date("2026-06-01T00:00:00.000Z");
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// The shape verification returns, taken from the function itself so the test pins the
// behavioural fields (ok / connectionId / status / wwwAuthenticate) without locking the
// union's type NAME — a later rename of the type must not redden these.
type Verification = Awaited<ReturnType<typeof verifyBearer>>;

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

function depsFor(db: Db, publicBaseUrl = "https://warthog.example") {
  return { db, config: configWithBaseUrl(publicBaseUrl), clock: fixedClock(NOW) };
}

// A request to the protected resource. The host deliberately DIFFERS from the
// configured base URL, so a challenge that echoed the request host (rather than config)
// would be caught. Omitting `authorization` sends no Authorization header.
function mcpRequest(authorization?: string): Request {
  const headers: Record<string, string> = {};
  if (authorization !== undefined) headers["authorization"] = authorization;
  return new Request("https://request-host.invalid/mcp", { method: "POST", headers });
}

// SHA-256 hex of a value — how a token is addressed in storage (design §6.1). Computed
// here so a seeded token lands under the same hash verification resolves it by.
function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

// Seed a token bound to a connection, stored under its SHA-256 hash exactly as
// `/oauth/token` would, and return the RAW bearer a client presents.
async function seedToken(
  db: Db,
  opts: { connectionId: string; kind: "access" | "refresh"; expiresAt: Date },
): Promise<string> {
  const raw = `${opts.kind}-${randomUUID()}`;
  await createToken(db, {
    tokenHash: sha256Hex(raw),
    connectionId: opts.connectionId,
    kind: opts.kind,
    expiresAt: opts.expiresAt,
  });
  return raw;
}

// Assert the verification rejected, and return the 401 challenge for further checks.
function expectRejected(result: Verification): { status: number; wwwAuthenticate: string } {
  if (result.ok) {
    assert.fail(
      `expected a 401 Bearer challenge, but verification succeeded (connection ${result.connectionId})`,
    );
  }
  return { status: result.status, wwwAuthenticate: result.wwwAuthenticate };
}

// Assert the verification resolved, and return the connection it resolved to.
function expectConnection(result: Verification): string {
  if (!result.ok) {
    assert.fail(
      `expected a resolved connection, but got a 401 challenge: ${result.wwwAuthenticate}`,
    );
  }
  return result.connectionId;
}

// The RFC 9728 / RFC 6750 challenge shape the design mandates: the Bearer scheme, a
// resource_metadata parameter, and scope="warthog".
function assertChallengeShape(wwwAuthenticate: string): void {
  assert.match(wwwAuthenticate, /^Bearer\b/, `challenge must use the Bearer scheme: ${wwwAuthenticate}`);
  assert.match(
    wwwAuthenticate,
    /resource_metadata=/,
    `challenge must carry a resource_metadata parameter: ${wwwAuthenticate}`,
  );
  assert.match(
    wwwAuthenticate,
    /scope="warthog"/,
    `challenge must carry scope="warthog": ${wwwAuthenticate}`,
  );
}

// --- AC1: no / invalid bearer → a 401 challenge -------------------------------------

test("a request with no Authorization header returns a 401 Bearer challenge", async () => {
  const db = await freshDb();
  try {
    const challenge = expectRejected(await verifyBearer(mcpRequest(), depsFor(db)));
    assert.equal(challenge.status, 401, "an unauthenticated MCP request must be 401");
    assertChallengeShape(challenge.wwwAuthenticate);
  } finally {
    await db.close();
  }
});

test("an unknown bearer token returns a 401 Bearer challenge", async () => {
  const db = await freshDb();
  try {
    const challenge = expectRejected(
      await verifyBearer(mcpRequest(`Bearer no-such-token-${randomUUID()}`), depsFor(db)),
    );
    assert.equal(challenge.status, 401);
    assertChallengeShape(challenge.wwwAuthenticate);
  } finally {
    await db.close();
  }
});

test("a non-Bearer Authorization scheme returns a 401 Bearer challenge", async () => {
  const db = await freshDb();
  try {
    // `Basic …` is a credential, but not a Bearer — the protected resource still
    // challenges for a Bearer token.
    const challenge = expectRejected(
      await verifyBearer(mcpRequest("Basic dXNlcjpwYXNz"), depsFor(db)),
    );
    assert.equal(challenge.status, 401);
    assertChallengeShape(challenge.wwwAuthenticate);
  } finally {
    await db.close();
  }
});

test("the challenge's resource_metadata points at the configured metadata URL, not the request host", async () => {
  const db = await freshDb();
  try {
    const challenge = expectRejected(
      await verifyBearer(mcpRequest(), depsFor(db, "https://warthog.example")),
    );
    assert.ok(
      challenge.wwwAuthenticate.includes("https://warthog.example"),
      `resource_metadata must be built from the configured base URL: ${challenge.wwwAuthenticate}`,
    );
    assert.ok(
      challenge.wwwAuthenticate.includes(".well-known/oauth-protected-resource"),
      `resource_metadata must point at the protected-resource metadata document: ${challenge.wwwAuthenticate}`,
    );
    assert.ok(
      !challenge.wwwAuthenticate.includes("request-host.invalid"),
      `the challenge must not echo the request host: ${challenge.wwwAuthenticate}`,
    );
  } finally {
    await db.close();
  }
});

test("the challenge's resource_metadata flows from config (a different base URL yields a different challenge)", async () => {
  const db = await freshDb();
  try {
    const a = expectRejected(await verifyBearer(mcpRequest(), depsFor(db, "https://a.example")));
    const b = expectRejected(await verifyBearer(mcpRequest(), depsFor(db, "https://b.example")));
    assert.ok(a.wwwAuthenticate.includes("https://a.example"));
    assert.ok(b.wwwAuthenticate.includes("https://b.example"));
    assert.notEqual(
      a.wwwAuthenticate,
      b.wwwAuthenticate,
      "a different configured base URL must produce a different resource_metadata URL",
    );
  } finally {
    await db.close();
  }
});

// --- AC2: a valid bearer resolves to its active connection --------------------------

test("a valid access token resolves to the connection it is bound to", async () => {
  const db = await freshDb();
  try {
    const connectionId = randomUUID();
    const token = await seedToken(db, {
      connectionId,
      kind: "access",
      expiresAt: new Date(NOW.getTime() + HOUR_MS),
    });
    const resolved = expectConnection(await verifyBearer(mcpRequest(`Bearer ${token}`), depsFor(db)));
    assert.equal(resolved, connectionId, "a valid token must resolve to its bound connection");
  } finally {
    await db.close();
  }
});

test("an expired access token is rejected with a 401 challenge", async () => {
  const db = await freshDb();
  try {
    const connectionId = randomUUID();
    // Expired one second before the frozen clock: it still resolves by hash, but it is
    // no longer valid, so verification must reject it.
    const token = await seedToken(db, {
      connectionId,
      kind: "access",
      expiresAt: new Date(NOW.getTime() - 1000),
    });
    const challenge = expectRejected(await verifyBearer(mcpRequest(`Bearer ${token}`), depsFor(db)));
    assert.equal(challenge.status, 401);
    assertChallengeShape(challenge.wwwAuthenticate);
  } finally {
    await db.close();
  }
});

test("a refresh token presented as a bearer is not a valid MCP credential and is rejected", async () => {
  const db = await freshDb();
  try {
    const connectionId = randomUUID();
    // A current refresh token (far-future expiry): it resolves, but a refresh token is
    // only for the token endpoint — it must not grant access at the protected resource.
    const refresh = await seedToken(db, {
      connectionId,
      kind: "refresh",
      expiresAt: new Date(NOW.getTime() + 30 * DAY_MS),
    });
    const challenge = expectRejected(
      await verifyBearer(mcpRequest(`Bearer ${refresh}`), depsFor(db)),
    );
    assert.equal(challenge.status, 401);
    assertChallengeShape(challenge.wwwAuthenticate);
  } finally {
    await db.close();
  }
});

test("a valid per-agent access key resolves as a bearer to its connection (design §6.1)", async () => {
  const db = await freshDb();
  try {
    const connectionId = randomUUID();
    const { key } = await issueAccessKey(db, { connectionId }, { random: systemRandom });
    const resolved = expectConnection(await verifyBearer(mcpRequest(`Bearer ${key}`), depsFor(db)));
    assert.equal(resolved, connectionId, "an access key must verify to the connection it binds to");
  } finally {
    await db.close();
  }
});

// --- AC2: a public route needs no bearer --------------------------------------------

test("a public route (the protected-resource metadata) is served with no bearer", async () => {
  // The protected-resource metadata is how an agent discovers HOW to obtain a token, so
  // it MUST be reachable with no Authorization header (INV-101: public routes stay
  // usable with no auth). This is the real, already-built handler — no bearer presented.
  const handler = createProtectedResourceMetadataHandler({
    config: configWithBaseUrl("https://warthog.example"),
  });
  const response = await handler(
    new Request("https://warthog.example/.well-known/oauth-protected-resource"),
  );
  assert.equal(response.status, 200, "a public route must be served with no bearer");
});
