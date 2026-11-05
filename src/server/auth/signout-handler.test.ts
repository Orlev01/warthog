// E04-S38 — Sign out: the injectable sign-out handler (`src/server/auth/signout-handler.ts`).
//
// RED-first: `./signout-handler` does not exist yet, so importing it throws and every
// test here fails until the builder adds it. That absence IS the point of test-first —
// do NOT implement anything to make these pass.
//
// These tests pin BEHAVIOUR (the HTTP outcome of a sign-out, what ends up stored, and
// which sessions survive), never the source text of the module — a later rename that
// preserves behaviour must not redden them. There is no browser, no Azure and no
// network: the person's account and their session(s) are driven through the REAL
// session seam (`createSession` / `verifySession`) against an isolated in-memory PGlite
// (src/test/db), and the handler deletes the current session through that same real
// path. Every member-scoped row hangs off a genuine `users` row, created through the
// real repo.
//
// ─── The contract this task defines (the builder implements exactly this) ────────────
//
//   createSignoutHandler(deps): (request: Request) => Promise<Response>
//
//   deps:
//     { db: Db; publicOrigin: string }   // the shared db + the origin the Origin check uses
//
//   The handler, for POST /api/auth/signout:
//     • verifies the request `Origin` against `publicOrigin` FIRST: a missing or foreign
//       Origin is 403 and ENDS NOTHING (no session deleted, cookie not cleared) — so a
//       cross-site request cannot sign anyone out (design §5).
//     • reads the presented session token from the `__Host-wh_session` cookie, deletes
//       exactly that session row (so the old token no longer verifies and ONLY that
//       session ends — the person's other devices stay signed in), clears the cookie
//       (`__Host-wh_session`, Max-Age=0, host-locked: Path=/ + Secure), and redirects to
//       /signin.
//     • with NO session (no cookie, or an unknown/expired/garbage token) it still clears
//       the cookie and redirects to /signin, deleting nothing.
//
// Every db handle is closed in a `finally` so node:test leaves no open handle; each test
// uses its own freshDb(). Emails are distinct per test so accounts never collide on the
// users.email UNIQUE.

import { test } from "node:test";
import assert from "node:assert/strict";

import { createSignoutHandler } from "./signout-handler";

import { createSession, verifySession } from "./session";
import { createUser, type User } from "../db/users";
import { fixedClock } from "../seams/clock";
import { systemRandom } from "../seams/random";
import { freshDb } from "../../test/db";
import type { Db } from "../db/index";

// A frozen instant: sessions are created and verified at the same clock, so they sit
// well inside their idle/absolute windows with no wall-clock dependence.
const T0 = new Date("2026-06-01T00:00:00.000Z");

// The configured public origin the handler checks the request `Origin` against, and a
// foreign origin a cross-site request would carry.
const GOOD_ORIGIN = "https://warthog.com.au";
const FOREIGN_ORIGIN = "https://evil.example";

// The host-locked session cookie name (project rule: the `__Host-` prefix).
const COOKIE_NAME = "__Host-wh_session";

// A placeholder wrapped-DEK reference; createUser stores it verbatim. Its value is
// irrelevant here — we only need a genuine `users` row so sessions can hang off a real
// userId (the account id every member-scoped row filters by).
const WRAPPED_DEK = "wrapped-dek-placeholder";

// Build the handler under test. Each test uses its own db, so nothing leaks across tests.
function makeHandler(db: Db, publicOrigin: string = GOOD_ORIGIN) {
  return createSignoutHandler({ db, publicOrigin });
}

// A POST sign-out request. `token` (when given) is placed in a `__Host-wh_session`
// cookie BETWEEN two decoy cookies, so the handler must pick the right value out of a
// real Cookie header rather than assuming the whole header is the token. `origin: null`
// sends no Origin header at all (the cross-site / no-origin case); omitting `token`
// sends no cookie at all (the no-session case).
function signoutRequest(
  { token, origin = GOOD_ORIGIN }: { token?: string | null; origin?: string | null } = {},
): Request {
  const headers: Record<string, string> = {};
  if (origin !== null) headers.origin = origin;
  if (token != null) headers.cookie = `ab=decoy1; ${COOKIE_NAME}=${token}; cd=decoy2`;
  return new Request("https://warthog.com.au/api/auth/signout", { method: "POST", headers });
}

