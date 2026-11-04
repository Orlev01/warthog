// E06-S04 — the OAuth 2.1 authorize endpoint and consent binding
// (`src/server/oauth/authorize.ts`; the thin `src/app/oauth/authorize/route.ts`
// wires it to the request/cookie/config).
//
// RED-first: `./authorize` does not exist yet, so importing it throws — every test
// here fails at import until the builder writes the module. That absence IS the
// point of test-first; do not implement anything to make these pass.
//
// These tests pin BEHAVIOUR (what the authorize seam RETURNS and what it STORES),
// never the source text of any module — a later rename that preserves behaviour
// must not redden them. The issued code is proven to bind to the consent's
// connection by reading it back through the already-built OAuth store
// (`getAuthCode`), not by grepping a SQL file.
//
// Seam note: an App-Router `route.ts` may export ONLY the known route keys (the HTTP
// verbs + config); `next build` rejects any other export (OBS-025). So the testable
// logic lives in the SIBLING server module `src/server/oauth/authorize.ts` — which
// the task's Touches already name — and the entry just reads the request's query, the
// `__Host-wh_session` cookie (→ `verifySession`) and `loadConfig()` before delegating.
// Because the session is resolved at the entry, the seam takes an already-resolved
// `Session | null`; "requires a signed-in session" is then testable at the seam by
// passing `null`.
//
// Consent note: the connection a person approves is created by the consent decision
// wired in later (E10-S03), and the connections table itself lands in a later
// migration (E09-S05). At this task `connectionId` is therefore an OPAQUE uuid that
// the caller supplies, and the authorize seam BINDS the issued code to it (the same
// treatment E06-S01's store gives `connection_id`).
//
// The contract this task defines (the builder implements exactly this):
//
//   authorize(input: AuthorizeInput, deps: AuthorizeDeps): Promise<AuthorizeResult>
//     input:  { params: URLSearchParams; session: Session | null; connectionId: string }
//     deps:   { db: Db; config: Config; clock: Clock; random: Random }
//     result: { ok: true;  redirectTo: string; code: string }
//           | { ok: false; ... }        // rejected — no code issued
//
//   On success it mints an opaque authorization code, stores it (addressed ONLY by
//   its SHA-256 hash) bound to the consent's connection together with the PKCE
//   challenge, client, redirect URI, resource and an expiry, and returns a redirect
//   back to the client's redirect URI carrying `code`, the echoed `state` and `iss`
//   (RFC 9207). It rejects a request that is not signed in, that is not PKCE S256, or
//   whose `resource` is not the MCP resource.
//
// Acceptance criteria → tests:
//   AC1 "Requires a signed-in session, PKCE S256 and a resource parameter equal to
//        the MCP resource, and returns the code with iss (RFC 9207)." — a signed-in
//        S256 request with the correct resource is accepted and redirects with code +
//        state + iss; iss is the CONFIGURED issuer (it changes with config, so it is
//        not a fixed or request-derived value).
//   AC2 "A missing or plain PKCE or a wrong resource is rejected; the code binds to
//        the consent's connection." — no session, a missing PKCE challenge, a plain
//        (or omitted-method) PKCE, a missing resource and a non-MCP resource are each
//        rejected with no code issued; a successful code reads back bound to the
//        supplied consent connection, stored only as its hash.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";

import { authorize, type AuthorizeDeps } from "./authorize";
import { createClient, getAuthCode } from "./store";
import { freshDb } from "../../test/db";
import { loadConfig, type Config } from "../config";
import { fixedClock } from "../seams/clock";
import { systemRandom } from "../seams/random";
import type { Db } from "../db/index";
import type { Session } from "../auth/session";

// A realistic consent: a verified platform (claude.ai via CIMD) consenting at the
// founder's public host. The resource is that host's MCP endpoint (design §6.1).
const BASE_URL = "https://warthog.com.au";
const MCP_RESOURCE = "https://warthog.com.au/mcp";
const CLIENT_ID = "https://claude.ai/.well-known/oauth-client";
const REDIRECT_URI = "https://claude.ai/api/mcp/auth_callback";
// A real RFC 7636 S256 code_challenge (base64url of a SHA-256 digest). The authorize
// endpoint binds it verbatim; the token endpoint is what later verifies a verifier.
const CODE_CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
const STATE = "state-7f3a91c0";
// A frozen instant so "expires in the future" is deterministic (never SQL now()).
const NOW = new Date("2026-01-01T00:00:00.000Z");

