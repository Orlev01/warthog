// E15-S15 — the household-invite accept route: `GET /household/join/[token]` + its
// sibling `handler.ts` (brief "Household sharing": "the owner invites members by email
// (invite link valid 7 days, up to 8 members); members join with their own accounts";
// design §4.1). INV-101 admin-auth-required, INV-102 validate-and-parameterize-input,
// INV-103 secrets-from-env.
//
// RED-first: neither the sibling factory (`./handler`, `createHouseholdJoinHandler`) nor
// the route entry (`./route`) exists yet, so importing them throws and every test in this
// file fails until the builder writes those modules. That absence IS the point of
// test-first — as the TESTER I must NOT create or edit any implementation/source file to
// make these pass; the builder writes `handler.ts` (and the thin `route.ts`) afterwards,
// to this contract.
//
// These tests pin BEHAVIOUR (the HTTP outcome for a given cookie + token + clock, and what
// the route does to the stored household membership), never the source text of any module
// — a later rename that preserves behaviour must not redden them. The session boundary is
// exercised with the REAL, already-built `verifySession` over an isolated in-memory PGlite
// seeded through the real stores (`createUser`, `createHousehold`, `issueInvite`,
// `createSession`), so the route's auth gate and single-use redemption are proven
// end-to-end without the network or Azure. Every db handle is closed in a `finally`.
//
// ---------------------------------------------------------------------------
// THE PINNED CONTRACT (chosen by the tester; the implementation conforms to it).
//
//   ./handler.ts — the testable sibling. A Next App-Router `route.ts` may export ONLY the
//     known route keys (the HTTP verb(s) + framework config like `runtime` / `dynamic`) or
//     `next build` rejects it (OBS-025), so the injectable, unit-testable seam lives HERE,
//     beside the entry. It is a factory returning the GET handler:
//
//       createHouseholdJoinHandler(seams?: {
//         db?:     Db;      // default: getServerDb() — the process-wide migrated db
//         clock?:  Clock;   // default: systemClock  — the redeem / session instant
//         config?: Config;  // default: loadConfig() — read through the one env seam
//       }): {
//         GET(request: Request,
//             context: { params: Promise<{ token: string }> }): Promise<Response>;
//       }
//
//     Constructing the handler reads NO config and opens NO database (all three seams are
//     resolved lazily inside the request handler), so merely importing the entry — which
//     builds the handler at module load — reads no config and keeps it importable under
//     `next build`.
//
//     GET redeems the single-use household invite token for the SIGNED-IN invited person
//     and opens the Household page in-app. The order (mirroring the approval-link route
//     `/a/[token]`, E12-S14):
//       1. validate the token shape at the boundary (INV-102) — a malformed or oversized
//          token is a 4xx and never reaches the invite store.
//       2. resolve the session from the `__Host-wh_session` cookie (the real
//          `verifySession`). No session → redirect to sign-in and redeem NOTHING, so the
//          single-use token survives for after sign-in and the link adds no member by
//          itself (the link carries no authority of its own).
//       3. redeem the token (the real `redeemInvite`) for the SESSION's user id — never a
//          value from the path/body: a live, unexpired, unused token adds the signed-in
//          person to the bound household ONCE; a reused, expired or unknown token is
//          rejected and adds no member; a redemption that would exceed the 8-member cap is
//          refused with a plain reason.
//       4. on success, redirect IN-APP to the Household page (`/household`), built from the
//          CONFIGURED public base URL — never the request host.
//
//   ./route.ts — the thin entry: the GET handler from the factory, and NOTHING else that
//     is a function (OBS-025). It may also export non-function framework config (`runtime`
//     / `dynamic`); the shape test below only forbids a leaked factory/seam function.
//
// Acceptance criteria → tests:
//   AC1 "A valid, unexpired token redeemed by the signed-in invited user adds them to the
//        household once and redirects to the Household page; a reused, expired or unknown
//        token is rejected and never adds a member twice." — a live token + the invited
//        user's session joins the bound household and redirects to `/household`; a SECOND
//        click of the same link adds no duplicate; an expired / unknown token adds no
//        member.
//   AC2 "An unauthenticated request to the link is sent to sign-in and does not add a
//        member, and redemption that would exceed 8 members is refused with a plain
//        reason." — no cookie → redirect to sign-in, no member added, and the token
//        survives for after sign-in; a redeem into a full household (8 members) is refused
//        with a plain reason and adds no member.
//   AC3 "The route module exports only the HTTP verb(s); the injectable handler factory
//        lives in the sibling module." — the entry's only function export is GET, and
//        `createHouseholdJoinHandler` is not re-exported from the entry (OBS-025).
//   [obligation:admin-auth-required] (INV-101) — an unauthenticated request (no session,
//        or an unverifiable cookie) is rejected (redirect to sign-in) and adds nothing;
//        identity is the server-verified session's user id, never a client value. (The
//        public-route half of the obligation — "a public route returns 200 with no
//        session" — is satisfied by Warthog's genuinely public routes and their own tests;
//        this task adds only a guarded link, so only the guarded half is exercised here.)
//   [obligation:validate-and-parameterize-input] (INV-102) — a malformed or oversized
//        token is a 4xx (never a 500) and never reaches a query; a SQL-injection probe in
//        the token cannot alter a query (the invite/member/household tables survive) and
//        the genuine token still redeems afterward.
//   [obligation:secrets-from-env] (INV-103) — config flows in through the injected seam
//        (an explicit env record, never ambient `process.env`), so a decoy secret planted
//        in the environment never surfaces in a join response.

