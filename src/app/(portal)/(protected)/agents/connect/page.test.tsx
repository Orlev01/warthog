// E10-S05 — Agents connect page loader (src/app/(portal)/(protected)/agents/connect/page.tsx).
//
// RED-first: today this entry is the operator placeholder ("Connect an agent" ComingSoon)
// — it names none of the agent platforms and shows no connector address. The assertions
// below FAIL until the builder replaces it with the real loader that reads the connector
// address from configuration and mounts the guided-connect view (the platform picker and
// the chosen platform's guided-connect view). That absence is the entire point of
// test-first — do NOT implement anything to make these pass.
//
// What this task is (E10-S05): the `/agents/connect` loader PAGE the Agents screen links
// to. The page sits inside the `(protected)` route group, so the auth guard is the GROUP
// LAYOUT's job (src/app/(portal)/(protected)/layout.tsx) — the page itself is a thin,
// config-driven loader. Its own responsibilities, and the only things these tests pin, are:
//   • read Warthog's public address from configuration (INV-21 / constitution #21 — the
//     public base URL, via `loadConfig()` called INSIDE the handler, never at module load)
//     and derive the connector address (`<publicBaseUrl>/mcp`, design §6.1/§6.2), and
//   • mount the guided-connect view — the platform picker (every platform the person can
//     choose) and a chosen platform's guided-connect view showing that connector address.
// The per-platform content contract (a section per platform, ordered steps, a live Copy
// control, a gap note + what to do instead) is the VIEW's own and is pinned by the sibling
// src/components/agents/connect-guide.test.tsx — not re-pinned here.
//
// How these tests stay honest:
//   * They assert BEHAVIOUR — what the page entry's default export RENDERS — never the
//     source text of page.tsx. A behaviour-preserving refactor (a moved import, reworded
//     copy, a different wrapper, a thin client picker around the guide) stays green as long
//     as the assembled page still mounts the guided-connect view with a config-driven
//     connector address.
//   * They import ONLY the page's framework field (its default export). A Next `page.tsx`
//     may export only its reserved route keys, so this file never demands a non-framework
//     export from the entry; any picker/view the builder adds is a sibling component with
//     its own tests.
//   * "Replaces the placeholder" keys on content the placeholder LACKS (the platform names
//     + the config-derived connector address), not on the placeholder's absence.
//   * The connector address flows env -> config module -> page: the config-driven test sets
//     TWO distinctive `PUBLIC_BASE_URL` values and asserts each derived address appears in
//     its own render while the OTHER does not — proving the page READS the address from
//     configuration rather than hard-coding it. Every absence check is scoped to the exact
//     full address string (distinctive, and legitimately appearing nowhere else).
//
// No-DOM caveat: selecting a platform is a client interaction, and React component / E2E
// testing is a per-job ADR (no DOM/jsdom here). We render the page's static markup with
// `react-dom/server` and assert the STATIC render — every platform offered (so a platform
// CAN be chosen) and a guided-connect view with the config-derived address shown — never
// a click handler we cannot reach. This mirrors the sibling page tests
// (src/app/help/compatibility/page.test.tsx) exactly.

import * as React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";

import ConnectPage from "./page";

// --- a complete, valid environment for the config module -----------------------
// The HMAC key and dev KEK are the repo's test-only base64 values that let `loadConfig`
// succeed (same fixture the compatibility page test uses). PUBLIC_BASE_URL is supplied per
// render so we can prove the connector address is derived from it. The page calls
// `loadConfig()` (no arg), which reads the real process.env, so these tests set process.env
// around the render and restore it afterwards.
const DEFAULT_BASE_URL = "https://connect.warthog.test";
const ALT_BASE_URL = "https://home.someone-else.example";

const BASE_ENV: Record<string, string> = {
  NODE_ENV: "development",
  PUBLIC_BASE_URL: DEFAULT_BASE_URL,
  WEBAUTHN_RP_ID: "localhost",
  DATABASE_URL: "pglite:memory",
  WARTHOG_HMAC_KEY: "ERERERERERERERERERERERERERERERERERERERERERE=",
  WARTHOG_DEV_KEK: "IiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiI=",
};
// Every env key these tests touch, so each case starts from a known slate.
const ENV_KEYS = [...Object.keys(BASE_ENV), "WARTHOG_DEV_TOOLS"];

// Apply the env slate (with any overrides) to process.env and return a restore function.
// node:test runs a file's tests sequentially, so set/restore around a single render is safe.
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

// --- tiny markup helpers (no DOM), mirrored from the sibling page tests ----------

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

