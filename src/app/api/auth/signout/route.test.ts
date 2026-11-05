// E04-S38 — Sign out: the HTTP endpoint POST /api/auth/signout.
//
// RED-first: neither the route entry (`./route`) nor the injectable route handler it
// wraps (`createSignoutRouteHandler`, in `src/server/auth/signout-handler.ts`) exists
// yet, so importing them throws and every test here fails until the builder adds them.
// That absence IS the point of test-first — do NOT implement anything to make these pass.
//
// What ships under this task (the contract these tests define):
//
//   src/server/auth/signout-handler.ts — the testable sibling seam of the route. A Next
//     App-Router `route.ts` may export ONLY the known route keys (the HTTP verbs) or
//     `next build` rejects it (OBS-025), so the injectable, unit-testable factory lives
//     HERE (the server module the route entry imports), never on the entry. It builds the
//     sign-out handler ONCE from the auth composition root and returns the request
//     handler:
//
//       createSignoutRouteHandler(seams?: {
//         getDeps?: () => Promise<SignoutHandlerDeps>;             // defaults to getSignoutDeps
//         createHandler?: (d: SignoutHandlerDeps) => SignoutHandler; // defaults to createSignoutHandler
//       }): (request: Request) => Promise<Response>
//
//     The handler is built LAZILY, on the first request, and reused — so merely
//     constructing the route handler reads no config and opens no database, which keeps
//     the route entry importable under `next build` (runtime config absent; the
//     server-composition-roots addendum).
//
//   ./route.ts — the thin entry: delegates to the route handler and exports ONLY `POST`.
//
// These tests pin BEHAVIOUR (that the route forwards to a handler built from the
// composition root, the response it returns, and the end-to-end HTTP outcome), never the
// source text of the modules — a later behaviour-preserving rename must not redden them.
// The dispatch proof runs through the injectable factory with FAKE deps (a spy handler),
// so no browser, Azure, config or network is needed; the composition-root proof runs the
// REAL composition root (getSignoutDeps) over an isolated in-memory PGlite (src/test/db)
// with dev config, so the real session repo parameter-binds every query.
//
// ─── Acceptance criteria → tests ─────────────────────────────────────────────────────
//   AC1 the route forwards the request to the sign-out handler and returns its response
//       verbatim (through the injectable factory with fake deps).
//   AC2 the route module exports only POST (OBS-025).
//   AC3 the handler is built ONCE, lazily, from the auth composition root (getSignoutDeps),
//       not from createDb or process.env inside src/app.
//   AC4 end-to-end through the REAL composition root: POST with a valid session cookie
//       deletes that session, clears the cookie (Max-Age=0) and redirects to /signin, and
//       the old token no longer verifies.

import { test } from "node:test";
import assert from "node:assert/strict";

import { createSignoutRouteHandler } from "../../../../server/auth/signout-handler";
import * as signoutRoute from "./route";

import type {
  SignoutHandler,
  SignoutHandlerDeps,
} from "../../../../server/auth/signout-handler";
import { getSignoutDeps } from "../../../../server/auth/compose";
import { loadConfig } from "../../../../server/config";
import { createUser } from "../../../../server/db/users";
import { createSession, verifySession } from "../../../../server/auth/session";
import { fixedClock } from "../../../../server/seams/clock";
import { systemRandom } from "../../../../server/seams/random";
import { freshDb } from "../../../../test/db";
import type { Db } from "../../../../server/db/index";

// --- fixtures -----------------------------------------------------------------------

// A valid DEVELOPMENT environment (dev tools on, a local dev KEK, pglite), the base the
// composition-root test builds config from. loadConfig(env) is a pure function of this
// record, so no test mutates the real process environment. PUBLIC_BASE_URL's origin is
// the Origin the real handler checks every request against.
const HMAC_KEY_B64 = Buffer.alloc(48, 0x2a).toString("base64");
const DEV_KEK_B64 = Buffer.alloc(32, 0x5c).toString("base64");
const DEV_ENV = {
  NODE_ENV: "development",
  PUBLIC_BASE_URL: "http://localhost:3000",
  WEBAUTHN_RP_ID: "localhost",
  DATABASE_URL: "pglite:memory",
  WARTHOG_DEV_TOOLS: "1",
  WARTHOG_HMAC_KEY: HMAC_KEY_B64,
  WARTHOG_DEV_KEK: DEV_KEK_B64,
} as const;

