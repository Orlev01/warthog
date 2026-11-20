// E05-S03 — Privacy policy & security-FAQ VIEW component (src/components/public/privacy.tsx).
//
// RED-first: src/components/public/privacy.tsx does NOT exist yet, so importing
// `./privacy` throws and EVERY test in this file fails until the builder adds the
// component. That absence is the entire point of test-first — do not implement
// anything to make these pass.
//
// WHY this component exists (brief feature "Agent compatibility and help pages";
// data-rights principle 20; brief.yaml ~L426-431): a PUBLIC, render-testable
// privacy policy / security FAQ that states, in plain Australian English:
//   • WHAT is stored and WHERE (Australia);
//   • that high-tier identity details AND cards are encrypted on the person's own
//     device, so neither Warthog's servers nor its staff can read them while stored;
//   • that those device-protected values pass through Warthog only for the single
//     release the person approved, and are discarded once collected or expired; and
//   • HOW to export everything or delete the account.
// The page entry (src/app/privacy/page.tsx) is a thin shell over this component; it
// is characterised separately in that file's sibling page.test.tsx.
//
// How these tests stay honest:
//   * They pin BEHAVIOUR — what the component RENDERS — never the source text of
//     privacy.tsx. A behaviour-preserving refactor (different wrapper elements,
//     reworded-but-still-plain copy, extra classes, next/link instead of <a>) stays
//     green as long as the assembled view still makes each statement above.
//   * Each claim is matched by a SET of plain-English signals (any one satisfies it),
//     mirroring landing/help's GAP_SIGNALS style, so the exact wording stays the
//     builder's to choose.
//   * The one absence check (no raw hex colour) is scoped to THIS component's own
//     rendered markup — the exact unit under test. There is deliberately NO
//     jargon-absence check here: the brief (design_ux.copy, ~L466-469) EXPRESSLY
//     permits security words like "encryption key"/"token" on the security FAQ, so
//     forbidding them would contradict the brief.
//
// By the project's named-export convention for view components (Landing, Wordmark,
// ComingSoon, Help) the privacy view is exported as `Privacy`, and — like Landing —
// it takes no props (its content is static; no config-driven value is in scope).
//
// We render with `react-dom/server` (no DOM/jsdom — React component / E2E testing is
// a per-job ADR) and read the emitted markup, exactly as landing.test.tsx does.

import * as React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";

import { Privacy } from "./privacy";

// --- tiny markup helpers (no DOM), mirrored from landing/help tests ------------

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

// Visible text with tags stripped and entities decoded: the words a sighted reader
// sees, whitespace collapsed.
function visibleText(markup: string): string {
  return decode(markup.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

// All human-facing text: the visible copy PLUS the words a screen reader announces
// from the attributes that carry them. Claims are matched against this so copy that
// lives in an aria-label (not loose body text) still counts.
function faceText(markup: string): string {
  const parts = [visibleText(markup)];
  for (const re of [
    /aria-label="([^"]*)"/gi,
    /\btitle="([^"]*)"/gi,
    /\balt="([^"]*)"/gi,
  ]) {
    for (const m of markup.matchAll(re)) parts.push(decode(m[1]!));
  }
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

function render(): string {
  return renderToStaticMarkup(<Privacy />);
}

// Assert at least one signal in a set matches — reports the whole set + the text on
// failure, so a reworded-but-faithful copy that nobody anticipated is easy to read.
function assertAnySignal(
  signals: RegExp[],
  text: string,
  message: string,
): void {
  assert.ok(
    signals.some((re) => re.test(text)),
    `${message}\n  looked for any of: ${signals.map(String).join(", ")}\n  in: "${text}"`,
  );
}

// --- plain-English signal sets (any one satisfies the claim) -------------------

// A storage statement — the page says it stores / keeps / holds the person's data.
const STORAGE_SIGNALS: RegExp[] = [
  /\bstor(?:e|es|ed|ing)\b/i,
  /\bkeep(?:s|ing)?\b/i,
  /\bkept\b/i,
  /\bhold(?:s|ing)?\b/i,
  /\bheld\b/i,
  /\bsaved?\b/i,
];

