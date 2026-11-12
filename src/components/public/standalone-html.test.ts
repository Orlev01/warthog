// UI/UX pass (visual-03, public-09, public-29) — the standalone HTML pages that route handlers
// return carry Warthog's own tokens in both colour schemes, a brand bar and a way forward,
// with no script, no remote asset and no echoed request value.
import { test } from "node:test";
import assert from "node:assert/strict";

import { standaloneHtml, standaloneResponse } from "./standalone-html";

test("a standalone page is self-contained, themed for light and dark, and branded", () => {
  const html = standaloneHtml({
    title: "Link not valid",
    eyebrow: "Approvals",
    heading: "This approval link isn't valid",
    paragraphs: ["Open the request from your inbox."],
    actions: [{ href: "/inbox", label: "Open your inbox", primary: true }, { href: "/", label: "Go to Warthog" }],
  });
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /<html lang="en-AU">/);
  assert.match(html, /<meta name="color-scheme" content="light dark">/);
  assert.match(html, /@media \(prefers-color-scheme:dark\)/);
  assert.match(html, /<title>Link not valid · Warthog<\/title>/);
  assert.match(html, /<a class="brand" href="\/">/);
  assert.match(html, /<a class="button" href="\/inbox">Open your inbox<\/a>/);
  assert.doesNotMatch(html, /<script|https?:\/\//, "no script and no remote asset");
  assert.doesNotMatch(html, /#4338ca|#a5b4fc/i, "never the retired indigo palette");
});

test("every caller-supplied value is escaped", () => {
  const html = standaloneHtml({ title: "<x>", heading: "\"<b>\"", paragraphs: ["a & <script>"], actions: [{ href: "/?q=\"><x", label: "<y>" }] });
  assert.doesNotMatch(html, /<script>|<x>|<y>|<b>/);
  assert.match(html, /a &amp; &lt;script&gt;/);
});

test("a standalone response keeps the caller's status and is never cached", async () => {
  const res = standaloneResponse({ title: "T", heading: "H", paragraphs: [] }, 400, { "referrer-policy": "no-referrer" });
  assert.equal(res.status, 400);
  assert.match(res.headers.get("content-type") ?? "", /text\/html/);
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.equal(res.headers.get("referrer-policy"), "no-referrer");
  assert.match(await res.text(), /<h1 id="page-title">H<\/h1>/);
});
