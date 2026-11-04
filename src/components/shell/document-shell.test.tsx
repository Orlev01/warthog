// E02-S07 — Document shell for theme and motion (src/components/shell/document-shell.tsx).
//
// RED-first: src/components/shell/document-shell.tsx does NOT exist yet, so
// importing `./document-shell` throws and every test here fails until the builder
// adds the component. That absence is the entire point of test-first — do not
// implement anything to make these pass.
//
// WHY this component exists (brief + conventions, App-Router rules):
//   The root app/layout.tsx must receive ONLY `children` (Next controls its
//   props; it may never be given a `theme`/`locale`/any extra prop). So the
//   presentation that varies per request — the person's colour-scheme choice and
//   their reduce-motion choice — lives in a plain, prop-driven, render-testable
//   component the layout delegates to. The layout reads the preference from the
//   request and returns `<DocumentShell theme=… reducedMotion=…>{children}</…>`.
//
// These tests pin BEHAVIOUR — what the shell RENDERS from its props — never the
// source text of document-shell.tsx, so a behaviour-preserving refactor stays
// green. We render with `react-dom/server` (no DOM/jsdom — React component / E2E
// testing is a per-job ADR) and read the emitted markup.
//
// The contract the builder implements (exactly this):
//
//   DocumentShell({ theme, reducedMotion, children }): the request-varying
//   document shell — a plain, synchronous, prop-driven component.
//     • theme: "light" | "dark" — the person's resolved colour preference. The
//       shell renders the document root <html> carrying the declarative hook the
//       stylesheet keys its token overrides on (globals.css: :root[data-theme=…]):
//       data-theme="dark" for dark, data-theme="light" for light. Setting it
//       makes the PREFERENCE win over the OS `prefers-color-scheme` media query
//       (globals.css forces light only on :root[data-theme="light"], and dark
//       only on :root[data-theme="dark"]).
//     • reducedMotion: boolean — when true, the shell disables non-essential
//       motion for the whole document REGARDLESS of the OS `prefers-reduced-motion`
//       setting, by rendering a <style> that neutralises CSS animation and
//       transition; when false it renders no such motion-disabling style.
//     • children: the page tree, rendered inside the document <body>.
//     • Being plain and prop-driven is what lets the root layout stay children-only:
//       the shell takes the preference as PROPS and renders purely from them with
//       react-dom/server (no DOM, no Next request APIs, no React context). Like the
//       other shell/ui components it does NOT import the stylesheet (the root
//       layout keeps `import "./globals.css"`), so it stays render-testable under
//       the plain `node --import tsx --test` runner.
//
import * as React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";

import { DocumentShell } from "./document-shell";

type Theme = "light" | "dark";
const THEMES: readonly Theme[] = ["light", "dark"];

// --- tiny markup helpers (no DOM) ------------------------------------------

// Visible text of an HTML fragment with tags stripped.
function strip(html: string): string {
  return html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

// The attribute string of the <html> document-root opening tag, or null.
function htmlAttrs(markup: string): string | null {
  const m = markup.match(/<html\b([^>]*)>/i);
  return m ? (m[1] ?? "") : null;
}

// The inner markup of <body>, or null.
function bodyInner(markup: string): string | null {
  const m = markup.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);
  return m ? (m[1] ?? "") : null;
}

// The inner CSS text of every <style> element in the markup.
function styleBlocks(markup: string): string[] {
  return [...markup.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1] ?? "");
}

// Does a block of CSS neutralise motion? — it zeroes/none-s BOTH of the two
// motion-bearing properties (animation and transition). Tolerant of the exact
// value (0, 0.01ms, none) and of `!important`, so wording is not pinned.
function disablesMotion(css: string): boolean {
  return /animation[^;}]*:\s*(0|none)/i.test(css) && /transition[^;}]*:\s*(0|none)/i.test(css);
}

// Render the shell the way the root layout would: a resolved preference as props,
// wrapping the page tree.
function render(
  theme: Theme,
  reducedMotion: boolean,
  children: React.ReactNode = <span />,
): string {
  return renderToStaticMarkup(
    <DocumentShell theme={theme} reducedMotion={reducedMotion}>
      {children}
    </DocumentShell>,
  );
}

// --- structure --------------------------------------------------------------

// The shell is the document the (children-only) root layout returns: an <html>
// document root wrapping a <body>, with the page tree inside the body.
test("renders an <html> document root wrapping a <body> that holds the children", () => {
  const marker = "DOC_SHELL_CHILD_MARKER_a71";
  const markup = render("light", false, <p>{marker}</p>);

  assert.ok(htmlAttrs(markup) != null, `the shell must render an <html> document root, got: ${markup}`);
  const body = bodyInner(markup);
  assert.ok(body != null, `the shell must render a <body>, got: ${markup}`);
  assert.ok(
    strip(body!).includes(marker),
    `the children must render inside <body> (not a dead frame), got body: "${strip(body!)}"`,
  );
});

