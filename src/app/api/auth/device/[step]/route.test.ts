// E04-S32 — the new-device sign-in HTTP endpoint: POST /api/auth/device/[step].
//
// RED-first: neither the route entry (`./route`) nor its sibling injection factory
// (`./handler`, `createDeviceStepHandler`) exists yet, so importing them throws and
// every test here fails until the builder adds them. That absence IS the point of
// test-first — do NOT implement anything to make these pass.
//
// What ships under this task (the contract these tests define):
//
//   ./handler.ts  — the testable sibling. A Next App-Router `route.ts` may export
//     ONLY the known route keys (the HTTP verbs) or `next build` rejects it (OBS-025),
//     so the injectable seam lives HERE, beside the entry. It is a factory that builds
//     the new-device handler (E04-S31 `createDeviceHandler`) ONCE from the auth
//     composition root and returns a step dispatcher:
//
//       createDeviceStepHandler(seams?: {
//         getDeps?: () => Promise<DeviceHandlerDeps>;             // defaults to the composition root
//         createHandler?: (d: DeviceHandlerDeps) => DeviceHandler; // defaults to createDeviceHandler
//       }): (request: Request, step: string) => Promise<Response>
//
//     The dispatcher maps the `[step]` segment to the matching new-device handler method
//     (the handshake's three steps, exactly as the task names them — request / approve /
//     collect):
//       request -> requestApproval
//       approve -> approve
//       collect -> collect
//     An unknown step is a 404 — and because the map is checked BEFORE the handler is
//     built, an unknown step is answered without ever consulting the composition root
//     (so a bare, config-less process still 404s). The handler is built lazily, on the
//     first KNOWN request, and reused — so merely constructing the dispatcher, or
//     answering an unknown step, touches no config and opens no database, which keeps
//     the entry importable under `next build` (runtime config absent; the
//     server-composition-roots addendum) and is why the route never calls createDb or
//     reads process.env.
//
//   ./route.ts   — the thin entry: awaits `{ step }` from the dynamic segment and
//     delegates to the dispatcher, exporting ONLY `POST`.
//
// These tests pin BEHAVIOUR (which method a step reaches, the response the dispatcher
// returns verbatim, the HTTP outcome of an unknown step, the module's exported
// surface), never the source text of the modules — a later rename that preserves
// behaviour must not redden them. The dispatch proofs run through the injectable
// factory with FAKE deps (a spy handler built from injected deps), so no browser,
// Azure, config or network is needed. (The new-device handler's own validate /
// parameterize / Origin / session / round-trip behaviour is already pinned by its
// sibling's tests under src/app/(auth)/device; this task is purely the HTTP step
// surface.)
//
// ─── Acceptance criteria → tests ─────────────────────────────────────────────────────
//   AC1 POST request / approve / collect each reach the matching new-device handler
//       method (through the injectable factory with fake deps), built once from the auth
//       composition root.
//   AC2 POST to an unknown step returns 404 (reaching no handler method), the route
//       entry exports ONLY POST, and neither constructing the dispatcher nor answering
//       an unknown step consults the composition root — so the route never calls
//       createDb or reads process.env.

import { test } from "node:test";
import assert from "node:assert/strict";

import { createDeviceStepHandler } from "./handler";
import * as deviceRoute from "./route";

import type {
  DeviceHandler,
  DeviceHandlerDeps,
} from "../../../../(auth)/device/handler";

// --- fixtures -----------------------------------------------------------------------

// A sentinel deps object. The dispatch tests fake `createHandler` to ignore it and
// return a spy, so its fields never matter — but its IDENTITY is asserted, to prove
// the handler is built FROM the deps the composition root (getDeps) produced.
const FAKE_DEPS = { marker: Symbol("device-deps") } as unknown as DeviceHandlerDeps;

// The step -> handler-method contract this route implements: the three handshake steps
// the task names (request / approve / collect), mapped to the new-device handler's own
// method names (`requestApproval` is reached by the `request` step).
const STEP_METHOD: ReadonlyArray<readonly [string, keyof DeviceHandler]> = [
  ["send-code", "sendCode"],
  ["request", "requestApproval"],
  ["approve", "approve"],
  ["collect", "collect"],
];

// A spy new-device handler: each method records the request it received and the exact
// Response it returned (a sentinel 222 so it is unmistakably the method's own output,
// never a 404 the dispatcher itself produced), so a test can assert both WHICH method
// a step reached and that the dispatcher returned its response verbatim.
function spyDeviceHandler() {
  const calls: Array<{ method: keyof DeviceHandler; request: Request; response: Response }> = [];
  const make = (method: keyof DeviceHandler) => async (request: Request): Promise<Response> => {
    const response = new Response(`spy:${String(method)}`, {
      status: 222,
      headers: { "x-spy-method": String(method) },
    });
    calls.push({ method, request, response });
    return response;
  };
  const handler: DeviceHandler = {
    sendCode: make("sendCode"),
    requestApproval: make("requestApproval"),
    approve: make("approve"),
    collect: make("collect"),
  };
  return { handler, calls };
}

