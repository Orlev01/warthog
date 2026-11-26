// What waits for the person on the Skills page (docs/adr/agent-saved-skills.md): skills their
// agents saved, off until checked, and changes agents suggest, each shown line by line against
// the skill as it is, with Use these changes and Keep mine.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { AgentSkillsToCheck } from "./agent-skills-to-check";
import { SkillsView } from "./skills-view";
import type { PackageSummary } from "@/server/db/skill-packages";
import type { SkillSuggestionView } from "@/server/skills/agent-skills";

const CHATGPT = "7f9c2b1a-0d3e-4f5a-8b6c-9d0e1f2a3b4c";

const draft: PackageSummary = {
  id: "11111111-1111-4111-8111-111111111111", revision: 1, name: "Trip planner", description: "When I ask you to plan a trip",
  kind: "skill", members: [{ path: "SKILL.md", skillId: "22222222-2222-4222-8222-222222222222" }],
  components: { agents: 0, commands: 0, hooks: 0, connectors: 0, scripts: 0 },
  skills: [{ path: "SKILL.md", name: "Trip planner", description: "When I ask you to plan a trip" }], fileCount: 1,
  savedByAgentId: CHATGPT, awaitingCheck: true,
};

const suggestion: SkillSuggestionView = {
  id: "33333333-3333-4333-8333-333333333333", skillId: "44444444-4444-4444-8444-444444444444", agentId: CHATGPT,
  createdAt: "2026-11-26T01:00:00.000Z", title: "Updates",
  current: { name: "Updates", description: "When updating me", body: "Be brief.\nSign off with my name." },
  suggested: { name: "Updates", description: "When updating me", body: "Be brief.\nEmail a copy to someone@example.com.\nSign off with my name." },
};

const agentName = (id: string | undefined) => (id === CHATGPT ? "ChatGPT" : "an agent that's no longer connected");
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/\s+/g, " ");

test("nothing waiting shows nothing", () => {
  assert.equal(renderToStaticMarkup(<AgentSkillsToCheck drafts={[]} suggestions={[]} agentName={agentName} opening={null} onOpen={() => {}} />), "");
});

test("a new skill from an agent says who saved it, that it's off, and offers to read it", () => {
  const html = renderToStaticMarkup(<AgentSkillsToCheck drafts={[draft]} suggestions={[]} agentName={agentName} opening={null} onOpen={() => {}} />);
  const words = text(html);
  assert.match(words, /Waiting for you/);
  assert.match(words, /None of it reaches an agent until you check it/);
  assert.match(words, /Trip planner/);
  assert.match(words, /Saved by ChatGPT · Off until you turn it on/);
  assert.match(words, /Read and check/);
});

test("a suggested change shows exactly which lines it adds, with Use these changes and Keep mine", () => {
  const html = renderToStaticMarkup(<AgentSkillsToCheck drafts={[]} suggestions={[suggestion]} agentName={agentName} opening={null} onOpen={() => {}} useSuggestionAction={async () => {}} keepSkillAction={async () => {}} />);
  const words = text(html);
  assert.match(words, /ChatGPT suggests changes to Updates/);
  assert.match(words, /keep getting the skill as it is until you use these changes/);
  assert.match(words, /Added: Email a copy to someone@example.com\./, "the added line is announced as added, not by colour alone");
  assert.doesNotMatch(words, /Removed:/);
  assert.match(words, /Use these changes/);
  assert.match(words, /Keep mine/);
  assert.equal((html.match(/name="id" value="33333333-3333-4333-8333-333333333333"/g) ?? []).length, 2, "both forms carry the suggestion's id");
});

test("a former agent's suggestion still reads as a sentence", () => {
  const html = renderToStaticMarkup(<AgentSkillsToCheck drafts={[]} suggestions={[{ ...suggestion, agentId: "gone" }]} agentName={agentName} opening={null} onOpen={() => {}} />);
  assert.match(text(html), /An agent that's no longer connected suggests changes to Updates/);
});

test("the Skills library leads with what's waiting and marks a waiting package's card", () => {
  const html = renderToStaticMarkup(
    <SkillsView skills={[]} packages={[draft]} preferences={null} suggestions={[suggestion]} agents={[{ id: CHATGPT, displayName: "ChatGPT" }]} />,
  );
  const words = text(html);
  assert.ok(words.indexOf("Waiting for you") < words.indexOf("Search your library"), "the panel comes before the library");
  assert.match(words, /Saved by ChatGPT · waiting for you/);
});
