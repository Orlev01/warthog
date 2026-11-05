// E18-S17 — Warthog wordmark in the shell and auth screens.
//
// RED-first: src/components/shell/wordmark.tsx does NOT exist yet, so importing
// `./wordmark` throws and every test in this file fails until the builder adds the
// component AND wires it into the desktop sidebar (app-shell.tsx) and the auth
// screens (auth-views.tsx). That absence is the entire point of test-first — do
// not implement anything to make these pass.
//
// Why this feature exists (task E18-S17): the signed-in shell and the auth screens
// show no product identity (seen in the first E2E screenshots); the brief asks for
// a polished security-portal look. A small Warthog wordmark — the product name plus
// a simple shield-style glyph — sits at the top of the desktop sidebar and above
// each auth screen's heading, linking home: to / when signed out (the auth screens)
// and to /home when signed in (the shell).
//
// These tests pin BEHAVIOUR — what gets RENDERED (an accessible link, where it sits
// relative to the navigation / heading, which design surface it points at) — never
// the source text of wordmark.tsx / app-shell.tsx / auth-views.tsx. A later
// behaviour-preserving refactor (different wrapper elements, a different shield
// glyph, reworded-but-equivalent markup, different CSS classes) stays green as long
// as the wordmark is still the right accessible link in the right place. We render
// with `react-dom/server` (no DOM/jsdom — React component / E2E testing is a
// per-job ADR) and read the emitted markup.
//
// The contract the builder implements (exactly this):
//
//   Wordmark({ href }): a small product wordmark that is a single LINK.
//     • Renders an <a href={href}> whose accessible name is "Warthog home".
//     • Shows the product name "Warthog" as visible text, beside a decorative
//       shield-style glyph (an <svg>; the glyph adds no words to the name).
//     • Uses only the design tokens (globals.css) — never a raw hex colour.
//
//   Placement (the two callers decide the destination):
//     • AppShell renders it at the top of the desktop sidebar, ABOVE the navigation,
//       pointing at /home (the signed-in home).
//     • Every auth view (sign-up, sign-in, recover, device) renders it ABOVE the
//       screen heading, pointing at / (the signed-out landing).

import * as React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";

import { Wordmark } from "./wordmark";
import { AppShell } from "./app-shell";
import { SignupView, SigninView, RecoverView, DeviceView } from "../auth/auth-views";

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

