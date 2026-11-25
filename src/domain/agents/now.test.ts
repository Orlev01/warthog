import { test } from "node:test";
import assert from "node:assert/strict";

import { ACTIVE_WINDOW_MS, groupNow, type NowAgent, type NowRun } from "./now";

const NOW = new Date("2026-11-25T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const agent = (id: string, name: string, platform: string, status: NowAgent["status"] = "connected"): NowAgent => ({ id, name, platform, status });
const run = (id: string, agentId: string, startedAgo: number, seenAgo: number): NowRun => ({ id, agentId, startedAt: ago(startedAgo), lastSeenAt: ago(seenAgo) });

const AGENTS = [
  agent("a-gem", "Gemini CLI · research", "localhost"),
  agent("a-cc", "Claude Code · laptop", "Claude"),
  agent("a-gpt", "ChatGPT", "ChatGPT"),
  agent("a-ai", "Claude", "Claude"),
  agent("a-dev", "Dev console", "dev-console"),
  agent("a-grok", "Grok", "Grok"),
  agent("a-quiet", "Quiet helper", "Claude"),
  agent("a-gone", "Old helper", "Claude", "disconnected"),
];

test("conversations group by provider in a fixed order, then by agent name", () => {
  const runs = [
    run("r-gem", "a-gem", 60_000, 30_000),
    run("r-cc", "a-cc", 3_600_000, 60_000),
    run("r-gpt", "a-gpt", 7_200_000, 7_000_000),
    run("r-ai", "a-ai", 600_000, 500_000),
    run("r-dev", "a-dev", 600_000, 500_000),
    run("r-grok", "a-grok", 600_000, 500_000),
  ];
  const { providers } = groupNow(AGENTS, runs, [], NOW);
  assert.deepEqual(providers.map((p) => p.label), ["Claude", "ChatGPT", "Gemini", "Grok", "Other agents"]);
  assert.deepEqual(providers[0]!.agents.map((a) => a.agent.name), ["Claude", "Claude Code · laptop"], "agents by name");
  assert.equal(providers[2]!.agents[0]!.agent.id, "a-gem", "an app on the computer sits with its provider by its name");
});

test("an agent's conversations list newest first by start, so a refresh doesn't move them", () => {
  const runs = [run("r1", "a-cc", 3_600_000, 10_000), run("r2", "a-cc", 60_000, 50_000), run("r3", "a-cc", 7_200_000, 7_000_000)];
  const first = groupNow(AGENTS, runs, [], NOW).providers[0]!.agents[0]!.conversations.map((c) => c.run.id);
  assert.deepEqual(first, ["r2", "r1", "r3"]);
  const touched = [run("r1", "a-cc", 3_600_000, 1_000), runs[1]!, runs[2]!];
  assert.deepEqual(groupNow(AGENTS, touched, [], NOW).providers[0]!.agents[0]!.conversations.map((c) => c.run.id), first, "a newer call keeps the order");
});

test("active means it called Warthog in the last 15 minutes", () => {
  const runs = [run("fresh", "a-cc", 3_600_000, ACTIVE_WINDOW_MS), run("stale", "a-cc", 3_600_000, ACTIVE_WINDOW_MS + 1000)];
  const grouping = groupNow(AGENTS, runs, [], NOW);
  const byId = new Map(grouping.providers[0]!.agents[0]!.conversations.map((c) => [c.run.id, c.active]));
  assert.equal(byId.get("fresh"), true);
  assert.equal(byId.get("stale"), false);
  assert.equal(grouping.activeCount, 1);
});

test("an agent with actions outside any conversation is shown, and quiet agents are listed", () => {
  const grouping = groupNow(AGENTS, [], [{ agentId: "a-gpt", count: 3, lastAt: ago(120_000) }, { agentId: "a-ai", count: 0, lastAt: ago(1) }], NOW);
  assert.deepEqual(grouping.providers.map((p) => p.label), ["ChatGPT"]);
  assert.deepEqual(grouping.providers[0]!.agents[0]!.unlinked, { agentId: "a-gpt", count: 3, lastAt: ago(120_000), active: true });
  assert.deepEqual(grouping.providers[0]!.agents[0]!.conversations, []);
  assert.deepEqual(grouping.quiet.map((a) => a.id), ["a-ai", "a-cc", "a-dev", "a-gem", "a-grok", "a-quiet"], "connected agents with nothing, by name; a disconnected one isn't listed");
  assert.equal(grouping.activeCount, 0, "loose actions aren't counted as active conversations");
});

test("a run for an agent that isn't listed is ignored", () => {
  const grouping = groupNow([AGENTS[1]!], [run("r-x", "someone-else", 60_000, 1_000)], [], NOW);
  assert.deepEqual(grouping.providers, []);
  assert.deepEqual(grouping.quiet.map((a) => a.id), ["a-cc"]);
});
