// UI/UX audit 2026-11-23 W-19 — the active sidebar link's accent bar (docs/adr/brand-marks-and-accent.md)
// never rendered: workspace.css declared the same selector twice and the later rule, without the
// bar, won. One declaration, with the bar.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("the active sidebar link is styled once, and that style carries the tint bar", async () => {
  const css = await readFile(new URL("./workspace.css", import.meta.url), "utf8");
  const rules = css.split("\n").filter((line) => line.startsWith('.wh-workspace .wh-sidebar-link[aria-current="page"] {'));
  assert.equal(rules.length, 1, "one declaration, so load order can't silently drop the bar");
  assert.match(rules[0]!, /inset 3px 0 0 var\(--wh-tint\)/);
});

// UI/UX audit 2026-11-23 W-44 — with reduced motion on, looping animations (spinners, skeleton
// pulses) were only shortened, so they flickered endlessly instead of stopping.
test("reduced motion stops looping animations and smooth scrolling, not just shortens them", async () => {
  const css = await readFile(new URL("./globals.css", import.meta.url), "utf8");
  const block = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
  const rule = block.slice(0, block.indexOf("}\n}") + 3);
  assert.match(rule, /animation-iteration-count:\s*1\s*!important/);
  assert.match(rule, /scroll-behavior:\s*auto\s*!important/);
  assert.match(rule, /animation-duration:\s*0\.01ms\s*!important/, "the existing rule stays");
});
