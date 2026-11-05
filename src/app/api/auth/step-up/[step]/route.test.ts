// E04-S36 — Confirm-it's-you (step-up) endpoints: the HTTP endpoint
// POST /api/auth/step-up/[step] (begin, finish).
//
// RED-first: neither the route entry (`./route`) nor the injectable step dispatcher it
// wraps (`createStepUpStepHandler`, in `src/server/auth/step-up-handler.ts`) exists yet,
// so importing them throws and every test here fails until the builder adds them. That
// absence IS the point of test-first — do NOT implement anything to make these pass.
//
// What ships under this task (the contract these tests define):
//
//   src/server/auth/step-up-handler.ts — the testable sibling seam of the route. A Next
//     App-Router `route.ts` may export ONLY the known route keys (the HTTP verbs) or
//     `next build` rejects it (OBS-025), so the injectable factory lives in the server
//     module the route entry imports, never on the entry. It builds the step-up handler
//     ONCE from the auth composition root and returns a step dispatcher:
//
//       createStepUpStepHandler(seams?: {
//         getDeps?: () => Promise<StepUpHandlerDeps>;             // defaults to getStepUpDeps
//         createHandler?: (d: StepUpHandlerDeps) => StepUpHandler; // defaults to createStepUpHandler
//       }): (request: Request, step: string) => Promise<Response>
//
//     The dispatcher maps the `[step]` segment to the matching handler method:
//       begin -> begin, finish -> finish. An unknown step is a 404. The handler is built
//       LAZILY, on the first request, and reused — so merely constructing the dispatcher
//       touches no config or db, which keeps the entry importable under `next build`.
//
//   ./route.ts — the thin entry: reads `{ step }` from the dynamic segment and delegates
//     to the dispatcher, exporting ONLY `POST`.
//
// These tests pin BEHAVIOUR (which method a step reaches, the response the dispatcher
// returns, the HTTP outcome end to end), never the source text of the modules — a later
// behaviour-preserving rename must not redden them. The dispatch proofs run through the
// injectable factory with FAKE deps (a spy handler), so no browser, Azure, config or
// network is needed; the composition-root proofs run the REAL composition root
// (getStepUpDeps) over an isolated in-memory PGlite (src/test/db) with dev config, so the
// real repos parameter-bind every query.
//
// ─── Acceptance criteria → tests ─────────────────────────────────────────────────────
//   AC1 POST begin / finish each reach the matching step-up handler method (through the
//       injectable factory with fake deps).
//   AC2 POST to an unknown step returns 404, and the route module exports only POST.
//   AC3 the handler is built once, lazily, from the auth composition root (getStepUpDeps),
//       not from createDb or process.env inside src/app.
//   AC4 end-to-end through the REAL composition root: a valid own-passkey begin→finish
//       records a step-up; a foreign Origin is 403; a no-session request is a 4xx; a
//       malformed body is a 4xx and an injection probe is bound as data.

import { test } from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";

import { createStepUpStepHandler } from "../../../../../server/auth/step-up-handler";
import * as stepUpRoute from "./route";

import type {
  StepUpHandler,
  StepUpHandlerDeps,
} from "../../../../../server/auth/step-up-handler";
import { getStepUpDeps } from "../../../../../server/auth/compose";
import { loadConfig } from "../../../../../server/config";
import { createUser } from "../../../../../server/db/users";
import { createSession, verifySession, COOKIE_NAME } from "../../../../../server/auth/session";
import { beginPasskeyRegistration, finishPasskeyRegistration } from "../../../../../server/auth/passkey";
import { createAuthenticator } from "../../../../../test/authenticator";
import { systemClock } from "../../../../../server/seams/clock";
import { systemRandom } from "../../../../../server/seams/random";
import { freshDb } from "../../../../../test/db";
import type { Db } from "../../../../../server/db/index";
import type { PublicKeyCredentialRequestOptionsJSON } from "@simplewebauthn/server";

// --- fixtures -----------------------------------------------------------------------

// A valid DEVELOPMENT environment (dev tools on, a local dev KEK, pglite), the base the
// composition-root tests build config from. loadConfig(env) is a pure function of this
// record, so no test mutates the real process environment. PUBLIC_BASE_URL's origin is
// the Origin the real handler checks every request against; WEBAUTHN_RP_ID is the RP ID.
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