function norm(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

// Visible text of an HTML fragment with tags stripped and entities decoded:
// exactly the words a sighted reader sees (an <svg> glyph contributes none).
function visibleText(markup: string): string {
  return norm(decode(markup.replace(/<[^>]*>/g, " ")));
}

// Read one double-quoted attribute off an element's attribute string.
function attr(attrs: string, name: string): string | null {
  const m = attrs.match(new RegExp(`\\b${name}="([^"]*)"`, "i"));
  return m ? m[1] : null;
}

type Anchor = {
  index: number; // byte offset of the opening <a in the markup (for DOM-order checks)
  attrs: string;
  inner: string;
  href: string | null;
  name: string; // accessible name: aria-label if present, else the visible text
};

// The accessible name of a link per ARIA: an aria-label (when present and
// non-empty) overrides the element's text content; otherwise the name is the
// visible text (which includes any visually-hidden text in the content).
function accessibleName(attrs: string, inner: string): string {
  const al = attr(attrs, "aria-label");
  if (al && al.trim().length > 0) return norm(decode(al));
  return visibleText(inner);
}

// Every <a> element in the markup, in DOM order, with its accessible name.
// (<a> cannot nest, so the non-greedy match is safe.)
function anchors(markup: string): Anchor[] {
  const out: Anchor[] = [];
  for (const m of markup.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const attrs = m[1];
    const inner = m[2];
    out.push({
      index: m.index ?? 0,
      attrs,
      inner,
      href: attr(attrs, "href"),
      name: accessibleName(attrs, inner),
    });
  }
  return out;
}

// The wordmark link: the anchor whose accessible name is "Warthog home"
// (matched case-insensitively, whitespace-normalised).
function wordmarkAnchor(markup: string): Anchor | undefined {
  return anchors(markup).find((a) => a.name.toLowerCase() === "warthog home");
}

// Offset of the first anchor whose accessible name contains `label`, or -1.
function firstAnchorIndex(markup: string, label: string): number {
  const re = new RegExp(`\\b${label}\\b`, "i");
  const hit = anchors(markup).find((a) => re.test(a.name));
  return hit ? hit.index : -1;
}

// ===========================================================================
// The Wordmark component — a single accessible link (AC2).
// ===========================================================================

// It is a LINK (an <a href>) to the destination it is given, and its accessible
// name is exactly "Warthog home". Exercised with BOTH destinations so the href is
// honoured from the prop, not hard-coded.
for (const href of ["/", "/home"]) {
  test(`Wordmark({ href: "${href}" }) is a link to ${href} named "Warthog home"`, () => {
    const markup = renderToStaticMarkup(<Wordmark href={href} />);
    const wm = wordmarkAnchor(markup);
    assert.ok(
      wm,
      `the wordmark must render an <a> whose accessible name is "Warthog home"; anchors found: ${JSON.stringify(
        anchors(markup).map((a) => ({ name: a.name, href: a.href })),
      )}`,
    );
    assert.equal(
      wm!.href,
      href,
      `the wordmark link must point at the href it is given ("${href}"), got "${wm!.href}"`,
    );
    assert.equal(
      wm!.name.toLowerCase(),
      "warthog home",
      `the wordmark's accessible name must be exactly "Warthog home", got "${wm!.name}"`,
    );
  });
}

// It is "text plus a glyph": the product name "Warthog" is shown as visible text,
// alongside a decorative shield-style glyph rendered as an <svg> (lucide renders an
// <svg>). The glyph adds no words — the accessible name assertion above already
// pins the name to exactly "Warthog home".
test("Wordmark shows the word 'Warthog' and a glyph (an <svg>)", () => {
  const markup = renderToStaticMarkup(<Wordmark href="/home" />);
  assert.match(
    visibleText(markup),
    /warthog/i,
    `the wordmark must show the product name "Warthog" as visible text, got: "${visibleText(markup)}"`,
  );
  assert.match(
    markup,
    /<svg\b/i,
    `the wordmark must render a shield-style glyph (an <svg>), got: ${markup}`,
  );
});

// AC2 — design tokens only: no raw hex colour in the wordmark's own markup. Scoped
// to the Wordmark unit (nothing the caller passes carries a "#"), so any hex here
// could only be a hard-coded colour.
test("Wordmark uses only design tokens, never a raw hex colour", () => {
  const markup = renderToStaticMarkup(<Wordmark href="/home" />);
  assert.ok(
    !/#[0-9a-fA-F]{3,8}\b/.test(markup),
    `no raw hex colour may appear in the wordmark markup, got: ${markup}`,
  );
});

// ===========================================================================
// AC1 (shell) — the desktop sidebar renders the wordmark ABOVE the navigation,
// pointing at /home (the signed-in home).
// ===========================================================================

test("AppShell renders the wordmark at the top of the desktop sidebar, above the nav, linking to /home", () => {
  const markup = renderToStaticMarkup(
    <AppShell activeSection="home">
      <span />
    </AppShell>,
  );

  const wm = wordmarkAnchor(markup);
  assert.ok(
    wm,
    `the app shell must render the "Warthog home" wordmark link; anchors found: ${JSON.stringify(
      anchors(markup).map((a) => ({ name: a.name, href: a.href })),
    )}`,
  );
  assert.equal(
    wm!.href,
    "/home",
    `the signed-in shell wordmark must link to /home, got "${wm!.href}"`,
  );

  // "Above the navigation": the wordmark precedes the sidebar's navigation items.
  // "Vault" is a link unique to the desktop sidebar (never the bottom nav), so the
  // wordmark sitting before it proves the wordmark is at the top of the sidebar.
  const vaultIndex = firstAnchorIndex(markup, "Vault");
  assert.ok(
    vaultIndex >= 0,
    `expected the desktop sidebar to carry a "Vault" link to anchor the position check, got: ${markup}`,
  );
  assert.ok(
    wm!.index < vaultIndex,
    "the wordmark must render ABOVE the sidebar navigation (before the sidebar links)",
  );
});

// ===========================================================================
// AC1 (auth) — every auth screen renders the wordmark ABOVE its heading,
// pointing at / (the signed-out landing).
// ===========================================================================

type Rendered = { view: string; step: string; render: () => string };

const AUTH: Rendered[] = [
  ...(["details", "code", "passkey", "recovery"] as const).map((step) => ({
    view: "SignupView",
    step,
    render: () => renderToStaticMarkup(<SignupView step={step} recoveryCode="K7MQ-2P4R-9XTD-6WHF" />),
  })),
  ...(["passkey", "code"] as const).map((step) => ({
    view: "SigninView",
    step,
    render: () => renderToStaticMarkup(<SigninView step={step} />),
  })),
  ...(["identify", "recovery-code", "passkey", "new-recovery"] as const).map((step) => ({
    view: "RecoverView",
    step,
    render: () => renderToStaticMarkup(<RecoverView step={step} recoveryCode="T3BN-5J8V-2QLR-7HMK" />),
  })),
  ...(["code", "confirm"] as const).map((step) => ({
    view: "DeviceView",
    step,
    render: () => renderToStaticMarkup(<DeviceView step={step} />),
  })),
];

for (const { view, step, render } of AUTH) {
  test(`${view} step "${step}" renders the wordmark above its heading, linking to /`, () => {
    const markup = render();

    const wm = wordmarkAnchor(markup);
    assert.ok(
      wm,
      `${view} step "${step}" must render the "Warthog home" wordmark link; anchors found: ${JSON.stringify(
        anchors(markup).map((a) => ({ name: a.name, href: a.href })),
      )}`,
    );
    assert.equal(
      wm!.href,
      "/",
      `the signed-out auth-screen wordmark must link to /, got "${wm!.href}" (${view} step "${step}")`,
    );

    // "Above its heading": the wordmark link precedes the screen's <h1>.
    const headingIndex = markup.search(/<h1\b/i);
    assert.ok(
      headingIndex >= 0,
      `${view} step "${step}" must render an <h1> heading to anchor the position check, got: ${markup}`,
    );
    assert.ok(
      wm!.index < headingIndex,
      `${view} step "${step}" must render the wordmark ABOVE the heading (before the <h1>)`,
    );
  });
}
