// E06-S08 — the admin-area session guard (`src/server/auth/guard.ts`), the auth/routing
// leg of this task's [obligation:admin-auth-required] (INV-101, design §5).
//
// RED-first: `./guard` does not exist yet, so importing it throws — every test here
// fails at import until the builder writes the module. That absence IS the point of
// test-first; do not implement anything to make these pass.
//
// Why this seam: INV-101 requires every admin route to require an authenticated
// operator session verified on the server, while the public routes stay usable with no
// auth. The portal's `(protected)` route group needs one place that turns "the session
// cookie the browser presented" into "admit this operator, or send them to sign in".
// The `/oauth/authorize` entry already does this inline (read the `__Host-wh_session`
// cookie → `verifySession` → redirect to `/signin` when there is none); this task
// centralises it as a reusable guard the `(protected)/layout.tsx` and any admin route
// delegate to. A `layout.tsx`/`route.ts` is an awkward unit-test target (reserved Next
// props, `redirect()` throws), so the testable decision lives in this server seam and
// the entry stays thin over it (conventions: thin entries over tested modules).
//
// These tests pin BEHAVIOUR (the admit/redirect decision for a given presented session
// token and stored session state), never source text — the guard is driven with real
// sessions created through the already-built `createSession`, so a later rename that
// preserves behaviour must not redden them.
//
// The contract this task defines (the builder implements exactly this):
//
//   requireSession(sessionToken: string | null, deps: { db: Db; clock: Clock })
//     : Promise<GuardResult>
//     result (a discriminated union, the repo idiom):
//       { ok: true;  session: Session }          // a valid session → admit the operator
//     | { ok: false; redirectTo: string }        // no valid session → send to sign-in
//
//     • `sessionToken` is the raw `__Host-wh_session` cookie value the entry extracted
//       (null when the cookie is absent). The guard never reads identity from any
//       client-supplied value other than this cookie (INV-101: caller identity is never
//       trusted from a client value).
//     • A null, unknown, tampered or expired token yields the redirect branch, with
//       `redirectTo` pointing at the sign-in page.
//     • A token that `verifySession` accepts yields the admit branch carrying the
//       resolved session (so an admin page can scope its reads by `session.userId`).
//
// Acceptance criteria → tests (AC3 / [obligation:admin-auth-required]):
//   "An unauthenticated request to any admin route is rejected (HTTP 401 or a redirect
//    to sign-in), while a public route returns HTTP 200 with no auth header or session."
//   — an absent / unknown / expired session is rejected toward sign-in; a valid session
//   is admitted; and a real public route (the protected-resource metadata) returns 200
//   with no auth header or session.
//
// Every db handle is closed in a `finally` so node:test leaves no open handle; each
// db-backed test uses its own `freshDb()` (an isolated in-memory PGlite with the real
// migrations), so tests share no state. Tests never touch the network or Azure.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { requireSession } from "./guard";
import { createSession } from "./session";
import { createUser } from "../db/users";
import { createProtectedResourceMetadataHandler } from "../../app/.well-known/oauth-protected-resource/handler";
import { loadConfig } from "../config";
import { freshDb } from "../../test/db";
import { fixedClock } from "../seams/clock";
import { systemRandom } from "../seams/random";
import type { Db } from "../db/index";

const T0 = new Date("2026-02-01T00:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

// The shape the guard returns, taken from the function itself so the test pins the
// behavioural fields (ok / session / redirectTo) without locking the union's type NAME.
type GuardResult = Awaited<ReturnType<typeof requireSession>>;

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

// Seed a person and a session for them, created at `clock`, and return the person's id
// together with the raw cookie token the client would present.
async function seedSession(
  db: Db,
  clock: { now(): Date },
): Promise<{ userId: string; token: string }> {
  const user = await createUser(db, {
    email: `operator-${randomUUID()}@warthog.example`,
    wrappedDek: "wrapped-dek-ref",
  });
  const { token } = await createSession(db, user.id, { clock, random: systemRandom });
  return { userId: user.id, token };
}

// Assert the guard rejected, and return where it redirected for further checks.
function expectRedirect(result: GuardResult): string {
  if (result.ok) {
    assert.fail("expected an unauthenticated request to be rejected, but a session was admitted");
  }
  return result.redirectTo;
}

// Assert the guard admitted, and return the resolved session.
function expectSession(result: GuardResult) {
  if (!result.ok) {
    assert.fail(`expected a valid session to be admitted, but it was redirected to ${result.redirectTo}`);
  }
  return result.session;
}

// --- Unauthenticated admin requests are rejected toward sign-in ---------------------

test("an unauthenticated request (no session cookie) to an admin route is rejected toward sign-in [admin-auth-required]", async () => {
  const db = await freshDb();
  try {
    const to = expectRedirect(await requireSession(null, { db, clock: fixedClock(T0) }));
    assert.match(to, /signin/, `an absent session must redirect to sign-in, got ${to}`);
  } finally {
    await db.close();
  }
});

test("an unknown session token is rejected toward sign-in", async () => {
  const db = await freshDb();
  try {
    const to = expectRedirect(
      await requireSession(`not-a-real-token-${randomUUID()}`, { db, clock: fixedClock(T0) }),
    );
    assert.match(to, /signin/, `an unknown session must redirect to sign-in, got ${to}`);
  } finally {
    await db.close();
  }
});

test("an expired session is rejected toward sign-in", async () => {
  const db = await freshDb();
  try {
    // Created at T0, then presented 15 days later — beyond the 14-day idle window, so
    // verifySession yields no session and the guard must redirect.
    const { token } = await seedSession(db, fixedClock(T0));
    const laterClock = fixedClock(new Date(T0.getTime() + 15 * DAY_MS));
    const to = expectRedirect(await requireSession(token, { db, clock: laterClock }));
    assert.match(to, /signin/, `an expired session must redirect to sign-in, got ${to}`);
  } finally {
    await db.close();
  }
});

// --- A valid session admits the operator --------------------------------------------

test("a valid session admits the operator and carries their user id", async () => {
  const db = await freshDb();
  try {
    const clock = fixedClock(T0);
    const { userId, token } = await seedSession(db, clock);
    const session = expectSession(await requireSession(token, { db, clock }));
    assert.equal(session.userId, userId, "the admitted session must be the operator's own");
  } finally {
    await db.close();
  }
});

// --- A public route is served with no auth ------------------------------------------

test("a public route returns HTTP 200 with no auth header or session [admin-auth-required]", async () => {
  // A genuinely public route (the protected-resource metadata) must stay usable with no
  // authentication (INV-101). This is the real, already-built handler, invoked with a
  // request that carries no Authorization header and no session cookie.
  const handler = createProtectedResourceMetadataHandler({
    config: configWithBaseUrl("https://warthog.example"),
  });
  const response = await handler(
    new Request("https://warthog.example/.well-known/oauth-protected-resource"),
  );
  assert.equal(response.status, 200, "a public route must be served with no auth");
});
