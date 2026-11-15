import { test } from "node:test";
import assert from "node:assert/strict";

import { clientSurface } from "./client-surface";

test("Anthropic's product header names the product, before the client name", () => {
  assert.equal(clientSurface("ClaudeCode", "claude-code"), "Claude Code");
  assert.equal(clientSurface("Cowork", "claude-code"), "Claude Cowork", "claude.ai sessions report the Claude Code client name");
  assert.equal(clientSurface("ClaudeAI", "Anthropic/ClaudeAI"), "claude.ai");
  assert.equal(clientSurface("SomethingNew", "claude-code"), "SomethingNew", "an unknown product is shown as reported");
});

test("a direct client is named by its MCP client name", () => {
  assert.equal(clientSurface(null, "claude-code"), "Claude Code");
  assert.equal(clientSurface(undefined, "openai-mcp"), "openai-mcp");
  assert.equal(clientSurface(null, undefined), undefined);
});

test("only a short printable name is ever shown", () => {
  assert.equal(clientSurface("<script>", "claude-code"), "Claude Code", "a malformed header falls back to the client name");
  assert.equal(clientSurface("x".repeat(61), undefined), undefined);
  assert.equal(clientSurface("Line\nBreak", "bad\u0000name"), undefined);
  assert.equal(clientSurface("  ClaudeCode  ", undefined), "Claude Code");
});
