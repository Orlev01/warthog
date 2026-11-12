// E12-S14 — the single-use approval-link route: `GET /a/[token]` + its sibling
// `handler.ts` (design §10 Notifications / SMS-email fallback; brief "SMS fallback";
// constitution 18 — approvals only inside the signed-in app).
//
// RED-first: neither the sibling factory (`./handler`, `createApprovalLinkHandler`)
// nor the route entry (`./route`) exists yet, so importing them throws and every test
// in this file fails until the builder writes those modules. That absence IS the point
// of test-first — do NOT implement anything to make these pass; the builder writes the
// handler + the thin entry afterwards.
//
// These tests pin BEHAVIOUR (the HTTP outcome for a given cookie + token + clock, and
// what the route does to the stored approval/token), never the source text of any
// module — a later rename that preserves behaviour must not redden them. The session
// boundary is exercised with the REAL, already-built `verifySession` over an isolated
// in-memory PGlite seeded through the real stores (`createUser`, `createSession`,
// `createApproval`, `issueApprovalLink`), so the route's auth gate and single-use
// redemption are proven end-to-end without the network or Azure. Every db handle is
// closed in a `finally`.
//
// ---------------------------------------------------------------------------
// THE PINNED CONTRACT (chosen by the tester; the implementation conforms to it).
//
//   ./handler.ts — the testable sibling. A Next App-Router `route.ts` may export ONLY
//     the known route keys (the HTTP verb(s) + framework config like `runtime` /
//     `dynamic`) or `next build` rejects it (OBS-025), so the injectable, unit-testable
//     seam lives HERE, beside the entry. It is a factory returning the GET handler:
//
//       createApprovalLinkHandler(seams?: {
//         db?:     Db;      // default: getServerDb() — the process-wide migrated db
//         clock?:  Clock;   // default: systemClock  — the redeem / session instant
//         config?: Config;  // default: loadConfig() — read through the one env seam
//       }): {
//         GET(request: Request,
//             context: { params: Promise<{ token: string }> }): Promise<Response>;
//       }
//
//     GET redeems the single-use link token for the SIGNED-IN OWNER and opens the
//     approval in-app:
//       1. resolve the session from the `__Host-wh_session` cookie (→ the real
//          `verifySession` over the injected db + clock). No session → redirect to
//          sign-in and redeem NOTHING (the single-use token must survive for after
//          sign-in; and the link never records a decision by itself — constitution 18).
//       2. redeem the token (→ the real `redeemApprovalLink`): a reused, expired or
//          unknown token is rejected (the approval is NOT opened).
//       3. member-scope the resolved approval to `session.userId` (never a client
//          value): a token that resolves to an approval NOT owned by the signed-in
//          person opens nothing.
//       4. on success, redirect IN-APP to the approval (the Location references the
//          approval id). The decision status is NEVER changed — the link opens, it
//          never approves/denies.
//
//   ./route.ts — the thin entry: the GET handler from the factory, and NOTHING else
//     that is a function (OBS-025). It may also export non-function framework config
//     (`runtime` / `dynamic`); this test only forbids a leaked factory/seam function.
//
// Acceptance criteria → tests:
//   AC1 "A valid, unexpired token for the signed-in owner opens the approval and marks
//        the token used; a reused, expired or unknown token is rejected." — a live
//        token + the owner's session redirects in-app to the approval; a SECOND use of
//        that token opens nothing (single-use); an expired token opens nothing and the
//        approval stays untouched; an unknown token opens nothing.
//   AC2 "An unauthenticated request to the link is sent to sign-in and the link never
//        records a decision by itself." — no cookie → redirect to sign-in, the token is
//        NOT consumed (a later signed-in click of the SAME token still opens it), and the
//        approval is never decided.
//   AC3 "The route module exports only the HTTP verb(s); the injectable handler factory
//        lives in the sibling module." — the entry's only function-typed export is GET,
//        and `createApprovalLinkHandler` is not re-exported from the entry (OBS-025).
//   (+) Member scope: a DIFFERENT signed-in person cannot open the owner's approval
//        through the owner's link (the user id is the session's, never from the path).

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

