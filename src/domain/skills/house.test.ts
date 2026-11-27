// "Using Warthog", the house skill (src/domain/skills/house.ts). These pin two lines of its
// guidance the founder asked for on 27 Nov 2026, after ChatGPT, holding an old copy of Warthog's
// tools, said Warthog couldn't create a calendar event and pointed to ChatGPT's own Outlook
// integration instead.

import { test } from "node:test";
import assert from "node:assert/strict";

import { HOUSE_GUIDANCE, houseInstructions } from "./house";

test("an agent whose app holds an old copy of Warthog's tools asks for a refresh, not says Warthog can't", () => {
  const line = HOUSE_GUIDANCE.split("\n").find((l) => l.includes("old copy of Warthog's tools"));
  assert.ok(line, "the guidance names the old tool list");
  assert.match(line, /find_tools and call_tool aren't in your tool list/);
  assert.match(line, /get_context allows something you have no tool for/);
  assert.match(line, /refresh Warthog in your app's settings, or disconnect and reconnect it/);
  assert.match(line, /Don't tell them Warthog can't do it\./);
});

test("a service connected in Warthog is used through Warthog, and a switched-off one is fixed in Warthog", () => {
  const line = HOUSE_GUIDANCE.split("\n").find((l) => l.includes("through Warthog, so their approvals"));
  assert.ok(line, "the guidance says to use services through Warthog");
  assert.match(line, /approvals, rules and Activity apply/);
  assert.match(line, /say what to change in Warthog \(this agent's page under Agents, or Connectors\)/);
  assert.match(line, /rather than suggesting they connect it to your app as well\./);
});

test("both lines reach every agent in get_context's instructions while the skill is Warthog's wording", () => {
  const instructions = houseInstructions(HOUSE_GUIDANCE);
  assert.ok(instructions.includes("old copy of Warthog's tools"));
  assert.ok(instructions.includes("Use the person's services through Warthog"));
});
