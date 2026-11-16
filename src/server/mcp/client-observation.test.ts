import { test } from "node:test";
import assert from "node:assert/strict";
import { clientObservation } from "./client-observation";

test("legacy and modern client observations have the same bounded, untrusted contract", () => {
  const info = { name: "Example", version: "2", description: "must not retain", websiteUrl: "https://private.example.test" };
  const capabilities = { roots: { private: "must not retain" }, sampling: {} };
  const legacy = clientObservation({ method: "initialize", params: { clientInfo: info, capabilities, protocolVersion: "2025-11-25" } }, new Headers());
  const modern = clientObservation({ _meta: { "io.modelcontextprotocol/clientInfo": info, "io.modelcontextprotocol/clientCapabilities": capabilities, "io.modelcontextprotocol/protocolVersion": "2025-11-25" } }, new Headers());
  assert.deepEqual(legacy, modern);
  assert.deepEqual(legacy, { name: "Example", version: "2", protocol: "2025-11-25", capabilities: ["roots", "sampling"], source: "client_reported" });
  assert.equal(clientObservation({}, new Headers()), undefined);
  assert.equal(clientObservation({ method: "tools/call" }, new Headers({ "mcp-protocol-version": "2025-11-25" })), undefined, "a protocol header alone must not replace the last declared client identity");
  assert.equal(clientObservation({ method: "initialize", params: { clientInfo: { name: "x".repeat(121) } } }, new Headers()), undefined);
  assert.doesNotMatch(JSON.stringify(modern), /private|must not retain/);
});

test("the client's own name is read from where each protocol revision carries it", async () => {
  const { envelopeClientName } = await import("./client-observation");
  const info = { name: "claude-code", version: "2.1.289" };
  assert.equal(envelopeClientName({ method: "tools/call", params: { _meta: { "io.modelcontextprotocol/clientInfo": info } } }), "claude-code");
  assert.equal(envelopeClientName({ method: "initialize", params: { clientInfo: info } }), "claude-code");
  assert.equal(envelopeClientName({ method: "tools/call", params: {} }), undefined);
  assert.equal(envelopeClientName({ method: "tools/call", params: { _meta: { "io.modelcontextprotocol/clientInfo": { name: "x".repeat(121) } } } }), undefined);
  assert.equal(envelopeClientName("not json"), undefined);
});
