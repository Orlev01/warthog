// E18-S16 — Help page entry (src/app/help/page.tsx).
//
// RED-first: today this entry is the operator placeholder ("Help" ComingSoon: a
// heading, an "On its way" empty state and "still being built" copy) — it names no
// sections, carries no links to compatibility / recover / privacy and says nothing
// about approvals or "Ask me first". The assertions below FAIL until the builder
// replaces it with the real plain-language help screen. That absence is the entire
// point of test-first — do not implement anything to make these pass.
//
// What this task is (E18-S16): a PUBLIC `/help` page, reachable by anyone with NO
// authentication (a person locked out of their account still needs it), that
// explains in plain Australian English what Warthog is, how to connect an agent
// (linking /help/compatibility), how approvals and "Ask me first" work, how to
// recover an account (linking /recover) and the privacy summary (linking /privacy).
// The copy carries no protocol jargon (no "OAuth", "MCP", "DCR" or "token").
//
// How these tests stay honest:
//   * They assert BEHAVIOUR — what the page entry's default export RENDERS for an
//     unauthenticated visitor — never the source text of page.tsx. A later
//     behaviour-preserving refactor (a moved import, reworded copy, a different
//     wrapper or an extracted view component) stays green as long as the assembled
//     page still shows the four sections and the three links.
//   * They import ONLY the page's framework field (its default export). A Next
//     `page.tsx` may export only its reserved route keys, so this file never demands
//     a non-framework export from the entry; whatever view component the builder
//     extracts can carry its own sibling content test.
//   * The "replaces the placeholder" checks key on content the placeholder LACKS
//     (the /help/compatibility, /recover and /privacy links, "Ask me first", the
//     section copy), not on the placeholder's absence.
//   * The jargon check is correctly scoped to THIS page's own visible output — the
//     acceptance criterion is precisely "no OAuth / MCP / DCR / token on the page",
//     so the unit under test IS the whole /help render. It reads the stripped
//     VISIBLE text (what a person reads), not tag attributes, so link hrefs and
//     class names can never trip it.
//
// We render with `react-dom/server` (no DOM/jsdom — React component / E2E testing is
// a per-job ADR) and read the emitted markup, mirroring the landing and compatibility
// page tests.

import * as React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";

import HelpPage from "./page";

