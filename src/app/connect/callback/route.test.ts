// E09-S18 — Provider OAuth callback route ENTRY (`src/app/connect/callback/route.ts`).
//
// RED-first: the entry `./route` does not exist yet, so importing it throws and every test
// here fails until the builder writes the module. That absence IS the point of test-first.
//
// A Next App-Router `route.ts` may export ONLY the known route keys (the HTTP verbs +
// framework config like `runtime`) or `next build` rejects it (OBS-025). The injectable
// factory that lets the handler be unit-tested (`createConnectCallbackHandler`) must
// therefore live in the SIBLING `handler.ts` (pinned in `handler.test.ts`), and the entry
// imports it and exports only its verb(s). The provider's redirect is a GET, so the entry
// exports a `GET`.
//
// These tests pin the entry's EXPORT SHAPE as behaviour (which is exactly what OBS-025 /
// `next build` enforce), never the source text — a rename inside the handler that preserves
// behaviour must not redden them. Importing the entry must be side-effect-free (the factory
// resolves its config/db seams lazily, per request), so this import never boots a database.

import { test } from "node:test";
import assert from "node:assert/strict";

import * as route from "./route";

// The only exports Next permits on a `route.ts`: the HTTP verbs plus framework config keys.
// Anything else (a leaked factory or seam) breaks `next build` (OBS-025).
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

test("the /connect/callback entry exports a GET handler for the provider redirect", () => {
  assert.equal(
    typeof (route as Record<string, unknown>).GET,
    "function",
    "the provider's OAuth redirect lands as a GET, so the entry must export a GET handler",
  );
});

test("the entry exports ONLY framework route keys — the injection factory stays in the sibling handler.ts (OBS-025)", () => {
  for (const key of Object.keys(route)) {
    assert.ok(
      VERB_KEYS.has(key) || CONFIG_KEYS.has(key),
      `route.ts may export only HTTP verbs + framework config; found a non-framework export "${key}" (OBS-025 — put seams/factories in the sibling handler.ts)`,
    );
  }

  // Every function export is an HTTP verb — no factory/seam leaked onto the entry.
  for (const [key, value] of Object.entries(route)) {
    if (typeof value === "function") {
      assert.ok(VERB_KEYS.has(key), `only HTTP-verb functions may be exported from route.ts; found "${key}"`);
    }
  }

  assert.ok(
    !("createConnectCallbackHandler" in route),
    "the injection factory lives in the sibling handler.ts, never on the route entry (OBS-025)",
  );
});