// The categories of data the page may enumerate as "what is stored". We require the
// page to name at least TWO distinct ones, proving it states what it stores rather
// than only gesturing at "your data".
const CATEGORY_SIGNALS: { label: string; re: RegExp }[] = [
  { label: "identity details / profile", re: /\b(?:identity|profile|details?)\b/i },
  { label: "cards", re: /\bcards?\b/i },
  { label: "activity record / history", re: /\b(?:activity|record|history)\b/i },
  { label: "memory", re: /\bmemor/i },
  { label: "skills", re: /\bskills?\b/i },
  { label: "rules / budgets / preferences", re: /\b(?:preference|rule|budget)s?\b/i },
];

// The protected identity details: high-tier, or the everyday words for them.
const SENSITIVE_DETAIL_SIGNALS: RegExp[] = [
  /high[-\s]?tier/i,
  /sensitive\b[\s\S]{0,20}\bdetail/i,
  /most sensitive/i,
  /\bpassport\b/i,
  /licen[cs]e/i,
  /identity document/i,
  /\bmedicare\b/i,
];

// Encrypted on the person's OWN device (not just "encrypted").
const DEVICE_SIGNALS: RegExp[] = [
  /\byour (?:own )?device/i,
  /\bon your (?:phone|device|computer|laptop)/i,
  /\bbefore (?:it|they) (?:ever )?leaves?\b/i,
  /encrypted on your\b/i,
  /\bon your end\b/i,
];