// The SHA-256 hex digest of a value — how a code is stored (constitution: codes are
// stored only as hashes; design §6.1). Computed here so the test addresses the stored
// row by the same hash the endpoint persists, proving the raw code is never a key.
function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

// A real Config built through the one env seam, with a chosen public base URL (so the
// MCP resource and the issuer both flow from it). A minimal DEVELOPMENT env (pglite is
// allowed in dev) keeps config construction off the real environment.
function configWithBaseUrl(publicBaseUrl: string): Config {
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

function deps(db: Db, base: string = BASE_URL): AuthorizeDeps {
  return { db, config: configWithBaseUrl(base), clock: fixedClock(NOW), random: systemRandom };
}

// A plain signed-in session (the seam only needs it to be non-null; the route is what
// resolves it from the cookie via verifySession). Distinct ids per call.
function signedInSession(): Session {
  return {
    id: randomUUID(),
    userId: randomUUID(),
    createdAt: new Date(NOW.getTime() - 60_000),
    lastSeenAt: new Date(NOW.getTime() - 60_000),
    steppedUpAt: null,
  };
}

// The agent's authorize query. Starts fully valid (signed-in, S256, correct
// resource); each test overrides or deletes (value === null) the one field under
// test, so a rejection isolates to that field.
function authorizeParams(overrides: Record<string, string | null> = {}): URLSearchParams {
  const params: Record<string, string> = {
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    code_challenge: CODE_CHALLENGE,
    code_challenge_method: "S256",
    resource: MCP_RESOURCE,
    state: STATE,
    scope: "warthog",
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === null) delete params[key];
    else params[key] = value;
  }
  return new URLSearchParams(params);
}

// An isolated in-memory db with the consenting client already registered, so the only
// reason a request is rejected is the field a given test is exercising.
async function dbWithClient(): Promise<Db> {
  const db = await freshDb();
  await createClient(db, { clientId: CLIENT_ID, registration: "cimd", redirectUris: [REDIRECT_URI] });
  return db;
}

// --- AC1 / AC2: a valid signed-in S256 request issues a code bound to the connection -

test("a signed-in S256 request with the MCP resource issues a code bound to the consent connection", async () => {
  const db = await dbWithClient();
  try {
    const connectionId = randomUUID();
    const result = await authorize(
      { params: authorizeParams(), session: signedInSession(), connectionId },
      deps(db),
    );

    assert.ok(result.ok, "a valid, signed-in, S256, correct-resource request is accepted");
    if (!result.ok) throw new Error("unreachable: result was not ok");

    assert.ok(result.code.length >= 32, "the code is an opaque, high-entropy value");

    // The code is stored addressed ONLY by its SHA-256 hash, bound to the consent.
    const stored = await getAuthCode(db, sha256Hex(result.code));
    assert.ok(stored != null, "the issued code is persisted, addressed by its SHA-256 hash");
    assert.equal(stored?.connectionId, connectionId, "the code binds to the consent's connection");
    assert.equal(stored?.codeChallenge, CODE_CHALLENGE, "the PKCE S256 challenge is bound to the code");
    assert.equal(stored?.redirectUri, REDIRECT_URI, "the redirect URI is bound to the code");
    assert.equal(stored?.resource, MCP_RESOURCE, "the MCP resource is bound to the code");
    assert.equal(stored?.clientId, CLIENT_ID, "the consenting client is bound to the code");
    assert.ok(stored!.expiresAt.getTime() > NOW.getTime(), "the code expires in the future");

    // The raw code is never a stored key — only its hash resolves it.
    const byRawCode = await getAuthCode(db, result.code);
    assert.equal(byRawCode, null, "the raw code is never stored in plaintext; only its hash resolves");
  } finally {
    await db.close();
  }
});

test("the authorization response redirects to the client with code, state and iss (RFC 9207)", async () => {
  const db = await dbWithClient();
  try {
    const result = await authorize(
      { params: authorizeParams(), session: signedInSession(), connectionId: randomUUID() },
      deps(db),
    );
    assert.ok(result.ok, "the request is accepted");
    if (!result.ok) throw new Error("unreachable: result was not ok");

    const url = new URL(result.redirectTo);
    assert.equal(
      `${url.origin}${url.pathname}`,
      REDIRECT_URI,
      "the response redirects back to the consenting client's redirect URI",
    );
    assert.equal(url.searchParams.get("code"), result.code, "the redirect carries the issued code");
    assert.equal(url.searchParams.get("state"), STATE, "the redirect echoes the request's state");
    assert.equal(url.searchParams.get("iss"), BASE_URL, "the redirect carries iss = the issuer (RFC 9207)");
  } finally {
    await db.close();
  }
});

