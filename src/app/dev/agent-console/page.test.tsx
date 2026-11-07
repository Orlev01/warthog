// E17-S10 — Dev fake agent console PAGE / loader (src/app/dev/agent-console/page.tsx).
//
// RED-first: src/app/dev/agent-console/page.tsx does NOT exist yet, so importing `./page`
// throws and every test here fails until the builder adds the loader. That absence is the
// entire point of test-first — do not implement anything to make these pass.
//
// What this task is (E17-S10): a `/dev/agent-console` page — an async loader that, behind
// the dev-tools guard, mints or reads a dev access key through the REAL per-agent
// access-key mechanism (the sibling `createAgentConsoleActions` seam, pinned in
// actions.test.ts) and mounts the render-testable client view (`AgentConsoleView`, pinned
// in its sibling component test) so a developer can POST tool calls to `/mcp` with that
// key and see the response while driving the primary journey over HTTP.
//
// The route lives behind the dev-tools guard. The task's touches are page.tsx and
// agent-console-view.tsx — NOT the `/dev` layout — so the acceptance criterion "with dev
// tools off, the route is not found" must be realised inside page.tsx itself: the loader
// enforces the guard (`requireDevTools(loadConfig())`) exactly as the sibling outbox
// loader re-derives it rather than trusting the layout alone. With dev tools on it
// provisions the dev access key and renders the console.
//
// How these tests stay honest:
//   * They assert BEHAVIOUR — what the loader's default export THROWS (dev off) or
//     RENDERS / PROVISIONS (dev on) — never the source text of page.tsx. A
//     behaviour-preserving refactor stays green.
//   * They import ONLY the page's framework field (its default export). A Next `page.tsx`
//     may export only its reserved route keys, so this file never demands a non-framework
//     export from the entry (the injectable seam lives in the sibling `actions.ts`, driven
//     directly by actions.test.ts). The database the loader provisions into is the real
//     process-wide `getServerDb()` — the intended composition root — not an injected prop.
//   * The flag flows env -> config module -> guard: the page reads it through
//     `loadConfig()` (the only reader of process.env; INV-103), never process.env
//     directly, so the tests drive the decision purely by the environment the config
//     module parses. [secrets-from-env is covered behaviourally here: the identical loader
//     renders or 404s purely by the environment it parses.]
//
// We render with `react-dom/server` (no DOM/jsdom — React component testing is a per-job
// ADR) and read the emitted markup, mirroring the view / page render tests.

import * as React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { notFound } from "next/navigation";

import DevAgentConsolePage from "./page";
// The real process-wide database the loader provisions into (ESM caches the module, so
// this is the SAME instance the page imports, whatever specifier it uses).
import { getServerDb } from "@/server/db/server";

// --- a complete, valid dev environment for the config module ----------------
// Mirrors the sibling outbox page test's fixture: the HMAC key and dev KEK are the repo's
// test-only base64 values that let `loadConfig` succeed. `WARTHOG_DEV_TOOLS` is supplied
// per case. `DATABASE_URL=pglite:memory` so `getServerDb()` opens an in-process database
// with the real migrations. The page calls `loadConfig()` (no arg), which reads the real
// process.env, so these tests set process.env and restore it afterwards.
const BASE_ENV: Record<string, string> = {
  NODE_ENV: "development",
  PUBLIC_BASE_URL: "https://warthog.example",
  WEBAUTHN_RP_ID: "localhost",
  DATABASE_URL: "pglite:memory",
  WARTHOG_HMAC_KEY: "ERERERERERERERERERERERERERERERERERERERERERE=",
  WARTHOG_DEV_KEK: "IiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiI=",
};
const ENV_KEYS = [...Object.keys(BASE_ENV), "WARTHOG_DEV_TOOLS"];

function devEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return { ...BASE_ENV, ...overrides };
}

// Apply an env slate to process.env and return a restore function. Snapshots every
// managed key first (node:test runs a file's tests sequentially, so set/restore around a
// single call is safe), then sets only the keys in `env`.
function applyEnv(env: Record<string, string>): () => void {
  const saved = new Map<string, string | undefined>();
  for (const key of ENV_KEYS) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(env)) process.env[key] = value;
  return () => {
    for (const key of ENV_KEYS) {
      const prev = saved.get(key);
      if (prev === undefined) delete process.env[key];
      else process.env[key] = prev;
    }
  };
}

