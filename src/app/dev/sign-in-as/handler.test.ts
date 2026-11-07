// E17-S09 — Dev sign-in-as route (`src/app/dev/sign-in-as/route.ts` + its SIBLING
// `handler.ts`, design §12 dev tools; INV-102 validate-and-parameterize-input,
// INV-103 secrets-from-env).
//
// RED-first: the sibling factory `./handler` (`createSignInAsHandler`) does not exist
// yet, so importing it throws and EVERY test here fails until the builder writes the
// module. That absence IS the point of test-first — as the TESTER I must NOT create or
// edit any implementation/source file to make these pass; the builder writes `handler.ts`
// (and the thin `route.ts`) afterwards, to this contract.
//
// WHY this exists (task E17-S09): the acceptance walkthrough needs to become a signed-in,
// step-up-satisfied person over plain HTTP without a real passkey. "Sign in as" stands in
// for a dev passkey: behind the dev-tools guard it mints a session for a chosen account
// and marks it freshly stepped-up, so the walk can reach guarded and sensitive screens.
// It is safe ONLY because it is gated by `WARTHOG_DEV_TOOLS` (the flag production refuses
// to start with — `assertProductionSafe` in `src/server/config.ts`) and is not found when
// that flag is off.
//
// WHY the sibling `handler.ts` (not `route.ts`): a Next App-Router `route.ts` may export
// ONLY the known route keys (the HTTP verb(s) + framework config) or `next build` rejects
// it (OBS-025). So the injectable, unit-testable factory lives in the sibling `handler.ts`
// and `route.ts` imports it and re-exports only `POST`. These tests therefore drive the
// HANDLER FACTORY directly and never import the `route.ts` entry (its entry-shape is not
// something a test may lock extra exports onto).
//
// A route handler is NOT wrapped by the `/dev/layout.tsx` guard the way a page is — Next
// layouts wrap pages, not route handlers — so this handler must re-derive the dev-tools
// gate ITSELF (reading `config.devTools`, which the config module parsed from the
// environment) and be not-found when dev tools are off. That self-gating is the subject of
// the first two tests below.
//
// These tests pin BEHAVIOUR (the HTTP outcome, the session/step-up actually stored, and
// the stored rows after a probe), never the source text of any module — a later rename
// that preserves behaviour must not redden them. There is no browser, no Azure and no
// network: accounts and sessions are driven through the REAL sibling seams
// (`createUser`, `verifySession`, `requireStepUp`) against an isolated in-memory PGlite
// (`src/test/db`), and the dev-tools flag flows the real path env → `loadConfig` → handler.
//
// ───────────────────────────────────────────────────────────────────────────────────
// THE PINNED CONTRACT (chosen by the tester; the implementation conforms to it).
//
//   interface SignInAsSeams {                       // every seam optional, real defaults,
//     db?:     Db;                                  // so `route.ts` can call
//     clock?:  Clock;                               // `createSignInAsHandler()` with no args.
//     random?: Random;
//     config?: Config;
//   }
//
//   createSignInAsHandler(seams?: SignInAsSeams): { POST(request: Request): Promise<Response> }
//
//     POST (the acceptance walk posts `{ email }` — the chosen account):
//       1. Dev-tools gate: when `config.devTools` is false the route is NOT FOUND and
//          creates nothing (a 404 Response or a Next `notFound()` — both accepted here).
//       2. Validate the body at the boundary (INV-102): malformed JSON, an oversized body,
//          or a missing / mis-shaped `email` is a 4xx (never a 500), and mints nothing.
//       3. Resolve the chosen account by email (parameter-bound; INV-102). A well-formed
//          but unknown email is a 4xx and mints nothing — a SQL-shaped value is looked up
//          as data and cannot alter the query.
//       4. On a real account: create a session for it AND record a step-up at the clock,
//          set the host-locked `__Host-wh_session` cookie, and return success (2xx/3xx).
//
// Config flows in through the injected `config` seam, which production builds from
// `loadConfig` (the ONE env reader; INV-103) — so the gate's decision, and the public
// origin, derive only from what the config module parsed from the environment, never from
// a value baked into the handler. The `[secrets-from-env]` obligation is covered
// behaviourally by the last test (the identical handler reaches opposite decisions purely
// from the injected config, and ignores a contradicting `process.env`); per the
// conventions these tests assert behaviour, not the source text of the module.

