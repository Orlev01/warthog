// E12-S14 — the single-use approval-link route, the obligation acceptance criteria
// (`src/app/a/[token]/route.ts` + its sibling `handler.ts`; INV-101 admin-auth-required,
// INV-102 validate-and-parameterize-input, INV-103 secrets-from-env).
//
// RED-first: `./handler` (`createApprovalLinkHandler`) does not exist yet, so importing
// it throws and every test here fails until the builder writes the module. That absence
// IS the point of test-first — do NOT implement anything to make these pass.
//
// These tests pin BEHAVIOUR, never source text. They use the SAME
// `createApprovalLinkHandler({ db, clock, config })` contract documented in the sibling
// `route.test.ts`: the session boundary runs the REAL `verifySession` over an isolated
// in-memory PGlite seeded through the real stores, and the public-route half reuses the
// already-built protected-resource metadata handler. Tests never touch the network or
// Azure; every db handle is closed in a `finally`.
//
//   AC [obligation:admin-auth-required] (INV-101) — an unauthenticated request to the
//     (auth-gated) link route is rejected (a redirect to sign-in, or 401), while a public
//     route is served 200 with no auth header or session; and WHICH approval opens is
//     decided by the session's user id, never a value from the path.
//   AC [obligation:validate-and-parameterize-input] (INV-102) — a malformed or oversized
//     token is rejected with a 4xx at the boundary (never a 500) and never reaches the
//     link store; a SQL-injection probe in the token cannot alter a query — the
//     approval_links table survives and the genuine link still redeems (parameter
//     binding / hashing is used).
//   AC [obligation:secrets-from-env] (INV-103) — config flows in through the injected
//     seam, and a decoy secret planted in the environment never appears in a route
//     response.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

import { createApprovalLinkHandler } from "./handler";
import type { ApprovalLinkRouteHandlers } from "./handler";
import { createProtectedResourceMetadataHandler } from "../../.well-known/oauth-protected-resource/handler";

import { freshDb } from "../../../test/db";
import type { Db } from "../../../server/db/index";
import { createUser } from "../../../server/db/users";
import { createApproval } from "../../../server/db/approvals";
import { issueApprovalLink } from "../../../server/db/approval-links";
import { createSession, COOKIE_NAME } from "../../../server/auth/session";
import { loadConfig, type Config } from "../../../server/config";
import { fixedClock, type Clock } from "../../../server/seams/clock";
import { systemRandom } from "../../../server/seams/random";

// --- fixtures ---------------------------------------------------------------------

const ORIGIN = "https://warthog.com.au";
const MINUTE_MS = 60_000;

const AGENT_A = "11111111-1111-1111-1111-111111111111";
const T0 = new Date("2026-02-01T09:00:00.000Z");
const WITHIN = new Date(T0.getTime() + 5 * MINUTE_MS);

const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);

const HMAC_KEY_B64 = Buffer.alloc(48, 0x2a).toString("base64");
const DEV_KEK_B64 = Buffer.alloc(32, 0x5c).toString("base64");

function testConfig(baseUrl: string = ORIGIN): Config {
  return loadConfig({
    NODE_ENV: "development",
    PUBLIC_BASE_URL: baseUrl,
    WEBAUTHN_RP_ID: "warthog.com.au",
    DATABASE_URL: "pglite:memory",
    WARTHOG_HMAC_KEY: HMAC_KEY_B64,
    WARTHOG_DEV_KEK: DEV_KEK_B64,
  } as NodeJS.ProcessEnv);
}

function handlerOver(db: Db, clock: Clock, config: Config = testConfig()): ApprovalLinkRouteHandlers {
  return createApprovalLinkHandler({ db, clock, config });
}

function linkRequest(token: string, opts: { cookie?: string } = {}): Request {
  const headers: Record<string, string> = {};
  if (opts.cookie) headers.cookie = opts.cookie;
  return new Request(`${ORIGIN}/a/${encodeURIComponent(token)}`, { method: "GET", headers });
}

function callGet(
  handlers: ApprovalLinkRouteHandlers,
  request: Request,
  token: string,
): Promise<Response> {
  return handlers.GET(request, { params: Promise.resolve({ token }) });
}

function locationOf(res: Response, request: Request): URL | null {
  const loc = res.headers.get("location");
  if (loc == null) return null;
  try {
    return new URL(loc, request.url);
  } catch {
    return null;
  }
}

function opensApproval(res: Response, request: Request, approvalId: string): boolean {
  if (!REDIRECT_CODES.has(res.status)) return false;
  const loc = locationOf(res, request);
  if (loc == null) return false;
  if (loc.origin !== new URL(request.url).origin) return false;
  return `${loc.pathname}${loc.search}${loc.hash}`.includes(approvalId);
}