// Call the loader's default export with the Next 15 resolved-promise prop shape (an entry
// that ignores searchParams/params is unaffected), under the given env, restoring
// process.env afterwards. Awaits so a dev-off `notFound()` surfaces here.
async function callPage(env: Record<string, string>): Promise<unknown> {
  assert.equal(
    typeof DevAgentConsolePage,
    "function",
    "the /dev/agent-console page must have a default export",
  );
  const restore = applyEnv(env);
  try {
    return await Promise.resolve(
      (DevAgentConsolePage as (props: unknown) => unknown)({
        searchParams: Promise.resolve({}),
        params: Promise.resolve({}),
      }),
    );
  } finally {
    restore();
  }
}

async function renderPage(env: Record<string, string>): Promise<string> {
  return renderToStaticMarkup((await callPage(env)) as React.ReactElement);
}

// --- markup helpers (no DOM) ------------------------------------------------

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

// Does the rendered page mount an interactive console — at least one field to type a tool
// call into and at least one live, named control to send it? (The view is proven in
// detail by its own component test; here we only prove the loader actually mounts it.)
function hasToolCallField(markup: string): boolean {
  return /<input\b/i.test(markup) || /<textarea\b/i.test(markup) || /<select\b/i.test(markup);
}
function hasLiveButton(markup: string): boolean {
  for (const m of markup.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/gi)) {
    if (!/\bdisabled=""/i.test(m[1]!)) return true;
  }
  return false;
}

// --- the behavioural definition of "a not-found" ---------------------------
// Whatever `notFound()` itself throws — derived from the real function so this stays
// correct across Next versions that change the digest string.
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

async function expectNotFound(call: () => Promise<unknown>): Promise<void> {
  let threw = false;
  let thrown: unknown;
  try {
    await call();
  } catch (err) {
    threw = true;
    thrown = err;
  }
  assert.ok(threw, "expected the route to be not-found, but the loader returned normally");
  const digest = (thrown as { digest?: unknown }).digest;
  assert.equal(
    digest,
    NOT_FOUND_DIGEST,
    `expected a Next not-found (digest ${NOT_FOUND_DIGEST}), got digest ${String(digest)}`,
  );
}

async function accessKeyCount(): Promise<number> {
  const db = await getServerDb();
  const result = await db.query("SELECT count(*)::int AS n FROM oauth_access_keys");
  return Number(result.rows[0]?.n ?? -1);
}

// ===========================================================================

// AC1/AC3 — with dev tools on, the loader renders the console AND provisions a real dev
// access key. Mounting an interactive console proves the view is wired; a row in the real
// `oauth_access_keys` table proves the loader reused the real per-agent access-key
// mechanism (not a parallel credential path).
//
// This is the FIRST dev-on render in the file, so it is what opens the process-wide
// `getServerDb()` (lazily, within the applied dev env — `getServerDb()` reads the db URL
// from the config module). We therefore only query the store AFTER the render, when the
// database is initialised and provisioning has run; an empty store would mean the loader
// mounted a console with no credential.
test("with dev tools on, the loader renders the agent console and provisions a real access key", async () => {
  const markup = await renderPage(devEnv({ WARTHOG_DEV_TOOLS: "1" }));

  const text = visibleText(markup);
  assert.ok(text.length >= 3, `the console must render a real screen, got: "${text}"`);
  assert.ok(
    hasToolCallField(markup),
    `the console must mount a field to enter a tool call, got: ${markup}`,
  );
  assert.ok(
    hasLiveButton(markup),
    `the console must offer a live control to send the tool call (no dead screen), got: ${markup}`,
  );

  // The loader provisioned a dev access key through the real mechanism — at least one row
  // sits in the real credential table.
  assert.ok(
    (await accessKeyCount()) >= 1,
    "the dev-on loader must mint/read a dev access key into the real oauth_access_keys table",
  );
});

// AC2 — with dev tools off, the route is not found (the loader enforces the guard through
// the config module, so an env without the flag triggers `notFound()` and provisions
// nothing).
test("with dev tools off (flag absent), the route is not found", async () => {
  await expectNotFound(() => callPage(devEnv())); // no WARTHOG_DEV_TOOLS
});

test('with WARTHOG_DEV_TOOLS="0", the route is also not found (only "1" enables)', async () => {
  await expectNotFound(() => callPage(devEnv({ WARTHOG_DEV_TOOLS: "0" })));
});

// AC2 / [secrets-from-env] — the decision flows env -> config -> guard: the SAME loader
// renders or 404s purely by the environment the config module parsed, nothing baked in.
test("the route's visibility flips with the environment the config module reads", async () => {
  // Flag set -> renders a real console screen.
  const markup = await renderPage(devEnv({ WARTHOG_DEV_TOOLS: "1" }));
  assert.ok(visibleText(markup).length >= 3, "with the flag set the loader renders the console");

  // Flag cleared -> not found.
  await expectNotFound(() => callPage(devEnv()));
});
