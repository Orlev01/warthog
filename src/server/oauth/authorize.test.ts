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

// ─── E10-S12 BEHAVIOUR SUPERSESSION (consent before code) ─────────────────────────────
//
// Until E10-S12 the `/oauth/authorize` route called `authorize()` directly and redirected
// a signed-in, valid request straight back to the client with a code — no consent, no
// agent row — so an OAuth-connected agent then got "This agent is not connected." on every
// tool call. E10-S12 moves consent FIRST: a signed-in, valid authorize request now goes to
// the consent screen, and the code is only minted once the person APPROVES (the consent
// decision action, E10-S03, still issues it through `authorize()` bound to the connection it
// creates).
//
// So this file keeps TWO contracts, and neither invalidates the other:
//   • `authorize()` — UNCHANGED. It is still the code-issuer, now called by the APPROVE
//     decision (post-consent). Every existing test below still characterizes it exactly.
//   • `beginAuthorization()` — NEW. The seam the thin GET route now delegates to: it
//     enforces the SAME rules (signed in, PKCE S256, matching resource) but, on success,
//     CARRIES the authorize request SERVER-SIDE (the pending-authorization store) and
//     returns a redirect to the internal `/oauth/consent` screen — it mints NO code and
//     sends nothing to the client. The route puts the returned opaque handle in a
//     host-locked cookie (never a URL/form field) so the consent page and the decision read
//     it server-side.
//
// The new section at the foot of this file pins `beginAuthorization`. It proves the request
// is carried server-side by reading it back through the already-built pending store
// (`getPendingAuthorization`), never by grepping a module — behaviour, not source text.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";

import { authorize, beginAuthorization, type AuthorizeDeps } from "./authorize";
import { getPendingAuthorization } from "./pending";
import { createClient, getAuthCode } from "./store";
import { createClientResolver } from "./clients";
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

// Review fix A1: the seams now include the client resolver. Tests resolve clients from the
// test database only — a CIMD fetch is never made (no network in tests); the CIMD path is
// exercised with an injected fake document where a test needs it.
async function noCimd(clientId: string): Promise<Record<string, unknown>> {
  throw new Error(`no CIMD fetch in tests (${clientId})`);
}