// Unreadable to Warthog / its servers / its staff while stored.
const UNREADABLE_SIGNALS: RegExp[] = [
  /\bunreadable\b/i,
  /can'?t\s+(?:be\s+)?(?:read|see|unlock|open|decrypt)/i,
  /cannot\s+(?:be\s+)?(?:read|see|unlock|open|decrypt)/i,
  /(?:neither|no one|nobody|not even|never)\b[\s\S]{0,40}\b(?:read|see|unlock|open|decrypt)/i,
  /\bonly you\b[\s\S]{0,40}\b(?:can|unlock|read|open|see)/i,
  /\bstaff\b[\s\S]{0,50}\b(?:can'?t|cannot|can\s*not|no|never|unable)\b/i,
];

// Passes through Warthog only for a release / hand-over.
const RELEASE_SIGNALS: RegExp[] = [
  /\brelease/i,
  /pass(?:es|ed)?\s+through/i,
  /hand(?:ed|s)?\s+(?:it\s+)?over/i,
  /\bhand(?:ed|s)?\s+across/i,
];

// Only when the person approves it.
const APPROVE_SIGNALS: RegExp[] = [
  /\bapprov/i,
  /you\s+(?:say\s+)?(?:yes|approve)/i,
  /you\s+allow/i,
];

// And discarded afterwards (once collected or expired).
const DISCARD_SIGNALS: RegExp[] = [
  /\bdiscard/i,
  /\bdeleted?\b/i,
  /\bremoved?\b/i,
  /\bgone\b/i,
  /\bnot kept\b/i,
  /thrown away/i,
  /\bexpire/i,
  /no longer\b[\s\S]{0,20}\b(?:kept|stored|held)/i,
];

// === AC1 — states WHERE data is stored: Australia ==============================

test("states that data is stored in Australia", () => {
  const text = faceText(render());
  assert.match(
    text,
    /\baustralia\b/i,
    `the privacy policy must state WHERE data is stored — in Australia — got: "${text}"`,
  );
  assertAnySignal(
    STORAGE_SIGNALS,
    text,
    "the privacy policy must make a storage statement (what is stored), not only name a country",
  );
});

// === AC1 — states WHAT is stored ===============================================

test("states what is stored (names at least two categories of data it holds)", () => {
  const text = faceText(render());
  assertAnySignal(
    STORAGE_SIGNALS,
    text,
    "the privacy policy must say it stores/keeps/holds the person's data",
  );
  const named = CATEGORY_SIGNALS.filter(({ re }) => re.test(text)).map((c) => c.label);
  assert.ok(
    named.length >= 2,
    `the privacy policy must state WHAT is stored by naming at least two kinds of data (e.g. identity details, cards, the activity record), matched only: ${JSON.stringify(named)} in: "${text}"`,
  );
});

// === AC1 — high-tier details AND cards are device-encrypted ====================

test("states that high-tier identity details and cards are encrypted on your own device", () => {
  const text = faceText(render());

  assert.match(
    text,
    /\bcards?\b/i,
    `the privacy policy must cover cards among the device-encrypted data, got: "${text}"`,
  );
  assertAnySignal(
    SENSITIVE_DETAIL_SIGNALS,
    text,
    "the privacy policy must cover your most sensitive (high-tier) identity details among the device-encrypted data",
  );
  assert.match(
    text,
    /\bencrypt/i,
    `the privacy policy must say these are encrypted, got: "${text}"`,
  );
  assertAnySignal(
    DEVICE_SIGNALS,
    text,
    "the privacy policy must say the encryption happens on the person's OWN device (not merely that data is 'encrypted')",
  );
});

// === AC1 — ... and are unreadable to Warthog (servers / staff) while stored =====

test("states that those values are unreadable to Warthog and its staff while stored", () => {
  const text = faceText(render());
  assertAnySignal(
    UNREADABLE_SIGNALS,
    text,
    "the privacy policy must state that neither Warthog's servers nor its staff can read the device-encrypted details and cards while stored",
  );
});

// === AC1 — pass through only for an approved release, then discarded ============

test("states that device-protected values pass through only for a release you approve, then are discarded", () => {
  const text = faceText(render());
  assertAnySignal(
    RELEASE_SIGNALS,
    text,
    "the privacy policy must say device-protected values pass through Warthog only for a release",
  );
  assertAnySignal(
    APPROVE_SIGNALS,
    text,
    "the privacy policy must say that release happens only when the person approves it",
  );
  assertAnySignal(
    DISCARD_SIGNALS,
    text,
    "the privacy policy must say the released value is discarded afterwards (once collected or expired)",
  );
});

// === AC1 — how to export or delete everything ==================================

test("explains how to export everything and how to delete the account", () => {
  const text = faceText(render());
  assert.match(
    text,
    /\bexport/i,
    `the privacy policy must explain that the person can export everything, got: "${text}"`,
  );
  assert.match(
    text,
    /\bdelet/i,
    `the privacy policy must explain that the person can delete their account / everything, got: "${text}"`,
  );
});

// === Design system — colour comes from tokens, never a raw hex literal =========

test("the privacy page uses design tokens, never a raw hex colour", () => {
  const markup = render();
  assert.ok(
    !/#[0-9a-fA-F]{3,8}\b/.test(markup),
    `no raw hex colour may appear in the privacy page markup, got: ${markup}`,
  );
});


test("privacy describes overseas providers and retention without Australia-only promises", () => {
  const markup = renderToStaticMarkup(<Privacy />);
  for (const phrase of ["Australia East", "Resend", "Twilio", "United States", "Google", "Microsoft", "30 days", "backups", "not end-to-end encrypted"]) {
    assert.ok(markup.includes(phrase), phrase);
  }
  assert.doesNotMatch(markup, /Every byte.*Australia|never moved.*offshore/);
});


test("deletion policy distinguishes live access removal from backup retention", () => {
  const markup = renderToStaticMarkup(<Privacy />);
  assert.match(markup, /cuts off access and schedules removal from the live application/);
  assert.match(markup, /database backups may retain older data until their retention period ends/);
});

test("the LinkedIn section says what Warthog reads, that every post waits for approval, and what it can't see", () => {
  const markup = renderToStaticMarkup(<Privacy />);
  assert.match(markup, /id="linkedin"/);
  assert.match(markup, /name, email address and\s+profile photo/);
  assert.match(markup, /Every post waits for your approval/);
  assert.match(markup, /can&#x27;t read your feed, connections, messages or job history/);
  assert.match(markup, /60 days/);
});