function redirectsToSignin(res: Response, request: Request): boolean {
  if (!REDIRECT_CODES.has(res.status)) return false;
  const loc = locationOf(res, request);
  if (loc == null) return false;
  return loc.pathname === "/signin" || loc.pathname.startsWith("/signin/");
}

// Is the request a rejection of an unauthenticated caller? Either a 401 or a redirect to
// sign-in (the two forms the obligation permits).
function rejectsUnauthenticated(res: Response, request: Request): boolean {
  return res.status === 401 || redirectsToSignin(res, request);
}

// Whether a relation of this exact name exists on this handle (a non-throwing probe
// scoped to the one table under test; behaviour, not source text).
async function tableExists(db: Db, name: string): Promise<boolean> {
  const result = await db.query("SELECT to_regclass($1) AS t", [name]);
  return result.rows[0]?.t != null;
}

async function seedUser(db: Db, who: string): Promise<string> {
  const user = await createUser(db, {
    email: `${who}@warthog.com.au`,
    wrappedDek: Buffer.from(`wrapped-dek-${who}`).toString("base64"),
  });
  return user.id;
}

async function seedApproval(db: Db, userId: string): Promise<string> {
  const approval = await createApproval(
    db,
    { userId, agentId: AGENT_A, detail: { recipient: "r@example", amount: "42.00 AUD", field: "f" } },
    randomBytes(32),
    fixedClock(T0),
  );
  return approval.id;
}

async function sessionCookie(db: Db, userId: string): Promise<string> {
  const created = await createSession(db, userId, { clock: fixedClock(T0), random: systemRandom });
  return `${COOKIE_NAME}=${created.token}`;
}

// A serialisation of a whole response (status + headers + body) for a leak scan.
async function serialise(res: Response): Promise<string> {
  const headers = [...res.headers.entries()].map(([k, v]) => `${k}:${v}`).join(" ");
  return `${res.status} ${headers} ${await res.text()}`;
}

// ===========================================================================
// AC [obligation:admin-auth-required] — the auth-gated link route rejects the
// unauthenticated; a public route is served with no auth; the session decides scope.
// ===========================================================================

test("[admin-auth-required] an unauthenticated request to the link route is rejected (sign-in or 401)", async () => {
  const db = await freshDb();
  try {
    const userId = await seedUser(db, "aar-reject");
    const approvalId = await seedApproval(db, userId);
    const { token } = await issueApprovalLink(db, { approvalId }, { clock: fixedClock(T0), random: systemRandom });

    const request = linkRequest(token); // no cookie / no session
    const res = await callGet(handlerOver(db, fixedClock(WITHIN)), request, token);

    assert.ok(
      rejectsUnauthenticated(res, request),
      `an unauthenticated request must be rejected (401 or sign-in redirect), got ${res.status}`,
    );
    assert.ok(!opensApproval(res, request, approvalId), "no approval opens without an authenticated session");
  } finally {
    await db.close();
  }
});

test("[admin-auth-required] a public route is served 200 with no auth header or session", async () => {
  // The protected-resource metadata is how an agent discovers HOW to authenticate, so it
  // MUST stay reachable with no Authorization header or cookie (INV-101: public routes
  // remain usable). This is the already-built public handler — no auth presented.
  const handler = createProtectedResourceMetadataHandler({ config: testConfig() });
  const res = await handler(new Request(`${ORIGIN}/.well-known/oauth-protected-resource`));
  assert.equal(res.status, 200, "a public route is served 200 with no auth header or session");
});

