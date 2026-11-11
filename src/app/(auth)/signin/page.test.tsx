import { withPageRequest } from "@/test/page-request";

// E04-S13 — Sign-in page entry (src/app/(auth)/signin/page.tsx).
//
// RED-first: today this entry is an operator placeholder (it renders the generic
// "coming soon" panel), so the assertions below FAIL until the builder replaces it
// with the real thin entry that mounts the sign-in VIEW (E04-S12) and wires its
// actions (the E04-S11 sign-in handler, surfaced as server actions in the sibling
// `actions.ts`). That absence is the entire point of test-first — do not implement
// anything to make these pass.
//
// What this task is (E04-S13): a THIN page entry that (1) mounts `SigninView` and
// (2) wires its actions, left OUTSIDE any protected route group. This page is the
// one that MUST stay unguarded — a guard layout wrapping its own sign-in page would
// redirect sign-in to itself (a loop) and sign-in would become unreachable.
//
// How these tests stay honest:
//   * They assert BEHAVIOUR — what the entry's default export RENDERS when a
//     signed-out visitor loads it — never the source text of page.tsx. A later
//     behaviour-preserving refactor (a different client controller, reworded view
//     copy, a moved import) stays green as long as the assembled screen still mounts
//     the sign-in view at its entry step with a live control.
//   * They import ONLY the page's framework field (its default export). A Next
//     `page.tsx` may export only its reserved route keys, so the testable wiring
//     seam lives in the sibling `actions.ts` / `handler.ts` (already tested in
//     handler.test.ts) — this file never demands a non-framework export from the
//     entry.
//   * Absence checks (the jargon scan) are scoped to THIS page's own rendered output
//     — the unit under test — so the same word elsewhere in the app is irrelevant.
//
// We render with `react-dom/server` (no DOM/jsdom — React component testing is a
// per-job ADR) and read the emitted markup.

import * as React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";

import SigninPage from "./page";

// --- tiny markup helpers (no DOM) ------------------------------------------

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

// Visible text of an HTML fragment with tags stripped and entities decoded.
function visibleText(markup: string): string {
  return decode(markup.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

// All human-facing text: the visible copy PLUS the words a screen reader announces
// from the attributes that carry them. The jargon scan runs over this.
function faceText(markup: string): string {
  const parts = [visibleText(markup)];
  for (const re of [
    /aria-label="([^"]*)"/gi,
    /placeholder="([^"]*)"/gi,
    /\btitle="([^"]*)"/gi,
    /\balt="([^"]*)"/gi,
  ]) {
    for (const m of markup.matchAll(re)) parts.push(decode(m[1]));
  }
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

function attr(attrs: string, name: string): string | null {
  const m = attrs.match(new RegExp(`\\b${name}="([^"]*)"`, "i"));
  return m ? m[1] : null;
}

type El = { attrs: string; inner: string };

function findAll(markup: string, tag: string): El[] {
  const out: El[] = [];
  for (const m of markup.matchAll(new RegExp(`<${tag}\\b([^>]*)>([\\s\\S]*?)</${tag}>`, "gi"))) {
    out.push({ attrs: m[1], inner: m[2] });
  }
  return out;
}

// An actionable native <button> is one not carrying the native `disabled` attribute
// (React renders a truthy boolean `disabled` prop as `disabled=""`). Matching the
// ATTRIBUTE (never a Tailwind `disabled:` class) proves a genuinely live control.
function actionableButtons(markup: string): { name: string; attrs: string }[] {
  return findAll(markup, "button")
    .filter((b) => !/\bdisabled=""/i.test(b.attrs))
    .map((b) => ({ name: visibleText(b.inner) || attr(b.attrs, "aria-label") || "", attrs: b.attrs }));
}

