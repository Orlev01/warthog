// E05-S01 — Landing view component (src/components/public/landing.tsx).
//
// RED-first: src/components/public/landing.tsx does NOT exist yet, so importing
// `./landing` throws and EVERY test in this file fails until the builder adds the
// component. That absence is the entire point of test-first — do not implement
// anything to make these pass.
//
// WHY this component exists (brief feature "Public landing page", design_ux
// primary_journey "LANDING"): the public front door must show, from ONE
// render-testable component, the four things the primary journey's LANDING surface
// promises:
//   • the POSITIONING LINE   "Your agents work for you, on your terms, from your home",
//   • the PLAIN THREE STEPS  (connect your services once; connect your agents;
//                             approve and see everything),
//   • the AGENT COMPATIBILITY LIST (Claude, ChatGPT, Gemini, Grok, Llama-based
//                             clients — the platforms the brief names), and
//   • SIGN UP / SIGN IN       links (to /signup and /signin).
// The page entry (src/app/page.tsx) is a thin shell over this component; it is
// characterised separately in src/app/page.test.tsx.
//
// How these tests stay honest:
//   * They pin BEHAVIOUR — what the component RENDERS — never the source text of
//     landing.tsx. A later behaviour-preserving refactor (different wrapper
//     elements, reworded-but-still-plain copy, extra classes, next/link instead of
//     <a>, a different icon) stays green as long as the assembled view still shows
//     the positioning line, the three steps, the compatibility list and the two
//     links.
//   * Every absence check (no raw hex, no jargon) is scoped to THIS component's own
//     rendered output — the exact unit under test — so the same string living
//     elsewhere in the app is irrelevant.
//
// We render with `react-dom/server` (no DOM/jsdom — React component / E2E testing
// is a per-job ADR) and read the emitted markup, exactly as the sibling view tests
// (dashboard-view.test.tsx, setup-checklist.test.tsx) do. By the project's named
// export convention for view components (DashboardView, SetupChecklist, Wordmark,
// ComingSoon) the landing view is exported as `Landing`.

import * as React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";

import { Landing } from "./landing";

// --- tiny markup helpers (no DOM), mirrored from the sibling view tests --------

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

// Visible text with tags stripped and entities decoded: exactly the words a
// sighted reader sees (an <svg> icon contributes none), whitespace collapsed.
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
    for (const m of markup.matchAll(re)) parts.push(decode(m[1]!));
  }
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

function attr(attrs: string, name: string): string | null {
  const m = attrs.match(new RegExp(`\\b${name}="([^"]*)"`, "i"));
  return m ? m[1]! : null;
}

type Anchor = { href: string | null; text: string };

// Every <a> in the markup (next/link also renders to <a>), with href + visible text.
function anchors(markup: string): Anchor[] {
  const out: Anchor[] = [];
  for (const m of markup.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    out.push({ href: attr(m[1]!, "href"), text: visibleText(m[2]!) });
  }
  return out;
}

function render(): string {
  return renderToStaticMarkup(<Landing />);
}

test("product preview is explicitly illustrative and compatibility is qualified", () => {
  const markup = render();
  const text = visibleText(markup);
  assert.match(text, /illustrative workspace/i);
  assert.match(text, /availability varies by platform and plan/i);
  assert.match(text, /only.*through Warthog/i);
  assert.ok(anchors(markup).some((link) => link.href === "/help/compatibility"));
});

test("public navigation has real destinations and FAQs use native disclosure controls", () => {
  const markup = render();
  for (const { href } of anchors(markup)) {
    assert.ok(href && href !== "#", "no placeholder links");
    if (href.startsWith("#")) assert.ok(markup.includes(`id="${href.slice(1)}"`));
  }
  assert.equal((markup.match(/<h1\b/g) ?? []).length, 1);
  assert.ok((markup.match(/<summary\b/g) ?? []).length >= 3);
  const preview = markup.match(/<figure\b[\s\S]*?<\/figure>/)?.[0];
  assert.ok(preview && !/<button\b/.test(preview), "the static preview must not pretend to have live controls");
});

test("marketing artwork is decorative and server content does not depend on animation", () => {
  const markup = render();
  assert.match(markup, /class="wh-landing-backdrop" aria-hidden="true"/);
  assert.match(markup, /data-motion="off"/);
  // Before hydration the motion control is hidden; it never renders as a dead, disabled
  // "Motion off" button (public-26) — reduced motion shows a plain note instead.
  assert.match(markup, /<button[^>]*type="button"[^>]*hidden=""[^>]*>[^]*Play animations<\/button>/);
  assert.doesNotMatch(markup, /Motion off|<button[^>]*disabled/);
  assert.ok(!/<(?:main|section|article|h[1-3])\b[^>]*(?:hidden|aria-hidden)/.test(markup));
});