// The Origin the dev-config handler accepts (origin of PUBLIC_BASE_URL).
const DEV_ORIGIN = new URL(DEV_ENV.PUBLIC_BASE_URL).origin;

const COOKIE_NAME = "__Host-wh_session";
const T0 = new Date("2026-06-01T00:00:00.000Z");
const WRAPPED_DEK = "wrapped-dek-placeholder";

function devConfig() {
  return loadConfig({ ...DEV_ENV } as NodeJS.ProcessEnv);
}

// A random tag so accounts never collide on the users.email UNIQUE across tests.
function tag(): string {
  return Math.random().toString(36).slice(2);
}

// A sentinel deps object. The dispatch tests fake `createHandler` to ignore it and
// return a spy, so its fields never matter — but its IDENTITY is asserted, to prove the
// handler is built FROM the deps the composition root (getDeps) produced.
const FAKE_DEPS = { marker: Symbol("signout-deps") } as unknown as SignoutHandlerDeps;

// A spy sign-out handler: records each request it received and returns a sentinel 222
// response (so it is unmistakably the handler's own output, never a status the route
// itself produced), so a test can assert the route forwarded the request and returned
// the handler's response verbatim.
function spySignoutHandler() {
  const calls: Array<{ request: Request; response: Response }> = [];
  const handler: SignoutHandler = async (request: Request): Promise<Response> => {
    const response = new Response("spy:signout", { status: 222, headers: { "x-spy": "signout" } });
    calls.push({ request, response });
    return response;
  };
  return { handler, calls };
}

// A POST sign-out request carrying a session cookie (between decoys) and an Origin.
function signoutRequest(
  { token, origin = DEV_ORIGIN }: { token?: string | null; origin?: string | null } = {},
): Request {
  const headers: Record<string, string> = {};
  if (origin !== null) headers.origin = origin;
  if (token != null) headers.cookie = `ab=decoy1; ${COOKIE_NAME}=${token}; cd=decoy2`;
  return new Request("http://localhost:3000/api/auth/signout", { method: "POST", headers });
}

// A route handler wired to the REAL composition root over `db` (dev config, dev
// tooling), leaving createHandler at its default (the real createSignoutHandler) — so the
// whole route -> composition root -> real handler -> real db path is exercised.
function realHandle(db: Db) {
  return createSignoutRouteHandler({
    getDeps: () => getSignoutDeps({ config: devConfig(), getDb: async () => db }),
  });
}

// =====================================================================================
// AC1 — the route forwards the request to the sign-out handler and returns its response.
// =====================================================================================

test("the route forwards the request to the sign-out handler and returns its response verbatim", async () => {
  const { handler, calls } = spySignoutHandler();
  const handle = createSignoutRouteHandler({
    getDeps: async () => FAKE_DEPS,
    createHandler: () => handler,
  });

  const request = signoutRequest({ token: "a-token" });
  const response = await handle(request);

  const last = calls.at(-1);
  assert.ok(last, "the route must reach the sign-out handler");
  assert.equal(last.request, request, "the original request is forwarded unchanged");
  assert.equal(response, last.response, "the handler's response is returned verbatim");
  assert.equal(response.status, 222, "the response is the handler's own (sentinel), not a route status");
  assert.equal(calls.length, 1, "the handler is called exactly once per request");
});

// =====================================================================================
// AC3 — the handler is built ONCE from the composition root (getDeps), lazily, and from
// the very deps getDeps returned.
// =====================================================================================

test("the sign-out handler is built once from the composition root and reused across requests", async () => {
  const { handler } = spySignoutHandler();
  let getDepsCount = 0;
  let createHandlerCount = 0;
  let receivedDeps: SignoutHandlerDeps | undefined;

  const handle = createSignoutRouteHandler({
    getDeps: async () => {
      getDepsCount += 1;
      return FAKE_DEPS;
    },
    createHandler: (deps) => {
      createHandlerCount += 1;
      receivedDeps = deps;
      return handler;
    },
  });

  await handle(signoutRequest({ token: "t1" }));
  await handle(signoutRequest({ token: "t2" }));
  await handle(signoutRequest({ token: "t3" }));

  assert.equal(getDepsCount, 1, "the composition root is consulted exactly once, not per request");
  assert.equal(createHandlerCount, 1, "the handler is built exactly once, not per request");
  assert.equal(receivedDeps, FAKE_DEPS, "the handler is built FROM the deps the composition root produced");
});

