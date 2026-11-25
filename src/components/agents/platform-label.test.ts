import { test } from "node:test";
import assert from "node:assert/strict";

import { platformLabel, reportedAppLine } from "./platform-label";

test("a platform shows in words a member recognises, never as a raw key", () => {
  assert.equal(platformLabel("dev-console"), "Developer console");
  assert.equal(platformLabel("chatgpt"), "ChatGPT");
  assert.equal(platformLabel("Claude"), "Claude");
  assert.equal(platformLabel("Claude Desktop"), "Claude Desktop", "a display name is kept as recorded");
  assert.equal(platformLabel("home_assistant"), "Home assistant", "an unknown slug is put into words");
});

test("a placeholder platform is left out rather than shown", () => {
  for (const value of ["Other", "other", "", "   ", null, undefined]) {
    assert.equal(platformLabel(value), null, String(value));
  }
});

test("an app that signed in through a callback on this computer reads as such, never as localhost", () => {
  // The stored platform is the callback's host (src/app/oauth/consent/actions.ts): Gemini CLI,
  // Codex and Claude Code connecting directly all sign in through one on the person's computer.
  assert.equal(platformLabel("localhost"), "App on your computer");
  assert.equal(platformLabel("127.0.0.1"), "App on your computer");
  assert.equal(platformLabel("LOCALHOST"), "App on your computer");
  assert.equal(platformLabel("localhost.example.com"), "localhost.example.com", "only the loopback host itself");
});

test("what the app reported is shown beside the platform only when it adds something", () => {
  assert.equal(reportedAppLine("localhost", "Gemini CLI"), "says it’s Gemini CLI");
  assert.equal(reportedAppLine("Other", "Codex"), "says it’s Codex", "an access key with no platform named");
  assert.equal(reportedAppLine("Claude", "Claude"), null, "the claude.ai connector already reads Claude");
  assert.equal(reportedAppLine("claude", "Claude"), null);
  assert.equal(reportedAppLine("Claude", "Claude Code"), "says it’s Claude Code");
  assert.equal(reportedAppLine("localhost", null), null);
  assert.equal(reportedAppLine("localhost", undefined), null);
});