// --- a complete, valid environment for the config module -----------------------
// The help overview needs no config in its acceptance criteria, but the builder may
// follow the server-page convention (read searchParams, then composition root) and
// touch `loadConfig()`. Supplying a complete, valid env slate (the repo's test-only
// HMAC key and dev KEK, same fixture the compatibility page test uses) keeps the
// render robust to either an async-config page or a plain static one — it is a no-op
// if the entry ignores config.
const BASE_ENV: Record<string, string> = {
  NODE_ENV: "development",
  PUBLIC_BASE_URL: "https://help.warthog.example",
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

// The VISIBLE text a person reads: tags (and therefore every attribute — href,
// class, …) stripped. The jargon check runs against this, so a link target like
// "/help/compatibility" in an href can never be mistaken for on-page copy.
function visibleText(markup: string): string {
  return decode(markup.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

// Every rendered link target, from an href on any element (a Next <Link> renders an
// <a href="…"> in static markup; a plain <a> does too).
function hrefs(markup: string): string[] {
  const out: string[] = [];
  for (const m of markup.matchAll(/\bhref="([^"]*)"/gi)) out.push(decode(m[1]!));
  return out;
}

// Render the page entry's default export (the route's screen) with env applied. The
// entry mounts a static screen, so it renders without a live request scope.
// `searchParams` / `params` are supplied as resolved promises (the Next 15 shape) so
// an entry that reads them sees an empty, fresh GET; one that ignores them is
// unaffected. The result may be sync JSX or an async server component — await either.
async function renderPage(): Promise<string> {
  assert.equal(
    typeof HelpPage,
    "function",
    "the help entry must have a default-exported page component",
  );
  const restore = applyEnv();
  try {
    const element = await Promise.resolve(
      (HelpPage as (props: unknown) => unknown)({
        searchParams: Promise.resolve({}),
        params: Promise.resolve({}),
      }),
    );
    return renderToStaticMarkup(element as React.ReactElement);
  } finally {
    restore();
  }
}

// === AC1 — public, reachable with no authentication ============================
//
// `/help` sits at the top level (not inside a protected route group and under no
// guard layout), so an unauthenticated visitor — including someone locked out of
// their account — must get the page, not a redirect/throw. If the builder put it
// behind a guard that reads a session, or read per-request data outside a request
// scope, rendering here (no request scope, no session) would throw — this catches
// that. A screen that renders is the render-test proxy for "returns 200 with no
// authentication".

test("help page renders for an unauthenticated visitor (public, not behind a guard)", async () => {
  let markup: string;
  try {
    markup = await renderPage();
  } catch (err) {
    assert.fail(
      "the help page must render for an unauthenticated visitor — a person locked out of their account still needs help, so it must not sit behind a guard that redirects or throws without a session, nor read request data outside a request scope: " +
        (err instanceof Error ? err.message : String(err)),
    );
    return;
  }
  assert.ok(
    visibleText(markup).length >= 8,
    `the help page must render a real screen with no authentication, got: "${visibleText(markup)}"`,
  );
});

// === AC1 — the three links the placeholder lacks ===============================
//
// The real help page points to the compatibility guide, account recovery and the
// privacy policy. Keying on these link targets (the placeholder has none) proves the
// placeholder has been replaced by the real screen.

test("help page links to /help/compatibility, /recover and /privacy", async () => {
  const markup = await renderPage();
  const links = hrefs(markup);

  for (const target of ["/help/compatibility", "/recover", "/privacy"]) {
    assert.ok(
      links.includes(target),
      `the help page must link to ${target} (the placeholder links nowhere), got hrefs: ${JSON.stringify(links)}`,
    );
  }
});

// === AC1 — the four sections, in plain words ===================================
//
// The page shows sections on connecting an agent, approvals (and the "Ask me first"
// setting the brief/CLAUDE.md vocabulary names), account recovery and privacy. These
// assert the visible copy carries each topic — content the "On its way" placeholder
// lacks.

test("help page shows all four sections: connecting an agent, approvals / Ask me first, recovery and privacy", async () => {
  const markup = await renderPage();
  const text = visibleText(markup);
  const low = text.toLowerCase();

  // Connecting an agent — "connect an agent", "connecting your agents", …
  assert.match(
    low,
    /connect[\s\S]{0,40}agent/i,
    `the help page must explain connecting an agent, got: "${text}"`,
  );

  // Approvals, and the exact "Ask me first" wording (brief copy; CLAUDE.md UI vocab).
  assert.match(
    low,
    /approv/i,
    `the help page must explain how approvals work, got: "${text}"`,
  );
  assert.ok(
    low.includes("ask me first"),
    `the help page must name the "Ask me first" setting in those exact words, got: "${text}"`,
  );

  // Account recovery (links to /recover) — the copy itself names recovery.
  assert.match(
    low,
    /recover/i,
    `the help page must explain how to recover an account, got: "${text}"`,
  );

  // Privacy summary (links to /privacy) — the copy itself names privacy.
  assert.match(
    low,
    /privacy/i,
    `the help page must include the privacy summary, got: "${text}"`,
  );
});

// === AC2 — no protocol jargon in the visible copy ==============================
//
// The brief forbids protocol/security jargon on primary screens; this task names the
// four terms that must never appear on the help page: "OAuth", "MCP", "DCR", "token".
// Scoped to THIS page's own visible text (the exact unit the AC governs) and read
// from the stripped copy, so a link href or class name can't be mistaken for on-page
// jargon. Substring match (case-insensitive) so plurals/compounds like "tokens" are
// caught too — none of these fragments occur inside the plain words the page needs
// (connect, agent, approve, recover, privacy, Warthog).

test("help page copy carries no protocol jargon (no OAuth / MCP / DCR / token)", async () => {
  const markup = await renderPage();
  const low = visibleText(markup).toLowerCase();

  for (const term of ["oauth", "mcp", "dcr", "token"]) {
    assert.ok(
      !low.includes(term),
      `the help page copy must use plain Australian English with no protocol jargon — found "${term}" in the visible text: "${low}"`,
    );
  }
});