import { test } from "node:test";
import assert from "node:assert/strict";

import { createHouseholdJoinHandler } from "./handler";
import * as routeEntry from "./route";

import { freshDb } from "../../../../test/db";
import type { Db } from "../../../../server/db/index";
import { createUser } from "../../../../server/db/users";
import {
  createHousehold,
  addMember,
  isHouseholdMember,
  listMembers,
  getHouseholdForMember,
} from "../../../../server/db/households";
import { issueInvite } from "../../../../server/db/household-invites";
import { createSession, COOKIE_NAME } from "../../../../server/auth/session";
import { loadConfig, type Config } from "../../../../server/config";
import { fixedClock, type Clock } from "../../../../server/seams/clock";
import { systemRandom } from "../../../../server/seams/random";

// --- fixtures ---------------------------------------------------------------------

const ORIGIN = "https://warthog.com.au";
const DAY_MS = 24 * 60 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * DAY_MS; // the invite link's expiry window (brief: "valid 7 days")

// T0 is when the session is created and the invite is issued; WITHIN redeems well inside
// the seven-day window (and the 14-day session idle window); TOKEN_EXPIRED is one
// millisecond past the invite's window but still inside the session's, so an "expired
// token" test can never be confused with an expired session.
const T0 = new Date("2026-02-01T09:00:00.000Z");
const WITHIN = new Date(T0.getTime() + 3 * DAY_MS);
const TOKEN_EXPIRED = new Date(T0.getTime() + SEVEN_DAYS_MS + 1);

const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);

// A well-formed but never-issued token (43 URL-safe chars, the base64url-of-256-bits shape
// `issueInvite` draws), so an "unknown token" test is shape-valid yet matches no stored hash.
const UNKNOWN_TOKEN = "B".repeat(43);

// Base64 secrets of the right length so `loadConfig` accepts the explicit env record — no
// real secret, and never read from the ambient environment.
const HMAC_KEY_B64 = Buffer.alloc(48, 0x2a).toString("base64");
const DEV_KEK_B64 = Buffer.alloc(32, 0x5c).toString("base64");

// Config built from an EXPLICIT env record (not ambient process.env): its public base URL
// shares the request origin, so a same-origin in-app redirect resolves cleanly, and no
// ambient env value can leak in (INV-103).
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

// The returned-handler shape — pinned locally so these tests depend only on the factory's
// runtime name and the GET it returns, not on an exported Seams/Handlers type name.
type JoinRouteHandlers = {
  GET(request: Request, context: { params: Promise<{ token: string }> }): Promise<Response>;
  POST(request: Request, context: { params: Promise<{ token: string }> }): Promise<Response>;
};

// Build the route handler over the test db + a fixed clock (the real session + redeem logic
// runs against this db; nothing touches getServerDb()).
function handlerOver(db: Db, clock: Clock, baseUrl: string = ORIGIN): JoinRouteHandlers {
  return createHouseholdJoinHandler({ db, clock, config: testConfig(baseUrl) }) as JoinRouteHandlers;
}

