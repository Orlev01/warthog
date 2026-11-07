// E10-S13 — /agents/connect links to the access-key page
// (src/app/(portal)/(protected)/agents/connect/page.tsx).
//
// RED-first: today the connect page mounts the guided-connect view but offers NO link to
// `/agents/access-key` — a platform that cannot use the standard connector sign-in is told
// to "create an access key" but has nowhere to go. These assertions FAIL until the builder
// adds that link. That absence is the point of test-first — do NOT implement anything to
// make these pass.
//
// WHAT this pins (AC3): "/agents/connect links to the access-key page for platforms that
// need it" (brief "Connect an agent" — a platform that can't use the remote connector flow
// gets a per-agent access key instead; constitution 16). The guided-connect view already
// names the gap and says "create an access key" in words (pinned by
// src/components/agents/connect-guide.test.tsx); THIS task turns that into a real,
// navigable link to the new `/agents/access-key` page.
//
// How these tests stay honest:
//   * They assert BEHAVIOUR — that the ASSEMBLED connect page RENDERS an anchor whose href
//     targets `/agents/access-key` — never the source text of page.tsx, and never WHERE the
//     link is added (the page, or the view it mounts). A behaviour-preserving refactor
//     (a <Link> vs an <a>, reworded link text, a moved element) stays green.
//   * They import ONLY the page's framework field (its default export), exactly like the
//     sibling src/app/(portal)/(protected)/agents/connect/page.test.tsx — a Next `page.tsx`
//     may export only its reserved route keys, so this file demands no non-framework export.
//   * No DOM/jsdom (React component / E2E is a per-job ADR): we render the page's static
//     markup with `react-dom/server` and read the emitted anchors, exactly as the sibling
//     page tests do.
//
// The connect page is a thin, config-driven loader (it reads `config.publicBaseUrl` through
// `loadConfig()` to derive the connector address), so it renders without a live session —
// the auth guard is the `(protected)` group layout's job. We set a complete, valid test env
// around the render (the repo's test-only base64 HMAC key + dev KEK) exactly as the sibling
// page test does, and restore it afterwards.

import * as React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";

import ConnectPage from "./page";

// --- a complete, valid environment for the config module (mirrors the sibling page test) --
const BASE_ENV: Record<string, string> = {
  NODE_ENV: "development",
  PUBLIC_BASE_URL: "https://connect.warthog.test",
  WEBAUTHN_RP_ID: "localhost",
  DATABASE_URL: "pglite:memory",
  WARTHOG_HMAC_KEY: "ERERERERERERERERERERERERERERERERERERERERERE=",
  WARTHOG_DEV_KEK: "IiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiI=",
};
const ENV_KEYS = [...Object.keys(BASE_ENV), "WARTHOG_DEV_TOOLS"];

function applyEnv(overrides: Record<string, string> = {}): () => void {
  const saved = new Map<string, string | undefined>();
  for (const key of ENV_KEYS) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
  for (const [key, value] of Object.entries({ ...BASE_ENV, ...overrides })) {
    process.env[key] = value;
  }
  return () => {
    for (const key of ENV_KEYS) {
      const prev = saved.get(key);
      if (prev === undefined) delete process.env[key];
      else process.env[key] = prev;
    }
  };
}

// --- tiny markup helpers (no DOM), mirrored from the sibling page tests ------------------

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
// Every <a> in the markup, with its href and visible text.
function anchors(markup: string): Array<{ href: string | null; text: string }> {
  const out: Array<{ href: string | null; text: string }> = [];
  for (const m of markup.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    out.push({ href: attr(m[1]!, "href"), text: visibleText(m[2]!) });
  }
  return out;
}

// The access-key page path this task adds. A link's href is this path exactly, optionally
// followed by a query or hash (e.g. `?platform=grok`) — matched at a boundary so a longer,
// unrelated path cannot satisfy it.
const ACCESS_KEY_PATH = "/agents/access-key";
function targetsAccessKey(href: string | null): boolean {
  return href != null && new RegExp(`^${ACCESS_KEY_PATH}(?:[?#]|$)`).test(href);
}

async function renderPage(): Promise<string> {
  assert.equal(typeof ConnectPage, "function", "the agents-connect entry must have a default-exported page component");
  const restore = applyEnv();
  try {
    const element = await Promise.resolve(
      (ConnectPage as (props: unknown) => unknown)({
        searchParams: Promise.resolve({}),
        params: Promise.resolve({}),
      }),
    );
    return renderToStaticMarkup(element as React.ReactElement);
  } finally {
    restore();
  }
}

// === AC3 — the connect page offers a navigable link to the access-key page ===============

test("the connect page links to the access-key page", async () => {
  const markup = await renderPage();
  const links = anchors(markup);
  assert.ok(
    links.some((a) => targetsAccessKey(a.href)),
    `the connect page must link to the access-key page (href "${ACCESS_KEY_PATH}") so a platform that can't use connector sign-in can create one; anchors=${JSON.stringify(links)}`,
  );
});

test("the access-key link reads as what it is (names the access key)", async () => {
  const markup = await renderPage();
  const accessKeyLinks = anchors(markup).filter((a) => targetsAccessKey(a.href));
  assert.ok(accessKeyLinks.length >= 1, "there must be a link to the access-key page");
  assert.ok(
    accessKeyLinks.some((a) => /access key/i.test(a.text)),
    `the access-key link must be labelled so the person knows where it goes; links=${JSON.stringify(accessKeyLinks)}`,
  );
});
