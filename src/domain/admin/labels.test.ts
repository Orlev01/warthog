import { test } from "node:test";
import assert from "node:assert/strict";

import { connectorLabel, errorCategoryLabel, factorLabel, outcomeLabel, platformLabel, routeLabel, titleCase } from "./labels";

test("identifiers become plain words, known ones by table and unknown ones by title case", () => {
  assert.equal(outcomeLabel("pending_approval"), "Waiting for approval");
  assert.equal(outcomeLabel("something_new"), "Something new");
  assert.equal(errorCategoryLabel("tool_error"), "Tool error");
  assert.equal(errorCategoryLabel("ssrf_blocked"), "Ssrf blocked");
  assert.equal(factorLabel("totp"), "Authenticator app");
  assert.equal(platformLabel("claude"), "Claude");
  assert.equal(platformLabel("my-bot"), "My bot");
  assert.equal(connectorLabel("gmail"), "Gmail");
  assert.equal(connectorLabel("unknown-svc", (id) => (id === "unknown-svc" ? "Unknown Service" : undefined)), "Unknown Service");
  assert.equal(connectorLabel("weird_thing"), "Weird thing");
  assert.equal(routeLabel("mcp"), "Agent connector (MCP)");
  assert.equal(titleCase(""), "");
});
