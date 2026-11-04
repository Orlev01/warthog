// E04-S23 — the sign-up HTTP endpoint: POST /api/auth/signup/[step].
//
// RED-first: neither the route entry (`./route`) nor its sibling injection factory
// (`./handler`, `createSignupStepHandler`) exists yet, so importing them throws and
// every test here fails until the builder adds them. That absence IS the point of
// test-first — do NOT implement anything to make these pass.
//
// What ships under this task (the contract these tests define):
//
//   ./handler.ts  — the testable sibling. A `route.ts` may export ONLY the known
//     route keys (the HTTP verbs) or `next build` rejects it (OBS-025), so the
//     injectable seam lives HERE, beside the entry. It is a factory that builds the
//     sign-up handler ONCE from the auth composition root and returns a step
//     dispatcher:
//
//       createSignupStepHandler(seams?: {
//         getDeps?: () => Promise<SignupHandlerDeps>;        // defaults to getSignupDeps
//         createHandler?: (d: SignupHandlerDeps) => SignupHandler; // defaults to createSignupHandler
//       }): (request: Request, step: string) => Promise<Response>
//
//     The dispatcher maps the `[step]` segment to the matching handler method:
//       send-code -> sendCode, verify-email -> verifyEmail,
//       register-passkey -> registerPasskey, confirm -> confirmSignup.
//     An unknown step is a 404. The handler is built lazily, on the first request,
//     and reused — so merely constructing the dispatcher touches no config or db,
//     which keeps the entry importable under `next build` (runtime config absent).
//
//   ./route.ts   — the thin entry: reads `{ step }` from the dynamic segment and
//     delegates to the dispatcher, exporting ONLY `POST`.
//
// These tests pin BEHAVIOUR (which method a step reaches, the response the dispatcher
// returns, the HTTP outcome of bad input), never the source text of the modules — a
// later rename that preserves behaviour must not redden them. The dispatch proof runs
// through the injectable factory with FAKE deps (a spy handler built from injected
// deps), so no browser, Azure, config or network is needed; the composition-root and
// validate-and-parameterize proofs run the REAL composition root (getSignupDeps) over
// an isolated in-memory PGlite (src/test/db) with dev tooling, so the dev outbox
// captures mail and the real repos parameter-bind every query.
//
// ─── Acceptance criteria → tests ─────────────────────────────────────────────────────
//   AC1 POST send-code / verify-email / register-passkey / confirm each reach the
//       matching sign-up handler method (through the injectable factory with fake deps).
//   AC2 POST to an unknown step returns 404, and the route module exports only POST.
//   AC3 the handler is built from the auth composition root (getSignupDeps), not from
//       createDb or process.env inside src/app.
//   AC4 [obligation:validate-and-parameterize-input] a handler rejects malformed or
//       oversized input with a 4xx, and a SQL-injection probe in an input field cannot
//       alter a query (parameter binding is used).

import { test } from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";

import { createSignupStepHandler } from "./handler";
import * as signupRoute from "./route";

import type {
  SignupHandler,
  SignupHandlerDeps,
} from "../../../../(auth)/signup/handler";
import { getSignupDeps } from "../../../../../server/auth/compose";
import { loadConfig } from "../../../../../server/config";
import { outbox } from "../../../../../server/notify/outbox";
import { freshDb } from "../../../../../test/db";
import type { Db } from "../../../../../server/db/index";

// --- fixtures -----------------------------------------------------------------------

// A valid DEVELOPMENT environment (dev tools on, a local dev KEK, pglite), the base the
// composition-root tests build config from. loadConfig(env) is a pure function of this
// record, so no test mutates the real process environment. publicBaseUrl's origin is
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

// The Origin the dev-config handler accepts (origin of PUBLIC_BASE_URL). The real
// handler refuses anything else, so the composition-root requests carry exactly this.
const DEV_ORIGIN = new URL(DEV_ENV.PUBLIC_BASE_URL).origin;

function devConfig() {
  return loadConfig({ ...DEV_ENV } as NodeJS.ProcessEnv);
}

// A sentinel deps object. The dispatch tests fake `createHandler` to ignore it and
// return a spy, so its fields never matter — but its IDENTITY is asserted, to prove
// the handler is built FROM the deps the composition root (getDeps) produced.
const FAKE_DEPS = { marker: Symbol("signup-deps") } as unknown as SignupHandlerDeps;

// The step -> handler-method contract this route implements.
const STEP_METHOD: ReadonlyArray<readonly [string, keyof SignupHandler]> = [
  ["send-code", "sendCode"],
  ["verify-email", "verifyEmail"],
  ["register-passkey", "registerPasskey"],
  ["confirm", "confirmSignup"],
];