function deps(
  db: Db,
  base: string = BASE_URL,
  fetchCimd: (clientId: string) => Promise<Record<string, unknown>> = noCimd,
): AuthorizeDeps {
  return {
    db,
    config: configWithBaseUrl(base),
    clock: fixedClock(NOW),
    random: systemRandom,
    resolveClient: createClientResolver({ db, fetchCimd }),
  };
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

// =====================================================================================
// E10-S12 — beginAuthorization: a signed-in VALID request now goes to CONSENT first.
//
// The thin GET `/oauth/authorize` route delegates to this seam instead of issuing a code
// outright. On success it CARRIES the authorize request server-side (the pending store)
// and returns a redirect to the internal `/oauth/consent` screen with an opaque handle
// (the route stores the handle in a host-locked cookie — never a URL/form field). It
// mints NO code and sends nothing back to the client; the code is issued only after the
// person approves (the decision calls `authorize()` above). It enforces the SAME rules as
// `authorize()` and rejects with the SAME error vocabulary, so the route maps
// `login_required` → the sign-in page and every other rejection → a 4xx.
//
//   beginAuthorization(
//     { params: URLSearchParams; session: Session | null },
//     AuthorizeDeps,
//   ): Promise<{ ok: true; handle: string; redirectTo: string } | { ok: false; error: string }>
// =====================================================================================

test("a signed-in, valid request is carried to the consent screen — no code is issued", async () => {
  const db = await dbWithClient();
  try {
    const result = await beginAuthorization(
      { params: authorizeParams(), session: signedInSession() },
      deps(db),
    );

    assert.ok(result.ok, "a signed-in, S256, correct-resource request begins the consent flow");
    if (!result.ok) throw new Error("unreachable: beginAuthorization was not ok");

    // It redirects to the INTERNAL consent screen — never back to the client — and the
    // target carries no authorization code (consent must happen before a code exists).
    assert.equal(result.redirectTo, "/oauth/consent", "a valid request is sent to the consent screen");
    assert.notEqual(result.redirectTo, REDIRECT_URI, "a valid request is NOT redirected to the client yet");
    assert.ok(
      result.handle.length >= 32,
      "the pending request is referenced by an opaque, high-entropy handle (for a host-locked cookie)",
    );
  } finally {
    await db.close();
  }
});

test("beginAuthorization carries the authorize request SERVER-SIDE under its handle", async () => {
  const db = await dbWithClient();
  try {
    const begun = await beginAuthorization(
      { params: authorizeParams(), session: signedInSession() },
      deps(db),
    );
    assert.ok(begun.ok, "the request begins consent");
    if (!begun.ok) throw new Error("unreachable: beginAuthorization was not ok");

    // The request is held server-side and read back WHOLE through the pending store — the
    // consent page and the decision read it from here, never trusting a form/URL field.
    const pending = getPendingAuthorization(begun.handle);
    assert.ok(pending != null, "the authorize request is held server-side under its handle");
    assert.equal(pending!.params.get("client_id"), CLIENT_ID, "the consenting client is carried through");
    assert.equal(pending!.params.get("redirect_uri"), REDIRECT_URI, "the client's redirect URI is carried through");
    assert.equal(pending!.params.get("code_challenge"), CODE_CHALLENGE, "the PKCE S256 challenge is carried through");
    assert.equal(pending!.params.get("code_challenge_method"), "S256", "the PKCE method is carried through");
    assert.equal(pending!.params.get("resource"), MCP_RESOURCE, "the MCP resource is carried through");
    assert.equal(pending!.params.get("state"), STATE, "the state is carried through for the final redirect");

    // The handle is unguessable: a different handle resolves to nothing.
    assert.equal(getPendingAuthorization("some-other-handle"), null, "a wrong handle resolves to no request");
  } finally {
    await db.close();
  }
});

test("beginAuthorization rejects an unauthenticated request with login_required (the route sends it to sign in)", async () => {
  const db = await dbWithClient();
  try {
    const result = await beginAuthorization(
      { params: authorizeParams(), session: null },
      deps(db),
    );
    assert.equal(result.ok, false, "with no signed-in session the consent flow must not begin");
    if (result.ok) throw new Error("unreachable: an unauthenticated begin was accepted");
    assert.equal(result.error, "login_required", "an unauthenticated begin names login_required");
  } finally {
    await db.close();
  }
});

test("beginAuthorization rejects a malformed request (bad PKCE / wrong resource) before consent", async () => {
  const db = await dbWithClient();
  try {
    const noPkce = await beginAuthorization(
      { params: authorizeParams({ code_challenge: null }), session: signedInSession() },
      deps(db),
    );
    assert.equal(noPkce.ok, false, "a request without a PKCE challenge never reaches consent");
    if (!noPkce.ok) assert.equal(noPkce.error, "invalid_request", "a missing PKCE challenge is an invalid_request");

    const plain = await beginAuthorization(
      { params: authorizeParams({ code_challenge_method: "plain" }), session: signedInSession() },
      deps(db),
    );
    assert.equal(plain.ok, false, "a non-S256 PKCE request never reaches consent");
    if (!plain.ok) assert.equal(plain.error, "invalid_request", "a plain PKCE method is an invalid_request");

    const wrongResource = await beginAuthorization(
      { params: authorizeParams({ resource: "https://evil.example/mcp" }), session: signedInSession() },
      deps(db),
    );
    assert.equal(wrongResource.ok, false, "a wrong-resource request never reaches consent");
    if (!wrongResource.ok) assert.equal(wrongResource.error, "invalid_target", "a wrong resource is an invalid_target");
  } finally {
    await db.close();
  }
});

// =====================================================================================
// Review fix A1 — the client and its redirect URI are ENFORCED, not just present.
//
// Until this fix `validateAuthorizeRequest` only checked that client_id and redirect_uri
// were non-empty: an unregistered client with any redirect URI — including
// `javascript:` — reached the consent screen, and Refuse/Approve then redirected to it
// (script on the Warthog origin, or a code delivered to any host). Now the client must
// resolve (a DCR row, or a CIMD document fetched through the guarded fetcher), the
// redirect URI must EXACTLY equal one the client registered, and it must also pass the
// shared redirect rule (https, or http on localhost / 127.0.0.1). `response_type` must be
// `code`. Both seams share the validator, so the approve path re-checks after consent.
// =====================================================================================

test("beginAuthorization rejects an unregistered client_id with invalid_client", async () => {
  const db = await dbWithClient();
  try {
    const result = await beginAuthorization(
      {
        params: authorizeParams({ client_id: "never-registered-client", redirect_uri: "https://attacker.example/cb" }),
        session: signedInSession(),
      },
      deps(db),
    );
    assert.equal(result.ok, false, "an unknown client never reaches consent");
    if (!result.ok) assert.equal(result.error, "invalid_client");
  } finally {
    await db.close();
  }
});

test("beginAuthorization rejects a redirect_uri the client did not register (exact match only)", async () => {
  const db = await dbWithClient();
  try {
    for (const redirectUri of [
      "https://claude.ai/other",
      "https://attacker.example/cb",
      `${REDIRECT_URI}/`,
      `${REDIRECT_URI}?x=1`,
      "https://CLAUDE.ai/api/mcp/auth_callback",
    ]) {
      const result = await beginAuthorization(
        { params: authorizeParams({ redirect_uri: redirectUri }), session: signedInSession() },
        deps(db),
      );
      assert.equal(result.ok, false, `an unregistered redirect URI is refused: ${redirectUri}`);
      if (!result.ok) assert.equal(result.error, "invalid_request");
    }
  } finally {
    await db.close();
  }
});

test("a javascript:, data: or plain-http redirect is refused even when it is in the client's registration", async () => {
  const db = await freshDb();
  try {
    const hostile = [
      "javascript:alert(1)//",
      "javascript://claude.ai/%0aalert(1)//",
      "data:text/html,x",
      "http://evil.example/cb",
    ];
    // A row planted straight into the store (bypassing /oauth/register's own check), so the
    // scheme rule at authorize is proven to hold on its own.
    await createClient(db, { clientId: "planted-client", registration: "dcr", redirectUris: hostile });
    for (const redirectUri of hostile) {
      const begun = await beginAuthorization(
        { params: authorizeParams({ client_id: "planted-client", redirect_uri: redirectUri }), session: signedInSession() },
        deps(db),
      );
      assert.equal(begun.ok, false, `begin refuses ${redirectUri}`);
      if (!begun.ok) assert.equal(begun.error, "invalid_request");

      const issued = await authorize(
        {
          params: authorizeParams({ client_id: "planted-client", redirect_uri: redirectUri }),
          session: signedInSession(),
          connectionId: randomUUID(),
        },
        deps(db),
      );
      assert.equal(issued.ok, false, `authorize issues no code for ${redirectUri}`);
    }
  } finally {
    await db.close();
  }
});

test("http on localhost / 127.0.0.1 is accepted for a client that registered it", async () => {
  const db = await freshDb();
  try {
    const local = ["http://localhost:8976/callback", "http://127.0.0.1:33418/cb"];
    await createClient(db, { clientId: "local-client", registration: "dcr", redirectUris: local });
    for (const redirectUri of local) {
      const begun = await beginAuthorization(
        { params: authorizeParams({ client_id: "local-client", redirect_uri: redirectUri }), session: signedInSession() },
        deps(db),
      );
      assert.ok(begun.ok, `a registered loopback redirect is accepted: ${redirectUri}`);
    }
  } finally {
    await db.close();
  }
});

test("response_type must be code", async () => {
  const db = await dbWithClient();
  try {
    for (const responseType of [null, "token", "code id_token"]) {
      const result = await beginAuthorization(
        { params: authorizeParams({ response_type: responseType }), session: signedInSession() },
        deps(db),
      );
      assert.equal(result.ok, false, `response_type ${String(responseType)} is refused`);
      if (!result.ok) assert.equal(result.error, "unsupported_response_type");
    }
  } finally {
    await db.close();
  }
});

test("authorize (the approve path) re-checks the client: an unknown client is issued no code", async () => {
  const db = await freshDb();
  try {
    const result = await authorize(
      { params: authorizeParams(), session: signedInSession(), connectionId: randomUUID() },
      deps(db),
    );
    assert.equal(result.ok, false, "with no registration for the client, no code is issued");
    if (!result.ok) assert.equal(result.error, "invalid_client");
  } finally {
    await db.close();
  }
});

test("a CIMD client is resolved from its metadata document and its redirect URIs enforced", async () => {
  const db = await freshDb();
  try {
    const cimd = async (clientId: string) => ({ client_id: clientId, redirect_uris: [REDIRECT_URI] });
    const ok = await beginAuthorization(
      { params: authorizeParams(), session: signedInSession() },
      deps(db, BASE_URL, cimd),
    );
    assert.ok(ok.ok, "a CIMD client whose document lists the redirect URI begins consent");

    const wrongRedirect = await beginAuthorization(
      { params: authorizeParams({ redirect_uri: "https://claude.ai/elsewhere" }), session: signedInSession() },
      deps(db, BASE_URL, cimd),
    );
    assert.equal(wrongRedirect.ok, false, "a redirect URI the document does not list is refused");

    const impostor = async () => ({ client_id: "https://evil.example/client", redirect_uris: [REDIRECT_URI] });
    const mismatched = await beginAuthorization(
      { params: authorizeParams(), session: signedInSession() },
      deps(db, BASE_URL, impostor),
    );
    assert.equal(mismatched.ok, false, "a document naming another client_id is refused");
    if (!mismatched.ok) assert.equal(mismatched.error, "invalid_client");
  } finally {
    await db.close();
  }
});

// Review fix A4 — only a VALID request is bounced through sign-in. A malformed or unknown-
// client request with no session is a 400 at once (never a sign-in round trip that comes
// back to an error), so login_required means "valid, just signed out".
test("a signed-out request that is malformed is rejected as malformed, not sent to sign in", async () => {
  const db = await dbWithClient();
  try {
    const plain = await beginAuthorization(
      { params: authorizeParams({ code_challenge_method: "plain" }), session: null },
      deps(db),
    );
    assert.equal(plain.ok, false);
    if (!plain.ok) assert.equal(plain.error, "invalid_request", "bad PKCE with no session is invalid_request");

    const unknown = await beginAuthorization(
      { params: authorizeParams({ client_id: "never-registered-client" }), session: null },
      deps(db),
    );
    assert.equal(unknown.ok, false);
    if (!unknown.ok) assert.equal(unknown.error, "invalid_client", "an unknown client with no session is invalid_client");

    const valid = await beginAuthorization({ params: authorizeParams(), session: null }, deps(db));
    assert.equal(valid.ok, false);
    if (!valid.ok) assert.equal(valid.error, "login_required", "a valid request with no session needs sign-in");
  } finally {
    await db.close();
  }
});