// A JSON POST request. The dispatch tests use a spy handler that ignores Origin, so the
// Origin here is incidental; it just makes a well-formed request.
function post(body: unknown): Request {
  return new Request("http://localhost:3000/api/auth/device/x", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost:3000" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

// =====================================================================================
// AC1 — each known step reaches its matching new-device handler method (fake deps).
// =====================================================================================

test("each known device step reaches its matching handler method and returns that method's response verbatim", async () => {
  const { handler, calls } = spyDeviceHandler();
  const dispatch = createDeviceStepHandler({
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
    assert.equal(response.status, 222, "the response is the method's own (sentinel), not a dispatcher status");
  }

  assert.equal(calls.length, STEP_METHOD.length, "each step reaches exactly one handler method");
});

// =====================================================================================
// AC1 — the handler is built ONCE from the composition root (getDeps), lazily, from the
// very deps getDeps returned, and reused across requests.
// =====================================================================================

test("the device handler is built once from the composition root and reused across requests", async () => {
  const { handler } = spyDeviceHandler();
  let getDepsCount = 0;
  let createHandlerCount = 0;
  let receivedDeps: DeviceHandlerDeps | undefined;

  const dispatch = createDeviceStepHandler({
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

test("the dispatcher builds nothing until the first known request (so the route entry stays import-safe)", async () => {
  const { handler } = spyDeviceHandler();
  let getDepsCount = 0;

  const dispatch = createDeviceStepHandler({
    getDeps: async () => {
      getDepsCount += 1;
      return FAKE_DEPS;
    },
    createHandler: () => handler,
  });

  assert.equal(getDepsCount, 0, "merely constructing the dispatcher must not touch the composition root");
  await dispatch(post({ email: "x@warthog.com.au", code: "123456", deviceLabel: "Phone" }), "request");
  assert.equal(getDepsCount, 1, "the handler is built on the first request");
});

// =====================================================================================
// AC2 — an unknown step is 404 (reaching no handler method), and an unknown step does
// NOT consult the composition root (answered before the handler is ever built).
// =====================================================================================

test("an unknown device step returns 404 and reaches no handler method", async () => {
  const { handler, calls } = spyDeviceHandler();
  const dispatch = createDeviceStepHandler({
    getDeps: async () => FAKE_DEPS,
    createHandler: () => handler,
  });

  // Exact-match only: a missing, misspelt, undercased, path-injected or object-inherited
  // step is unknown. Note `approve`/`collect` ARE valid slugs, so they are deliberately
  // absent here; only the step whose slug differs from its method name (`request` ->
  // `requestApproval`) has near-miss negatives — the camelCase/kebab method spellings
  // must NOT resolve.
  const unknownSteps = [
    "",
    "bogus",
    "requestApproval",
    "request-approval",
    "requestapproval",
    "REQUEST",
    "Approve",
    "COLLECT",
    "request/extra",
    "collect/x",
    "device",
    "new-device",
    "constructor",
    "__proto__",
    "toString",
  ];
  for (const step of unknownSteps) {
    const response = await dispatch(post({ anything: true }), step);
    assert.equal(response.status, 404, `unknown step ${JSON.stringify(step)} must be 404`);
  }
  assert.equal(calls.length, 0, "an unknown step reaches no handler method");
});

test("an unknown step is 404 WITHOUT consulting the composition root (no createDb / no process.env read)", async () => {
  let getDepsCount = 0;
  let createHandlerCount = 0;
  const { handler } = spyDeviceHandler();
  const dispatch = createDeviceStepHandler({
    getDeps: async () => {
      getDepsCount += 1;
      return FAKE_DEPS;
    },
    createHandler: () => {
      createHandlerCount += 1;
      return handler;
    },
  });

  const response = await dispatch(post({ anything: true }), "not-a-step");
  assert.equal(response.status, 404, "an unknown step is 404");
  assert.equal(getDepsCount, 0, "an unknown step must not reach the composition root (where config/db would be read)");
  assert.equal(createHandlerCount, 0, "an unknown step must not build the handler");
});

// =====================================================================================
// AC2 — the route entry exports ONLY POST, and delegates to the dispatcher. Driving the
// REAL route entry with an unknown step proves the wiring (await params -> dispatch ->
// 404) end to end WITHOUT any config or database — the config-less path that shows the
// route reads no process.env and opens no db at import or on this request.
// =====================================================================================

test("the device route module exports only POST (OBS-025: the injection seam lives in the sibling, not the entry)", () => {
  const keys = Object.keys(deviceRoute);
  assert.ok(keys.includes("POST"), "the route must export a POST handler");
  assert.equal(typeof deviceRoute.POST, "function", "POST is the route handler function");
  assert.deepEqual(keys.sort(), ["POST"], "the entry exports ONLY POST — no factory, no other verb");
});

test("the route's POST awaits the [step] param and 404s an unknown step through the real dispatcher (no config/db needed)", async () => {
  const request = post({ anything: true });
  const response = await deviceRoute.POST(request, {
    params: Promise.resolve({ step: "definitely-not-a-device-step" }),
  });
  assert.equal(response.status, 404, "the real route entry resolves the dynamic segment and 404s an unknown step");
});