// A spy sign-up handler: each method records the request it received and the exact
// Response it returned (a sentinel 222 so it is unmistakably the method's own output,
// never a 404/4xx the dispatcher itself produced), so a test can assert both WHICH
// method a step reached and that the dispatcher returned its response verbatim.
function spySignupHandler() {
  const calls: Array<{ method: keyof SignupHandler; request: Request; response: Response }> = [];
  const make = (method: keyof SignupHandler) => async (request: Request): Promise<Response> => {
    const response = new Response(`spy:${String(method)}`, {
      status: 222,
      headers: { "x-spy-method": String(method) },
    });
    calls.push({ method, request, response });
    return response;
  };
  const handler: SignupHandler = {
    sendCode: make("sendCode"),
    verifyEmail: make("verifyEmail"),
    registerPasskey: make("registerPasskey"),
    confirmSignup: make("confirmSignup"),
  };
  return { handler, calls };
}

// A JSON POST request. `origin: null` sends no Origin at all; a raw string body is sent
// verbatim (for malformed JSON), anything else is JSON-encoded. The dispatch tests use
// a spy handler that ignores Origin; the composition-root tests need DEV_ORIGIN.
function post(body: unknown, origin: string | null = DEV_ORIGIN): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (origin !== null) headers.origin = origin;
  return new Request("http://localhost:3000/api/auth/signup/x", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

// A random tag so dev-outbox assertions (the outbox is a process-wide singleton shared
// with every other test) find THIS test's message without assuming it is alone.
function tag(): string {
  return Math.random().toString(36).slice(2);
}

// Count the email_codes rows for one address (bound as a parameter).
async function emailCodeCount(db: Db, email: string): Promise<number> {
  const result = await db.query("SELECT count(*)::int AS n FROM email_codes WHERE email = $1", [email]);
  return Number(result.rows[0]?.n ?? -1);
}

// A dispatcher wired to the REAL composition root over `db` (dev config, dev tooling),
// leaving createHandler at its default (the real createSignupHandler) — so the whole
// route -> composition root -> real handler -> real db path is exercised.
function realDispatch(db: Db) {
  return createSignupStepHandler({
    getDeps: () => getSignupDeps({ config: devConfig(), getDb: async () => db }),
  });
}

// =====================================================================================
// AC1 — each known step reaches its matching sign-up handler method (fake deps).
// =====================================================================================

test("each known sign-up step reaches its matching handler method and returns that method's response verbatim", async () => {
  const { handler, calls } = spySignupHandler();
  const dispatch = createSignupStepHandler({
    getDeps: async () => FAKE_DEPS,
    createHandler: () => handler,
  });

  for (const [step, method] of STEP_METHOD) {
    const request = post({ probe: step });
    const response = await dispatch(request, step);

    const last = calls.at(-1);
    assert.ok(last, `dispatching ${step} must reach a handler method`);
    assert.equal(last.method, method, `${step} must reach ${String(method)}`);
    assert.equal(last.request, request, `${step} must forward the original request unchanged`);
    assert.equal(response, last.response, `${step} must return the handler method's response verbatim`);
    assert.equal(response.status, 222, `the response is the method's own (sentinel), not a dispatcher status`);
  }

  // Exactly one method call per step — no step fanned out to a second method.
  assert.equal(calls.length, STEP_METHOD.length, "each step reaches exactly one handler method");
});

// =====================================================================================
// AC3 — the handler is built ONCE from the composition root (getDeps), lazily, and the
// handler is built from the very deps getDeps returned.
// =====================================================================================

test("the sign-up handler is built once from the composition root and reused across requests", async () => {
  const { handler } = spySignupHandler();
  let getDepsCount = 0;
  let createHandlerCount = 0;
  let receivedDeps: SignupHandlerDeps | undefined;

  const dispatch = createSignupStepHandler({
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
    await dispatch(post({ probe: step }), step);
  }

  assert.equal(getDepsCount, 1, "the composition root is consulted exactly once, not per request");
  assert.equal(createHandlerCount, 1, "the handler is built exactly once, not per request");
  assert.equal(receivedDeps, FAKE_DEPS, "the handler is built FROM the deps the composition root produced");
});

test("the dispatcher builds nothing until the first request (so the route entry stays import-safe)", async () => {
  const { handler } = spySignupHandler();
  let getDepsCount = 0;

  const dispatch = createSignupStepHandler({
    getDeps: async () => {
      getDepsCount += 1;
      return FAKE_DEPS;
    },
    createHandler: () => handler,
  });

  assert.equal(getDepsCount, 0, "merely constructing the dispatcher must not touch the composition root");
  await dispatch(post({ email: "x@warthog.com.au" }), "send-code");
  assert.equal(getDepsCount, 1, "the handler is built on the first request");
});

// =====================================================================================
// AC2 — an unknown step is 404; the route module exports only POST.
// =====================================================================================

test("an unknown sign-up step returns 404 and reaches no handler method", async () => {
  const { handler, calls } = spySignupHandler();
  const dispatch = createSignupStepHandler({
    getDeps: async () => FAKE_DEPS,
    createHandler: () => handler,
  });

  // Exact-match only: a missing, misspelt, undercased or path-injected step is unknown.
  const unknownSteps = ["", "bogus", "sendcode", "send_code", "SEND-CODE", "confirm/extra", "signup"];
  for (const step of unknownSteps) {
    const response = await dispatch(post({ anything: true }), step);
    assert.equal(response.status, 404, `unknown step ${JSON.stringify(step)} must be 404`);
  }
  assert.equal(calls.length, 0, "an unknown step reaches no handler method");
});

test("the sign-up route module exports only POST (OBS-025: the injection seam lives in the sibling, not the entry)", () => {
  const keys = Object.keys(signupRoute);
  assert.ok(keys.includes("POST"), "the route must export a POST handler");
  assert.equal(typeof signupRoute.POST, "function", "POST is the route handler function");
  assert.deepEqual(keys.sort(), ["POST"], "the entry exports ONLY POST — no factory, no other verb");
});

// =====================================================================================
// AC3 (functional) — the REAL composition root produces a working handler the route
// dispatches to: a well-formed send-code lands a code in the dev outbox.
// =====================================================================================

test("built from the real composition root, a well-formed send-code step works end to end", async () => {
  const db = await freshDb();
  try {
    const dispatch = realDispatch(db);
    const email = `s23-${tag()}@warthog.com.au`;

    const response = await dispatch(post({ email }), "send-code");
    assert.equal(response.status, 200, "a well-formed send-code returns 200 through the real handler");

    const delivered = outbox
      .list()
      .filter((m) => m.channel === "email" && m.recipient === email);
    assert.equal(delivered.length, 1, "the composition root wired a working email sender (dev outbox captured the code)");
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC4 [obligation:validate-and-parameterize-input] — bad input dispatched through the
// route is a 4xx (never a 500), and an injection probe is bound as data.
// =====================================================================================

test("[obligation:validate-and-parameterize-input] malformed and mis-shaped send-code input is a 4xx (never a 500)", async () => {
  const db = await freshDb();
  try {
    const dispatch = realDispatch(db);

    // All carry a valid Origin, so the ONLY reason to reject is the input itself.
    const badBodies: unknown[] = [
      "{ not valid json at all",
      {},
      { email: 123 },
      { email: [] },
      { email: null },
    ];
    for (const body of badBodies) {
      const response = await dispatch(post(body), "send-code");
      assert.ok(
        response.status >= 400 && response.status < 500,
        `bad input ${JSON.stringify(body)} must be a 4xx, got ${response.status}`,
      );
    }
  } finally {
    await db.close();
  }
});

test("[obligation:validate-and-parameterize-input] an oversized send-code body is a 4xx before any work", async () => {
  const db = await freshDb();
  try {
    const dispatch = realDispatch(db);
    const email = `oversize-${tag()}@warthog.com.au`;

    // A schema-valid shape padded past any reasonable body cap (~2 MiB).
    const huge = { email, pad: "x".repeat(2 * 1024 * 1024) };
    const response = await dispatch(post(huge), "send-code");
    assert.ok(response.status >= 400 && response.status < 500, `an oversized body must be a 4xx, got ${response.status}`);
    assert.equal(
      outbox.list().filter((m) => m.recipient === email).length,
      0,
      "an oversized body sends nothing",
    );
  } finally {
    await db.close();
  }
});

test("[obligation:validate-and-parameterize-input] a SQL-injection probe in the email field is bound as data and cannot alter a query", async () => {
  const db = await freshDb();
  try {
    const dispatch = realDispatch(db);

    // A baseline code row; if the probe below were concatenated into SQL rather than
    // bound, the trailing statement would drop the table and take this row with it.
    const safeEmail = `survivor-${tag()}@warthog.com.au`;
    const baseline = await dispatch(post({ email: safeEmail }), "send-code");
    assert.equal(baseline.status, 200, "a baseline code is issued before the probe");
    const beforeCount = await emailCodeCount(db, safeEmail);
    assert.ok(beforeCount >= 1, "the baseline code row exists");

    // The classic injection probe through the email field, with a valid Origin. Bound
    // as a parameter it is stored as data; it never runs as SQL and never crashes.
    const probe = "robert'); DROP TABLE email_codes; --@warthog.com.au";
    const response = await dispatch(post({ email: probe }), "send-code");
    assert.ok(response.status < 500, `the probe must be handled, not crash the server (got ${response.status})`);

    // The injection did NOT execute: the table still exists and still holds the baseline row.
    await db.query("SELECT 1 FROM email_codes LIMIT 1");
    assert.ok(
      (await emailCodeCount(db, safeEmail)) >= beforeCount,
      "the baseline code survived — the probe was data, not SQL",
    );
  } finally {
    await db.close();
  }
});
