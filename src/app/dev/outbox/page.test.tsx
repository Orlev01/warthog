// E17-S08 — Dev outbox viewer PAGE / loader (src/app/dev/outbox/page.tsx).
//
// RED-first: src/app/dev/outbox/page.tsx does NOT exist yet, so importing `./page`
// throws and every test here fails until the builder adds the loader. That absence
// is the entire point of test-first — do not implement anything to make these pass.
//
// What this task is (E17-S08): a `/dev/outbox` page — an async loader that reads the
// push / email / SMS the process-wide dev outbox (`src/server/notify/outbox.ts`)
// captured and mounts the render-testable `OutboxView` (tested in its sibling
// component test) with that list, so the primary journey's notifications and
// single-use approval / sign-in links can be seen while driving it over HTTP.
//
// The route lives behind the dev-tools guard. The task's touches are page.tsx and
// outbox-view.tsx — NOT the `/dev` layout — so the acceptance criterion "with dev
// tools off, the route is not found" must be realised inside page.tsx itself: the
// loader enforces the guard (`requireDevTools(loadConfig())`) exactly as the
// protected security page re-derives its own session guard rather than trusting the
// layout alone. With dev tools on it reads the outbox and renders the list.
//
// How these tests stay honest:
//   * They assert BEHAVIOUR — what the loader's default export RENDERS (dev on) or
//     THROWS (dev off) — never the source text of page.tsx. A behaviour-preserving
//     refactor stays green.
//   * They import ONLY the page's framework field (its default export). A Next
//     `page.tsx` may export only its reserved route keys, so this file never demands
//     a non-framework export from the entry (that would lock the builder into an
//     unwinnable conflict with `next build`). The outbox it reads is seeded through
//     the real process-wide singleton — the intended dev seam — not an injected prop.
//   * The flag flows env -> config module -> guard: the page reads it through
//     `loadConfig()` (the only reader of process.env; INV-103), never process.env
//     directly, so the tests drive the decision purely by the environment the config
//     module parses.
//
// We render with `react-dom/server` (no DOM/jsdom — React component testing is a
// per-job ADR) and read the emitted markup, mirroring the view render tests.

import * as React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { renderToStaticMarkup } from "react-dom/server";
import { notFound } from "next/navigation";

import DevOutboxPage from "./page";
// The process-wide outbox the loader reads — seeded here through its real public
// API, the intended dev seam (ESM caches the module, so this is the SAME instance
// the page imports, whatever specifier it uses).
import { outbox } from "@/server/notify/outbox";

// --- a complete, valid dev environment for the config module ----------------
// Mirrors the dev-tools guard test's fixture: the HMAC key and dev KEK are the
// repo's test-only base64 values that let `loadConfig` succeed. `WARTHOG_DEV_TOOLS`
// is supplied per case. The page calls `loadConfig()` (no arg), which reads the real
// process.env, so these tests set process.env and restore it afterwards.
const BASE_ENV: Record<string, string> = {
  NODE_ENV: "development",
  PUBLIC_BASE_URL: "https://warthog.example",
  WEBAUTHN_RP_ID: "localhost",
  DATABASE_URL: "pglite:memory",
  WARTHOG_HMAC_KEY: "ERERERERERERERERERERERERERERERERERERERERERE=",
  WARTHOG_DEV_KEK: "IiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiI=",
};
// Every env key these tests touch, so each case starts from a known slate (in
// particular WARTHOG_DEV_TOOLS is cleared unless a case sets it).
const ENV_KEYS = [...Object.keys(BASE_ENV), "WARTHOG_DEV_TOOLS"];

function devEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return { ...BASE_ENV, ...overrides };
}

// Apply an env slate to process.env and return a restore function. Snapshots every
// managed key first (node:test runs a file's tests sequentially, so set/restore
// around a single call is safe), then sets only the keys in `env`.
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

