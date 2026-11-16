import { test } from "node:test";
import assert from "node:assert/strict";
import { clientObservation, reportedRunId } from "./client-observation";

// Claude Code 2.1.289's own envelope on a tools/call, as measured on 16 Nov 2026.
const CLAUDE_CODE_META = {
  "io.modelcontextprotocol/clientInfo": { name: "claude-code", title: "Claude Code", version: "2.1.289", description: "Anthropic's agentic coding tool", websiteUrl: "https://claude.com/claude-code" },
  "io.modelcontextprotocol/clientCapabilities": { elicitation: {}, roots: {} },
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
};

test("legacy and modern client observations have the same bounded, untrusted contract", () => {
  const info = { name: "Example", version: "2", description: "must not retain", websiteUrl: "https://private.example.test" };
  const capabilities = { roots: { private: "must not retain" }, sampling: {} };
  const legacy = clientObservation({ method: "initialize", params: { clientInfo: info, capabilities, protocolVersion: "2025-11-25" } }, new Headers());
  const modern = clientObservation({ method: "tools/call", params: { name: "get_context", _meta: { "io.modelcontextprotocol/clientInfo": info, "io.modelcontextprotocol/clientCapabilities": capabilities, "io.modelcontextprotocol/protocolVersion": "2025-11-25" } } }, new Headers());
  assert.deepEqual(legacy, modern);
  assert.deepEqual(legacy, { name: "Example", version: "2", protocol: "2025-11-25", capabilities: ["roots", "sampling"], source: "client_reported" });
  assert.equal(clientObservation({}, new Headers()), undefined);
  assert.equal(clientObservation({ method: "tools/call" }, new Headers({ "mcp-protocol-version": "2025-11-25" })), undefined, "a protocol header alone must not replace the last declared client identity");
  assert.equal(clientObservation({ method: "initialize", params: { clientInfo: { name: "x".repeat(121) } } }, new Headers()), undefined);
  assert.doesNotMatch(JSON.stringify(modern), /private|must not retain/);
});

test("a 2026-07-28 client is read from the request's params._meta, where it sends itself on every request", () => {
  const observed = clientObservation({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_context", arguments: {}, _meta: CLAUDE_CODE_META } }, new Headers());
  assert.deepEqual(observed, { name: "claude-code", version: "2.1.289", protocol: "2026-07-28", capabilities: ["elicitation", "roots"], source: "client_reported" });
  assert.doesNotMatch(JSON.stringify(observed), /agentic|claude\.com/, "descriptions and links are not kept");
  // A top-level _meta is read only when the params carry none.
  assert.equal(clientObservation({ method: "tools/call", _meta: CLAUDE_CODE_META, params: {} }, new Headers())?.name, "claude-code");
  assert.equal(clientObservation({ method: "tools/call", _meta: CLAUDE_CODE_META, params: { _meta: {} } }, new Headers()), undefined);
  assert.equal(clientObservation({ method: "tools/call", params: { _meta: { "io.modelcontextprotocol/clientInfo": { name: "x".repeat(121) } } } }, new Headers()), undefined);
  assert.equal(clientObservation("not json", new Headers()), undefined);
});

test("an agent's own run reference is read from the request's params._meta", () => {
  assert.equal(reportedRunId({ method: "tools/call", params: { _meta: { "app.warthog/runId": "fix-tests.1" } } }), "fix-tests.1");
  assert.equal(reportedRunId({ method: "tools/call", _meta: { "app.warthog/runId": "older-shape" } }), "older-shape");
  assert.equal(reportedRunId({ method: "tools/call", params: { _meta: { "app.warthog/runId": "has spaces" } } }), undefined);
  assert.equal(reportedRunId({ method: "tools/call", params: { _meta: { "app.warthog/runId": "r".repeat(121) } } }), undefined);
  assert.equal(reportedRunId({ method: "tools/call", params: {} }), undefined);
  assert.equal(reportedRunId(null), undefined);
});