import { createApprovalLinkHandler } from "./handler";
// Documentary type anchors — the exact shapes the implementation exports. Erased at
// runtime (and test files are excluded from `tsc`), so a rename cannot break these; the
// runtime assertions below are what actually gate behaviour.
import type { ApprovalLinkSeams, ApprovalLinkRouteHandlers } from "./handler";
import * as routeEntry from "./route";

import { freshDb } from "../../../test/db";
import type { Db } from "../../../server/db/index";
import { createUser } from "../../../server/db/users";
import { createApproval } from "../../../server/db/approvals";
import { issueApprovalLink } from "../../../server/db/approval-links";
import { createSession, COOKIE_NAME } from "../../../server/auth/session";
import { isUnopened } from "../../../server/approvals/opened";
import { loadConfig, type Config } from "../../../server/config";
import { fixedClock, type Clock } from "../../../server/seams/clock";
import { systemRandom } from "../../../server/seams/random";

// --- fixtures ---------------------------------------------------------------------

const ORIGIN = "https://warthog.com.au";
const MINUTE_MS = 60_000;
const TEN_MINUTES_MS = 10 * MINUTE_MS; // the single-use link's expiry window (design §10)

// A valid agent-connection uuid for the approval's `agent_id` column (no agent row is
// needed for this route, mirroring the approval-links store tests).
const AGENT_A = "11111111-1111-1111-1111-111111111111";

// T0 is when the session is created and the link is issued; WITHIN is well inside the
// ten-minute window; TOKEN_EXPIRED is one millisecond past it (the token has lapsed but
// the 14-day session is still live, so an "expired token" test cannot be confused with
// an expired session).
const T0 = new Date("2026-02-01T09:00:00.000Z");
const WITHIN = new Date(T0.getTime() + 5 * MINUTE_MS);
const TOKEN_EXPIRED = new Date(T0.getTime() + TEN_MINUTES_MS + 1);

const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);

// Base64 secrets of the right length so `loadConfig` accepts the explicit env record —
// no real secret, and never read from the ambient environment.
const HMAC_KEY_B64 = Buffer.alloc(48, 0x2a).toString("base64");
const DEV_KEK_B64 = Buffer.alloc(32, 0x5c).toString("base64");

// Config built from an explicit env record (not ambient process.env): its public base
// URL shares the request origin, so a same-origin in-app redirect resolves cleanly.
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

// Build the route handler over the test db + a fixed clock (the real session + redeem
// + member-scope logic runs against this db; nothing touches getServerDb()).
function handlerOver(db: Db, clock: Clock): ApprovalLinkRouteHandlers {
  const seams: ApprovalLinkSeams = { db, clock, config: testConfig() };
  return createApprovalLinkHandler(seams);
}

// A GET to /a/<token>. The token rides in the path; Next hands it to the handler as the
// awaited `[token]` param, so the request carries it for realism and the context supplies
// it as the resolved param. `cookie` sets the session cookie (absent → unauthenticated).
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

// Resolve a Location header against the request URL (so a relative OR absolute redirect
// both resolve to an absolute URL), or null when there is no (parseable) Location.
function locationOf(res: Response, request: Request): URL | null {
  const loc = res.headers.get("location");
  if (loc == null) return null;
  try {
    return new URL(loc, request.url);
  } catch {
    return null;
  }
}

// Did the response OPEN the approval in-app? A same-origin redirect whose target
// references the approval id. Same-origin only: the link must open the approval inside
// Warthog, never bounce the person to an external host.
function opensApproval(res: Response, request: Request, approvalId: string): boolean {
  if (!REDIRECT_CODES.has(res.status)) return false;
  const loc = locationOf(res, request);
  if (loc == null) return false;
  if (loc.origin !== new URL(request.url).origin) return false;
  return `${loc.pathname}${loc.search}${loc.hash}`.includes(approvalId);
}

// Did the response send the person to sign in?
function redirectsToSignin(res: Response, request: Request): boolean {
  if (!REDIRECT_CODES.has(res.status)) return false;
  const loc = locationOf(res, request);
  if (loc == null) return false;
  return loc.pathname === "/signin" || loc.pathname.startsWith("/signin/");
}

// The stored status of an approval, read with a parameterized query (behaviour, not
// source text). `pending` means no decision was recorded.
async function statusOf(db: Db, approvalId: string): Promise<string | undefined> {
  const result = await db.query("SELECT status FROM approvals WHERE id = $1", [approvalId]);
  return result.rows[0]?.status as string | undefined;
}

