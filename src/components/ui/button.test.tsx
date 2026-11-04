// E02-S01 — Button primitive (src/components/ui/button.tsx).
//
// RED-first: src/components/ui/button.tsx does NOT exist yet, so importing
// `./button` throws and every test here fails until the builder adds the
// component. That absence is the entire point of test-first — do not implement
// anything to make these pass.
//
// These tests pin BEHAVIOUR — what the component RENDERS: the element it emits,
// its accessible name, the design-token classes it applies, and the native
// `disabled` attribute. They never read the source text of button.tsx, so a
// later refactor that preserves behaviour must not redden them. We render with
// `react-dom/server` (no DOM/jsdom needed — React component / E2E testing is a
// per-job ADR) and read the emitted markup.
//
// The contract the builder implements (exactly this):
//
//   Button(props): a native <button> element.
//     • variant?: "primary" | "secondary"
//         - "primary"   → the ONE accent action: an accent fill (bg-accent …).
//         - "secondary" → a neutral surface button with NO accent fill
//           (the accent is reserved for the one primary action).
//     • children        → the visible label, which is the accessible name.
//     • disabled?        → renders the NATIVE `disabled` attribute so the button
//           is not actionable.
//     • Every variant shows a visible focus ring built on the `focus` design
//       token (globals.css: --color-focus).
//
import * as React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";

import { Button } from "./button";

// The class attribute of the rendered ROOT element (the button itself). Variant
// and focus assertions read THIS string, so each is scoped to the button under
// test — never a child node or some sibling component's output.
function rootClass(markup: string): string {
  const m = markup.match(/class="([^"]*)"/);
  return m ? m[1] : "";
}

// The text content of the markup, tags stripped. A button's accessible name is
// computed from its contents, so this is that name for a plain-text label.
function textOf(markup: string): string {
  return markup.replace(/<[^>]*>/g, "").trim();
}

// A focus ring built on the `focus` token: a ring/outline/shadow utility coloured
// by the token (ring-focus / outline-focus / shadow-focus), or an arbitrary value
// that references the focus CSS variable (--color-focus / --wh-focus).
function usesFocusToken(cls: string): boolean {
  return /\b(?:ring|outline|shadow)-focus\b/.test(cls) || /--(?:wh-|color-)?focus\b/.test(cls);
}

test("primary is an accent button whose label is its accessible name", () => {
  const markup = renderToStaticMarkup(<Button variant="primary">Save</Button>);

  assert.match(markup, /^<button[\s>]/, "the primary Button renders a native <button> element");
  assert.ok(textOf(markup).includes("Save"), "the visible label is the button's accessible name");

  const cls = rootClass(markup);
  // The one accent action: the solid accent fill token (not the subtle
  // bg-accent-soft / bg-accent-hover variants).
  assert.match(cls, /\bbg-accent(?![\w-])/, "the primary variant uses the accent fill token (bg-accent)");
});

test("secondary is a neutral button (no accent fill) whose label is its accessible name", () => {
  const markup = renderToStaticMarkup(<Button variant="secondary">Cancel</Button>);

  assert.match(markup, /^<button[\s>]/, "the secondary Button renders a native <button> element");
  assert.ok(textOf(markup).includes("Cancel"), "the visible label is the button's accessible name");

  // Scoped to THIS button's own class: a neutral secondary never paints any
  // accent FILL (the accent is reserved for the one primary action). A neutral
  // surface/line/text token is expected instead.
  const cls = rootClass(markup);
  assert.ok(!/bg-accent/.test(cls), "the secondary variant must not use an accent fill");
});

test("primary and secondary render as distinct variants", () => {
  const primary = rootClass(renderToStaticMarkup(<Button variant="primary">A</Button>));
  const secondary = rootClass(renderToStaticMarkup(<Button variant="secondary">B</Button>));
  assert.notEqual(primary, secondary, "the two variants must render different classes");
});

test("every variant shows a visible focus ring built on the focus token", () => {
  for (const variant of ["primary", "secondary"] as const) {
    const cls = rootClass(renderToStaticMarkup(<Button variant={variant}>Go</Button>));
    assert.ok(
      usesFocusToken(cls),
      `the ${variant} button must apply a focus ring using the focus token (got class: "${cls}")`,
    );
  }
});

test("a disabled button carries the native disabled attribute (not actionable)", () => {
  const markup = renderToStaticMarkup(
    <Button variant="primary" disabled>
      Save
    </Button>,
  );
  // React renders a true boolean attribute as `disabled=""`. A Tailwind
  // `disabled:` variant class renders as `disabled:...` inside class="…", so this
  // matches the ATTRIBUTE specifically (never a class name), proving the button
  // is genuinely non-actionable rather than merely styled-disabled.
  assert.ok(
    markup.includes('disabled=""'),
    "a disabled Button must render the native disabled attribute",
  );
});

test("an enabled button is actionable (no disabled attribute)", () => {
  const markup = renderToStaticMarkup(<Button variant="primary">Save</Button>);
  assert.ok(
    !markup.includes('disabled=""'),
    "an enabled Button must not render the native disabled attribute",
  );
});