// Render the real page in an anonymous request, with no cookie or database.
async function renderPage(Page: unknown): Promise<string> {
  assert.equal(
    typeof Page,
    "function",
    "the sign-in entry must have a default-exported page component",
  );
  const element = await withPageRequest("/signin", undefined, () =>
    (Page as (props: unknown) => unknown)({
      searchParams: Promise.resolve({}),
      params: Promise.resolve({}),
    }),
  );
  return renderToStaticMarkup(element as React.ReactElement);
}

// --- the forbidden vocabulary (brief design_ux.copy; design §5; INV-22) -----
// "passkey" is the brief's OWN plain vocabulary and is expected on this screen, not
// jargon, so it is deliberately NOT in this list.

const JARGON: { label: string; re: RegExp }[] = [
  { label: "OAuth", re: /\boauth\b/i },
  { label: "MCP", re: /\bmcp\b/i },
  { label: "PRF", re: /\bprf\b/i },
  { label: "token", re: /\btokens?\b/i },
  { label: "WebAuthn", re: /\bwebauthn\b/i },
  { label: "FIDO", re: /\bfido\b/i },
  { label: "TOTP", re: /\btotp\b/i },
  { label: "HMAC", re: /\bhmac\b/i },
  { label: "JWT", re: /\bjwt\b/i },
  { label: "attestation", re: /\battestation\b/i },
  { label: "assertion", re: /\bassertion\b/i },
  { label: "encryption key", re: /\bencryption key\b/i },
  { label: "RP ID", re: /\brp id\b/i },
];

// ===========================================================================

// AC1 (mount the view) — the entry mounts `SigninView` at its entry step: the
// passkey sign-in screen (passkeys are the primary, phishing-resistant factor;
// design §5). The step talks about the person's "passkey" in plain words. The
// operator placeholder never says "passkey", so this is RED until the real view is
// mounted.
test("sign-in page entry mounts the sign-in view's passkey step (plain 'passkey' copy)", async () => {
  const markup = await renderPage(SigninPage);
  assert.match(
    visibleText(markup),
    /\bpasskey\b/i,
    `the sign-in entry must mount the passkey sign-in view, which offers to sign in with the person's "passkey" in plain words, got: "${visibleText(markup)}"`,
  );
});

// AC1 (wire the actions) — the mounted view is a LIVE screen: it offers an
// actionable, named control to sign in (no dead button). The inert placeholder has
// no control at all → RED.
test("sign-in page entry presents an actionable, named control to sign in (no dead control)", async () => {
  const markup = await renderPage(SigninPage);
  const live = actionableButtons(markup).filter((b) => b.name.trim().length > 0);
  assert.ok(
    live.length >= 1,
    `the sign-in entry must mount a live, named control to sign in (not a dead/inert screen), got: ${markup}`,
  );
});

// AC2 (outside any guard — the point of this task) — sign-in must be reachable by a
// signed-out visitor: the entry renders without a session and must NOT sit behind
// a guard that reads a session and redirects/throws when none is present (a guard
// wrapping its own sign-in page loops it to itself). If the builder wrapped it in a
// protected route group, rendering here (an anonymous request) would throw —
// this test catches that.
test("sign-in page entry renders for a signed-out visitor (not behind a protected guard)", async () => {
  let markup: string;
  try {
    markup = await renderPage(SigninPage);
  } catch (err) {
    assert.fail(
      "the sign-in page must render for a signed-out visitor — it must stay outside any protected route group so a guard never redirects sign-in to itself: " +
        (err instanceof Error ? err.message : String(err)),
    );
    return;
  }
  assert.ok(
    visibleText(markup).length >= 8,
    `the sign-in entry must render a real screen for a signed-out visitor, got: "${visibleText(markup)}"`,
  );
});

// Primary-screen copy discipline — no protocol or security jargon on the assembled
// sign-in screen. Scoped to THIS page's own rendered face text.
test("sign-in page entry shows no protocol or security jargon", async () => {
  const text = faceText(await renderPage(SigninPage));
  for (const { label, re } of JARGON) {
    assert.ok(
      !re.test(text),
      `the sign-in screen must say what happens in plain words — found jargon "${label}" in: "${text}"`,
    );
  }
});