// Warthog's connector address derived from the public base URL (design §6.1/§6.2): the
// base URL with any trailing slash stripped, joined to the `/mcp` endpoint path. This is
// the same derivation the sibling public compatibility page uses.
function mcpAddress(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/mcp`;
}

// Render the page entry's default export (the route's screen) with env applied. The thin
// loader reads config and mounts a view, so it renders without a live request scope.
// `searchParams` / `params` are supplied as resolved promises (the Next 15 shape) so an
// entry that reads them sees an empty, fresh GET; one that ignores them is unaffected. The
// result may be sync JSX or an async server component — await either.
async function renderPage(baseUrl: string = DEFAULT_BASE_URL): Promise<string> {
  assert.equal(
    typeof ConnectPage,
    "function",
    "the agents-connect entry must have a default-exported page component",
  );
  const restore = applyEnv({ PUBLIC_BASE_URL: baseUrl });
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

// The six agent platforms the task/brief name (Claude, ChatGPT, Gemini, Grok, Llama-based
// clients, Other). "Llama" matches as a substring so "Llama-based clients" also satisfies
// it. The placeholder "Connect an agent" front door names none of them.
const PLATFORMS: { name: string; re: RegExp }[] = [
  { name: "Claude", re: /\bclaude\b/i },
  { name: "ChatGPT", re: /\bchat\s*gpt\b/i },
  { name: "Gemini", re: /\bgemini\b/i },
  { name: "Grok", re: /\bgrok\b/i },
  { name: "Llama", re: /\bllama\b/i },
  { name: "Other", re: /\bother\b/i },
];

// === The page is a mounted screen; the guard lives in the layout, not the page =====
//
// `/agents/connect` sits inside the `(protected)` route group, where the GROUP LAYOUT does
// the auth guard — the page itself is a thin config-driven loader that mounts a static
// view. So rendering the page component directly (no session, no request scope) must
// produce a screen, not throw. If the builder reads the session/cookies at the PAGE (the
// guard's job belongs to the layout) or reads per-request data outside a request scope,
// rendering here would throw — this catches that.

test("agents connect page renders a mounted screen (guard belongs to the group layout, not the page)", async () => {
  let markup: string;
  try {
    markup = await renderPage();
  } catch (err) {
    assert.fail(
      "the /agents/connect page must render as a thin config-driven loader without a live session or request scope — the auth guard belongs to the (protected) group layout, not this page, and the page must not read request data outside a request scope: " +
        (err instanceof Error ? err.message : String(err)),
    );
    return;
  }
  assert.ok(
    visibleText(markup).length >= 8,
    `the /agents/connect page must render a real screen, got: "${visibleText(markup)}"`,
  );
});

// === AC1 — mounts the guided-connect view: the platform picker + the config address =
//
// The assembled page mounts the guided-connect view: every agent platform the person can
// choose (the picker — content the placeholder LACKS), plus the connector address DERIVED
// FROM CONFIG (the distinctive PUBLIC_BASE_URL joined to the "/mcp" endpoint). Keying on
// this proves the placeholder page has been replaced by the real connect loader.

test("mounts the guided-connect view: names every agent platform the person can choose", async () => {
  const markup = await renderPage();
  const text = visibleText(markup);
  for (const platform of PLATFORMS) {
    assert.ok(
      platform.re.test(text),
      `the connect page must name "${platform.name}" so the person can pick it (the placeholder does not), got: "${text}"`,
    );
  }
});

test("mounts the guided-connect view: shows the config-derived connector address to paste", async () => {
  const markup = await renderPage();
  const address = mcpAddress(DEFAULT_BASE_URL);
  assert.ok(
    decode(markup).includes(address),
    `the connect page must show Warthog's connector address derived from configuration ("${address}" from PUBLIC_BASE_URL) so people can paste it, got: ${decode(markup)}`,
  );
});

test("mounts the guided-connect view: shows connect step guidance, not just a bare address", async () => {
  // "Guided" means the view tells the person what to do with the address (paste / add /
  // enter it), not merely prints it. The placeholder shows no such guidance.
  const text = visibleText(await renderPage());
  assert.match(
    text,
    /\b(paste|add|enter)\b/i,
    `the connect page must mount the guided-connect view (step guidance telling the person to paste/add the connector address), not just a bare address, got: "${text}"`,
  );
});

// === AC2 — the page READS the connector address from configuration =================
//
// The connector address flows env -> config module -> page. Render with two distinctive
// public base URLs: each render must show the address derived from ITS configured base
// URL, and must NOT show the address derived from the other one. A hard-coded address
// would survive the change — so this proves the page reads the address from configuration.

test("reads the connector address from configuration (a different PUBLIC_BASE_URL changes the shown address)", async () => {
  const defaultAddress = mcpAddress(DEFAULT_BASE_URL);
  const altAddress = mcpAddress(ALT_BASE_URL);

  const defaultMarkup = decode(await renderPage(DEFAULT_BASE_URL));
  assert.ok(
    defaultMarkup.includes(defaultAddress),
    `configuring PUBLIC_BASE_URL="${DEFAULT_BASE_URL}" must show the connector address "${defaultAddress}", got: ${defaultMarkup}`,
  );

  const altMarkup = decode(await renderPage(ALT_BASE_URL));
  assert.ok(
    altMarkup.includes(altAddress),
    `configuring PUBLIC_BASE_URL="${ALT_BASE_URL}" must show the connector address "${altAddress}", got: ${altMarkup}`,
  );
  // Scoped to the exact full address: if the page baked in the first address it would
  // still appear even though a different base URL is configured. It must not.
  assert.ok(
    !altMarkup.includes(defaultAddress),
    `the connector address must come from configuration, not a hard-coded literal — "${defaultAddress}" must not appear when PUBLIC_BASE_URL is "${ALT_BASE_URL}", got: ${altMarkup}`,
  );
});
