// E10-S12 — Consent page loader (`src/app/oauth/consent/actions.ts`, the SIBLING seam the
// thin `src/app/oauth/consent/page.tsx` entry mounts).
//
// RED-first: the consent loader seam does not exist yet, so importing `./actions` throws
// (ERR_MODULE_NOT_FOUND) and every test here fails until the builder adds it. That absence
// IS the point of test-first — do NOT implement anything to make these pass.
//
// WHY this exists (brief "Agent consent screen"; design §6.1): after a signed-in person's
// valid authorize request is carried to the consent screen (`beginAuthorization`, which
// stores the request SERVER-SIDE under an opaque handle the route puts in a host-locked
// cookie), the consent page must render it — naming the connecting platform, showing a
// "Verified platform" badge for a KNOWN platform callback and the host prominently for any
// other, and offering the permission choices. This loader turns the server-side pending
// request (resolved by its handle, NEVER trusted from a form/URL field) into the
// prop-driven <ConsentView>'s props (E10-S02). A route/page entry may export only its
// framework fields (OBS-025), so the loader lives in this sibling module and the page stays
// thin over it.
//
// These tests pin BEHAVIOUR — what the loader RETURNS for a given pending request — never
// the source text of any module, so a later behaviour-preserving refactor (a reworded
// label, a different known-platform data source) stays green. The pending request is seeded
// through the REAL `beginAuthorization` seam (the same server-side store the live route
// writes), so the loader is exercised exactly as the running page drives it.
//
// ─── The contract this task defines (the builder implements exactly this) ─────────────
//
//   loadConsentView(handle: string): Promise<ConsentViewProps | null>
//
//   • resolves the pending authorize request held server-side under `handle`;
//   • returns the <ConsentView> props — the connecting `platform` name, the `redirect`
//     { host, verified } (verified === the callback host is a KNOWN platform: claude.ai,
//     claude.com, chatgpt.com, Google's oauth-redirect — EXACT host, never a look-alike),
//     a valid starting-set `template`, and the plain-words `requestedScopes`;
//   • returns `null` when the handle resolves to nothing (unknown or already consumed), so
//     the page shows an expired-request message rather than crashing.

import { test } from "node:test";
import assert from "node:assert/strict";

import { loadConsentView } from "./actions";
import { beginAuthorization } from "../../../server/oauth/authorize";
import { putPendingAuthorization } from "../../../server/oauth/pending";

import { loadConfig, type Config } from "../../../server/config";
import { fixedClock } from "../../../server/seams/clock";
import { systemRandom } from "../../../server/seams/random";
import { freshDb } from "../../../test/db";
import type { Db } from "../../../server/db/index";
import type { Session } from "../../../server/auth/session";

const BASE_URL = "https://warthog.com.au";
const MCP_RESOURCE = "https://warthog.com.au/mcp";
const CLIENT_ID = "https://claude.ai/.well-known/oauth-client";
const CODE_CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
const STATE = "state-7f3a91c0";
const NOW = new Date("2026-06-01T00:00:00.000Z");

const VALID_TEMPLATES = ["minimal", "standard", "custom"] as const;

function configWithBaseUrl(publicBaseUrl: string): Config {
  return loadConfig({
    NODE_ENV: "development",
    PUBLIC_BASE_URL: publicBaseUrl,
    WEBAUTHN_RP_ID: "localhost",
    DATABASE_URL: "pglite:memory",
    WARTHOG_HMAC_KEY: "ERERERERERERERERERERERERERERERERERERERERERE=",
    WARTHOG_DEV_KEK: "IiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiI=",
  } as NodeJS.ProcessEnv);
}

// The signed-in person who begins (and so owns) every seeded request, and who views it.
const SESSION_USER = "user-consent";

// A signed-in session (the loader only needs the request to have begun; begin validates it).
function signedInSession(): Session {
  return {
    id: "sess-consent",
    userId: SESSION_USER,
    createdAt: new Date(NOW.getTime() - 60_000),
    lastSeenAt: new Date(NOW.getTime() - 60_000),
    steppedUpAt: null,
  };
}

// The authorize query the consent screen carries through — valid S256 for this server's MCP
// resource — with the client's callback redirect_uri chosen per test (the only variable, so
// the verified-platform decision isolates to the callback host).
function authorizeParams(redirectUri: string): URLSearchParams {
  return new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: redirectUri,
    code_challenge: CODE_CHALLENGE,
    code_challenge_method: "S256",
    resource: MCP_RESOURCE,
    state: STATE,
    scope: "warthog",
  });
}

// Seed a real pending request SERVER-SIDE (the way the GET route does) and return its handle.
async function seedPending(db: Db, redirectUri: string): Promise<string> {
  const begun = await beginAuthorization(
    { params: authorizeParams(redirectUri), session: signedInSession() },
    {
      db,
      config: configWithBaseUrl(BASE_URL),
      clock: fixedClock(NOW),
      random: systemRandom,
      // Review fix A1: authorize now enforces the client's registered redirect URIs, so the
      // seeded client registers exactly the callback under test.
      resolveClient: async (clientId) =>
        clientId === CLIENT_ID ? { clientId, registration: "cimd", redirectUris: [redirectUri] } : null,
    },
  );
  assert.ok(begun.ok, "seeding the pending authorize request must succeed");
  if (!begun.ok) throw new Error("unreachable: beginAuthorization failed to seed");
  return begun.handle;
}

// =====================================================================================
// A known platform callback → the consent view names the platform and marks it verified.
// =====================================================================================

