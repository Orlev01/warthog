import { test } from "node:test";
import assert from "node:assert/strict";

import { agentBrand, agentProvider } from "./brands";

test("an agent's provider follows its platform, then its name, like its mark", () => {
  assert.deepEqual(agentProvider("Claude", "Research"), { key: "claude", label: "Claude" });
  assert.deepEqual(agentProvider("ChatGPT"), { key: "chatgpt", label: "ChatGPT" });
  assert.deepEqual(agentProvider("localhost", "Gemini CLI · research"), { key: "gemini", label: "Gemini" }, "an app on the computer, named by the person");
  assert.deepEqual(agentProvider("localhost", "Codex"), { key: "chatgpt", label: "ChatGPT" }, "Codex sits with OpenAI's agents, as its mark does");
  assert.deepEqual(agentProvider("dev-console", "Dev console"), { key: "other", label: "Other agents" });
  assert.deepEqual(agentProvider(undefined, undefined), { key: "other", label: "Other agents" });
  for (const [platform, name] of [["Claude", "x"], ["localhost", "Gemini CLI"], ["Grok", "y"]] as const) {
    assert.equal(agentBrand(platform, name)?.title !== undefined, agentProvider(platform, name).key !== "other", `${platform}/${name}: a provider exactly when there is a mark`);
  }
});