// A GET to /household/join/<token>. The token rides in the path; Next hands it to the
// handler as the awaited `[token]` param, so the request carries it for realism and the
// context supplies it as the resolved param. `cookie` sets the session cookie (absent →
// unauthenticated).
function joinRequest(token: string, opts: { cookie?: string } = {}): Request {
  const headers: Record<string, string> = {};
  if (opts.cookie) headers.cookie = opts.cookie;
  return new Request(`${ORIGIN}/household/join/${encodeURIComponent(token)}`, {
    method: "GET",
    headers,
  });
}

function callGet(
  handlers: JoinRouteHandlers,
  request: Request,
  token: string,
): Promise<Response> {
  return handlers.GET(request, { params: Promise.resolve({ token }) });
}

// The confirming POST the join page's form sends to /household/join/<token>. A browser
// submitting Warthog's own form sends Warthog's Origin; `origin: null` omits the header and
// any other value forges a cross-site submission.
function confirmRequest(token: string, opts: { cookie?: string; origin?: string | null } = {}): Request {
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
  if (opts.cookie) headers.cookie = opts.cookie;
  const origin = opts.origin === undefined ? ORIGIN : opts.origin;
  if (origin !== null) headers.origin = origin;
  return new Request(`${ORIGIN}/household/join/${encodeURIComponent(token)}`, {
    method: "POST",
    headers,
    body: "",
  });
}

function callPost(
  handlers: JoinRouteHandlers,
  request: Request,
  token: string,
): Promise<Response> {
  return handlers.POST(request, { params: Promise.resolve({ token }) });
}

// Open the link (GET) and confirm the join (POST), as the invited person does: the GET must
// show the confirmation without joining, and the POST performs the join.
async function openAndConfirm(
  handlers: JoinRouteHandlers,
  token: string,
  cookie: string,
): Promise<{ request: Request; response: Response }> {
  const page = await callGet(handlers, joinRequest(token, { cookie }), token);
  assert.equal(page.status, 200, `opening the link shows the confirmation page (status ${page.status})`);
  const request = confirmRequest(token, { cookie });
  return { request, response: await callPost(handlers, request, token) };
}

// Resolve a Location header against the request URL (so a relative OR absolute redirect both
// resolve to an absolute URL), or null when there is no (parseable) Location.
function locationOf(res: Response, request: Request): URL | null {
  const loc = res.headers.get("location");
  if (loc == null) return null;
  try {
    return new URL(loc, request.url);
  } catch {
    return null;
  }
}

// Did the response open the Household page in-app? A same-origin redirect whose path is the
// Household page (`/household`, route groups stripped). Same-origin only: the link must open
// the page inside Warthog, never bounce the person to an external host. A trailing slash is
// tolerated; a query string (e.g. a success notice) is ignored.
function redirectsToHousehold(res: Response, request: Request): boolean {
  if (!REDIRECT_CODES.has(res.status)) return false;
  const loc = locationOf(res, request);
  if (loc == null) return false;
  if (loc.origin !== new URL(request.url).origin) return false;
  return loc.pathname.replace(/\/$/, "") === "/household";
}

// Did the response send the person to sign in?
function redirectsToSignin(res: Response, request: Request): boolean {
  if (!REDIRECT_CODES.has(res.status)) return false;
  const loc = locationOf(res, request);
  if (loc == null) return false;
  return loc.pathname === "/signin" || loc.pathname.startsWith("/signin/");
}

// A client-safe, in-app outcome: never a 5xx (no raw crash), and any redirect stays on
// Warthog (same origin — it never bounces the person off to another host). The real
// guarantee for a refusal is asserted separately on the DB state (no member added).
function assertInApp(res: Response, request: Request): void {
  assert.ok(res.status < 500, `expected a client-safe response (never a 5xx), got ${res.status}`);
  if (REDIRECT_CODES.has(res.status)) {
    const loc = locationOf(res, request);
    assert.ok(loc != null, "a redirect carries a parseable Location");
    assert.equal(
      loc.origin,
      new URL(request.url).origin,
      "an in-app redirect stays on Warthog (same origin), never bouncing off to another host",
    );
  }
}

