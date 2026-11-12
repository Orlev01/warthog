// What the audit log knows about each tool's effect (`./tool-effects`): reads vs changes,
// and which curated tools declare a reversal (Undo).

import { test } from "node:test";
import assert from "node:assert/strict";

import { READ_ONLY_TOOLS, isReadOnlyTool, reversalToolFor } from "./tool-effects";
import { coreToolMetadata } from "../mcp/tools/metadata";

test("core tools count as reads exactly when their published MCP hint says read-only", () => {
  for (const tool of ["get_context", "get_skill", "search_memory", "list_tasks", "list_records", "find_tools"]) {
    assert.ok(isReadOnlyTool(tool), tool);
    assert.equal(coreToolMetadata(tool).annotations.readOnlyHint, true);
  }
  for (const tool of ["remember", "create_task", "call_tool", "check_approval", "log_activity"]) {
    assert.ok(!isReadOnlyTool(tool), tool);
  }
});

test("curated connector reads are reads; sends, creates and unknown tools are not", () => {
  assert.ok(isReadOnlyTool("google-gmail__search"));
  assert.ok(isReadOnlyTool("google-gmail__read"));
  assert.ok(!isReadOnlyTool("google-gmail__send"));
  assert.ok(!isReadOnlyTool("google-calendar__create"));
  assert.ok(!isReadOnlyTool("some-service__request"), "a generic request's effect is unknown");
  assert.ok(READ_ONLY_TOOLS.length > 6);
});

test("Undo is offered for the real curated calendar tools, and only for them", () => {
  assert.equal(reversalToolFor("google-calendar__create"), "google-calendar__delete");
  assert.equal(reversalToolFor("microsoft-outlook-calendar__create"), "microsoft-outlook-calendar__delete");
  assert.equal(reversalToolFor("google_calendar__create_event"), undefined, "the stale name matches no tool");
  assert.equal(reversalToolFor("google-gmail__send"), undefined);
  assert.equal(reversalToolFor(undefined), undefined);
});
