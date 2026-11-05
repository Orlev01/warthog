// E05-S01 — Home page entry (src/app/page.tsx).
//
// RED-first: today this entry is the operator placeholder front door — it renders
// only the "Warthog" heading and the positioning line, with none of the landing's
// steps, compatibility list or sign-up/sign-in links. The assertions below FAIL
// until the builder replaces it with the real thin entry that mounts the landing
// VIEW (src/components/public/landing.tsx). That absence is the entire point of
// test-first — do not implement anything to make these pass.
//
// What this task is (E05-S01): a THIN page entry that mounts the `Landing` view,
// REPLACING the placeholder home, reachable by anyone with no authentication.
//
// How these tests stay honest:
//   * They assert BEHAVIOUR — what the page entry's default export RENDERS for an
//     unauthenticated visitor — never the source text of page.tsx. A later
//     behaviour-preserving refactor (a moved import, reworded landing copy, a
//     different wrapper) stays green as long as the assembled home still shows the
//     landing.
//   * They import ONLY the page's framework field (its default export). A Next
//     `page.tsx` may export only its reserved route keys, so this file never
//     demands a non-framework export from the entry (the view's own content
//     contract lives in src/components/public/landing.test.tsx).
//   * The "replaces the placeholder" check keys on the landing content the
//     placeholder LACKS (the /signup + /signin links and the three-step copy), not
//     on the placeholder's absence — the positioning line alone can't distinguish
//     them, because the placeholder already shows it.
//
// We render with `react-dom/server` (no DOM/jsdom — React component / E2E testing
// is a per-job ADR) and read the emitted markup, mirroring the (auth) page tests.

import * as React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";

import Home from "./page";

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

function attr(attrs: string, name: string): string | null {
  const m = attrs.match(new RegExp(`\\b${name}="([^"]*)"`, "i"));
  return m ? m[1]! : null;
}

function hrefs(markup: string): (string | null)[] {
  const out: (string | null)[] = [];
  for (const m of markup.matchAll(/<a\b([^>]*)>/gi)) out.push(attr(m[1]!, "href"));
  return out;
}

// Render the page entry's default export (the route's screen). The thin entry
// mounts a static view, so it renders without a live request scope. `searchParams`
// / `params` are supplied as resolved promises (the Next 15 shape) so an entry that
// reads them sees an empty, fresh GET; one that ignores them is unaffected. The
// result may be sync JSX or an async server component — await either.
async function renderPage(Page: unknown): Promise<string> {
  assert.equal(
    typeof Page,
    "function",
    "the home entry must have a default-exported page component",
  );
  const element = await Promise.resolve(
    (Page as (props: unknown) => unknown)({
      searchParams: Promise.resolve({}),
      params: Promise.resolve({}),
    }),
  );
  return renderToStaticMarkup(element as React.ReactElement);
}

// === AC2 — public, no authentication ===========================================
//
// The home route sits at the top level (not inside a protected route group), so an
// unauthenticated visitor must get the page, not a guard redirect/throw. If the
// builder put it behind a guard that reads a session, rendering here (no request
// scope, no session) would throw — this catches that. A screen that renders is the
// render-test proxy for "returns 200 with no authentication".

test("home page renders for an unauthenticated visitor (public, not behind a guard)", async () => {
  let markup: string;
  try {
    markup = await renderPage(Home);
  } catch (err) {
    assert.fail(
      "the home page must render for an unauthenticated visitor — the public landing must not sit behind a guard that redirects or throws without a session: " +
        (err instanceof Error ? err.message : String(err)),
    );
    return;
  }
  assert.ok(
    visibleText(markup).length >= 8,
    `the home page must render a real screen with no authentication, got: "${visibleText(markup)}"`,
  );
});

// === AC1 — the real landing replaces the placeholder ===========================
//
// The assembled home mounts the landing view: the positioning line PLUS the two
// things the placeholder front door lacks — the Sign up / Sign in links and the
// three-step copy. Keying on this content (not on the placeholder's absence) proves
// the placeholder home has been replaced by the real landing.

test("home page mounts the landing: positioning line, sign-up/sign-in links, and the three steps", async () => {
  const markup = await renderPage(Home);
  const text = visibleText(markup);
  const low = text.toLowerCase();

  assert.ok(
    text.includes("Your agents work for you, on your terms, from your home"),
    `the home page must show the positioning line, got: "${text}"`,
  );

  const links = hrefs(markup);
  assert.ok(
    links.includes("/signup"),
    `the home page must link to /signup (placeholder home does not), got hrefs: ${JSON.stringify(links)}`,
  );
  assert.ok(
    links.includes("/signin"),
    `the home page must link to /signin (placeholder home does not), got hrefs: ${JSON.stringify(links)}`,
  );

  // A representative slice of the three-step explanation the placeholder lacks.
  assert.match(
    low,
    /connect[^.!?]{0,40}services?\b/i,
    `the home page must show the "connect your services" step, got: "${text}"`,
  );
  assert.match(
    low,
    /\bapprove\b/i,
    `the home page must show the "approve and see everything" step, got: "${text}"`,
  );
});