// A refusal that communicates a plain reason: either a 4xx whose status IS the refusal, or a
// same-origin in-app redirect carrying a reason in its query string (the repo's `?notice=`
// idiom). Either way it is client-safe and never a silent success.
function assertRefusedWithReason(res: Response, request: Request): void {
  assertInApp(res, request);
  if (REDIRECT_CODES.has(res.status)) {
    const loc = locationOf(res, request);
    assert.ok(
      loc != null && loc.search.length > 0,
      "a refusal that redirects in-app carries a plain reason in its query string",
    );
  } else {
    assert.ok(
      res.status >= 400 && res.status < 500,
      `a non-redirect refusal is a 4xx carrying the reason, got ${res.status}`,
    );
  }
}

// Flatten a response (status + headers + body) to a string, so a test can assert an ambient
// secret never appears anywhere in it.
async function serialiseResponse(res: Response): Promise<string> {
  const headers = [...res.headers.entries()].map(([k, v]) => `${k}:${v}`).join(" ");
  let body = "";
  try {
    body = await res.clone().text();
  } catch {
    body = "";
  }
  return `${res.status} ${headers} ${body}`;
}

// Whether a relation of this exact name exists — a non-throwing probe for the injection
// survival test. `to_regclass` yields the name when it exists and NULL when it does not.
async function tableExists(db: Db, name: string): Promise<boolean> {
  const result = await db.query("SELECT to_regclass($1) AS t", [name]);
  return result.rows[0]?.t != null;
}

// Create a person and return their id + email (the invited email an invite is bound to; the
// id is the session user added on redemption).
async function seedUser(db: Db, who: string): Promise<{ id: string; email: string }> {
  const email = `${who}@warthog.com.au`;
  const user = await createUser(db, {
    email,
    wrappedDek: Buffer.from(`wrapped-dek-${who}`).toString("base64"),
  });
  return { id: user.id, email };
}

// Seed a live session for `userId` (created at T0) and return the request Cookie header
// value that presents it — the real token the session store minted, under the real cookie
// name, so the handler's own `verifySession` admits it.
async function sessionCookie(db: Db, userId: string): Promise<string> {
  const created = await createSession(db, userId, { clock: fixedClock(T0), random: systemRandom });
  return `${COOKIE_NAME}=${created.token}`;
}

// Arrange a household owned by `ownerWho` and a live invite (issued at T0) bound to
// `inviteeWho`'s email. Returns both people, the household and the RAW invite token.
async function setupInvite(
  db: Db,
  ownerWho: string,
  inviteeWho: string,
): Promise<{
  owner: { id: string; email: string };
  invitee: { id: string; email: string };
  house: { id: string };
  token: string;
}> {
  const owner = await seedUser(db, ownerWho);
  const invitee = await seedUser(db, inviteeWho);
  const house = await createHousehold(db, { ownerId: owner.id });
  const { token } = await issueInvite(
    db,
    { householdId: house.id, email: invitee.email },
    { clock: fixedClock(T0), random: systemRandom },
  );
  return { owner, invitee, house: { id: house.id }, token };
}

// ===========================================================================
// AC1 — a valid, unexpired token redeemed by the signed-in invited user adds them ONCE and
// redirects to the Household page; a reused / expired / unknown token is rejected and never
// adds a member twice.
// ===========================================================================

test("[AC1] a live token + the invited user's session joins the household and redirects to the Household page", async () => {
  const db = await freshDb();
  try {
    const { owner, invitee, house, token } = await setupInvite(db, "ac1-ok-owner", "ac1-ok-invitee");
    const cookie = await sessionCookie(db, invitee.id);

    assert.equal(
      await isHouseholdMember(db, house.id, invitee.id),
      false,
      "the invitee is not a member before redeeming",
    );

    const { request, response: res } = await openAndConfirm(handlerOver(db, fixedClock(WITHIN)), token, cookie);

    assert.ok(redirectsToHousehold(res, request), `confirming opens the Household page in-app (status ${res.status})`);
    assert.ok(!redirectsToSignin(res, request), "a signed-in invitee is never bounced to sign-in");

    // The signed-in user is now a member of exactly the bound household.
    assert.equal(await isHouseholdMember(db, house.id, invitee.id), true, "the invitee is now a member");
    assert.equal((await getHouseholdForMember(db, invitee.id))?.id, house.id, "the invitee belongs to the bound household");
    const members = await listMembers(db, house.id, owner.id);
    assert.equal(members.length, 2, "the household now has two members (owner + redeemer)");
    assert.equal(members.find((m) => m.userId === invitee.id)?.role, "member", "the redeemer joins as a plain member");
  } finally {
    await db.close();
  }
});

