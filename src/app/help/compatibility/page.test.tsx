// E05-S02 — Compatibility page entry (src/app/help/compatibility/page.tsx).
//
// RED-first: today this entry is the operator placeholder ("Which agents work with
// Warthog" ComingSoon) — it names none of the agent platforms, shows no connector
// address, and notes no platform gap. The assertions below FAIL until the builder
// replaces it with the real thin entry that mounts the help/compatibility VIEW
// (src/components/public/help.tsx), passing the connector address derived from
// config. That absence is the entire point of test-first — do not implement
// anything to make these pass.
//
// What this task is (E05-S02): a PUBLIC `/help/compatibility` page, reachable by
// anyone with NO authentication, that mounts the `Help` view. The page's own job is
// to read the public address from configuration (INV-21) — `config.publicBaseUrl`,
// via `loadConfig()` called INSIDE the handler (never at module load; next build
// evaluates route modules with no runtime config) — derive Warthog's connector
// address (`<publicBaseUrl>/mcp`, design §6.1/§6.2) and hand it to the view.
//
// How these tests stay honest:
//   * They assert BEHAVIOUR — what the page entry's default export RENDERS for an
//     unauthenticated visitor — never the source text of page.tsx. A later
//     behaviour-preserving refactor (a moved import, reworded copy, a different
//     wrapper) stays green as long as the assembled page still mounts the help view
//     with a config-driven connector address.
//   * They import ONLY the page's framework field (its default export). A Next
//     `page.tsx` may export only its reserved route keys, so this file never demands
//     a non-framework export from the entry (the view's own content contract — every
//     platform, connect steps, the gap note — lives in the sibling
//     src/components/public/help.test.tsx).
//   * The "replaces the placeholder" check keys on content the placeholder LACKS
//     (the platform names + the config-derived connector address), not on the
//     placeholder's absence.
//   * The connector address flows env -> config module -> page: these tests set a
//     DISTINCTIVE `PUBLIC_BASE_URL` and assert the derived address appears, proving
//     the page reads the public address from configuration rather than hard-coding
//     it. The flag/secret fixture mirrors the config module's contract exactly as
//     the sibling dev-tools page test does.
//
// We render with `react-dom/server` (no DOM/jsdom — React component / E2E testing
// is a per-job ADR) and read the emitted markup, mirroring the landing page test.

import * as React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";

import CompatibilityPage from "./page";

// --- a complete, valid environment for the config module -----------------------
// The HMAC key and dev KEK are the repo's test-only base64 values that let
// `loadConfig` succeed (same fixture the dev-tools page test uses). PUBLIC_BASE_URL
// is distinctive so we can prove the connector address is derived from it. The page
// calls `loadConfig()` (no arg), which reads the real process.env, so these tests
// set process.env around the render and restore it afterwards.
const PUBLIC_BASE_URL = "https://compat.warthog.example";
const CONNECTOR_ADDRESS = `${PUBLIC_BASE_URL}/mcp`; // design §6.1/§6.2: the MCP endpoint

const BASE_ENV: Record<string, string> = {
  NODE_ENV: "development",
  PUBLIC_BASE_URL,
  WEBAUTHN_RP_ID: "localhost",
  DATABASE_URL: "pglite:memory",
  WARTHOG_HMAC_KEY: "ERERERERERERERERERERERERERERERERERERERERERE=",
  WARTHOG_DEV_KEK: "IiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiI=",
};
// Every env key these tests touch, so each case starts from a known slate.
const ENV_KEYS = [...Object.keys(BASE_ENV), "WARTHOG_DEV_TOOLS"];

// Apply the env slate to process.env and return a restore function. node:test runs a
// file's tests sequentially, so set/restore around a single render is safe.
function applyEnv(): () => void {
  const saved = new Map<string, string | undefined>();
  for (const key of ENV_KEYS) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(BASE_ENV)) process.env[key] = value;
  return () => {
    for (const key of ENV_KEYS) {
      const prev = saved.get(key);
      if (prev === undefined) delete process.env[key];
      else process.env[key] = prev;
    }
  };
}

// --- tiny markup helpers (no DOM) ----------------------------------------------

function decode(s: string): string {
  return s
    .replace(/&amp;/gi, "&")
    .replace(/&#x27;/gi, "'")
    .replace(/&#39;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&nbsp;/gi, " ");
}

function visibleText(markup: string): string {
  return decode(markup.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

// Render the page entry's default export (the route's screen) with env applied. The
// thin entry mounts a static view, so it renders without a live request scope.
// `searchParams` / `params` are supplied as resolved promises (the Next 15 shape) so
// an entry that reads them sees an empty, fresh GET; one that ignores them is
// unaffected. The result may be sync JSX or an async server component — await either.
async function renderPage(): Promise<string> {
  assert.equal(
    typeof CompatibilityPage,
    "function",
    "the compatibility entry must have a default-exported page component",
  );
  const restore = applyEnv();
  try {
    const element = await Promise.resolve(
      (CompatibilityPage as (props: unknown) => unknown)({
        searchParams: Promise.resolve({}),
        params: Promise.resolve({}),
      }),
    );
    return renderToStaticMarkup(element as React.ReactElement);
  } finally {
    restore();
  }
}

// The six agent platforms the task names, as substrings (Llama matches
// "Llama-based clients"). The placeholder front door shows none of them.
const PLATFORMS = ["Claude", "ChatGPT", "Gemini", "Grok", "Llama", "Other"] as const;

// === AC2 — public, no authentication ===========================================
//
// `/help/compatibility` sits at the top level (not inside a protected route group
// and under no guard layout), so an unauthenticated visitor must get the page, not a
// redirect/throw. If the builder put it behind a guard that reads a session, or read
// per-request data outside a request scope, rendering here (no request scope, no
// session) would throw — this catches that. A screen that renders is the render-test
// proxy for "returns 200 with no authentication".

test("compatibility page renders for an unauthenticated visitor (public, not behind a guard)", async () => {
  let markup: string;
  try {
    markup = await renderPage();
  } catch (err) {
    assert.fail(
      "the compatibility page must render for an unauthenticated visitor — a public help page must not sit behind a guard that redirects or throws without a session, nor read request data outside a request scope: " +
        (err instanceof Error ? err.message : String(err)),
    );
    return;
  }
  assert.ok(
    visibleText(markup).length >= 8,
    `the compatibility page must render a real screen with no authentication, got: "${visibleText(markup)}"`,
  );
});

// === AC1 — mounts the real help view, with the config-driven connector address ==
//
// The assembled page mounts the help view: every agent platform the placeholder
// LACKS, plus the connector address DERIVED FROM CONFIG (proving the page reads the
// public address from configuration, INV-21 — the distinctive PUBLIC_BASE_URL set
// above appears, joined to the "/mcp" endpoint path). Keying on this content proves
// the placeholder page has been replaced by the real compatibility view.

test("compatibility page mounts the help view: every platform and the config-derived connector address", async () => {
  const markup = await renderPage();
  const text = visibleText(markup);
  const low = text.toLowerCase();

  for (const platform of PLATFORMS) {
    assert.ok(
      low.includes(platform.toLowerCase()),
      `the compatibility page must name "${platform}" (the placeholder does not), got: "${text}"`,
    );
  }

  assert.ok(
    decode(markup).includes(CONNECTOR_ADDRESS),
    `the compatibility page must show Warthog's connector address derived from configuration ("${CONNECTOR_ADDRESS}" from PUBLIC_BASE_URL), got: ${decode(markup)}`,
  );
});