test("renders the consent view for a valid pending request, with the client's callback host", async () => {
  const db = await freshDb();
  try {
    const props = await loadConsentView(await seedPending(db, "https://claude.ai/api/mcp/auth_callback"), SESSION_USER);

    assert.ok(props != null, "a valid pending request renders the consent view");
    assert.equal(props!.redirect.host, "claude.ai", "the redirect shows the client's callback host");
    assert.ok(props!.platform.length > 0, "the connecting platform is named on the screen");
    assert.ok(
      (VALID_TEMPLATES as readonly string[]).includes(props!.template),
      `a valid starting set is preselected, got: ${props!.template}`,
    );
    assert.ok(
      Array.isArray(props!.requestedScopes) && props!.requestedScopes.length > 0,
      "what the agent asks for is shown in plain words",
    );
  } finally {
    await db.close();
  }
});

test("a known platform callback is marked verified (the Verified-platform badge)", async () => {
  const db = await freshDb();
  try {
    for (const host of ["claude.ai", "claude.com", "chatgpt.com"]) {
      const props = await loadConsentView(await seedPending(db, `https://${host}/callback`), SESSION_USER);
      assert.ok(props != null, `${host}: a valid pending request renders`);
      assert.equal(props!.redirect.host, host, `${host}: the callback host is shown`);
      assert.equal(props!.redirect.verified, true, `${host}: a known platform callback is verified`);
    }
  } finally {
    await db.close();
  }
});

// =====================================================================================
// Any other callback host → NOT verified (shown prominently, never a silent trust); a
// look-alike host that a naive suffix/substring check would accept is NOT verified either.
// =====================================================================================

test("an unknown redirect host is not verified", async () => {
  const db = await freshDb();
  try {
    const props = await loadConsentView(await seedPending(db, "https://relay.some-unknown-agent.example/cb"), SESSION_USER);
    assert.ok(props != null, "a valid pending request still renders");
    assert.equal(props!.redirect.host, "relay.some-unknown-agent.example", "the unknown host is shown");
    assert.equal(props!.redirect.verified, false, "an unknown platform callback is NOT marked verified");
  } finally {
    await db.close();
  }
});

test("a look-alike host (ending in a known host) is NOT verified — the match is exact", async () => {
  const db = await freshDb();
  try {
    // `evil-claude.ai` ends with `claude.ai`, so a naive `endsWith`/substring check would
    // wrongly trust it. The known-platform check must be an EXACT host match.
    const props = await loadConsentView(await seedPending(db, "https://evil-claude.ai/callback"), SESSION_USER);
    assert.ok(props != null, "a valid pending request still renders");
    assert.equal(props!.redirect.host, "evil-claude.ai", "the look-alike host is shown");
    assert.equal(props!.redirect.verified, false, "a look-alike of a known host must NOT be verified");
  } finally {
    await db.close();
  }
});

// =====================================================================================
// An unknown / already-consumed handle resolves to nothing — the page shows an expired
// message, never a crash.
// =====================================================================================

test("an unresolvable handle renders no consent view (null)", async () => {
  const props = await loadConsentView("no-such-pending-handle", SESSION_USER);
  assert.equal(props, null, "an unknown/expired pending handle renders no consent view");
});

// Rendering the consent view must NOT consume the one-time pending request — the page
// renders first and the person approves afterwards, so the decision must still find it.
test("loading the consent view does not consume the pending request", async () => {
  const db = await freshDb();
  try {
    const handle = await seedPending(db, "https://claude.ai/api/mcp/auth_callback");

    const first = await loadConsentView(handle, SESSION_USER);
    assert.ok(first != null, "the consent view renders the pending request");

    const second = await loadConsentView(handle, SESSION_USER);
    assert.ok(second != null, "the pending request is still present after rendering (render is non-consuming)");
  } finally {
    await db.close();
  }
});

// =====================================================================================
// Review fix A1 (defence in depth) — even if a pending request with a hostile redirect
// were ever held, the consent view never renders it and never marks it verified. Planted
// straight into the pending store, because `beginAuthorization` itself now refuses them.
// =====================================================================================

test("a pending request with a javascript:, data: or plain-http redirect renders no consent view", async () => {
  for (const redirectUri of [
    "javascript://claude.ai/%0aalert(1)//",
    "javascript:alert(document.domain)//",
    "data:text/html,x",
    "http://claude.ai/api/mcp/auth_callback",
  ]) {
    const handle = putPendingAuthorization(authorizeParams(redirectUri), SESSION_USER, systemRandom);
    assert.equal(await loadConsentView(handle, SESSION_USER), null, `no consent view for ${redirectUri}`);
  }
});

test("a known host on a non-default port is shown but not marked verified", async () => {
  const handle = putPendingAuthorization(authorizeParams("https://claude.ai:8443/api/mcp/auth_callback"), SESSION_USER, systemRandom);
  const props = await loadConsentView(handle, SESSION_USER);
  assert.ok(props != null, "an https callback on another port still renders");
  assert.equal(props!.redirect.verified, false, "only the platform's default https origin earns the badge");
});

// Review fix W3.4 — the consent screen renders a pending request only for the person who
// started it: someone else signed in on the same browser sees the expired notice instead.
test("another signed-in person gets no consent view for someone's pending request", async () => {
  const db = await freshDb();
  try {
    const handle = await seedPending(db, "https://claude.ai/api/mcp/auth_callback");
    assert.equal(await loadConsentView(handle, "someone-else"), null, "a different person sees nothing");
    assert.ok((await loadConsentView(handle, SESSION_USER)) != null, "the person who started it still sees it");
  } finally {
    await db.close();
  }
});