// Seed a person and return their id.
async function seedUser(db: Db, who: string): Promise<string> {
  const user = await createUser(db, {
    email: `${who}@warthog.com.au`,
    wrappedDek: Buffer.from(`wrapped-dek-${who}`).toString("base64"),
  });
  return user.id;
}

// Seed a PENDING approval owned by `userId` and return its id. The detail is
// DEK-encrypted by the store; this route never reads it.
async function seedApproval(db: Db, userId: string): Promise<string> {
  const approval = await createApproval(
    db,
    { userId, agentId: AGENT_A, detail: { recipient: "r@example", amount: "42.00 AUD", field: "f" } },
    randomBytes(32),
    fixedClock(T0),
  );
  return approval.id;
}

// Seed a live session for `userId` and return the request Cookie header value that
// presents it (the real token the session store minted, under the real cookie name).
async function sessionCookie(db: Db, userId: string): Promise<string> {
  const created = await createSession(db, userId, { clock: fixedClock(T0), random: systemRandom });
  return `${COOKIE_NAME}=${created.token}`;
}

// ===========================================================================
// AC1 — a valid, unexpired token for the signed-in OWNER opens the approval; the token
// is single-use; a reused / expired / unknown token is rejected.
// ===========================================================================

test("[AC1] a live token + the owner's session redirects IN-APP to the approval", async () => {
  const db = await freshDb();
  try {
    const userId = await seedUser(db, "ac1-open");
    const approvalId = await seedApproval(db, userId);
    const { token } = await issueApprovalLink(db, { approvalId }, { clock: fixedClock(T0), random: systemRandom });
    const cookie = await sessionCookie(db, userId);

    const request = linkRequest(token, { cookie });
    const res = await callGet(handlerOver(db, fixedClock(WITHIN)), request, token);

    assert.ok(opensApproval(res, request, approvalId), `the link opens the approval in-app (status ${res.status})`);
    assert.ok(!redirectsToSignin(res, request), "a signed-in owner is never bounced to sign-in");
  } finally {
    await db.close();
  }
});

test("[AC1] the link never records a decision by itself — opening leaves the approval pending", async () => {
  const db = await freshDb();
  try {
    const userId = await seedUser(db, "ac1-nodecide");
    const approvalId = await seedApproval(db, userId);
    const { token } = await issueApprovalLink(db, { approvalId }, { clock: fixedClock(T0), random: systemRandom });
    const cookie = await sessionCookie(db, userId);

    await callGet(handlerOver(db, fixedClock(WITHIN)), linkRequest(token, { cookie }), token);

    // Following the link OPENS the approval; it must NOT approve or deny it
    // (constitution 18 — a decision is only ever taken in the signed-in app).
    assert.equal(await statusOf(db, approvalId), "pending", "opening the link records no decision");
  } finally {
    await db.close();
  }
});

test("[AC1] the token is single-use: a second click of the same link opens nothing", async () => {
  const db = await freshDb();
  try {
    const userId = await seedUser(db, "ac1-reuse");
    const approvalId = await seedApproval(db, userId);
    const { token } = await issueApprovalLink(db, { approvalId }, { clock: fixedClock(T0), random: systemRandom });
    const cookie = await sessionCookie(db, userId);
    const handlers = handlerOver(db, fixedClock(WITHIN));

    const first = await callGet(handlers, linkRequest(token, { cookie }), token);
    assert.ok(opensApproval(first, linkRequest(token, { cookie }), approvalId), "the first use opens the approval");

    const reuseReq = linkRequest(token, { cookie });
    const second = await callGet(handlers, reuseReq, token);
    assert.ok(
      !opensApproval(second, reuseReq, approvalId),
      "the token was marked used on the first click — a reused link opens nothing",
    );
  } finally {
    await db.close();
  }
});