test("[AC1] the invite is single-use: a second click of the same link adds no second membership", async () => {
  const db = await freshDb();
  try {
    const { owner, invitee, house, token } = await setupInvite(db, "ac1-reuse-owner", "ac1-reuse-invitee");
    const cookie = await sessionCookie(db, invitee.id);
    const handlers = handlerOver(db, fixedClock(WITHIN));

    const { request: firstReq, response: first } = await openAndConfirm(handlers, token, cookie);
    assert.ok(redirectsToHousehold(first, firstReq), "the first use opens the Household page");
    assert.equal((await listMembers(db, house.id, owner.id)).length, 2, "the first redemption added the invitee");

    // A second click presents the same (now-used) token: single-use, so it is rejected and
    // adds no duplicate membership.
    const secondReq = confirmRequest(token, { cookie });
    const second = await callPost(handlers, secondReq, token);
    assertInApp(second, secondReq);

    const members = await listMembers(db, house.id, owner.id);
    assert.equal(members.length, 2, "a reused link adds no duplicate member — still two members");
    assert.equal(
      members.filter((m) => m.userId === invitee.id).length,
      1,
      "the invitee appears exactly once — never added twice",
    );
  } finally {
    await db.close();
  }
});

test("[AC1] an expired token is rejected and adds no member", async () => {
  const db = await freshDb();
  try {
    const { house, invitee, token } = await setupInvite(db, "ac1-exp-owner", "ac1-exp-invitee");
    const cookie = await sessionCookie(db, invitee.id);

    // The session (14-day idle) is still live at +7 days; only the 7-day invite token lapsed.
    for (const request of [joinRequest(token, { cookie }), confirmRequest(token, { cookie })]) {
      const handlers = handlerOver(db, fixedClock(TOKEN_EXPIRED));
      const res = await (request.method === "GET" ? callGet : callPost)(handlers, request, token);
      assertRefusedWithReason(res, request);
    }
    assert.equal(await isHouseholdMember(db, house.id, invitee.id), false, "an expired token adds no member");
  } finally {
    await db.close();
  }
});

