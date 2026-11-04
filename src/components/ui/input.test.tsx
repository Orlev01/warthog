// E02-S02 — Input primitive (src/components/ui/input.tsx).
//
// RED-first: src/components/ui/input.tsx does NOT exist yet, so importing
// `./input` throws and every test here fails until the builder adds the
// component. That absence is the entire point of test-first — do not implement
// anything to make these pass.
//
// These tests pin BEHAVIOUR — what the component RENDERS: the element it emits,
// the design-token touch-target class it applies, and that it forwards the
// attributes a Field needs to wire accessibility (id, aria-describedby,
// aria-invalid) plus a caller className. They never read the source text of
// input.tsx, so a behaviour-preserving refactor must not redden them. We render
// with `react-dom/server` (no DOM/jsdom needed — React component / E2E testing
// is a per-job ADR) and read the emitted markup.
//
// The contract the builder implements (exactly this):
//
//   Input(props): a native <input> element.
//     • Carries at least a 44px touch target (WCAG 2.2 AA) built on the spacing
//       scale — Tailwind `min-h-11` (= 2.75rem = 44px) by convention, never a
//       raw px literal in a hex colour.
//     • Forwards every standard input attribute it is given (id, type, name,
//       placeholder, value, aria-describedby, aria-invalid, …) so a Field can
//       associate a Label and an error message with it.
//     • Merges a caller-supplied className rather than replacing its own classes.
//     • Uses design tokens, never a raw hex colour.
//
import * as React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";

import { Input } from "./input";

// Parse the `name="value"` attribute pairs out of a tag's attribute text. The
// tokenizer treats each attribute as a whole, so `aria-invalid="true"` never
// looks like an `id` attribute, etc.
function parseAttrs(attrText: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([\w:-]+)="([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(attrText))) attrs[m[1]] = m[2];
  return attrs;
}

// Attributes of the first <input> element in the markup (there is one).
function inputAttrs(markup: string): Record<string, string> {
  const m = markup.match(/<input\b([^>]*)>/);
  assert.ok(m, "expected an <input> element in the rendered markup");
  return parseAttrs(m![1]);
}

// A ≥44px touch target: the Tailwind 11/12/… spacing utilities (11 = 2.75rem =
// 44px) or an arbitrary value that is itself ≥44px.
function hasTouchTarget(cls: string): boolean {
  if (/\b(?:min-h|h)-(?:11|12|13|14|16|20)\b/.test(cls)) return true;
  const px = cls.match(/\b(?:min-h|h)-\[(\d+(?:\.\d+)?)px\]/);
  if (px && Number(px[1]) >= 44) return true;
  const rem = cls.match(/\b(?:min-h|h)-\[(\d+(?:\.\d+)?)rem\]/);
  if (rem && Number(rem[1]) * 16 >= 44) return true;
  return false;
}

test("Input renders a native <input> element", () => {
  const markup = renderToStaticMarkup(<Input />);
  assert.match(markup, /^<input[\s/>]/, "Input must render a native <input> element");
});

test("Input carries at least a 44px touch target (WCAG 2.2 AA)", () => {
  const markup = renderToStaticMarkup(<Input />);
  const cls = inputAttrs(markup).class ?? "";
  assert.ok(
    hasTouchTarget(cls),
    `Input must apply a >=44px touch-target class (got class: "${cls}")`,
  );
});

test("Input forwards the attributes a Field uses to wire accessibility", () => {
  // These are exactly the hooks a Field threads through to associate a Label and
  // an error message with the control; the Input must pass them straight on.
  const markup = renderToStaticMarkup(
    <Input id="email" type="email" aria-describedby="email-error" aria-invalid={true} />,
  );
  const attrs = inputAttrs(markup);
  assert.equal(attrs.id, "email", "Input forwards the id prop");
  assert.equal(attrs.type, "email", "Input forwards the type prop");
  assert.equal(attrs["aria-describedby"], "email-error", "Input forwards aria-describedby");
  assert.equal(attrs["aria-invalid"], "true", "Input forwards aria-invalid");
});

test("Input merges a caller className with its own classes", () => {
  const markup = renderToStaticMarkup(<Input className="mt-2" />);
  const cls = inputAttrs(markup).class ?? "";
  assert.ok(cls.includes("mt-2"), "the caller className is present on the input");
  assert.ok(
    hasTouchTarget(cls),
    "the Input's own touch-target class survives alongside the caller className",
  );
});

test("Input uses design tokens, never a raw hex colour", () => {
  // The rendered markup carries no caller text, so any `#rrggbb` here could only
  // be a hard-coded colour in the component — forbidden by the one-source-of-
  // visual-truth rule (colour comes from tokens).
  const markup = renderToStaticMarkup(<Input />);
  assert.ok(
    !/#[0-9a-fA-F]{3,8}\b/.test(markup),
    "no raw hex colour may appear in the Input's rendered markup",
  );
});