test("[admin-auth-required] WHICH approval opens is the session's — not a token redeemed by another person", async () => {
  const db = await freshDb();
  try {
    const ownerId = await seedUser(db, "aar-owner");
    const approvalId = await seedApproval(db, ownerId);
    const { token } = await issueApprovalLink(db, { approvalId }, { clock: fixedClock(T0), random: systemRandom });

    // Another person is signed in; the owner's link must not open the owner's approval
    // for them — the member scope is the session's user id, never the path's token.
    const intruderId = await seedUser(db, "aar-intruder");
    const intruderCookie = await sessionCookie(db, intruderId);

    const request = linkRequest(token, { cookie: intruderCookie });
    const res = await callGet(handlerOver(db, fixedClock(WITHIN)), request, token);

    assert.ok(
      !opensApproval(res, request, approvalId),
      "the owner's approval never opens for a different signed-in person",
    );
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC [obligation:validate-and-parameterize-input] — a malformed/oversized token is a
// 4xx at the boundary; a SQL-injection probe cannot alter a query.
// ===========================================================================

test("[validate-and-parameterize-input] an oversized token is rejected with a 4xx (never a 500)", async () => {
  const db = await freshDb();
  try {
    const userId = await seedUser(db, "vp-oversize");
    await seedApproval(db, userId);
    const cookie = await sessionCookie(db, userId); // a valid session, so the only fault is the token

    // A token far beyond any sane opaque-link length: rejected by the validation boundary.
    const oversized = "A".repeat(10 * 1024);
    const res = await callGet(handlerOver(db, fixedClock(WITHIN)), linkRequest(oversized, { cookie }), oversized);

    assert.ok(res.status >= 400 && res.status < 500, `an oversized token must be a 4xx, got ${res.status}`);
  } finally {
    await db.close();
  }
});

test("[validate-and-parameterize-input] a malformed (non URL-safe) token is rejected with a 4xx", async () => {
  const db = await freshDb();
  try {
    const userId = await seedUser(db, "vp-malformed");
    await seedApproval(db, userId);
    const cookie = await sessionCookie(db, userId);

    // A link token rides in a URL, so it is a URL-safe opaque string; a token laced with
    // SQL punctuation fails the shape check and is rejected at the boundary.
    const malformed = "x'); DROP TABLE approval_links; --";
    const res = await callGet(handlerOver(db, fixedClock(WITHIN)), linkRequest(malformed, { cookie }), malformed);

    assert.ok(res.status >= 400 && res.status < 500, `a malformed token must be a 4xx, got ${res.status}`);
  } finally {
    await db.close();
  }
});

test("[validate-and-parameterize-input] a SQL-injection probe in the token cannot alter a query", async () => {
  const db = await freshDb();
  try {
    const userId = await seedUser(db, "vp-inject");
    const approvalId = await seedApproval(db, userId);
    // A genuine link, so the table is populated and its survival is meaningful.
    const { token } = await issueApprovalLink(db, { approvalId }, { clock: fixedClock(T0), random: systemRandom });
    const cookie = await sessionCookie(db, userId);
    const handlers = handlerOver(db, fixedClock(WITHIN));

    const probe = "x'; DROP TABLE approval_links; --";
    await callGet(handlers, linkRequest(probe, { cookie }), probe);

    assert.equal(
      await tableExists(db, "approval_links"),
      true,
      "the approval_links table must still exist — the probe was validated/bound, never run as SQL",
    );

    // The genuine link still opens the approval, proving the store is intact and the
    // real token travels bound (hashed), not spliced.
    const genuineReq = linkRequest(token, { cookie });
    const res = await callGet(handlers, genuineReq, token);
    assert.ok(
      opensApproval(res, genuineReq, approvalId),
      "the genuine link still redeems after the injection attempt — parameter binding is used",
    );
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC [obligation:secrets-from-env] — config flows through the injected seam and no
// ambient env secret leaks into a route response.
// ===========================================================================

test("[secrets-from-env] a decoy env secret never appears in a route response", async () => {
  const DECOY = "sk_live_DECOY_must_never_appear_in_warthog";
  const prev = process.env.WARTHOG_DECOY_SECRET;
  process.env.WARTHOG_DECOY_SECRET = DECOY;

  const db = await freshDb();
  try {
    const userId = await seedUser(db, "sfe-decoy");
    const approvalId = await seedApproval(db, userId);
    const { token } = await issueApprovalLink(db, { approvalId }, { clock: fixedClock(T0), random: systemRandom });

    // Config is built from an explicit env record (no decoy), so the route reads
    // configuration through the injected seam, never ambient process.env.
    const handlers = handlerOver(db, fixedClock(WITHIN), testConfig());

    const authedReq = linkRequest(token, { cookie: await sessionCookie(db, userId) });
    const authed = await callGet(handlers, authedReq, token);
    const unauthed = await callGet(handlers, linkRequest("C".repeat(43)), "C".repeat(43));

    // Sanity: we exercised the SUCCESS path (opensApproval reads status + headers, which
    // survive the body read below), so the leak scan covers a real opened-approval response.
    assert.ok(opensApproval(authed, authedReq, approvalId), "sanity: the authed request opened the approval");

    const dump = `${await serialise(authed)} ${await serialise(unauthed)}`;
    assert.ok(!dump.includes(DECOY), "no ambient env secret is folded into any route response");
  } finally {
    await db.close();
    if (prev === undefined) delete process.env.WARTHOG_DECOY_SECRET;
    else process.env.WARTHOG_DECOY_SECRET = prev;
  }
});
