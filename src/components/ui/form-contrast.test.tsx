// Review fix G9 — form-control borders meet WCAG 2.2 SC 1.4.11 Non-text Contrast (3:1).
//
// Inputs, selects and textareas drew their only visible boundary with --wh-line
// (#e4e4e7 on white = 1.27:1; #27272a on zinc-900 = 1.19:1), the same faint token used for
// decorative dividers, while the field's fill matched the card behind it — so the field
// itself was effectively invisible to low-vision users. Form controls now use a dedicated
// --wh-line-input token that clears 3:1 against every surface a field sits on, in both
// themes; --wh-line stays for decorative dividers.
//
// The token values are read from the one stylesheet (globals.css) and their contrast is
// computed with the WCAG relative-luminance formula; the shared Input and Select are
// rendered and checked to use the token.

import * as React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";

import { Input } from "./input";
import { Select } from "./select";

const CSS = readFileSync(join(process.cwd(), "src", "app", "globals.css"), "utf8");

// The custom properties declared in the first block that matches `selector`.
function tokens(selector: RegExp): Record<string, string> {
  const match = selector.exec(CSS);
  assert.ok(match, `globals.css has a ${selector} block`);
  const body = CSS.slice(match.index + match[0].length, CSS.indexOf("}", match.index));
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/(--wh-[a-z-]+):\s*(#[0-9a-fA-F]{6})/g)) out[m[1]!] = m[2]!;
  return out;
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

const THEMES: Array<[string, RegExp]> = [
  ["light", /:root\s*\{/],
  ["dark (OS preference)", /:root:not\(\[data-theme="light"\]\)\s*\{/],
  ["dark (chosen)", /:root\[data-theme="dark"\]\s*\{/],
];

for (const [name, selector] of THEMES) {
  test(`${name}: the form-control border clears 3:1 against the page, card and muted fills`, () => {
    const light = tokens(/:root\s*\{/);
    const theme = { ...light, ...tokens(selector) };
    const border = theme["--wh-line-input"];
    assert.ok(border, "a --wh-line-input token is defined");
    for (const fill of ["--wh-bg", "--wh-surface", "--wh-surface-muted"]) {
      const ratio = contrast(border!, theme[fill]!);
      assert.ok(ratio >= 3, `${border} on ${fill} ${theme[fill]} is ${ratio.toFixed(2)}:1 (needs 3:1)`);
    }
  });
}

test("the shared Input and Select draw their border with the form-control token", () => {
  for (const markup of [
    renderToStaticMarkup(<Input aria-label="Name" />),
    renderToStaticMarkup(
      <Select aria-label="Kind">
        <option>One</option>
      </Select>,
    ),
  ]) {
    assert.match(markup, /\bborder-line-input\b/);
    assert.ok(!/\bborder-line\b(?!-)/.test(markup), "not the faint decorative divider token");
  }
});

test("raw form controls elsewhere that still use the divider token are lifted to the form-control border", () => {
  // A safety net in globals.css for screens that compose a raw <select>/<textarea>/<input>
  // with `border-line`: it must target form controls only and leave an invalid field's
  // danger border alone.
  const rule = /([^{}]*\.border-line[^{}]*)\{\s*border-color:\s*var\(--wh-line-input\);?\s*\}/.exec(CSS);
  assert.ok(rule, "globals.css lifts border-line on form controls to --wh-line-input");
  for (const tag of ["select", "textarea", "input"]) assert.match(rule![1]!, new RegExp(`\\b${tag}\\b`));
  assert.match(rule![1]!, /:not\(\[aria-invalid="true"\]\)/);
});
