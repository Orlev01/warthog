// E05-S02 — Help / compatibility VIEW component (src/components/public/help.tsx).
//
// RED-first: src/components/public/help.tsx does NOT exist yet, so importing
// `./help` throws and EVERY test in this file fails until the builder adds the
// component. That absence is the entire point of test-first — do not implement
// anything to make these pass.
//
// WHY this component exists (brief feature "Agent compatibility and help pages";
// "Connect an agent"): a PUBLIC, render-testable page that explains, PER AGENT
// PLATFORM, how to connect Warthog and notes any current platform gap. From ONE
// component it must show:
//   • a section PER PLATFORM naming each of Claude, ChatGPT, Gemini, Grok, Llama
//     and "Other" (the six platforms the brief/task name),
//   • CONNECT STEPS that show exactly where to paste Warthog's connector address
//     (the address is config-driven per INV-21, so it arrives as a prop — the page
//     entry derives it from `config.publicBaseUrl` and passes it in), and
//   • a CURRENT PLATFORM GAP note and what to do instead (e.g. a platform that does
//     not yet support the standard remote connector sign-in — brief "Connect an
//     agent" / integrations).
// The page entry (src/app/help/compatibility/page.tsx) is a thin shell over this
// component; it is characterised separately in that file's sibling page.test.tsx.
//
// How these tests stay honest:
//   * They pin BEHAVIOUR — what the component RENDERS — never the source text of
//     help.tsx. A behaviour-preserving refactor (different wrapper elements,
//     reworded-but-still-plain copy, extra classes, a different icon, next/link
//     instead of <a>) stays green as long as the assembled view still names every
//     platform, shows the connector address with connect steps, and notes a gap.
//   * Every absence check (no raw hex, no protocol/security jargon) is scoped to
//     THIS component's own rendered output — the exact unit under test. The jargon
//     scan runs over PROSE only (URLs stripped first), because the connector address
//     the user pastes is a URL ending in "/mcp" — that path is data to copy, not the
//     page "saying MCP" as jargon.
//
// By the project's named-export convention for view components (Landing, Wordmark,
// ComingSoon, DashboardView) the help/compatibility view is exported as `Help`, and
// the one config-driven value it displays — the connector address to paste — is a
// prop (`connectorAddress`), mirroring how the sibling view components take their
// data as props rather than reading config themselves (src/components/** is pure).
//
// We render with `react-dom/server` (no DOM/jsdom — React component / E2E testing
// is a per-job ADR) and read the emitted markup, exactly as landing.test.tsx does.

import * as React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";

import { Help } from "./help";

// --- tiny markup helpers (no DOM), mirrored from landing.test.tsx --------------

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