test("[AC1] an unknown (never-issued) token is rejected and adds no member", async () => {
  const db = await freshDb();
  try {
    // A real invite exists for the invitee, but they present a DIFFERENT, never-issued token.
    const { house, invitee } = await setupInvite(db, "ac1-unk-owner", "ac1-unk-invitee");
    const cookie = await sessionCookie(db, invitee.id);

    for (const request of [joinRequest(UNKNOWN_TOKEN, { cookie }), confirmRequest(UNKNOWN_TOKEN, { cookie })]) {
      const handlers = handlerOver(db, fixedClock(WITHIN));
      const res = await (request.method === "GET" ? callGet : callPost)(handlers, request, UNKNOWN_TOKEN);
      assertRefusedWithReason(res, request);
    }
    assert.equal(await isHouseholdMember(db, house.id, invitee.id), false, "a token matching no stored invite adds no member");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC2 — an unauthenticated request is sent to sign-in and adds no member (the token
// survives for after sign-in); a redeem into a full household is refused with a plain reason.
// ===========================================================================

test("[AC2] an unauthenticated click is sent to sign-in and adds no member", async () => {
  const db = await freshDb();
  try {
    const { house, invitee, token } = await setupInvite(db, "ac2-signin-owner", "ac2-signin-invitee");

    const request = joinRequest(token); // no cookie
    const res = await callGet(handlerOver(db, fixedClock(WITHIN)), request, token);

    assert.ok(redirectsToSignin(res, request), `an unauthenticated click goes to sign-in (status ${res.status})`);
    assert.equal(
      locationOf(res, request)?.searchParams.get("next"),
      `/household/join/${token}`,
      "sign-in is asked to return to this link afterwards (a relative path)",
    );
    const posted = confirmRequest(token); // a confirm with no session joins no one either
    assert.ok(redirectsToSignin(await callPost(handlerOver(db, fixedClock(WITHIN)), posted, token), posted));
    assert.equal(await isHouseholdMember(db, house.id, invitee.id), false, "no member is added without a session");
  } finally {
    await db.close();
  }
});

test("[AC2] the invite carries no authority of its own: the token survives an unauthenticated click", async () => {
  const db = await freshDb();
  try {
    const { house, invitee, token } = await setupInvite(db, "ac2-survive-owner", "ac2-survive-invitee");
    const handlers = handlerOver(db, fixedClock(WITHIN));

    // First click: no session → sign-in. The single-use token must NOT be consumed, or the
    // link would be dead by the time the invited person has signed in.
    await callGet(handlers, joinRequest(token), token);
    assert.equal(await isHouseholdMember(db, house.id, invitee.id), false, "the unauthenticated click adds no member");

    // After signing in, the SAME link still joins the household — proof it was not burned.
    const cookie = await sessionCookie(db, invitee.id);
    const { request: signedIn, response: res } = await openAndConfirm(handlers, token, cookie);
    assert.ok(redirectsToHousehold(res, signedIn), "the token still redeems after sign-in — the unauthenticated click did not consume it");
    assert.equal(await isHouseholdMember(db, house.id, invitee.id), true, "the invited person joins once signed in");
  } finally {
    await db.close();
  }
});

test("[AC2] redeeming into a full household (8 members) is refused with a plain reason and adds no member", async () => {
  const db = await freshDb();
  try {
    const owner = await seedUser(db, "ac2-cap-owner");
    const house = await createHousehold(db, { ownerId: owner.id });

    // The owner is member #1. Seven more fill the household to the shared cap of 8.
    for (let i = 1; i <= 7; i++) {
      const filler = await seedUser(db, `ac2-cap-filler-${i}`);
      const added = await addMember(db, { householdId: house.id, userId: filler.id });
      assert.equal(added.ok, true, `filler #${i} fits within the cap of 8`);
    }
    assert.equal((await listMembers(db, house.id, owner.id)).length, 8, "sanity: the household is full at 8 members");

    // A ninth person holds a genuinely-issued, live invite — but the household is full.
    const ninth = await seedUser(db, "ac2-cap-ninth");
    const { token } = await issueInvite(
      db,
      { householdId: house.id, email: ninth.email },
      { clock: fixedClock(T0), random: systemRandom },
    );
    const cookie = await sessionCookie(db, ninth.id);

    const request = confirmRequest(token, { cookie });
    const res = await callPost(handlerOver(db, fixedClock(WITHIN)), request, token);

    assertRefusedWithReason(res, request);
    assert.equal(await isHouseholdMember(db, house.id, ninth.id), false, "the refused ninth person was not enrolled");
    assert.equal((await listMembers(db, house.id, owner.id)).length, 8, "membership is still 8 after the refusal");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// [obligation:admin-auth-required] (INV-101) — identity is the server-verified session's
// user id, never a client value. An unauthenticated request (no session, or an unverifiable
// cookie) is rejected (redirect to sign-in) and adds nothing. The public-route half of the
// obligation is covered by Warthog's genuinely public routes and their own tests.
// ===========================================================================

test("[admin-auth-required] a garbage/unknown session cookie is treated as unauthenticated (real verifySession) and adds no member", async () => {
  const db = await freshDb();
  try {
    const { house, invitee, token } = await setupInvite(db, "auth-garbage-owner", "auth-garbage-invitee");

    // A cookie is present, but its token verifies against no stored session, so the REAL
    // verifySession yields no session and the link adds nothing.
    const garbage = `${COOKIE_NAME}=no-such-session-abcdef0123456789`;
    for (const request of [joinRequest(token, { cookie: garbage }), confirmRequest(token, { cookie: garbage })]) {
      const handlers = handlerOver(db, fixedClock(WITHIN));
      const res = await (request.method === "GET" ? callGet : callPost)(handlers, request, token);
      assert.ok(redirectsToSignin(res, request), `an unverifiable cookie is sent to sign-in (status ${res.status})`);
    }
    assert.equal(await isHouseholdMember(db, house.id, invitee.id), false, "an unverifiable cookie adds no member");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// [obligation:validate-and-parameterize-input] (INV-102) — a malformed or oversized token
// is a 4xx (never a 500) and never reaches a query; a SQL-injection probe in the token
// cannot alter a query (the tables survive) and the genuine token still redeems afterward.
// ===========================================================================

test("[validate-and-parameterize-input] a malformed / injection-shaped / oversized token is a 4xx, adds no member, and the tables survive; the genuine token still redeems", async () => {
  const db = await freshDb();
  try {
    const { house, invitee, token } = await setupInvite(db, "vp-owner", "vp-invitee");
    // A VALID session so the ONLY reason to reject a bad token is the token shape itself —
    // the 4xx is unambiguously from token validation, whatever order the handler checks in.
    const cookie = await sessionCookie(db, invitee.id);
    const handlers = handlerOver(db, fixedClock(WITHIN));

    const badTokens = [
      "x'); DROP TABLE household_invites; --", // classic SQL-injection shape (illegal chars)
      "robert'); DROP TABLE household_members; --",
      "../../etc/passwd",
      "a b c", // whitespace — not a URL-safe opaque token
      "", // empty
      "A".repeat(10_000), // grossly oversized, far beyond any opaque-link length
    ];
    for (const bad of badTokens) {
      for (const res of [
        await callGet(handlers, joinRequest(bad, { cookie }), bad),
        await callPost(handlers, confirmRequest(bad, { cookie }), bad),
      ]) {
        assert.ok(
          res.status >= 400 && res.status < 500,
          `a malformed/oversized token ${JSON.stringify(bad.slice(0, 32))} must be a 4xx (never a 5xx), got ${res.status}`,
        );
      }
    }

    // The injection probes never ran as SQL: every table survives, and no member was added.
    assert.equal(await tableExists(db, "household_invites"), true, "the household_invites table survives every probe");
    assert.equal(await tableExists(db, "household_members"), true, "the household_members table survives every probe");
    assert.equal(await tableExists(db, "households"), true, "the households table survives every probe");
    assert.equal(await isHouseholdMember(db, house.id, invitee.id), false, "no malformed token added a member");

    // The real token still redeems — proving the tables are intact and the handler functional.
    const { request: okReq, response: okRes } = await openAndConfirm(handlers, token, cookie);
    assert.ok(redirectsToHousehold(okRes, okReq), "the genuine token still redeems after the injection attempts");
    assert.equal(await isHouseholdMember(db, house.id, invitee.id), true, "the invited person joins with the genuine token");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// [obligation:secrets-from-env] (INV-103) — config flows in through the injected seam (an
// explicit env record, never ambient process.env), so a decoy secret planted in the
// environment never surfaces in a join response.
// ===========================================================================

test("[secrets-from-env] no ambient env secret is folded into a join response (config comes from the injected seam)", async () => {
  const DECOY = "sk_live_DECOY_must_never_appear_in_warthog";
  const prev = process.env.WARTHOG_DECOY_SECRET;
  process.env.WARTHOG_DECOY_SECRET = DECOY;
  const db = await freshDb();
  try {
    const { invitee, token } = await setupInvite(db, "secrets-owner", "secrets-invitee");
    const cookie = await sessionCookie(db, invitee.id);

    // The handler runs purely from its injected seams (db + clock + an explicit config), so
    // no ambient process.env is read — a decoy secret can never surface in the response.
    const handlers = handlerOver(db, fixedClock(WITHIN));
    const page = await callGet(handlers, joinRequest(token, { cookie }), token);
    const res = await callPost(handlers, confirmRequest(token, { cookie }), token);

    for (const response of [page, res]) {
      const serialised = await serialiseResponse(response);
      assert.ok(!serialised.includes(DECOY), "no ambient env secret appears in the join responses");
    }
  } finally {
    await db.close();
    if (prev === undefined) delete process.env.WARTHOG_DECOY_SECRET;
    else process.env.WARTHOG_DECOY_SECRET = prev;
  }
});

// ===========================================================================
// AC3 — the route entry exports ONLY its HTTP verb(s); the injection factory lives in the
// sibling handler.ts (OBS-025). Behaviour-level: only function-typed exports are checked, so
// a non-function framework config export (`runtime` / `dynamic`) is allowed.
// ===========================================================================

test("[AC3] the /household/join/[token] route entry exports only its GET and POST handlers (the seam lives in the sibling)", () => {
  assert.equal(typeof routeEntry.GET, "function", "the entry must export a GET handler");
  assert.equal(typeof routeEntry.POST, "function", "the entry must export a POST handler");

  const fnExports = Object.entries(routeEntry)
    .filter(([, value]) => typeof value === "function")
    .map(([key]) => key)
    .sort();
  assert.deepEqual(
    fnExports,
    ["GET", "POST"],
    "the entry's only function exports are GET and POST — no factory/seam leaked (OBS-025)",
  );
  assert.ok(
    !("createHouseholdJoinHandler" in routeEntry),
    "the injection factory lives in the sibling handler.ts, never on the route entry",
  );
});

// ===========================================================================
// Opening the link never joins by itself (review finding: a plain cross-site GET — a link or
// an auto-redirect from any site, carrying the SameSite=Lax session cookie — silently added a
// signed-in victim to an attacker's household, exposing their spending totals and letting
// the attacker set their limit). The GET only shows a confirmation; the join is a POST from
// Warthog's own page, refused when it comes from anywhere else.
// ===========================================================================

test("opening the link shows a confirmation with a join form and adds no member", async () => {
  const db = await freshDb();
  try {
    const { house, invitee, token } = await setupInvite(db, "confirm-owner", "confirm-invitee");
    const cookie = await sessionCookie(db, invitee.id);

    const res = await callGet(handlerOver(db, fixedClock(WITHIN)), joinRequest(token, { cookie }), token);
    assert.equal(res.status, 200, "the link renders a page rather than joining");
    assert.match(res.headers.get("content-type") ?? "", /text\/html/);
    assert.equal(res.headers.get("cache-control"), "no-store", "the confirmation is never cached");
    const html = await res.text();
    assert.match(html, /<form[^>]+method="post"/i, "the page carries a form that confirms with a POST");
    assert.ok(html.includes(`action="/household/join/${token}"`), "the form posts back to this link");
    assert.equal(await isHouseholdMember(db, house.id, invitee.id), false, "opening the link added no member");
  } finally {
    await db.close();
  }
});

test("a confirming POST from another site (or with no Origin) is refused and adds no member", async () => {
  const db = await freshDb();
  try {
    const { house, invitee, token } = await setupInvite(db, "csrf-owner", "csrf-invitee");
    const cookie = await sessionCookie(db, invitee.id);
    const handlers = handlerOver(db, fixedClock(WITHIN));

    for (const origin of ["https://evil.example", "null", null]) {
      const res = await callPost(handlers, confirmRequest(token, { cookie, origin }), token);
      assert.equal(res.status, 403, `a POST with Origin ${String(origin)} is refused`);
    }
    assert.equal(await isHouseholdMember(db, house.id, invitee.id), false, "no cross-site POST added a member");

    // Warthog's own form still works afterwards (the invite was not consumed).
    const { request, response } = await openAndConfirm(handlers, token, cookie);
    assert.ok(redirectsToHousehold(response, request));
    assert.equal(await isHouseholdMember(db, house.id, invitee.id), true);
  } finally {
    await db.close();
  }
});

test("a signed-in account that is not the invited one is refused on the link itself, before any confirmation", async () => {
  const db = await freshDb();
  try {
    const { house, token } = await setupInvite(db, "other-owner", "other-invitee");
    const stranger = await seedUser(db, "other-stranger");
    const cookie = await sessionCookie(db, stranger.id);
    const handlers = handlerOver(db, fixedClock(WITHIN));

    const request = joinRequest(token, { cookie });
    const res = await callGet(handlers, request, token);
    assertRefusedWithReason(res, request);
    assert.equal(locationOf(res, request)?.searchParams.get("notice"), "wrong_account");

    const posted = confirmRequest(token, { cookie });
    assertRefusedWithReason(await callPost(handlers, posted, token), posted);
    assert.equal(await isHouseholdMember(db, house.id, stranger.id), false, "the stranger was not added");
  } finally {
    await db.close();
  }
});