// --- AC1: dark mode from a passed preference --------------------------------

// The passed theme preference is applied as the data-theme hook on the <html>
// root — the exact selector globals.css redefines its colour tokens on. Driven
// by the prop (dark → "dark", light → "light"), and NEVER the other value, so the
// preference wins over the OS media query and is not hard-coded.
test("applies the passed theme preference as data-theme on the <html> root", () => {
  for (const theme of THEMES) {
    const attrs = htmlAttrs(render(theme, false));
    assert.ok(attrs != null, `the shell must render an <html> root for theme "${theme}"`);
    assert.match(
      attrs!,
      new RegExp(`data-theme="${theme}"`, "i"),
      `the <html> root must carry data-theme="${theme}" for the "${theme}" preference, got attrs: "${attrs}"`,
    );
    const other: Theme = theme === "dark" ? "light" : "dark";
    assert.ok(
      !new RegExp(`data-theme="${other}"`, "i").test(attrs!),
      `the <html> root must not carry data-theme="${other}" when the preference is "${theme}" (it must follow the prop), got attrs: "${attrs}"`,
    );
  }
});

// Explicit AC1 wording: the dark preference engages dark mode (its documented
// hook), and the light preference does not.
test("the dark preference engages dark mode; the light preference does not", () => {
  assert.match(
    htmlAttrs(render("dark", false)) ?? "",
    /data-theme="dark"/i,
    "theme=\"dark\" must engage dark mode via data-theme=\"dark\" on the document root",
  );
  assert.ok(
    !/data-theme="dark"/i.test(htmlAttrs(render("light", false)) ?? ""),
    "theme=\"light\" must NOT engage dark mode on the document root",
  );
});

// --- AC1: reduced motion from a passed preference ---------------------------

// When reduced motion is requested, the shell emits a <style> that disables
// non-essential motion (neutralising both animation and transition) — regardless
// of the theme, and regardless of the OS setting.
test("disables non-essential motion (a motion-neutralising <style>) when reduced-motion is requested", () => {
  for (const theme of THEMES) {
    const blocks = styleBlocks(render(theme, true));
    assert.ok(
      blocks.some(disablesMotion),
      `with reducedMotion=true (theme "${theme}") the shell must render a <style> that neutralises animation AND transition; got style blocks: ${JSON.stringify(blocks)}`,
    );
  }
});

// When reduced motion is NOT requested, the shell renders no motion-disabling
// style — so the behaviour follows the prop and is not forced on everyone. Scoped
// narrowly to <style> blocks that neutralise motion (other markup is irrelevant).
test("renders no motion-disabling <style> when reduced-motion is not requested", () => {
  for (const theme of THEMES) {
    const blocks = styleBlocks(render(theme, false));
    assert.ok(
      !blocks.some(disablesMotion),
      `with reducedMotion=false (theme "${theme}") the shell must NOT force motion off; got style blocks: ${JSON.stringify(blocks)}`,
    );
  }
});

// --- AC2: a plain, prop-driven, render-testable component -------------------

// The shell renders synchronously to markup from its props alone — no DOM, no
// Next request APIs, no context. This is what lets the root layout stay
// children-only: the request-varying preference is a PROP of this component, not
// something Next injects into the layout. (An async/request-reading component
// would make renderToStaticMarkup throw.)
test("is a plain component that renders synchronously from its props alone", () => {
  const markup = render("dark", true, <p>ok</p>);
  assert.equal(typeof markup, "string", "the shell must render to a string synchronously");
  assert.ok(markup.length > 0, "the shell must render non-empty markup");
});

// Prop-driven: the output varies with each preference (so each is genuinely read
// from its prop, not baked in).
test("output is driven by the props: theme and reducedMotion each change the markup", () => {
  assert.notEqual(
    render("dark", false),
    render("light", false),
    "changing the theme preference must change the rendered document",
  );
  assert.notEqual(
    render("dark", true),
    render("dark", false),
    "changing the reduced-motion preference must change the rendered document",
  );
});

// --- design system ----------------------------------------------------------

// Colour comes from tokens via the data-theme hook, never a hard-coded hex (e.g.
// a naive `background:#09090b` for dark instead of data-theme). The caller passes
// no "#", so any hex in the output could only be a hard-coded colour.
test("the shell uses the token/theme mechanism, never a raw hex colour", () => {
  for (const theme of THEMES) {
    for (const reduced of [true, false]) {
      const markup = render(theme, reduced, <p>no hex here</p>);
      assert.ok(
        !/#[0-9a-fA-F]{3,8}\b/.test(markup),
        `no raw hex colour may appear in the shell markup (theme "${theme}", reducedMotion=${reduced}), got: ${markup}`,
      );
    }
  }
});
