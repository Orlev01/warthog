// The agent platform guide (shared by the connect page and the public compatibility page):
// every platform answers "will this work for me?" in one plain line, the common ones are
// marked, and no step over-promises or reads like an internal caveat (content-08).

import { test } from "node:test";
import assert from "node:assert/strict";

import { AGENT_PLATFORMS } from "./compatibility";

test("every platform has a status, a one-line summary and at least two steps", () => {
  for (const platform of AGENT_PLATFORMS) {
    assert.ok(["connector", "depends", "unverified"].includes(platform.status), platform.name);
    assert.ok(platform.summary.trim().length > 0, `${platform.name} has a summary`);
    assert.ok(platform.steps.length >= 2, `${platform.name} has its steps`);
  }
});

test("Claude and ChatGPT are the featured platforms, and Dots and Instinct are marked unverified", () => {
  assert.deepEqual(
    AGENT_PLATFORMS.filter((p) => "featured" in p && p.featured).map((p) => p.name),
    ["Claude", "ChatGPT"],
  );
  assert.deepEqual(
    AGENT_PLATFORMS.filter((p) => p.status === "unverified").map((p) => p.name),
    ["Dots (OpenAI)", "Instinct"],
  );
});

test("the Gemini and Grok steps say what works without the defensive caveats", () => {
  const text = AGENT_PLATFORMS.filter((p) => p.name === "Gemini" || p.name === "Grok")
    .flatMap((p) => p.steps)
    .join(" ");
  assert.doesNotMatch(text, /do not assume|does not imply|consumer/i);
  assert.match(text, /Gemini CLI/);
  assert.match(text, /xAI API/);
});