test("iss is the configured issuer — it changes with config, not a fixed or request value", async () => {
  const dbA = await freshDb();
  const dbB = await freshDb();
  try {
    for (const db of [dbA, dbB]) {
      await createClient(db, { clientId: CLIENT_ID, registration: "cimd", redirectUris: [REDIRECT_URI] });
    }

    const resultA = await authorize(
      { params: authorizeParams({ resource: "https://a.example/mcp" }), session: signedInSession(), connectionId: randomUUID() },
      deps(dbA, "https://a.example"),
    );
    const resultB = await authorize(
      { params: authorizeParams({ resource: "https://b.example/mcp" }), session: signedInSession(), connectionId: randomUUID() },
      deps(dbB, "https://b.example"),
    );

    assert.ok(resultA.ok && resultB.ok, "both correct-resource requests are accepted");
    if (!resultA.ok || !resultB.ok) throw new Error("unreachable: a result was not ok");

    assert.equal(new URL(resultA.redirectTo).searchParams.get("iss"), "https://a.example");
    assert.equal(new URL(resultB.redirectTo).searchParams.get("iss"), "https://b.example");
  } finally {
    await dbA.close();
    await dbB.close();
  }
});

// --- AC2: rejections -----------------------------------------------------------------

test("an unauthenticated request (no signed-in session) is rejected", async () => {
  const db = await dbWithClient();
  try {
    const result = await authorize(
      { params: authorizeParams(), session: null, connectionId: randomUUID() },
      deps(db),
    );
    assert.equal(result.ok, false, "with no signed-in session the request must be rejected");
  } finally {
    await db.close();
  }
});

test("a request with no PKCE code_challenge is rejected", async () => {
  const db = await dbWithClient();
  try {
    const result = await authorize(
      { params: authorizeParams({ code_challenge: null }), session: signedInSession(), connectionId: randomUUID() },
      deps(db),
    );
    assert.equal(result.ok, false, "a request without a PKCE challenge must be rejected");
  } finally {
    await db.close();
  }
});

test("a non-S256 PKCE request (plain, or an omitted method) is rejected — S256 only", async () => {
  const db = await dbWithClient();
  try {
    const plain = await authorize(
      { params: authorizeParams({ code_challenge_method: "plain" }), session: signedInSession(), connectionId: randomUUID() },
      deps(db),
    );
    assert.equal(plain.ok, false, "a plain PKCE method must be rejected");

    // An omitted method defaults to plain under RFC 7636, which is also forbidden:
    // S256 must be requested explicitly.
    const omitted = await authorize(
      { params: authorizeParams({ code_challenge_method: null }), session: signedInSession(), connectionId: randomUUID() },
      deps(db),
    );
    assert.equal(omitted.ok, false, "an omitted PKCE method must be rejected (it is not S256)");
  } finally {
    await db.close();
  }
});

test("a request with no resource parameter is rejected", async () => {
  const db = await dbWithClient();
  try {
    const result = await authorize(
      { params: authorizeParams({ resource: null }), session: signedInSession(), connectionId: randomUUID() },
      deps(db),
    );
    assert.equal(result.ok, false, "the resource parameter is required");
  } finally {
    await db.close();
  }
});

test("a request whose resource is not the MCP resource is rejected", async () => {
  const db = await dbWithClient();
  try {
    // The issuer itself, without the `/mcp` path — not the protected resource.
    const wrongPath = await authorize(
      { params: authorizeParams({ resource: BASE_URL }), session: signedInSession(), connectionId: randomUUID() },
      deps(db),
    );
    assert.equal(wrongPath.ok, false, "a resource that is not exactly the MCP resource must be rejected");

    // A different host's MCP endpoint is not this server's resource.
    const wrongHost = await authorize(
      { params: authorizeParams({ resource: "https://evil.example/mcp" }), session: signedInSession(), connectionId: randomUUID() },
      deps(db),
    );
    assert.equal(wrongHost.ok, false, "another host's resource must be rejected");
  } finally {
    await db.close();
  }
});
