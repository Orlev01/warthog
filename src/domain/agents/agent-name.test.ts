import { test } from "node:test";
import assert from "node:assert/strict";

import { AGENT_NAME_MAX, normaliseAgentName } from "./agent-name";

test("a name is kept as typed, tidied", () => {
  assert.equal(normaliseAgentName("Gemini CLI · research"), "Gemini CLI · research");
  assert.equal(normaliseAgentName("  Claude   Code\tlaptop \n"), "Claude Code laptop");
  assert.equal(normaliseAgentName("Café helper"), "Café helper", "Unicode is normalised");
});

test("invisible and control characters never reach the stored name", () => {
  assert.equal(normaliseAgentName("Co​dex"), "Codex");
  assert.equal(normaliseAgentName("Codex‮ helper"), "Codex helper");
  assert.equal(normaliseAgentName("Codex\u0000\u0007 helper"), "Codex helper");
});

test("an empty or overlong name is refused", () => {
  for (const raw of ["", "   ", "​​"]) assert.equal(normaliseAgentName(raw), null, JSON.stringify(raw));
  assert.equal(normaliseAgentName("a".repeat(AGENT_NAME_MAX))?.length, AGENT_NAME_MAX);
  assert.equal(normaliseAgentName("a".repeat(AGENT_NAME_MAX + 1)), null);
});

test("a name holding a card number or other private value is refused, not stored part-hidden", () => {
  assert.equal(normaliseAgentName("Card 4111 1111 1111 1111"), null);
  assert.equal(normaliseAgentName("Shopping 4111111111111111"), null);
});