import { test } from "node:test";
import assert from "node:assert/strict";
import { notFound } from "next/navigation";

import { createSignInAsHandler } from "./handler";

import { loadConfig, type Config } from "../../../server/config";
import { COOKIE_NAME, verifySession } from "../../../server/auth/session";
import { requireStepUp } from "../../../server/auth/step-up";
import { createUser, getUserByEmail } from "../../../server/db/users";
import { systemRandom } from "../../../server/seams/random";
import type { Clock } from "../../../server/seams/clock";
import { freshDb } from "../../../test/db";
import type { Db } from "../../../server/db/index";

const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;

// A frozen instant the sign-in-as happens at. The step-up is recorded at this clock, so
// its freshness is judged with no wall-clock dependence.
const T0 = new Date("2026-05-01T00:00:00.000Z");

// The step-up stays fresh for five minutes (design §5), so a clock one second past that
// window is the earliest moment a step-up is stale. We never hard-code the handler's
// internals — we advance the injected clock past the five-minute boundary and read
// `requireStepUp` (the real freshness seam) on each side of it.
const STEP_UP_WINDOW_MS = 5 * MINUTE_MS;

// The configured public base URL / origin. The request carries this `Origin` on the happy
// path so that IF the handler also enforces same-origin (as the sign-in / step-up handlers
// do) these requests still pass — this file does not otherwise test the Origin check.
const PUBLIC_BASE_URL = "https://warthog.com.au";
const GOOD_ORIGIN = "https://warthog.com.au";

// A placeholder wrapped-DEK reference; createUser stores it verbatim. Its value is
// irrelevant here — we only need a genuine `users` row so a session can hang off a real
// userId.
const WRAPPED_DEK = "wrapped-dek-placeholder";

// A complete, valid DEVELOPMENT environment for the config module (the same test-only
// secrets the dev-guard test uses, so `loadConfig` succeeds). `WARTHOG_DEV_TOOLS` is
// supplied per test via `overrides`, so the dev-tools flag flows the real path
// env → loadConfig → handler and nothing about the gate is baked in.
function devEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "development",
    PUBLIC_BASE_URL,
    WEBAUTHN_RP_ID: "warthog.com.au",
    DATABASE_URL: "pglite:memory",
    WARTHOG_HMAC_KEY: "ERERERERERERERERERERERERERERERERERERERERERE=",
    WARTHOG_DEV_KEK: "IiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiI=",
    ...overrides,
  } as NodeJS.ProcessEnv;
}

// The dev-tools-ENABLED and dev-tools-DISABLED configs, each produced by the real config
// module from an environment that differs only in the flag.
function enabledConfig(): Config {
  return loadConfig(devEnv({ WARTHOG_DEV_TOOLS: "1" }));
}
function disabledConfig(): Config {
  return loadConfig(devEnv()); // no WARTHOG_DEV_TOOLS at all
}

// A clock whose "now" a test advances, so the five-minute window is crossed
// deterministically (same shape as the sign-in step-up test). The sign-in-as and the first
// `requireStepUp` read it at `start`; advancing it then ages the step-up out.
function mutableClock(start: Date): { clock: Clock; advance(ms: number): void } {
  let current = start.getTime();
  return {
    clock: {
      now(): Date {
        return new Date(current);
      },
    },
    advance(ms: number): void {
      current += ms;
    },
  };
}

// Build the handler under test with the real db/random seams, an explicit config, and a
// test clock. Each test uses its own db + clock, so nothing leaks across tests.
function makeHandler(db: Db, config: Config, clock: Clock) {
  return createSignInAsHandler({ db, clock, random: systemRandom, config });
}