// Visible text with tags stripped and entities decoded: exactly the words a sighted
// reader sees (an <svg> icon contributes none), whitespace collapsed.
function visibleText(markup: string): string {
  return decode(markup.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

// All human-facing text: the visible copy PLUS the words a screen reader announces
// from the attributes that carry them. The jargon scan runs over this (with URLs
// stripped — see faceProse).
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

// Human-facing PROSE: faceText with URLs removed, so the connector address the user
// copies (a URL that legitimately contains "/mcp") is not mistaken for jargon prose.
function faceProse(markup: string): string {
  return faceText(markup).replace(/https?:\/\/\S+/gi, " ").replace(/\s+/g, " ").trim();
}

// The visible text of every section label — a heading (h1–h6), an accordion
// <summary>, or a definition term (<dt>). "Per-platform" means each platform gets
// its OWN labelled section, so we assert against these, not loose body text (which
// avoids matching an incidental "other" in a sentence).
function sectionLabels(markup: string): string[] {
  const out: string[] = [];
  for (const m of markup.matchAll(/<(h[1-6]|summary|dt)\b[^>]*>([\s\S]*?)<\/\1>/gi)) {
    out.push(visibleText(m[2]!));
  }
  return out;
}

// A distinctive, obviously-fake connector address passed in as the config-driven
// prop. The real page entry derives this from `config.publicBaseUrl` (INV-21); here
// we only need a value we can look for in the output to prove it is displayed.
const CONNECTOR_ADDRESS = "https://connect.warthog.test/mcp";

function render(): string {
  return renderToStaticMarkup(<Help connectorAddress={CONNECTOR_ADDRESS} />);
}

// The six agent platforms the task/brief name (Claude, ChatGPT, Gemini, Grok,
// Llama, Other). "Llama" is matched as a substring so "Llama-based clients" (the
// wording the landing uses) also satisfies it.
const PLATFORMS: { name: string; re: RegExp }[] = [
  { name: "Claude", re: /\bclaude\b/i },
  { name: "ChatGPT", re: /\bchat\s*gpt\b/i },
  { name: "Gemini", re: /\bgemini\b/i },
  { name: "Grok", re: /\bgrok\b/i },
  { name: "Llama", re: /\bllama\b/i },
  { name: "Other", re: /\bother\b/i },
];

// Signals that the page notes a CURRENT PLATFORM GAP and what to do instead (brief
// "Connect an agent": "a note of any platform gap … and what to do instead"; a
// platform that cannot use the standard connector sign-in gets an access key). Any
// one of these is enough — the wording is the builder's to choose.
const GAP_SIGNALS: RegExp[] = [
  /\bnot yet\b/i,
  /\bdoesn['’]?t\s+(?:yet\s+)?support/i,
  /\bdoes not\s+(?:yet\s+)?support/i,
  /\bisn['’]?t\s+(?:yet\s+)?(?:supported|available)/i,
  /\byet to\s+(?:support|add)/i,
  /\bcan['’]?t\s+(?:yet\s+)?(?:use|connect)/i,
  /\bcannot\s+(?:yet\s+)?(?:use|connect)/i,
  /\baccess key\b/i,
  /\bwhat to do instead\b/i,
];

// The forbidden vocabulary on a primary screen (brief design_ux.copy: never show
// protocol or security jargon on primary screens — say what happens instead). Same
// list the landing is held to; "connector" is NOT jargon — the brief uses it as
// user-facing product language ("custom connector", "connector address").
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

// === AC1 — a section per agent platform ========================================
//
// Each of the six platforms must be named as its OWN section label (heading /
// accordion summary / term), proving the page is organised per platform rather
// than listing the names in one sentence.

test("names every agent platform as its own section (Claude, ChatGPT, Gemini, Grok, Llama, Other)", () => {
  const markup = render();
  const labels = sectionLabels(markup);
  assert.ok(
    labels.length > 0,
    `the help page must be organised into labelled sections (headings or accordion summaries), got markup: ${markup}`,
  );
  for (const platform of PLATFORMS) {
    assert.ok(
      labels.some((label) => platform.re.test(label)),
      `the help page must have a section for "${platform.name}", got section labels: ${JSON.stringify(labels)}`,
    );
  }
});

// === AC1 — connect steps that show the connector address =======================
//
// The connect steps show "exactly where to paste Warthog's connector address"
// (brief). We prove both halves: the exact config-driven address passed in is
// displayed verbatim, and there is an actionable instruction (paste / add / copy /
// enter) telling the person what to do with it.

test("shows the connector address to paste, exactly as supplied", () => {
  const markup = render();
  assert.ok(
    decode(markup).includes(CONNECTOR_ADDRESS),
    `the help page must display the connector address it is given ("${CONNECTOR_ADDRESS}") so people can paste it, got: ${decode(markup)}`,
  );
});

test("gives an actionable connect step for the connector address", () => {
  const text = visibleText(render());
  assert.match(
    text.toLowerCase(),
    /\b(paste|add|copy|enter)\b/i,
    `the connect steps must tell people what to do with the connector address (paste / add / copy / enter), got: "${text}"`,
  );
});

// === AC1 — a current platform gap and what to do instead =======================

test("notes a current platform gap and what to do instead", () => {
  const text = faceText(render());
  assert.ok(
    GAP_SIGNALS.some((re) => re.test(text)),
    `the help page must note any current platform gap and what to do instead (e.g. a platform that does not yet support the standard connector, so create an access key), got: "${text}"`,
  );
});

// === Design system — colour comes from tokens, never a raw hex literal =========

test("the help page uses design tokens, never a raw hex colour", () => {
  const markup = render();
  assert.ok(
    !/#[0-9a-fA-F]{3,8}\b/.test(markup),
    `no raw hex colour may appear in the help page markup, got: ${markup}`,
  );
});

// === Primary-screen copy discipline — plain words, no protocol/security jargon ==
//
// Scoped to this component's own PROSE (URLs stripped), so the "/mcp" in the
// connector address a person copies does not read as the page "saying MCP".

test("the help page shows no protocol or security jargon in its prose", () => {
  const prose = faceProse(render());
  for (const { label, re } of JARGON) {
    assert.ok(
      !re.test(prose),
      `the help page must say what happens in plain words — found jargon "${label}" in: "${prose}"`,
    );
  }
});
