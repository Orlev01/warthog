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
  assert.equal(clientSurface(null, "codex-mcp-client"), "Codex", "measured 25 Nov 2026");
  assert.equal(clientSurface(null, "gemini-cli-mcp-client"), "Gemini CLI", "measured 25 Nov 2026");
  assert.equal(clientSurface(undefined, "openai-mcp"), "openai-mcp");
  assert.equal(clientSurface(null, undefined), undefined);
});

test("only a short printable name is ever shown", () => {
  assert.equal(clientSurface("<script>", "claude-code"), "Claude Code", "a malformed header falls back to the client name");
  assert.equal(clientSurface("x".repeat(61), undefined), undefined);
  assert.equal(clientSurface("Line\nBreak", "bad\u0000name"), undefined);
  assert.equal(clientSurface("  ClaudeCode  ", undefined), "Claude Code");
});

test("an unknown product name is redacted before it is shown or stored", () => {
  assert.doesNotMatch(clientSurface("4111 1111 1111 1111") ?? "", /4111 1111 1111 1111/);
  assert.doesNotMatch(clientSurface(null, "4111111111111111") ?? "", /4111111111111111/);
});