test("[AC1] an expired token is rejected and the approval is left untouched", async () => {
  const db = await freshDb();
  try {
    const userId = await seedUser(db, "ac1-expired");
    const approvalId = await seedApproval(db, userId);
    const { token } = await issueApprovalLink(db, { approvalId }, { clock: fixedClock(T0), random: systemRandom });
    const cookie = await sessionCookie(db, userId);

    // The session (14-day idle) is still live at +10min; only the 10-minute token lapsed.
    const request = linkRequest(token, { cookie });
    const res = await callGet(handlerOver(db, fixedClock(TOKEN_EXPIRED)), request, token);

    assert.ok(!opensApproval(res, request, approvalId), "an expired token opens nothing");
    assert.equal(
      await isUnopened(db, approvalId),
      true,
      "the approval is still unopened and pending — the expired link changed nothing",
    );
  } finally {
    await db.close();
  }
});

test("[AC1] an unknown token is rejected and opens nothing", async () => {
  const db = await freshDb();
  try {
    const userId = await seedUser(db, "ac1-unknown");
    const approvalId = await seedApproval(db, userId);
    // A link exists for the approval, but the person presents a DIFFERENT, never-issued
    // (but well-formed) token.
    await issueApprovalLink(db, { approvalId }, { clock: fixedClock(T0), random: systemRandom });
    const cookie = await sessionCookie(db, userId);

    const unknown = "B".repeat(43);
    const request = linkRequest(unknown, { cookie });
    const res = await callGet(handlerOver(db, fixedClock(WITHIN)), request, unknown);

    assert.ok(!opensApproval(res, request, approvalId), "a token matching no stored link opens nothing");
    assert.equal(await isUnopened(db, approvalId), true, "the real approval is untouched by an unknown token");
  } finally {
    await db.close();
  }
});

// UI/UX pass interaction-22 / public-28: a link that can't open anything (used, expired,
// unknown, or someone else's) lands on the inbox WITH a notice saying so, never silently.
function landsOnLinkExpiredNotice(res: Response, request: Request): boolean {
  const loc = locationOf(res, request);
  return REDIRECT_CODES.has(res.status) && loc !== null && loc.pathname === "/inbox" && loc.searchParams.get("notice") === "link_expired" && !loc.searchParams.has("approval");
}