test("the route handler builds nothing until the first request (so the route entry stays import-safe)", async () => {
  const { handler } = spySignoutHandler();
  let getDepsCount = 0;

  const handle = createSignoutRouteHandler({
    getDeps: async () => {
      getDepsCount += 1;
      return FAKE_DEPS;
    },
    createHandler: () => handler,
  });

  assert.equal(getDepsCount, 0, "merely constructing the route handler must not touch the composition root");
  await handle(signoutRequest({ token: "t" }));
  assert.equal(getDepsCount, 1, "the handler is built on the first request");
});

test("createSignoutRouteHandler() with no seams constructs without touching config or a database", () => {
  // The default-seam construction (what route.ts does at module load) must not throw and
  // must not read config / open a db — proof the entry is importable under `next build`.
  assert.doesNotThrow(() => {
    const handle = createSignoutRouteHandler();
    assert.equal(typeof handle, "function", "the route handler is a request handler function");
  });
});

// =====================================================================================
// AC2 — the route module exports only POST.
// =====================================================================================

test("the sign-out route module exports only POST (OBS-025: the injection seam lives in the sibling, not the entry)", () => {
  const keys = Object.keys(signoutRoute);
  assert.ok(keys.includes("POST"), "the route must export a POST handler");
  assert.equal(typeof (signoutRoute as { POST: unknown }).POST, "function", "POST is the route handler function");
  assert.deepEqual(keys.sort(), ["POST"], "the entry exports ONLY POST — no factory, no other verb");
});

// =====================================================================================
// AC4 — end-to-end through the REAL composition root: a valid-session sign-out deletes
// the session, clears the cookie and redirects to /signin.
// =====================================================================================

test("built from the real composition root, a valid-session POST deletes the session, clears the cookie and lands on /signin", async () => {
  const db = await freshDb();
  try {
    const handle = realHandle(db);

    const user = await createUser(db, { email: `signout-e2e-${tag()}@warthog.com.au`, wrappedDek: WRAPPED_DEK });
    const created = await createSession(db, user.id, { clock: fixedClock(T0), random: systemRandom });

    assert.ok(
      await verifySession(db, created.token, { clock: fixedClock(T0) }),
      "precondition: the session verifies before sign-out",
    );

    const res = await handle(signoutRequest({ token: created.token, origin: DEV_ORIGIN }));

    assert.ok(res.status >= 300 && res.status < 400, `sign-out redirects (3xx), got ${res.status}`);
    assert.equal(res.headers.get("location"), "/signin", "sign-out lands on /signin");

    const cookie = res.headers.get("set-cookie");
    assert.ok(cookie, "sign-out clears the session cookie");
    assert.ok(cookie!.startsWith(`${COOKIE_NAME}=`), `the cleared cookie is ${COOKIE_NAME}: ${JSON.stringify(cookie)}`);
    assert.match(cookie!, /Max-Age=0/i, "the cleared cookie carries Max-Age=0");

    assert.equal(
      await verifySession(db, created.token, { clock: fixedClock(T0) }),
      null,
      "the old session token no longer verifies — the session row was deleted",
    );
  } finally {
    await db.close();
  }
});

test("built from the real composition root, a foreign-Origin POST is 403 and ends nothing", async () => {
  const db = await freshDb();
  try {
    const handle = realHandle(db);

    const user = await createUser(db, { email: `signout-e2e-foreign-${tag()}@warthog.com.au`, wrappedDek: WRAPPED_DEK });
    const created = await createSession(db, user.id, { clock: fixedClock(T0), random: systemRandom });

    const res = await handle(signoutRequest({ token: created.token, origin: "https://evil.example" }));

    assert.equal(res.status, 403, "a foreign-Origin sign-out is forbidden");
    assert.ok(
      await verifySession(db, created.token, { clock: fixedClock(T0) }),
      "the session is untouched — a cross-site request cannot sign anyone out",
    );
  } finally {
    await db.close();
  }
});
