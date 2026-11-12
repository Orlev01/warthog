import * as React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { ResourceScope } from "./resource-scope";
import { agentSection, AGENT_SECTIONS } from "@/domain/permissions/workspace";
import { collectEdits } from "@/app/(portal)/(protected)/agents/[id]/permission-edits";

test("resource screens explain account scope and link to each agent's matching section", () => {
  for (const [path, section] of [
    ["/connectors", "connectors"],
    ["/vault/cards", "vault"],
    ["/skills", "skills"],
    ["/memory", "memory"],
    ["/spending", "spending"],
    ["/rules", "rules"],
  ] as const) {
    const html = renderToStaticMarkup(
      <ResourceScope
        pathname={path}
        agents={[{ id: "agent-a", name: "My agent" }]}
      />,
    );
    assert.match(html, /How access works/);
    assert.match(html, /Manage for one agent/);
    // Links, not a select that navigates on change (WCAG 3.2.2), so an arrow key never
    // leaves the page and the picker works without JavaScript.
    assert.doesNotMatch(html, /<select/);
    assert.match(html, new RegExp(`href="/agents/agent-a\\?section=${section}"[^>]*>\\s*<span>My agent</span>`));
  }
  // With no agents the picker is left out rather than replaced by a competing call to action.
  const none = renderToStaticMarkup(<ResourceScope pathname="/memory" agents={[]} />);
  assert.match(none, /How access works/);
  assert.doesNotMatch(none, /Manage for one agent|Connect your first agent/);
  // Inside the page heading band it is a labelled group, not a second landmark.
  const heading = renderToStaticMarkup(
    <ResourceScope variant="heading" pathname="/memory" agents={[{ id: "a", name: "A" }]} />,
  );
  assert.match(heading, /^<div role="group" aria-label="Agent scope"/);
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