// Create a genuine person row and return it. Distinct labels give distinct (unique)
// emails within a test, so two users never collide on the users.email UNIQUE.
async function freshUser(db: Db, label: string): Promise<User> {
  return createUser(db, { email: `${label}@warthog.com.au`, wrappedDek: WRAPPED_DEK });
}

// Mint a real session for `user` at T0 and return the raw token the browser would hold.
async function startSession(db: Db, user: User): Promise<string> {
  const created = await createSession(db, user.id, { clock: fixedClock(T0), random: systemRandom });
  return created.token;
}

// Count the sessions currently stored. Each test uses its own freshly-migrated,
// isolated database, so a total count is the right "how many are signed in" probe.
async function sessionCount(db: Db): Promise<number> {
  const result = await db.query("SELECT count(*)::int AS n FROM sessions");
  return Number(result.rows[0]?.n ?? -1);
}

// A session token still resolves to a live session (the device is still signed in).
async function stillValid(db: Db, token: string): Promise<boolean> {
  return (await verifySession(db, token, { clock: fixedClock(T0) })) != null;
}

// The Set-Cookie value a sign-out emits (there is exactly one).
function setCookie(res: Response): string | null {
  return res.headers.get("set-cookie");
}

// Assert the response clears the host-locked session cookie: the `__Host-wh_session`
// cookie with Max-Age=0 and the `__Host-` requirements (Path=/, Secure).
function assertClearsSessionCookie(res: Response): void {
  const cookie = setCookie(res);
  assert.ok(cookie, "sign-out must clear the session cookie (a Set-Cookie header)");
  assert.ok(
    cookie!.startsWith(`${COOKIE_NAME}=`),
    `the cleared cookie must be the host-locked ${COOKIE_NAME} cookie: ${JSON.stringify(cookie)}`,
  );
  assert.match(cookie!, /Max-Age=0/i, `the cleared cookie carries Max-Age=0: ${JSON.stringify(cookie)}`);
  assert.match(cookie!, /Path=\//i, `a __Host- cookie must be Path=/: ${JSON.stringify(cookie)}`);
  assert.match(cookie!, /;\s*Secure/i, `a __Host- cookie must be Secure: ${JSON.stringify(cookie)}`);
}

// Assert the response is a redirect that lands the browser on /signin.
function assertRedirectsToSignin(res: Response): void {
  assert.ok(
    res.status >= 300 && res.status < 400,
    `sign-out must redirect (a 3xx), got ${res.status}`,
  );
  assert.equal(res.headers.get("location"), "/signin", "sign-out lands on /signin");
}

// =====================================================================================
// AC1 — a valid sign-out deletes the current session, clears the cookie (Max-Age=0),
// redirects to /signin, and the old token no longer verifies.
// =====================================================================================

test("a valid sign-out deletes the current session, clears the cookie and redirects to /signin", async () => {
  const db = await freshDb();
  try {
    const handler = makeHandler(db);
    const person = await freshUser(db, "signout-happy");
    const token = await startSession(db, person);

    assert.equal(await sessionCount(db), 1, "precondition: the person has one session");
    assert.ok(await stillValid(db, token), "precondition: the token verifies before sign-out");

    const res = await handler(signoutRequest({ token }));

    assertRedirectsToSignin(res);
    assertClearsSessionCookie(res);

    // The session ROW is gone: the token no longer verifies, and the table is empty.
    assert.equal(await stillValid(db, token), false, "the old session token no longer verifies");
    assert.equal(await sessionCount(db), 0, "the session row was deleted");
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC2 — signing out ends ONLY the current session: the person's other sessions, and
// every other person's session, stay valid.
// =====================================================================================

test("sign-out ends only the current session — the person's other sessions stay signed in", async () => {
  const db = await freshDb();
  try {
    const handler = makeHandler(db);

    // One person with two devices (two sessions), plus a second person signed in on
    // their own device — none of which this sign-out may touch.
    const person = await freshUser(db, "signout-current");
    const other = await freshUser(db, "signout-bystander");
    const current = await startSession(db, person);
    const otherDeviceSameperson = await startSession(db, person);
    const otherPerson = await startSession(db, other);

    assert.equal(await sessionCount(db), 3, "precondition: three live sessions");

    const res = await handler(signoutRequest({ token: current }));
    assertRedirectsToSignin(res);

    // Exactly the current session ended; the other two survive untouched.
    assert.equal(await stillValid(db, current), false, "the current device's session ended");
    assert.ok(
      await stillValid(db, otherDeviceSameperson),
      "the person's OTHER device stays signed in",
    );
    assert.ok(await stillValid(db, otherPerson), "a different person's session is untouched");
    assert.equal(await sessionCount(db), 2, "exactly one session row was deleted");
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC3 — a missing or foreign Origin is 403 and ENDS NOTHING (no deletion, no cookie
// cleared), so a cross-site request cannot sign anyone out.
// =====================================================================================

test("a foreign-Origin sign-out is 403 and ends nothing", async () => {
  const db = await freshDb();
  try {
    const handler = makeHandler(db);
    const person = await freshUser(db, "signout-foreign");
    const token = await startSession(db, person);

    const res = await handler(signoutRequest({ token, origin: FOREIGN_ORIGIN }));

    assert.equal(res.status, 403, "a foreign-Origin sign-out is forbidden");
    assert.equal(setCookie(res), null, "a forbidden sign-out does not clear the cookie (ends nothing)");
    assert.ok(await stillValid(db, token), "the session is untouched — the device stays signed in");
    assert.equal(await sessionCount(db), 1, "no session row was deleted");
  } finally {
    await db.close();
  }
});

test("a sign-out with no Origin header is 403 and ends nothing", async () => {
  const db = await freshDb();
  try {
    const handler = makeHandler(db);
    const person = await freshUser(db, "signout-noorigin");
    const token = await startSession(db, person);

    const res = await handler(signoutRequest({ token, origin: null }));

    assert.equal(res.status, 403, "a sign-out with no Origin is forbidden");
    assert.equal(setCookie(res), null, "a forbidden sign-out does not clear the cookie (ends nothing)");
    assert.ok(await stillValid(db, token), "the session is untouched");
    assert.equal(await sessionCount(db), 1, "no session row was deleted");
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC4 — a request with NO session still clears the cookie and redirects to /signin,
// deleting nothing (no cookie at all, and an unknown/garbage token).
// =====================================================================================

test("a sign-out with no session cookie still clears the cookie and redirects to /signin", async () => {
  const db = await freshDb();
  try {
    const handler = makeHandler(db);

    // Someone else is signed in; a no-cookie sign-out must not disturb them.
    const bystander = await freshUser(db, "signout-nocookie-bystander");
    const bystanderToken = await startSession(db, bystander);

    const res = await handler(signoutRequest({ origin: GOOD_ORIGIN })); // no cookie

    assertRedirectsToSignin(res);
    assertClearsSessionCookie(res);
    assert.ok(await stillValid(db, bystanderToken), "no session was deleted");
    assert.equal(await sessionCount(db), 1, "nothing was deleted");
  } finally {
    await db.close();
  }
});

test("a sign-out with an unknown token clears the cookie and redirects without deleting anything", async () => {
  const db = await freshDb();
  try {
    const handler = makeHandler(db);

    const bystander = await freshUser(db, "signout-unknown-bystander");
    const bystanderToken = await startSession(db, bystander);

    // A token that matches no stored session: the classic SQL-injection probe, so this
    // doubles as proof the token is bound as data (hashed, parameterized) and never woven
    // into SQL — it cannot drop the table or crash the server (INV-102).
    const probe = "robert'); DROP TABLE sessions; --";
    const res = await handler(signoutRequest({ token: probe }));

    assert.ok(res.status < 500, `an unknown/garbage token must be handled, not crash (got ${res.status})`);
    assertRedirectsToSignin(res);
    assertClearsSessionCookie(res);

    // The injection did NOT execute and nothing was deleted: the table and the bystander survive.
    await db.query("SELECT 1 FROM sessions LIMIT 1");
    assert.ok(await stillValid(db, bystanderToken), "the bystander's session survived — the token was data");
    assert.equal(await sessionCount(db), 1, "no session row was deleted");
  } finally {
    await db.close();
  }
});
