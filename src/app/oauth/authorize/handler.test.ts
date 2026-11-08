// Review fixes A1 + A4 — the GET `/oauth/authorize` handler (`./handler`, which the thin
// `route.ts` wires to the real db/config/clock/random/client resolver).
//
// A1: a request that fails validation — an unknown client, an unregistered or hostile
//     redirect URI — is answered with a 400 page from Warthog itself: no Location header
//     (never a redirect to an unvalidated URI) and no consent cookie.
// A4: a VALID request from a signed-out browser is sent to sign-in carrying a relative
//     return path (`/signin?next=/oauth/authorize?…`), so the agent's connection resumes
//     after sign-in instead of stranding the person on Home. A signed-in valid request
//     still goes to the consent screen with the host-locked pending-handle cookie.

import { test } from "node:test";
import assert from "node:assert/strict";

import { createAuthorizeHandler } from "./handler";
import { createClient } from "../../../server/oauth/store";
import { createClientResolver } from "../../../server/oauth/clients";
import { getPendingAuthorization } from "../../../server/oauth/pending";
import { createSession } from "../../../server/auth/session";
import { createUser } from "../../../server/db/users";
import { loadConfig, type Config } from "../../../server/config";
import { fixedClock } from "../../../server/seams/clock";
import { systemRandom } from "../../../server/seams/random";
import { freshDb } from "../../../test/db";
import type { Db } from "../../../server/db/index";

const BASE_URL = "https://warthog.com.au";
const MCP_RESOURCE = "https://warthog.com.au/mcp";
const CLIENT_ID = "8a3e7f0c-0b5e-4f7e-9d0a-5f0c1e2d3b4a";
const REDIRECT_URI = "https://claude.ai/api/mcp/auth_callback";
const CODE_CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
const NOW = new Date("2026-06-01T00:00:00.000Z");

function config(): Config {
  return loadConfig({
    NODE_ENV: "development",
    PUBLIC_BASE_URL: BASE_URL,
    WEBAUTHN_RP_ID: "localhost",
    DATABASE_URL: "pglite:memory",
    WARTHOG_HMAC_KEY: "ERERERERERERERERERERERERERERERERERERERERERE=",
    WARTHOG_DEV_KEK: "IiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiI=",
  } as NodeJS.ProcessEnv);
}

function handlerFor(db: Db) {
  return createAuthorizeHandler({
    db,
    config: config(),
    clock: fixedClock(NOW),
    random: systemRandom,
    resolveClient: createClientResolver({
      db,
      fetchCimd: async (clientId) => {
        throw new Error(`no CIMD fetch in tests (${clientId})`);
      },
    }),
  });
}

function authorizeQuery(overrides: Record<string, string> = {}): string {
  return new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    code_challenge: CODE_CHALLENGE,
    code_challenge_method: "S256",
    resource: MCP_RESOURCE,
    state: "s-1",
    ...overrides,
  }).toString();
}

function get(query: string, cookie?: string): Request {
  return new Request(`${BASE_URL}/oauth/authorize?${query}`, {
    headers: cookie ? { cookie } : {},
  });
}

async function dbWithClient(): Promise<Db> {
  const db = await freshDb();
  await createClient(db, { clientId: CLIENT_ID, registration: "dcr", redirectUris: [REDIRECT_URI] });
  return db;
}

async function signedInCookie(db: Db): Promise<string> {
  return (await signedIn(db)).cookie;
}

// A signed-in person: their id and their session cookie.
async function signedIn(db: Db): Promise<{ userId: string; cookie: string }> {
  const user = await createUser(db, { email: "authorize-route@warthog.com.au", wrappedDek: "d3JhcHBlZA==" });
  const created = await createSession(db, user.id, { clock: fixedClock(NOW), random: systemRandom });
  return { userId: user.id, cookie: `__Host-wh_session=${created.token}` };
}

test("a signed-out valid request is sent to sign in with a relative return path to the same authorize request", async () => {
  const db = await dbWithClient();
  try {
    const query = authorizeQuery();
    const res = await handlerFor(db)(get(query));
    assert.equal(res.status, 302);
    const location = res.headers.get("location") ?? "";
    assert.ok(location.startsWith("/signin?next="), `goes to sign-in, got: ${location}`);
    const next = new URL(location, BASE_URL).searchParams.get("next");
    assert.equal(next, `/oauth/authorize?${query}`, "next is the original authorize path and query");
    assert.ok(next!.startsWith("/") && !next!.startsWith("//"), "next is a relative, same-origin path");
    assert.equal(res.headers.get("set-cookie"), null, "nothing is held for a signed-out request");
  } finally {
    await db.close();
  }
});

test("a signed-in valid request goes to the consent screen with the pending-handle cookie", async () => {
  const db = await dbWithClient();
  try {
    const person = await signedIn(db);
    const res = await handlerFor(db)(get(authorizeQuery(), person.cookie));
    assert.equal(res.status, 302);
    assert.equal(res.headers.get("location"), "/oauth/consent");
    const cookie = res.headers.get("set-cookie") ?? "";
    const match = /^__Host-wh_consent=([0-9a-f]+);/.exec(cookie);
    assert.ok(match, `a host-locked consent cookie is set, got: ${cookie}`);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /Secure/);
    assert.ok(getPendingAuthorization(match![1]!, person.userId) != null, "the cookie names the signed-in person's pending request");
  } finally {
    await db.close();
  }
});

test("an unknown client or an unregistered / hostile redirect gets a 400 page — never a redirect", async () => {
  const db = await dbWithClient();
  try {
    const cookie = await signedInCookie(db);
    const cases = [
      authorizeQuery({ client_id: "never-registered-client" }),
      authorizeQuery({ redirect_uri: "https://attacker.example/cb" }),
      authorizeQuery({ redirect_uri: "javascript:alert(document.domain)//" }),
      authorizeQuery({ code_challenge_method: "plain" }),
    ];
    for (const query of cases) {
      for (const withSession of [true, false]) {
        const res = await handlerFor(db)(get(query, withSession ? cookie : undefined));
        assert.equal(res.status, 400, `400 for ${query} (signed in: ${withSession})`);
        assert.equal(res.headers.get("location"), null, "no Location header — nothing is redirected");
        assert.equal(res.headers.get("set-cookie"), null, "no consent cookie is set");
        const body = await res.text();
        assert.ok(!body.includes("javascript:"), "the page never echoes the hostile redirect");
        assert.match(res.headers.get("content-type") ?? "", /text\/html/);
      }
    }
  } finally {
    await db.close();
  }
});
