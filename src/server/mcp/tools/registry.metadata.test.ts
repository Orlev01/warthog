import assert from "node:assert/strict";
import { test } from "node:test";
import { createToolRegistry } from "./registry";
import type { AgentCallPipeline } from "../pipeline";
import type { ConnectionPermissions } from "../../db/agent-permissions";

const pipeline: AgentCallPipeline = {
  async handleAgentCall() { throw new Error("Discovery must not execute a tool"); },
  async executeApprovedHold() { throw new Error("Discovery must not execute a hold"); },
};
const registry = createToolRegistry({ pipeline });
const permissions = {
  grantedConnectors: ["gmail"], readTools: true, changeTools: "ask_first",
} as ConnectionPermissions;

test("core discovery declares titles and accurate effect hints, including approval side effects", () => {
  const reads = new Set(["get_context", "get_skill", "search_memory", "list_tasks", "list_records"]);
  for (const tool of registry.coreTools) {
    assert.ok(tool.title.length > 0, tool.name);
    assert.equal(tool.annotations.title, tool.title);
    assert.equal(tool.annotations.readOnlyHint, reads.has(tool.name), tool.name);
    for (const key of ["destructiveHint", "idempotentHint", "openWorldHint"] as const) {
      assert.equal(typeof tool.annotations[key], "boolean", `${tool.name}.${key}`);
    }
  }
  assert.equal(registry.get("check_approval")!.annotations.openWorldHint, true);
  assert.equal(registry.get("check_approval")!.annotations.destructiveHint, true);
  assert.equal(registry.get("collect_release")!.annotations.idempotentHint, false);
  assert.equal(registry.get("request_identity_detail")!.annotations.readOnlyHint, false);
});

test("trusted connector reads are distinct from sends and unknown or mixed-effect tools", () => {
  const tools = registry.resolveTools(permissions, { gmail: [
    { name: "read", title: "Gmail: Read message", makesChange: false },
    { name: "send", makesChange: true },
    { name: "request", makesChange: false }, // GET and POST share this legacy tool.
    { name: "provider", makesChange: false, requiresApproval: true },
    "unknown",
  ] });
  const read = tools.find(t => t.name === "gmail__read")!;
  assert.equal(read.title, "Gmail: Read message");
  assert.equal(read.annotations.readOnlyHint, true);
  assert.equal(read.annotations.destructiveHint, false);
  assert.equal(read.annotations.openWorldHint, true);
  for (const name of ["send", "request", "provider", "unknown"]) {
    const tool = tools.find(t => t.name === `gmail__${name}`)!;
    assert.equal(tool.annotations.readOnlyHint, false, name);
    assert.equal(tool.annotations.destructiveHint, true, name);
    assert.equal(tool.annotations.idempotentHint, false, name);
  }
});

test("collapsed discovery distinguishes finding tools from executing an arbitrary tool", () => {
  const tools = registry.resolveTools(permissions, { gmail: Array.from({ length: 90 }, (_, i) => `tool_${i}`) });
  assert.equal(tools.find(t => t.name === "find_tools")!.annotations.readOnlyHint, true);
  const call = tools.find(t => t.name === "call_tool")!;
  assert.equal(call.annotations.readOnlyHint, false);
  assert.equal(call.annotations.destructiveHint, true);
  assert.equal(call.annotations.openWorldHint, true);
});