test("a used, expired, unknown or someone else's link lands on the inbox with a notice that says why", async () => {
  const db = await freshDb();
  try {
    const ownerId = await seedUser(db, "dead-link-owner");
    const approvalId = await seedApproval(db, ownerId);
    const { token } = await issueApprovalLink(db, { approvalId }, { clock: fixedClock(T0), random: systemRandom });
    const cookie = await sessionCookie(db, ownerId);

    const expiredReq = linkRequest(token, { cookie });
    assert.ok(landsOnLinkExpiredNotice(await callGet(handlerOver(db, fixedClock(TOKEN_EXPIRED)), expiredReq, token), expiredReq), "expired");

    const unknown = "C".repeat(43);
    const unknownReq = linkRequest(unknown, { cookie });
    assert.ok(landsOnLinkExpiredNotice(await callGet(handlerOver(db, fixedClock(WITHIN)), unknownReq, unknown), unknownReq), "unknown");

    const { token: second } = await issueApprovalLink(db, { approvalId }, { clock: fixedClock(T0), random: systemRandom });
    const handlers = handlerOver(db, fixedClock(WITHIN));
    const intruderCookie = await sessionCookie(db, await seedUser(db, "dead-link-intruder"));
    const intruderReq = linkRequest(second, { cookie: intruderCookie });
    assert.ok(landsOnLinkExpiredNotice(await callGet(handlers, intruderReq, second), intruderReq), "someone else's, told nothing more");

    const { token: third } = await issueApprovalLink(db, { approvalId }, { clock: fixedClock(T0), random: systemRandom });
    await callGet(handlers, linkRequest(third, { cookie }), third);
    const reusedReq = linkRequest(third, { cookie });
    assert.ok(landsOnLinkExpiredNotice(await callGet(handlers, reusedReq, third), reusedReq), "already used");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC2 — an unauthenticated request is sent to sign-in; the link never records a
// decision by itself and the single-use token is NOT consumed before sign-in.
// ===========================================================================

test("[AC2] an unauthenticated click is sent to sign-in", async () => {
  const db = await freshDb();
  try {
    const userId = await seedUser(db, "ac2-signin");
    const approvalId = await seedApproval(db, userId);
    const { token } = await issueApprovalLink(db, { approvalId }, { clock: fixedClock(T0), random: systemRandom });

    const request = linkRequest(token); // no cookie
    const res = await callGet(handlerOver(db, fixedClock(WITHIN)), request, token);

    assert.ok(redirectsToSignin(res, request), `an unauthenticated click goes to sign-in (status ${res.status})`);
    assert.ok(!opensApproval(res, request, approvalId), "the approval is not opened without a session");
  } finally {
    await db.close();
  }
});

test("[AC2] sign-in is told to come back to the same link afterwards", async () => {
  const db = await freshDb();
  try {
    const userId = await seedUser(db, "ac2-next");
    const approvalId = await seedApproval(db, userId);
    const { token } = await issueApprovalLink(db, { approvalId }, { clock: fixedClock(T0), random: systemRandom });

    const request = linkRequest(token); // no cookie
    const res = await callGet(handlerOver(db, fixedClock(WITHIN)), request, token);

    const loc = locationOf(res, request);
    assert.ok(loc != null && loc.pathname === "/signin", "goes to sign-in");
    assert.equal(loc.searchParams.get("next"), `/a/${token}`, "with the link as the relative return path");
  } finally {
    await db.close();
  }
});

test("[AC2] the link carries no authority of its own: the token survives an unauthenticated click", async () => {
  const db = await freshDb();
  try {
    const userId = await seedUser(db, "ac2-survive");
    const approvalId = await seedApproval(db, userId);
    const { token } = await issueApprovalLink(db, { approvalId }, { clock: fixedClock(T0), random: systemRandom });
    const handlers = handlerOver(db, fixedClock(WITHIN));

    // First click: no session → sign-in. The single-use token must NOT be consumed, or
    // the link would be dead by the time the person has signed in.
    await callGet(handlers, linkRequest(token), token);
    assert.equal(await statusOf(db, approvalId), "pending", "the unauthenticated click records no decision");

    // After signing in, the SAME link still opens the approval — proof it was not burned.
    const cookie = await sessionCookie(db, userId);
    const signedIn = linkRequest(token, { cookie });
    const res = await callGet(handlers, signedIn, token);
    assert.ok(
      opensApproval(res, signedIn, approvalId),
      "the token still redeems after sign-in — the unauthenticated click did not consume it",
    );
  } finally {
    await db.close();
  }
});

// ===========================================================================
// Member scope — the signed-in person's id decides what opens; the id in the path is a
// credential bound to an approval, never an authority to open ANOTHER person's approval.
// ===========================================================================

test("[member-scope] a different signed-in person cannot open the owner's approval via the owner's link", async () => {
  const db = await freshDb();
  try {
    const ownerId = await seedUser(db, "ms-owner");
    const approvalId = await seedApproval(db, ownerId);
    const { token } = await issueApprovalLink(db, { approvalId }, { clock: fixedClock(T0), random: systemRandom });

    // A DIFFERENT person is signed in and clicks the owner's link.
    const intruderId = await seedUser(db, "ms-intruder");
    const intruderCookie = await sessionCookie(db, intruderId);

    const request = linkRequest(token, { cookie: intruderCookie });
    const res = await callGet(handlerOver(db, fixedClock(WITHIN)), request, token);

    assert.ok(!opensApproval(res, request, approvalId), "the owner's approval does not open for another person");
    assert.equal(
      await isUnopened(db, approvalId),
      true,
      "the owner's approval is left unopened — a non-owner marked nothing",
    );
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC3 — the route entry exports ONLY its HTTP verb(s); the injection factory lives in
// the sibling handler.ts (OBS-025). Behaviour-level: only function-typed exports are
// checked, so a non-function framework config export (`runtime` / `dynamic`) is allowed.
// ===========================================================================

test("[AC3] the /a/[token] route entry exports only its GET handler (the seam lives in the sibling)", () => {
  assert.equal(typeof routeEntry.GET, "function", "the entry must export a GET handler");

  const fnExports = Object.entries(routeEntry)
    .filter(([, value]) => typeof value === "function")
    .map(([key]) => key)
    .sort();
  assert.deepEqual(
    fnExports,
    ["GET"],
    "the entry's only function export is GET — no factory/seam leaked (OBS-025)",
  );
  assert.ok(
    !("createApprovalLinkHandler" in routeEntry),
    "the injection factory lives in the sibling handler.ts, never on the route entry",
  );
});
