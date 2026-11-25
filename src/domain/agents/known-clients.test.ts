import { test } from "node:test";
import assert from "node:assert/strict";

import { KNOWN_CLIENTS, knownClient, reportedApp } from "./known-clients";

test("every listed client name was measured, with a date and how", () => {
  const names = new Set<string>();
  for (const client of KNOWN_CLIENTS) {
    assert.match(client.measured, /^\d{4}-\d{2}-\d{2}$/, client.name);
    assert.ok(client.source.length > 20, `${client.name} says how it was measured`);
    assert.ok(!names.has(client.name), `${client.name} is listed once`);
    names.add(client.name);
  }
});

test("the apps measured on 16 and 25 November are known by their exact client names", () => {
  assert.equal(knownClient("claude-code")?.product, "Claude Code");
  assert.equal(knownClient("codex-mcp-client")?.product, "Codex");
  assert.equal(knownClient("codex-mcp-client")?.provider, "chatgpt");
  assert.equal(knownClient("gemini-cli-mcp-client")?.product, "Gemini CLI");
  assert.equal(knownClient("gemini-cli-mcp-client")?.provider, "gemini");
  assert.equal(knownClient("  claude-code "), knownClient("claude-code"), "surrounding spaces don't matter");
});

test("a name that wasn't measured is not guessed", () => {
  for (const name of ["gemini", "Claude Code", "CLAUDE-CODE", "openai-mcp", "mcp-test-client", "", undefined]) {
    assert.equal(knownClient(name), undefined, String(name));
  }
});

test("an agent's apps name one product when they agree on it", () => {
  assert.deepEqual(reportedApp([{ name: "gemini-cli-mcp-client" }]), { provider: "gemini", label: "Gemini CLI" });
  assert.deepEqual(
    reportedApp([{ name: "codex-mcp-client" }, { name: "codex-mcp-client" }, { name: "something-else" }]),
    { provider: "chatgpt", label: "Codex" },
    "an app Warthog doesn't know is left out",
  );
});

test("several products of one provider name the provider", () => {
  assert.deepEqual(
    reportedApp([{ name: "claude-code" }, { name: "Anthropic/ClaudeAI" }, { name: "Anthropic/Toolbox" }]),
    { provider: "claude", label: "Claude" },
    "the claude.ai connector is used from Claude Code and claude.ai",
  );
});

test("apps from different providers, or none Warthog knows, give nothing", () => {
  assert.equal(reportedApp([{ name: "claude-code" }, { name: "gemini-cli-mcp-client" }]), null);
  assert.equal(reportedApp([{ name: "openai-mcp" }, {}]), null);
  assert.equal(reportedApp([]), null);
});