// A JSON POST request to the route, carrying the good `Origin` header.
function signInAsRequest(body: unknown): Request {
  return new Request(`${PUBLIC_BASE_URL}/dev/sign-in-as`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: GOOD_ORIGIN },
    body: JSON.stringify(body),
  });
}

// A POST request carrying a raw (not JSON.stringify-ed) body — for the malformed-JSON and
// oversized-body cases, where the body must be exactly the bytes we choose.
function rawRequest(raw: string): Request {
  return new Request(`${PUBLIC_BASE_URL}/dev/sign-in-as`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: GOOD_ORIGIN },
    body: raw,
  });
}

// The behavioural definition of "a not-found": whatever `notFound()` itself throws.
// Derived from the real function (not hardcoded) so this stays correct across Next
// versions that change the digest string.
const NOT_FOUND_DIGEST = (() => {
  try {
    notFound();
  } catch (err) {
    const digest = (err as { digest?: unknown }).digest;
    if (typeof digest === "string") return digest;
    throw new Error("notFound() threw without a string digest; cannot anchor the test");
  }
  throw new Error("notFound() did not throw; cannot anchor the test");
})();

// Assert the route is NOT FOUND, accepting EITHER buildable shape: the handler returns a
// 404 Response, or it triggers a Next `notFound()` (which throws the anchored digest). A
// route handler is not wrapped by the `/dev` layout, so whichever the builder picks, the
// client sees a 404.
async function expectNotFound(call: () => Promise<Response>): Promise<void> {
  let res: Response | undefined;
  let thrown: unknown;
  let threw = false;
  try {
    res = await call();
  } catch (err) {
    threw = true;
    thrown = err;
  }
  if (threw) {
    const digest = (thrown as { digest?: unknown }).digest;
    assert.equal(
      digest,
      NOT_FOUND_DIGEST,
      `expected a Next not-found (digest ${NOT_FOUND_DIGEST}), got digest ${String(digest)}`,
    );
    return;
  }
  assert.ok(res, "the disabled route returned no response and threw nothing");
  assert.equal(res.status, 404, `expected the disabled route to be 404, got ${res.status}`);
}

// The session token the browser would hold, pulled out of the `Set-Cookie` a successful
// sign-in-as emits (the host-locked `__Host-wh_session` cookie, value up to the first `;`).
function sessionTokenFromCookie(setCookie: string | null): string {
  assert.ok(setCookie, "a successful sign-in-as must set a session cookie");
  assert.ok(
    setCookie.startsWith(`${COOKIE_NAME}=`),
    `the session cookie must be the host-locked ${COOKIE_NAME} cookie: ${JSON.stringify(setCookie)}`,
  );
  return setCookie.slice(`${COOKIE_NAME}=`.length).split(";")[0]!;
}

// Count the sessions currently stored. Each test uses its own freshly-migrated, isolated
// database, so a total count is the right "nobody got signed in" probe. It also doubles as
// a liveness probe for the `sessions` table (a SQL-injection DROP would make this throw).
async function sessionCount(db: Db): Promise<number> {
  const result = await db.query("SELECT count(*)::int AS n FROM sessions");
  return Number(result.rows[0]?.n ?? -1);
}

// Create a genuine person row and return it. Distinct labels give distinct (unique) emails
// within a test, so two users never collide on the users.email UNIQUE.
async function freshUser(db: Db, label: string) {
  return createUser(db, { email: `${label}@warthog.com.au`, wrappedDek: WRAPPED_DEK });
}

// =====================================================================================
// AC1 — with dev tools ON, the route creates a valid session for the chosen account,
// marked stepped-up within the last 5 minutes.
// =====================================================================================

