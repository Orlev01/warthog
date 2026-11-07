// E11-S18 — Vault unlock-method endpoint: the App-Router entry
// `src/app/api/vault/unlock-method/route.ts`.
//
// RED-first: the entry `./route` does not exist yet, so importing it throws and every test
// here fails until the builder writes the module. That absence IS the point of test-first —
// as the TESTER I must NOT create or edit any implementation/source file to make these pass.
//
// A Next App-Router `route.ts` may export ONLY the known route keys (the HTTP verbs +
// framework config like `runtime`) or `next build` rejects it (OBS-025). The injectable
// factory that lets the handler be unit-tested (`createVaultUnlockHttpHandlers`) therefore
// lives in `src/server/vault/unlock-http.ts` (pinned in its own test), and this entry imports
// it and exports only its verb. The browser SAVES a wrapped vault key, so the entry exports a
// `POST`.
//
// These tests pin the entry's EXPORT SHAPE as behaviour (exactly what OBS-025 / `next build`
// enforce), never the source text — a rename inside the handler that preserves behaviour must
// not redden them. Importing the entry must be side-effect-free (the factory resolves its
// config/db/session seams lazily, per request), so this import boots no database and reads no
// config.

import { test } from "node:test";
import assert from "node:assert/strict";

import * as route from "./route";

// The only exports Next permits on a `route.ts`: the HTTP verbs plus framework config keys.
const VERB_KEYS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);
const CONFIG_KEYS = new Set([
  "runtime",
  "dynamic",
  "dynamicParams",
  "revalidate",
  "fetchCache",
  "preferredRegion",
  "maxDuration",
  "generateStaticParams",
  "generateMetadata",
]);

test("the unlock-method entry exports a POST handler for the browser's save", () => {
  assert.equal(
    typeof (route as Record<string, unknown>).POST,
    "function",
    "the browser saves a wrapped vault key, so the entry must export a POST handler",
  );
});

test("the entry exports ONLY framework route keys — the injection factory stays in src/server/vault/unlock-http.ts (OBS-025)", () => {
  for (const key of Object.keys(route)) {
    assert.ok(
      VERB_KEYS.has(key) || CONFIG_KEYS.has(key),
      `route.ts may export only HTTP verbs + framework config; found a non-framework export "${key}" (OBS-025)`,
    );
  }

  for (const [key, value] of Object.entries(route)) {
    if (typeof value === "function") {
      assert.ok(VERB_KEYS.has(key), `only HTTP-verb functions may be exported from route.ts; found "${key}"`);
    }
  }

  assert.ok(
    !("createVaultUnlockHttpHandlers" in route),
    "the injection factory lives in src/server/vault/unlock-http.ts, never on the route entry (OBS-025)",
  );
});