// Call the loader's default export with the Next 15 resolved-promise prop shape
// (an entry that ignores searchParams/params is unaffected), under the given env,
// restoring process.env afterwards. Awaits so a dev-off `notFound()` surfaces here.
async function callPage(env: Record<string, string>): Promise<unknown> {
  assert.equal(typeof DevOutboxPage, "function", "the /dev/outbox page must have a default export");
  const restore = applyEnv(env);
  try {
    return await Promise.resolve(
      (DevOutboxPage as (props: unknown) => unknown)({
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

function hrefs(markup: string): string[] {
  const out: string[] = [];
  for (const m of markup.matchAll(/<a\b[^>]*\bhref="([^"]*)"[^>]*>/gi)) out.push(decode(m[1]));
  return out;
}

// --- the behavioural definition of "a not-found" ---------------------------
// Whatever `notFound()` itself throws — derived from the real function so this
// stays correct across Next versions that change the digest string.
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

// ===========================================================================

// AC1 — with dev tools on, the page lists the push, email and SMS the outbox
// captured, with their single-use links. Seeding the real process-wide outbox and
// finding the messages in the rendered page proves the loader reads `outbox.list()`
// and feeds the view (unique recipients/links keep this independent of any other
// messages the shared singleton holds).
test("with dev tools on, the page lists the push, email and SMS captured by the outbox, with their links", async () => {
  const tag = randomUUID();
  const push = { recipient: `push-sub-${tag}`, body: "An agent is waiting for your approval." };
  const email = {
    recipient: `person-${tag}@example.com`,
    body: "Open the approval to continue.",
    link: `https://warthog.com.au/a/approval-${tag}`,
  };
  const sms = {
    recipient: "+61400111222",
    body: `Warthog: confirm the waiting request ${tag}.`,
    link: `https://warthog.com.au/signin/${tag}`,
  };
  await outbox.sendPush(push);
  await outbox.sendEmail(email);
  await outbox.sendSms(sms);

  const markup = await renderPage(devEnv({ WARTHOG_DEV_TOOLS: "1" }));
  const text = visibleText(markup);

  for (const recipient of [push.recipient, email.recipient, sms.recipient]) {
    assert.ok(text.includes(recipient), `the captured recipient "${recipient}" must be listed`);
  }
  for (const body of [push.body, email.body, sms.body]) {
    assert.ok(text.includes(body), `the captured body "${body}" must be listed`);
  }
  const rendered = hrefs(markup);
  for (const link of [email.link, sms.link]) {
    assert.ok(
      rendered.includes(link),
      `the captured single-use link "${link}" must render as an anchor href, got: ${JSON.stringify(
        rendered,
      )}`,
    );
  }
});

// AC1 — the loader reflects the LIVE outbox: a message recorded after this test
// begins still appears, proving it reads `outbox.list()` at request time rather than
// a build-time snapshot.
test("the page reflects messages captured in the live outbox", async () => {
  const tag = randomUUID();
  const recipient = `late-${tag}@example.com`;
  await outbox.sendEmail({
    recipient,
    body: "A later approval is waiting.",
    link: `https://warthog.com.au/a/late-${tag}`,
  });

  const text = visibleText(await renderPage(devEnv({ WARTHOG_DEV_TOOLS: "1" })));
  assert.ok(text.includes(recipient), `a freshly captured message ("${recipient}") must appear`);
});

// AC2 — with dev tools off, the route is not found. The loader enforces the guard
// through the config module, so an env without the flag triggers `notFound()`.
test("with dev tools off (flag absent), the route is not found", async () => {
  await expectNotFound(() => callPage(devEnv())); // no WARTHOG_DEV_TOOLS
});

test('with WARTHOG_DEV_TOOLS="0", the route is also not found (only "1" enables)', async () => {
  await expectNotFound(() => callPage(devEnv({ WARTHOG_DEV_TOOLS: "0" })));
});

// AC2 — the decision flows env -> config -> guard: the SAME loader renders or 404s
// purely by the environment the config module parsed, nothing baked in.
test("the route's visibility flips with the environment the config module reads", async () => {
  const tag = randomUUID();
  await outbox.sendPush({ recipient: `flip-${tag}`, body: "waiting" });

  // Flag set -> renders a real screen.
  const markup = await renderPage(devEnv({ WARTHOG_DEV_TOOLS: "1" }));
  assert.ok(visibleText(markup).includes(`flip-${tag}`), "with the flag set the page renders the list");

  // Flag cleared -> not found.
  await expectNotFound(() => callPage(devEnv()));
});