// The Origin the dev-config handler accepts (origin of PUBLIC_BASE_URL), and the RP ID.
const DEV_ORIGIN = new URL(DEV_ENV.PUBLIC_BASE_URL).origin;
const DEV_RP_ID = DEV_ENV.WEBAUTHN_RP_ID;

const WRAPPED_DEK = "wrapped-dek-placeholder";

function devConfig() {
  return loadConfig({ ...DEV_ENV } as NodeJS.ProcessEnv);
}

// A random tag so accounts never collide on the users.email UNIQUE across tests.
function tag(): string {
  return Math.random().toString(36).slice(2);
}

// A sentinel deps object. The dispatch tests fake `createHandler` to ignore it and return
// a spy, so its fields never matter — but its IDENTITY is asserted, to prove the handler
// is built FROM the deps the composition root (getDeps) produced.
const FAKE_DEPS = { marker: Symbol("step-up-deps") } as unknown as StepUpHandlerDeps;

// The step -> handler-method contract this route implements.
const STEP_METHOD: ReadonlyArray<readonly [string, keyof StepUpHandler]> = [
  ["begin", "begin"],
  ["finish", "finish"],
];

// A spy step-up handler: each method records the request it received and returns a
// sentinel 222 response (unmistakably the method's own output, never a 404/4xx the
// dispatcher itself produces), so a test can assert WHICH method a step reached and that
// the dispatcher returned its response verbatim.
function spyStepUpHandler() {
  const calls: Array<{ method: keyof StepUpHandler; request: Request; response: Response }> = [];
  const make = (method: keyof StepUpHandler) => async (request: Request): Promise<Response> => {
    const response = new Response(`spy:${String(method)}`, {
      status: 222,
      headers: { "x-spy-method": String(method) },
    });
    calls.push({ method, request, response });
    return response;
  };
  const handler: StepUpHandler = { begin: make("begin"), finish: make("finish") };
  return { handler, calls };
}

// A POST request for `step`. `token` (when given) rides in the `__Host-wh_session`
// cookie; `origin: null` sends no Origin header; a body is JSON-encoded (a raw string is
// sent verbatim, for malformed JSON).
function request(
  step: string,
  { token, origin = DEV_ORIGIN, body }: { token?: string | null; origin?: string | null; body?: unknown } = {},
): Request {
  const headers: Record<string, string> = {};
  if (origin !== null) headers.origin = origin;
  if (token != null) headers.cookie = `${COOKIE_NAME}=${token}`;
  const init: RequestInit = { method: "POST", headers };
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = typeof body === "string" ? body : JSON.stringify(body);
  }
  return new Request(`http://localhost:3000/api/auth/step-up/${step}`, init);
}

// A dispatcher wired to the REAL composition root over `db` (dev config, dev tooling),
// leaving createHandler at its default (the real createStepUpHandler) — so the whole
// route -> composition root -> real handler -> real db path is exercised.
function realDispatch(db: Db) {
  return createStepUpStepHandler({
    getDeps: () => getStepUpDeps({ config: devConfig(), getDb: async () => db }),
  });
}

// =====================================================================================
// AC1 — each known step reaches its matching step-up handler method (fake deps).
// =====================================================================================

test("each known step reaches its matching step-up handler method and returns that method's response verbatim", async () => {
  const { handler, calls } = spyStepUpHandler();
  const dispatch = createStepUpStepHandler({
    getDeps: async () => FAKE_DEPS,
    createHandler: () => handler,
  });

  for (const [step, method] of STEP_METHOD) {
    const req = request(step);
    const response = await dispatch(req, step);

    const last = calls.at(-1);
    assert.ok(last, `dispatching ${step} must reach a handler method`);
    assert.equal(last.method, method, `${step} must reach ${String(method)}`);
    assert.equal(last.request, req, `${step} must forward the original request unchanged`);
    assert.equal(response, last.response, `${step} must return the handler method's response verbatim`);
    assert.equal(response.status, 222, "the response is the method's own (sentinel), not a dispatcher status");
  }

  assert.equal(calls.length, STEP_METHOD.length, "each step reaches exactly one handler method");
});

