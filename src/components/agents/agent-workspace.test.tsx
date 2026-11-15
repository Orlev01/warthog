import * as React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { ResourceScope } from "./resource-scope";
import { agentSection, AGENT_SECTIONS } from "@/domain/permissions/workspace";
import { collectEdits } from "@/app/(portal)/(protected)/agents/[id]/permission-edits";
import { AgentWorkspaceHeader, AgentOverview, AgentResources, RecentConversations } from "./agent-workspace";
import type { AgentWorkspaceData } from "@/server/agents/workspace-data";
import type { PermissionsViewProps } from "./permissions-view";

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
  // A disconnected agent can't be managed (its settings are read-only), so it isn't offered.
  const mixed = renderToStaticMarkup(
    <ResourceScope pathname="/memory" agents={[{ id: "on", name: "On" }, { id: "off", name: "Off", connected: false }]} />,
  );
  assert.match(mixed, /href="\/agents\/on\?section=memory"/);
  assert.doesNotMatch(mixed, /\/agents\/off/);
  const allOff = renderToStaticMarkup(
    <ResourceScope pathname="/memory" agents={[{ id: "off", name: "Off", connected: false }]} />,
  );
  assert.doesNotMatch(allOff, /Manage for one agent/);
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

// --- the agent header and Overview (UI/UX pass, lane C) ---------------------------------

function workspaceData(overrides: Partial<AgentWorkspaceData["agent"]> = {}): AgentWorkspaceData {
  return {
    agent: { id: "11111111-2222-4333-8444-555555555555", userId: "u", connectionId: "c", displayName: "Dev console", platform: "dev-console", status: "connected", connectedAt: new Date(), lastActiveAt: new Date(), requestCount: 13, ...overrides },
    performance: { examined: 13, measured: 13, failed: 0, unknown: 0, refused: 1, p95Ms: 13 },
    clientObservation: null,
    spending: null,
    memory: [],
    activity: [],
    auditSummary: { total: 50, byCategory: {}, byOutcome: { blocked: 2, failed: 0 }, disputed: 0 },
    memoryRead: true,
    budget: null,
  } as unknown as AgentWorkspaceData;
}
const PERMISSIONS = {
  agentName: "Dev console", connectors: [], lowTierRead: true, highTierRequest: false, cardAccess: false, budget: null,
  skills: [], tasksAccess: true, recordsAccess: false, sharedMemoryRead: true, learningSharing: false, rules: [],
} as PermissionsViewProps;
const text = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/&#x27;|&rsquo;/g, "’").replace(/\s+/g, " ");

test("the agent header shows its state with the shared Status and the platform in words", () => {
  const html = renderToStaticMarkup(<AgentWorkspaceHeader data={workspaceData()} section="overview" />);
  assert.match(text(html), /Connected · Developer console · 13 requests/);
  assert.doesNotMatch(text(html), /dev-console/);
  const off = renderToStaticMarkup(<AgentWorkspaceHeader data={workspaceData({ status: "disconnected" })} section="overview" />);
  assert.match(text(off), /\bDisconnected\b/);
  assert.doesNotMatch(text(off), /Reconnect needed/, "there is no reconnecting a disconnected agent");
  assert.match(off, /href="\/agents\/connect"[^>]*>Connect it again/, "a disconnected agent offers the way back");
  assert.match(text(off), /Connecting it again adds it as a new agent/, "and says it comes back as a new agent");
});

test("the Overview leads with a plain summary and folds the diagnostics away", () => {
  const html = renderToStaticMarkup(<AgentOverview data={workspaceData()} permissions={PERMISSIONS} lastActive="Today, 9:00 pm" />);
  const shown = text(html);
  assert.match(shown, /Last request Today, 9:00 pm/);
  assert.match(shown, /Review the 2 entries that need attention/);
  // The evidence is kept, inside a closed "Technical details" disclosure.
  const details = /<details\b(?![^>]*\bopen\b)[^>]*>([\s\S]*?)<\/details>/.exec(html);
  assert.ok(details, "a collapsed technical section");
  assert.match(text(details![1]!), /Technical details[\s\S]*95th percentile response time/);
  const outside = html.replace(details![0], "");
  assert.doesNotMatch(text(outside), /95th percentile|heartbeat|client metadata/i, "no diagnostics in the lead");
  assert.match(shown, /Warthog controls only what Dev console does through Warthog, not its own tools or chats\./);
  assert.match(shown, /2 need attention/);
});

test("the memory and spending read-outs are panels with a next step when empty", () => {
  const memory = renderToStaticMarkup(<AgentResources data={workspaceData()} section="memory" />);
  assert.match(memory, /class="wh-panel"/);
  assert.match(text(memory), /No memories it can read yet\./);
  const spending = renderToStaticMarkup(<AgentResources data={workspaceData()} section="spending" />);
  assert.match(text(spending), /No card budget set for this agent\. Turn on card access below/);
});

test("the Overview lists the agent's recent conversations, each linking to what it did", () => {
  const data = {
    ...workspaceData(),
    conversations: [
      { id: "5d0c2a4e-8b1f-4c3d-9e2a-7f6b5a4c3d2e", label: "Fixing the website tests", via: "Claude Code", actions: 14, lastActive: "Today, 10:42 am", lastActiveAt: "2026-11-16T23:42:00.000Z", href: "/activity?run=5d0c2a4e-8b1f-4c3d-9e2a-7f6b5a4c3d2e" },
      { id: "6e1d3b5f-9c2a-4d4e-8f3b-8a7c6b5d4e3f", label: null, via: null, actions: 1, lastActive: "Yesterday, 4:00 pm", lastActiveAt: "2026-11-15T05:00:00.000Z", href: "/activity?run=6e1d3b5f-9c2a-4d4e-8f3b-8a7c6b5d4e3f" },
    ],
  } as unknown as AgentWorkspaceData;
  const html = renderToStaticMarkup(<RecentConversations data={data} />);
  const shown = text(html);
  assert.match(shown, /Recent conversations The latest chats and sessions Dev console started with Warthog/);
  assert.match(shown, /Fixing the website tests via Claude Code · 14 entries · last active Today, 10:42 am/);
  assert.match(shown, /Untitled conversation 1 entry · last active Yesterday, 4:00 pm/);
  assert.match(html, /href="\/activity\?run=5d0c2a4e-8b1f-4c3d-9e2a-7f6b5a4c3d2e"/);
  assert.match(text(renderToStaticMarkup(<RecentConversations data={workspaceData()} />)), /None yet/);
  assert.match(text(renderToStaticMarkup(<AgentOverview data={data} permissions={PERMISSIONS} lastActive={null} />)), /Recent conversations/, "the Overview includes it");
});