// The questions also answer "where is my data and how am I protected?" in their own group,
// pointing to the privacy policy. Every claim has to be one the code and policy support, so
// the strong-sounding words Warthog can't back up (no end-to-end path, no certification, no
// independent audit yet) never appear on the front door.
test("questions include a security and privacy group that doesn't overclaim", () => {
  const markup = render();
  const group = markup.match(/<section\b[^>]*id="questions-security"[\s\S]*?<\/section>/)?.[0];
  assert.ok(group, "a security and privacy question group is present");
  assert.match(visibleText(group), /^Security and privacy\b/);
  assert.ok((group.match(/<summary\b/g) ?? []).length >= 8, "the group covers the common concerns");
  const text = visibleText(group);
  for (const concern of [/\bstored\b/i, /\bAustralia\b/, /\bencrypted\b/i, /\bstaff\b/i, /\bnever sell\b/i, /\bdelete\b/i]) {
    assert.match(text, concern);
  }
  assert.ok(anchors(group).some((link) => link.href === "/privacy"));
  for (const overclaim of [
    /end[- ]to[- ]end/i,
    /zero[- ]knowledge/i,
    /\bSOC ?2\b/i,
    /\bISO ?27001\b/i,
    /(?:military|bank)[- ]grade/i,
    /unhackable|tamper[- ]proof/i,
    /independently audited|pen(?:etration)?[- ]test/i,
  ]) {
    assert.doesNotMatch(visibleText(markup), overclaim);
  }
});

// The positioning line (brief overview; design_ux primary_journey) — asserted
// without a trailing period so either "…home" or "…home." satisfies it.
const POSITIONING_LINE = "Your agents work for you, on your terms, from your home";

// The compatible agent platforms the brief names, twice (overview + "Connect an
// agent"): Claude, ChatGPT, Gemini, Grok, Llama-based clients.
const COMPATIBLE_AGENTS = ["Claude", "ChatGPT", "Gemini", "Grok", "Llama"] as const;

// The forbidden vocabulary on a primary screen (brief design_ux.copy: never show
// protocol or security jargon on primary screens — say what happens instead).
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
  { label: "encryption key", re: /\bencryption key\b/i },
];

// === AC1 — the positioning line ================================================

test("renders the positioning line verbatim", () => {
  const text = visibleText(render());
  assert.ok(
    text.includes(POSITIONING_LINE),
    `the landing must show the positioning line "${POSITIONING_LINE}", got: "${text}"`,
  );
});

// === AC1 — the plain three steps ===============================================
//
// The brief's three steps (design_ux feature list): "connect your services once;
// connect your agents; approve and see everything". Each step is pinned by the
// distinctive words that can only come from that step (never the positioning line
// or the compatibility list), so a reworded-but-faithful step still passes while a
// missing step fails.

test("renders the three steps: connect your services, connect your agents, approve and see everything", () => {
  const text = visibleText(render());
  const low = text.toLowerCase();

  // Step 1 — connect your services (once). "services" appears nowhere else on the
  // landing, so pairing it with "connect" pins the first step.
  assert.match(
    low,
    /connect[^.!?]{0,40}services?\b/i,
    `step 1 must be about connecting your services, got: "${text}"`,
  );

  // Step 2 — connect your agents.
  assert.match(
    low,
    /connect[^.!?]{0,40}agents?\b/i,
    `step 2 must be about connecting your agents, got: "${text}"`,
  );

  // Step 3 — approve and see everything. "approve" and "everything" are each
  // distinctive to the third step.
  assert.match(low, /\bapprove\b/i, `step 3 must be about approving, got: "${text}"`);
  assert.match(
    low,
    /\beverything\b/i,
    `step 3 must be about seeing everything, got: "${text}"`,
  );
});

// === AC1 — the agent compatibility list ========================================

test("renders the agent compatibility list naming every compatible platform", () => {
  const text = visibleText(render());
  const low = text.toLowerCase();
  for (const agent of COMPATIBLE_AGENTS) {
    assert.ok(
      low.includes(agent.toLowerCase()),
      `the compatibility list must name "${agent}", got: "${text}"`,
    );
  }
});

// === AC1 — Sign up / Sign in links =============================================

test("renders a Sign up link to /signup and a Sign in link to /signin", () => {
  const markup = render();
  const as = anchors(markup);

  const signUp = as.filter((a) => a.href === "/signup");
  assert.ok(
    signUp.length >= 1,
    `the landing must link to /signup, got anchors: ${JSON.stringify(as)}`,
  );
  assert.ok(
    signUp.some((a) => /sign\s*up/i.test(a.text)),
    `the /signup link must read as "Sign up", got: ${JSON.stringify(signUp)}`,
  );

  const signIn = as.filter((a) => a.href === "/signin");
  assert.ok(
    signIn.length >= 1,
    `the landing must link to /signin, got anchors: ${JSON.stringify(as)}`,
  );
  assert.ok(
    signIn.some((a) => /sign\s*in/i.test(a.text)),
    `the /signin link must read as "Sign in", got: ${JSON.stringify(signIn)}`,
  );
});

// === Design system — colour comes from tokens, never a raw hex literal =========

test("the landing uses design tokens, never a raw hex colour", () => {
  const markup = render();
  assert.ok(
    !/#[0-9a-fA-F]{3,8}\b/.test(markup),
    `no raw hex colour may appear in the landing markup, got: ${markup}`,
  );
});

// === Primary-screen copy discipline — plain words, no protocol/security jargon ==

test("the landing shows no protocol or security jargon", () => {
  const text = faceText(render());
  for (const { label, re } of JARGON) {
    assert.ok(
      !re.test(text),
      `the landing must say what happens in plain words — found jargon "${label}" in: "${text}"`,
    );
  }
});
