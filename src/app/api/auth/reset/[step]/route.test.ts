// Review fix W3.3 — POST /api/auth/reset/[step] dispatches each known step to the reset
// handler built (once, lazily) from the auth composition root; an unknown step is a 404
// that builds nothing. Seams are injected, so no config, database or network is touched.

import { test } from "node:test";
import assert from "node:assert/strict";

import { createResetStepHandler } from "./handler";
import * as resetRoute from "./route";

import type { ResetHandler, ResetHandlerDeps } from "../../../../(auth)/reset/handler";

const FAKE_DEPS = { marker: Symbol("reset-deps") } as unknown as ResetHandlerDeps;

const STEP_METHOD: ReadonlyArray<readonly [string, keyof ResetHandler]> = [
  ["send-code", "sendCode"],
  ["request", "request"],
  ["cancel", "cancel"],
  ["setup-send-code", "setupSendCode"],
  ["setup-verify", "setupVerify"],
  ["setup-finish", "setupFinish"],
];

function recordingHandler(calls: string[]): ResetHandler {
  const answer = (name: string) => async () => {
    calls.push(name);
    return new Response(name, { status: 200 });
  };
  return {
    sendCode: answer("sendCode"),
    request: answer("request"),
    cancel: answer("cancel"),
    setupSendCode: answer("setupSendCode"),
    setupVerify: answer("setupVerify"),
    setupFinish: answer("setupFinish"),
  };
}

const post = () => new Request("https://warthog.com.au/api/auth/reset/x", { method: "POST" });

test("each known step reaches its handler method, built once from the composition root", async () => {
  const calls: string[] = [];
  let builds = 0;
  const dispatch = createResetStepHandler({
    getDeps: async () => FAKE_DEPS,
    createHandler: (deps) => {
      assert.equal(deps, FAKE_DEPS);
      builds += 1;
      return recordingHandler(calls);
    },
  });
  for (const [step, method] of STEP_METHOD) {
    const res = await dispatch(post(), step);
    assert.equal(await res.text(), method, `${step} → ${method}`);
  }
  assert.deepEqual(calls, STEP_METHOD.map(([, method]) => method));
  assert.equal(builds, 1, "the handler is built once and reused");
});

test("an unknown step is a 404 and builds nothing", async () => {
  let built = false;
  const dispatch = createResetStepHandler({
    getDeps: async () => {
      built = true;
      return FAKE_DEPS;
    },
  });
  for (const step of ["sendCode", "setupFinish", "setup", "constructor", "__proto__", "complete", ""]) {
    assert.equal((await dispatch(post(), step)).status, 404, `${step || "(empty)"} is not a step`);
  }
  assert.equal(built, false, "no config or database was touched");
});

test("the route module exports only POST", () => {
  assert.deepEqual(Object.keys(resetRoute).sort(), ["POST"]);
});
