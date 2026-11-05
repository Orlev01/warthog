// E17-S07 — the dev-tools guard (`src/server/dev/guard.ts`).
//
// RED-first: `./guard` does not exist yet, so importing it throws — every test here
// fails at import until the builder writes the module. That absence IS the point of
// test-first; do not implement anything to make these pass.
//
// Why this seam: the `/dev` affordances must only exist when `WARTHOG_DEV_TOOLS=1`
// (which the production config refuses to start with — see `assertProductionSafe` in
// `src/server/config.ts`). A single gate keeps the whole dev surface off by default and
// out of production: the thin `src/app/dev/layout.tsx` entry calls this guard, which
// admits the request when dev tools are enabled and triggers a Next not-found when they
// are not — so every `/dev` route 404s unless the flag is explicitly set.
//
// Why test the guard and not the layout: a `layout.tsx` is an awkward unit-test target
// (reserved Next props, it may export only its framework default, and the gate's effect
// — `notFound()` — throws). So the testable decision lives in this server seam and the
// entry stays thin over it (conventions: thin entries over tested modules), exactly as
// the admin `(protected)/layout.tsx` delegates to `src/server/auth/guard.ts`. These
// tests therefore drive the GUARD directly and never import the layout entry.
//
// These tests pin BEHAVIOUR (does the guard admit, or does it trigger a not-found, for a
// given config), never source text — a later rename that preserves behaviour must not
// redden them.
//
// The contract this task defines (the builder implements exactly this):
//
//   requireDevTools(config: Config): void
//     • Reads the dev-tools flag through the config module (`config.devTools`, which the
//       config module parsed from the environment) — never from `process.env` directly.
//     • When dev tools are enabled it returns normally (admits the request).
//     • When dev tools are disabled it triggers a Next not-found (`notFound()`), which
//       throws — so a `/dev` route under the guard renders the 404 page.
//
// Acceptance criteria → tests:
//   AC1 "When WARTHOG_DEV_TOOLS is set, the guard allows access." — an enabled config
//        admits (no throw).
//   AC2 "When it is unset, the guard triggers a not-found." — a disabled config throws
//        the Next not-found signal (digest matched against the real `notFound()`), and
//        only the literal "1" enables (so "0"/absent both 404).
//   AC "The guard reads the flag through the config module and never through process.env
//        directly." — with process.env set to the OPPOSITE of the injected config, the
//        guard follows the injected config, proving it never reads the env var itself.
//   AC [secrets-from-env] "config is read from env" — the flag flows env → config module
//        → guard; the same guard code reaches opposite decisions purely from the env the
//        config module parsed, so nothing about the gate is baked in.
//
// NOTE on the two obligation ACs carried by this task:
//   • [validate-and-parameterize-input] — this task adds no input-taking handler and no
//     database query: the guard's only argument is a trusted `Config` produced by the
//     config module. There is no untrusted input to validate and no SQL to parameterize
//     here, so that obligation has no concrete surface in E17-S07 (its real tests live
//     with the actual `/dev` handlers in sibling tasks). Inventing a handler to satisfy
//     a templated obligation would violate YAGNI and the test-first rule.
//   • [secrets-from-env] — covered behaviourally below: the gate's decision derives only
//     from config (which the config module reads from the environment); no flag value is
//     hardcoded into the guard.
//
// Tests never touch the network, a database, or Azure.
import { test } from "node:test";
import assert from "node:assert/strict";
import { notFound } from "next/navigation";

import { requireDevTools } from "./guard";
import { loadConfig } from "../config";

// A complete, valid development environment for the config module. The HMAC key and dev
// KEK are the repo's test-only values (same as the auth guard test); they let
// `loadConfig` succeed. `WARTHOG_DEV_TOOLS` is supplied per test via `overrides`.
function devEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "development",
    PUBLIC_BASE_URL: "https://warthog.example",
    WEBAUTHN_RP_ID: "localhost",
    DATABASE_URL: "pglite:memory",
    WARTHOG_HMAC_KEY: "ERERERERERERERERERERERERERERERERERERERERERE=",
    WARTHOG_DEV_KEK: "IiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiI=",
    ...overrides,
  } as NodeJS.ProcessEnv;
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

