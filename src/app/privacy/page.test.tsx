// E05-S03 — Privacy page entry (src/app/privacy/page.tsx).
//
// RED-first: today this entry is the operator placeholder ("Privacy" ComingSoon: a
// heading, an "On its way" empty state and "still being built" copy) — it states
// nothing about Australia, device encryption, releases, or exporting/deleting. The
// assertions below FAIL until the builder replaces it with the real screen that
// mounts the privacy / security-FAQ VIEW (src/components/public/privacy.tsx). That
// absence is the entire point of test-first — do not implement anything to make
// these pass.
//
// What this task is (E05-S03): a PUBLIC `/privacy` page, reachable by anyone with
// NO authentication, that returns 200 and shows the privacy policy / security FAQ.
//
// How these tests stay honest:
//   * They assert BEHAVIOUR — what the page entry's default export RENDERS for an
//     unauthenticated visitor — never the source text of page.tsx. A later
//     behaviour-preserving refactor (a moved import, reworded copy, a different
//     wrapper, extracting the view) stays green as long as the assembled page still
//     renders publicly and surfaces the real policy content.
//   * They import ONLY the page's framework field (its default export). A Next
//     `page.tsx` may export only its reserved route keys, so this file never demands
//     a non-framework export from the entry — the full content contract (Australia,
//     device encryption, release-then-discard, export/delete) lives in the sibling
//     src/components/public/privacy.test.tsx. Here we only prove the page is PUBLIC
//     and mounts that real view, keying on a little distinctive content the
//     placeholder LACKS (not on the placeholder's absence).
//
// We render with `react-dom/server` (no DOM/jsdom — React component / E2E testing is
// a per-job ADR) and read the emitted markup, mirroring the landing / help / compat
// page tests.

import * as React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";

import PrivacyPage from "./page";

// --- a complete, valid environment for the config module -----------------------
// The privacy policy needs no config in its acceptance criteria, but the builder may
// follow the server-page convention (read searchParams, then composition root) and
// touch `loadConfig()`. Supplying a complete, valid env slate (the repo's test-only
// HMAC key and dev KEK, same fixture the help/compatibility page tests use) keeps the
// render robust to either an async-config page or a plain static one — it is a no-op
// if the entry ignores config.
const BASE_ENV: Record<string, string> = {
  NODE_ENV: "development",
  PUBLIC_BASE_URL: "https://privacy.warthog.example",
  WEBAUTHN_RP_ID: "localhost",
  DATABASE_URL: "pglite:memory",
  WARTHOG_HMAC_KEY: "ERERERERERERERERERERERERERERERERERERERERERE=",
  WARTHOG_DEV_KEK: "IiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiI=",
};
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

// The VISIBLE text a person reads: tags (and therefore every attribute) stripped.
function visibleText(markup: string): string {
  return decode(markup.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

// Render the page entry's default export (the route's screen) with env applied. The
// entry mounts a static screen, so it renders without a live request scope.
// `searchParams` / `params` are supplied as resolved promises (the Next 15 shape) so
// an entry that reads them sees an empty, fresh GET; one that ignores them is
// unaffected. The result may be sync JSX or an async server component — await either.
async function renderPage(): Promise<string> {
  assert.equal(
    typeof PrivacyPage,
    "function",
    "the privacy entry must have a default-exported page component",
  );
  const restore = applyEnv();
  try {
    const element = await Promise.resolve(
      (PrivacyPage as (props: unknown) => unknown)({
        searchParams: Promise.resolve({}),
        params: Promise.resolve({}),
      }),
    );
    return renderToStaticMarkup(element as React.ReactElement);
  } finally {
    restore();
  }
}

// === AC2 — public, returns 200 with no authentication ==========================
//
// `/privacy` sits at the top level (not inside a protected route group and under no
// guard layout), so an unauthenticated visitor must get the page, not a
// redirect/throw. If the builder put it behind a guard that reads a session, or read
// per-request data outside a request scope, rendering here (no request scope, no
// session) would throw — this catches that. A screen that renders is the render-test
// proxy for "returns 200 with no authentication".

test("privacy page renders for an unauthenticated visitor (public, not behind a guard)", async () => {
  let markup: string;
  try {
    markup = await renderPage();
  } catch (err) {
    assert.fail(
      "the privacy page must render for an unauthenticated visitor — a public privacy policy must not sit behind a guard that redirects or throws without a session, nor read request data outside a request scope: " +
        (err instanceof Error ? err.message : String(err)),
    );
    return;
  }
  assert.ok(
    visibleText(markup).length >= 8,
    `the privacy page must render a real screen with no authentication, got: "${visibleText(markup)}"`,
  );
});

// === AC1 — mounts the real privacy policy, replacing the placeholder ===========
//
// The assembled page shows the real policy, not the "On its way" placeholder. We key
// on a little distinctive content the placeholder LACKS — it is stored in Australia,
// and you can export or delete everything. The full content contract is enforced in
// the sibling component test; here this just proves the placeholder is gone and the
// real view is mounted.

test("privacy page mounts the real policy: names Australia and the export/delete rights", async () => {
  const text = visibleText(await renderPage());
  const low = text.toLowerCase();

  assert.ok(
    /\baustralia\b/i.test(low),
    `the privacy page must state data is stored in Australia (the placeholder does not), got: "${text}"`,
  );
  assert.ok(
    low.includes("export"),
    `the privacy page must explain you can export everything (the placeholder does not), got: "${text}"`,
  );
  assert.ok(
    /\bdelet/i.test(low),
    `the privacy page must explain you can delete your account (the placeholder does not), got: "${text}"`,
  );
});
