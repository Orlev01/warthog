import { test } from "node:test";
import assert from "node:assert/strict";

import { platformLabel } from "./platform-label";

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