// Assert the guard triggered a Next not-found: it threw, and the thrown value carries
// the same digest `notFound()` produces (so a `/dev` route renders the 404 page).
function expectNotFound(call: () => unknown): void {
  let thrown: unknown;
  let threw = false;
  try {
    call();
  } catch (err) {
    threw = true;
    thrown = err;
  }
  assert.ok(threw, "expected the guard to trigger a not-found, but it returned normally");
  const digest = (thrown as { digest?: unknown }).digest;
  assert.equal(
    digest,
    NOT_FOUND_DIGEST,
    `expected a Next not-found (digest ${NOT_FOUND_DIGEST}), got digest ${String(digest)}`,
  );
}

// --- AC1: the flag set admits ------------------------------------------------------

test("when WARTHOG_DEV_TOOLS is set, the guard allows access", () => {
  const config = loadConfig(devEnv({ WARTHOG_DEV_TOOLS: "1" }));
  assert.equal(config.devTools, true, "precondition: the config module parsed the flag as enabled");
  assert.doesNotThrow(
    () => requireDevTools(config),
    "an enabled config must admit the request (no not-found)",
  );
});

// --- AC2: the flag unset / off triggers a not-found --------------------------------

test("when WARTHOG_DEV_TOOLS is unset, the guard triggers a not-found", () => {
  const config = loadConfig(devEnv()); // no WARTHOG_DEV_TOOLS at all
  assert.equal(config.devTools, false, "precondition: an absent flag parses as disabled");
  expectNotFound(() => requireDevTools(config));
});

test('WARTHOG_DEV_TOOLS="0" also triggers a not-found (only the literal "1" enables)', () => {
  const config = loadConfig(devEnv({ WARTHOG_DEV_TOOLS: "0" }));
  assert.equal(config.devTools, false, "precondition: \"0\" parses as disabled");
  expectNotFound(() => requireDevTools(config));
});

// --- AC: reads the flag through config, never through process.env directly ---------

test("the guard decides from the config object, never from process.env directly", () => {
  // Build both decisions up front, then make process.env contradict each one. If the
  // guard read process.env itself it would flip; it must instead follow the injected
  // config, which is the only thing the config module ever read the flag from.
  const enabledConfig = loadConfig(devEnv({ WARTHOG_DEV_TOOLS: "1" }));
  const disabledConfig = loadConfig(devEnv()); // flag off in this config

  const original = process.env.WARTHOG_DEV_TOOLS;
  try {
    // process.env says OFF, injected config says ON → the guard must still admit.
    delete process.env.WARTHOG_DEV_TOOLS;
    assert.doesNotThrow(
      () => requireDevTools(enabledConfig),
      "guard must follow the enabled config even when process.env has no flag",
    );
    process.env.WARTHOG_DEV_TOOLS = "";
    assert.doesNotThrow(
      () => requireDevTools(enabledConfig),
      "guard must follow the enabled config even when process.env.WARTHOG_DEV_TOOLS is empty",
    );

    // process.env says ON, injected config says OFF → the guard must still 404.
    process.env.WARTHOG_DEV_TOOLS = "1";
    expectNotFound(() => requireDevTools(disabledConfig));
  } finally {
    if (original === undefined) delete process.env.WARTHOG_DEV_TOOLS;
    else process.env.WARTHOG_DEV_TOOLS = original;
  }
});

// --- AC [secrets-from-env]: the flag flows env → config module → guard -------------

test("config is read from env: the same guard reaches opposite decisions from the env alone [secrets-from-env]", () => {
  // Nothing about the gate is baked in: flip only the environment the config module
  // parses, and the identical guard call flips with it.
  assert.doesNotThrow(
    () => requireDevTools(loadConfig(devEnv({ WARTHOG_DEV_TOOLS: "1" }))),
    "an env with the flag set, parsed by the config module, must admit",
  );
  expectNotFound(() => requireDevTools(loadConfig(devEnv())));
});
