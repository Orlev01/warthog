// E02-S01 — Card primitive (src/components/ui/card.tsx).
//
// RED-first: src/components/ui/card.tsx does NOT exist yet, so importing `./card`
// throws and every test here fails until the builder adds the component. That
// absence is the point of test-first — do not implement anything to make these
// pass.
//
// These tests pin BEHAVIOUR — what the component RENDERS (it wraps its children
// in a token-based surface container) — never the source text of card.tsx. We
// render with `react-dom/server` and read the emitted markup.
//
// The contract the builder implements (exactly this):
//
//   Card(props): a surface container that wraps its children.
//     • children → rendered inside the card.
//     • Built on the design tokens: a raised surface (bg-surface) with a subtle
//       border (border-line) — see technical-design §11 "cards with subtle
//       borders". Colour comes from tokens, never a raw hex literal.
//
import * as React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";

import { Card } from "./card";

// The class attribute of the rendered ROOT element (the card container itself).
function rootClass(markup: string): string {
  const m = markup.match(/class="([^"]*)"/);
  return m ? m[1] : "";
}

function textOf(markup: string): string {
  return markup.replace(/<[^>]*>/g, "").trim();
}

test("Card wraps and renders its children", () => {
  const markup = renderToStaticMarkup(<Card>Agent summary</Card>);
  assert.ok(textOf(markup).includes("Agent summary"), "the card renders its children");
});

test("Card is a raised surface built on the surface token", () => {
  const markup = renderToStaticMarkup(<Card>content</Card>);
  const cls = rootClass(markup);
  assert.match(cls, /\bbg-surface\b/, "the Card paints the surface token (bg-surface)");
});

test("Card has a subtle border built on the line token", () => {
  const markup = renderToStaticMarkup(<Card>content</Card>);
  const cls = rootClass(markup);
  assert.match(cls, /\bborder-line\b/, "the Card uses the subtle border token (border-line)");
});

test("Card uses design tokens, never a raw hex colour", () => {
  // Plain-text children carry no `#`, so any hex in the card's own markup could
  // only be a hard-coded colour in the component — forbidden by the one-source-
  // of-visual-truth rule (colour comes from tokens).
  const markup = renderToStaticMarkup(<Card>content</Card>);
  assert.ok(
    !/#[0-9a-fA-F]{3,8}\b/.test(markup),
    "no raw hex colour may appear in the Card's rendered markup",
  );
});