// =====================================================================================
// AC3 — the handler is built ONCE from the composition root (getDeps), lazily, and from
// the very deps getDeps returned.
// =====================================================================================

test("the step-up handler is built once from the composition root and reused across requests", async () => {
  const { handler } = spyStepUpHandler();
  let getDepsCount = 0;
  let createHandlerCount = 0;
  let receivedDeps: StepUpHandlerDeps | undefined;

  const dispatch = createStepUpStepHandler({
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

  for (const [step] of STEP_METHOD) {
    await dispatch(request(step), step);
  }

  assert.equal(getDepsCount, 1, "the composition root is consulted exactly once, not per request");
  assert.equal(createHandlerCount, 1, "the handler is built exactly once, not per request");
  assert.equal(receivedDeps, FAKE_DEPS, "the handler is built FROM the deps the composition root produced");
});

test("the dispatcher builds nothing until the first request (so the route entry stays import-safe)", async () => {
  const { handler } = spyStepUpHandler();
  let getDepsCount = 0;

  const dispatch = createStepUpStepHandler({
    getDeps: async () => {
      getDepsCount += 1;
      return FAKE_DEPS;
    },
    createHandler: () => handler,
  });

  assert.equal(getDepsCount, 0, "merely constructing the dispatcher must not touch the composition root");
  await dispatch(request("begin", { token: "a-token" }), "begin");
  assert.equal(getDepsCount, 1, "the handler is built on the first request");
});

test("createStepUpStepHandler() with no seams constructs without touching config or a database", () => {
  // The default-seam construction (what route.ts does at module load) must not throw and
  // must not read config / open a db — proof the entry is importable under `next build`.
  assert.doesNotThrow(() => {
    const dispatch = createStepUpStepHandler();
    assert.equal(typeof dispatch, "function", "the dispatcher is a request handler function");
  });
});

test("a failed bring-up is not cached: the next request retries the composition root", async () => {
  const { handler } = spyStepUpHandler();
  let getDepsCount = 0;
  const dispatch = createStepUpStepHandler({
    getDeps: async () => {
      getDepsCount += 1;
      if (getDepsCount === 1) throw new Error("database briefly unreachable");
      return FAKE_DEPS;
    },
    createHandler: () => handler,
  });

  await assert.rejects(dispatch(request("begin", { token: "t1" }), "begin"), /briefly unreachable/);
  const res = await dispatch(request("begin", { token: "t2" }), "begin");
  assert.equal(getDepsCount, 2, "the second request consulted the composition root again");
  assert.ok(res instanceof Response, "the retried bring-up serves the request");
});

// =====================================================================================
// AC2 — an unknown step is 404; the route module exports only POST.
// =====================================================================================

test("an unknown step returns 404 and reaches no handler method", async () => {
  const { handler, calls } = spyStepUpHandler();
  const dispatch = createStepUpStepHandler({
    getDeps: async () => FAKE_DEPS,
    createHandler: () => handler,
  });

  // Exact-match only: a missing, misspelt, miscased or path-injected step is unknown.
  const unknownSteps = ["", "bogus", "Begin", "begin ", "finish/extra", "begin-passkey", "stepup"];
  for (const step of unknownSteps) {
    const response = await dispatch(request(step, { token: "t" }), step);
    assert.equal(response.status, 404, `unknown step ${JSON.stringify(step)} must be 404`);
  }
  assert.equal(calls.length, 0, "an unknown step reaches no handler method");
});

test("the step-up route module exports only POST (OBS-025: the injection seam lives in the sibling, not the entry)", () => {
  const keys = Object.keys(stepUpRoute);
  assert.ok(keys.includes("POST"), "the route must export a POST handler");
  assert.equal(typeof (stepUpRoute as { POST: unknown }).POST, "function", "POST is the route handler function");
  assert.deepEqual(keys.sort(), ["POST"], "the entry exports ONLY POST — no factory, no other verb");
});

// =====================================================================================
// AC4 — end to end through the REAL composition root. The real handler uses the real
// clock, so sessions are created at the real "now" (not a frozen past) to sit inside
// their validity window.
// =====================================================================================

test("built from the real composition root, a valid own-passkey begin→finish records a step-up on the current session", async () => {
  const db = await freshDb();
  try {
    const dispatch = realDispatch(db);

    const user = await createUser(db, { email: `stepup-e2e-${tag()}@warthog.com.au`, wrappedDek: WRAPPED_DEK });
    // Origin + RP ID match the dev composition root, so the step-up assertion verifies.
    const auth = createAuthenticator({ origin: DEV_ORIGIN });
    const regOptions = await beginPasskeyRegistration(
      db,
      { userId: user.id, userName: user.email },
      { rpId: DEV_RP_ID, origin: DEV_ORIGIN },
    );
    const regResponse = await auth.register(regOptions);
    const reg = await finishPasskeyRegistration(
      db,
      { userId: user.id, response: regResponse },
      { rpId: DEV_RP_ID, origin: DEV_ORIGIN },
    );
    assert.equal(reg.ok, true, "setup passkey registration verifies");

    const created = await createSession(db, user.id, { clock: systemClock, random: systemRandom });

    // begin → options → authenticate → finish, all through the route dispatcher.
    const beginRes = await dispatch(request("begin", { token: created.token }), "begin");
    assert.equal(beginRes.status, 200, "begin returns options for the signed-in person");
    const beginBody = (await beginRes.json()) as { options?: PublicKeyCredentialRequestOptionsJSON };
    assert.ok(beginBody.options, "begin returns WebAuthn authentication options");

    const assertion = await auth.authenticate(beginBody.options);
    const finishRes = await dispatch(
      request("finish", { token: created.token, body: { authenticationResponse: assertion } }),
      "finish",
    );
    assert.ok(finishRes.status < 400, `a valid finish succeeds (not a 4xx/5xx), got ${finishRes.status}`);

    const session = await verifySession(db, created.token, { clock: systemClock });
    assert.ok(session?.steppedUpAt != null, "the finish recorded a step-up on the current session");
  } finally {
    await db.close();
  }
});

test("built from the real composition root, a foreign-Origin step-up is 403 and a no-session step-up is a 4xx", async () => {
  const db = await freshDb();
  try {
    const dispatch = realDispatch(db);
    const user = await createUser(db, { email: `stepup-e2e-guard-${tag()}@warthog.com.au`, wrappedDek: WRAPPED_DEK });
    const created = await createSession(db, user.id, { clock: systemClock, random: systemRandom });

    const foreign = await dispatch(
      request("begin", { token: created.token, origin: "https://evil.example" }),
      "begin",
    );
    assert.equal(foreign.status, 403, "a foreign-Origin step-up is forbidden");

    const noSession = await dispatch(request("begin", { token: null }), "begin");
    assert.ok(noSession.status >= 400 && noSession.status < 500, `a no-session begin is a 4xx, got ${noSession.status}`);
  } finally {
    await db.close();
  }
});

test("[obligation:validate-and-parameterize-input] through the real composition root, malformed input is a 4xx and an injection probe is bound as data", async () => {
  const db = await freshDb();
  try {
    const dispatch = realDispatch(db);

    const user = await createUser(db, { email: `stepup-e2e-probe-${tag()}@warthog.com.au`, wrappedDek: WRAPPED_DEK });
    const created = await createSession(db, user.id, { clock: systemClock, random: systemRandom });

    // Malformed JSON with a valid session + Origin → a controlled 4xx, never a 500.
    const malformed = await dispatch(request("finish", { token: created.token, body: "{ not json" }), "finish");
    assert.ok(malformed.status >= 400 && malformed.status < 500, `malformed input must be a 4xx, got ${malformed.status}`);

    // A SQL-injection probe as the session token: bound as its hash (parameterized), it
    // matches no session and never runs as SQL — the sessions table and the baseline
    // session both survive.
    const probe = "robert'); DROP TABLE sessions; --";
    const injected = await dispatch(request("begin", { token: probe }), "begin");
    assert.ok(injected.status < 500, `the probe must be handled, not crash the server (got ${injected.status})`);

    await db.query("SELECT 1 FROM sessions LIMIT 1");
    assert.ok(
      await verifySession(db, created.token, { clock: systemClock }),
      "the baseline session survived — the token was data, not SQL",
    );
  } finally {
    await db.close();
  }
});