test("dev on: creates a valid session for the chosen account, marked stepped-up within the last 5 minutes", async () => {
  const c = mutableClock(T0);
  const db = await freshDb();
  try {
    const handler = makeHandler(db, enabledConfig(), c.clock);
    const user = await freshUser(db, "walker");

    const res = await handler.POST(signInAsRequest({ email: user.email }));
    assert.ok(
      res.status >= 200 && res.status < 400,
      `sign-in-as succeeds (2xx/3xx) when dev tools are on, got ${res.status}`,
    );

    // The minted session verifies, belongs to the CHOSEN account, and carries a step-up.
    const token = sessionTokenFromCookie(res.headers.get("set-cookie"));
    const session = await verifySession(db, token, { clock: c.clock });
    assert.ok(session, "the issued session token verifies");
    assert.equal(session.userId, user.id, "the session belongs to the chosen account");
    assert.ok(session.steppedUpAt != null, "the session is marked stepped-up");

    // Marked stepped-up WITHIN the last 5 minutes: fresh now, stale once the window passes.
    assert.equal(
      requireStepUp(session, { clock: c.clock }),
      true,
      "the step-up is fresh (within the 5-minute window) right after sign-in-as",
    );
    c.advance(STEP_UP_WINDOW_MS + SECOND_MS);
    assert.equal(
      requireStepUp(session, { clock: c.clock }),
      false,
      "the step-up ages out once five minutes have passed",
    );
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC2 — with dev tools OFF, the route is NOT FOUND and creates nothing (even for a real
// account and a well-formed body).
// =====================================================================================

test("dev off: the route is not found and mints no session, even for a real account", async () => {
  const c = mutableClock(T0);
  const db = await freshDb();
  try {
    const config = disabledConfig();
    assert.equal(config.devTools, false, "precondition: an absent flag parses as dev-tools-off");
    const handler = makeHandler(db, config, c.clock);
    const user = await freshUser(db, "walker");

    await expectNotFound(() => handler.POST(signInAsRequest({ email: user.email })));
    assert.equal(await sessionCount(db), 0, "a not-found route mints no session");
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC3 — with dev tools ON, a well-formed but UNKNOWN account is rejected with a 4xx and
// mints nothing (the handler validates the requested account).
// =====================================================================================

test("dev on: a well-formed but unknown account is rejected with a 4xx and mints no session", async () => {
  const c = mutableClock(T0);
  const db = await freshDb();
  try {
    const handler = makeHandler(db, enabledConfig(), c.clock);
    // No account created: "nobody@…" resolves to no user.

    const res = await handler.POST(signInAsRequest({ email: "nobody@warthog.com.au" }));
    assert.ok(
      res.status >= 400 && res.status < 500,
      `an unknown account is a 4xx, got ${res.status}`,
    );
    assert.equal(
      res.headers.get("set-cookie"),
      null,
      "the rejection sets no session cookie",
    );
    assert.equal(await sessionCount(db), 0, "an unknown account mints no session");
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC4 — [validate-and-parameterize-input] malformed / mis-shaped / oversized input is a
// 4xx (never a 500) and mints nothing.
// =====================================================================================

test("dev on: malformed, mis-shaped or oversized input is rejected with a 4xx and mints no session [validate-and-parameterize-input]", async () => {
  const c = mutableClock(T0);
  const db = await freshDb();
  try {
    const handler = makeHandler(db, enabledConfig(), c.clock);
    // A real account exists; none of these malformed requests may sign anyone in.
    await freshUser(db, "walker");

    // Malformed JSON body.
    const r1 = await handler.POST(rawRequest("{ not json"));
    assert.ok(r1.status >= 400 && r1.status < 500, `malformed JSON → 4xx, got ${r1.status}`);

    // Mis-shaped: missing the `email` field.
    const r2 = await handler.POST(signInAsRequest({}));
    assert.ok(r2.status >= 400 && r2.status < 500, `missing email → 4xx, got ${r2.status}`);

    // Mis-shaped: `email` is not a string.
    const r3 = await handler.POST(signInAsRequest({ email: 123 }));
    assert.ok(r3.status >= 400 && r3.status < 500, `non-string email → 4xx, got ${r3.status}`);

    // Oversized: a body well beyond any sane cap (> 1 MiB, the boundary's default ceiling,
    // and far beyond any tighter per-route cap). Rejected before it is even parsed.
    const huge = JSON.stringify({ email: "a".repeat(1_200_000) });
    const r4 = await handler.POST(rawRequest(huge));
    assert.ok(r4.status >= 400 && r4.status < 500, `oversized body → 4xx, got ${r4.status}`);

    assert.equal(await sessionCount(db), 0, "no malformed request mints a session");
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC4 — [validate-and-parameterize-input] a SQL-injection probe in the email field cannot
// alter a query: parameter binding treats it as data, so it signs no one in and leaves the
// schema and rows untouched.
// =====================================================================================

test("dev on: a SQL-injection probe in the email field cannot alter a query (parameter binding) [validate-and-parameterize-input]", async () => {
  const c = mutableClock(T0);
  const db = await freshDb();
  try {
    const handler = makeHandler(db, enabledConfig(), c.clock);

    // A genuine account the probes must neither authenticate as nor corrupt.
    const victim = await freshUser(db, "victim");

    // Classic probes: a tautology that would match every row if concatenated, a comment
    // that would truncate the predicate, and a statement-terminating DROP. Under parameter
    // binding each is a literal email that matches no account.
    const probes = [
      "nobody' OR '1'='1",
      "' OR 1=1 --",
      "'; DROP TABLE sessions; --",
      `${victim.email}'--`,
    ];
    for (const email of probes) {
      const res = await handler.POST(signInAsRequest({ email }));
      assert.ok(
        res.status >= 400 && res.status < 500,
        `probe ${JSON.stringify(email)} is rejected with a 4xx, got ${res.status}`,
      );
      assert.equal(
        res.headers.get("set-cookie"),
        null,
        `probe ${JSON.stringify(email)} sets no session cookie`,
      );
    }

    // Nothing was altered: no session exists, the `sessions` table still answers (it was
    // never dropped), and the real account row is intact and still resolvable by its exact
    // email — proof the probes were bound as data, not woven into the SQL.
    assert.equal(await sessionCount(db), 0, "no probe minted a session (and the table survives)");
    const stillThere = await getUserByEmail(db, victim.email);
    assert.ok(stillThere, "the real account row is intact (the users table was not altered)");
    assert.equal(stillThere.id, victim.id, "the real account resolves to the same id as before");
  } finally {
    await db.close();
  }
});

// =====================================================================================
// [secrets-from-env] — config is read from env: the gate's decision (and therefore the
// whole dev surface) derives ONLY from the injected config, which the config module parsed
// from the environment. The identical handler reaches opposite outcomes purely from the
// injected config, and ignores a contradicting `process.env` — so nothing about the gate
// is baked into the handler and no env value is read directly inside it.
// =====================================================================================

test("config is read from env: the gate follows the injected config, never process.env directly [secrets-from-env]", async () => {
  const c = mutableClock(T0);
  const db = await freshDb();
  try {
    const user = await freshUser(db, "walker");
    const enabled = enabledConfig();
    const disabled = disabledConfig();

    const original = process.env.WARTHOG_DEV_TOOLS;
    try {
      // process.env says OFF (absent), injected config says ON → the handler must still
      // mint a session, proving it follows the injected config, not the ambient env.
      delete process.env.WARTHOG_DEV_TOOLS;
      const onRes = await makeHandler(db, enabled, c.clock).POST(
        signInAsRequest({ email: user.email }),
      );
      assert.ok(
        onRes.status >= 200 && onRes.status < 400,
        `the enabled config admits regardless of process.env, got ${onRes.status}`,
      );
      assert.ok(onRes.headers.get("set-cookie"), "the enabled config mints a session");

      // process.env says ON, injected config says OFF → the handler must still be not-found.
      process.env.WARTHOG_DEV_TOOLS = "1";
      await expectNotFound(() =>
        makeHandler(db, disabled, c.clock).POST(signInAsRequest({ email: user.email })),
      );
    } finally {
      if (original === undefined) delete process.env.WARTHOG_DEV_TOOLS;
      else process.env.WARTHOG_DEV_TOOLS = original;
    }
  } finally {
    await db.close();
  }
});
