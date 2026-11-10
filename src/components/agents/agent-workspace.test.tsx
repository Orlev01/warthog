import * as React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { ResourceScope } from "./resource-scope";
import { agentSection, AGENT_SECTIONS } from "@/domain/permissions/workspace";
import { collectEdits } from "@/app/(portal)/(protected)/agents/[id]/permission-edits";

test("resource screens expose account scope and an agent selector", () => {
  for (const path of [
    "/connectors",
    "/vault/cards",
    "/skills",
    "/memory",
    "/spending",
    "/rules",
  ]) {
    const html = renderToStaticMarkup(
      <ResourceScope
        pathname={path}
        agents={[{ id: "agent-a", name: "My agent" }]}
      />,
    );
    assert.match(html, /Account resources/);
    assert.match(html, /Manage for an agent/);
    assert.match(html, /My agent/);
  }
  assert.equal(
    renderToStaticMarkup(<ResourceScope pathname="/agents/one" agents={[]} />),
    "",
  );
});
test("workspace section boundaries reject unknown sections", () => {
  for (const [key] of AGENT_SECTIONS) assert.equal(agentSection(key), key);
  assert.equal(agentSection(undefined), "overview");
  assert.equal(agentSection(["skills"]), null);
  assert.equal(agentSection("//external"), null);
});
test("saving one workspace section does not overwrite unrelated permissions", () => {
  const checkbox = (name: string, checked: boolean) => ({
    name,
    checked,
    value: "",
    type: "checkbox",
  });
  const result = collectEdits(
    [
      checkbox("memoryRead", true),
      checkbox("memoryWrite", false),
      checkbox("learningSharing", false),
    ],
    {
      currency: "AUD",
      period: "month",
      connectors: ["gmail"],
      skills: ["skill"],
      section: "memory",
    },
  );
  assert.deepEqual(result, {
    ok: true,
    input: { memoryRead: true, memoryWrite: false, learningSharing: false },
  });
  assert.equal(
    collectEdits([], {
      currency: "AUD",
      period: "month",
      connectors: [],
      section: "memory",
    }).ok,
    false,
  );
});
