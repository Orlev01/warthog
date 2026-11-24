// Home's "Build your profile" block (src/domain/home/profile-build.ts; docs/adr/profile-build.md).
import { test } from "node:test";
import assert from "node:assert/strict";

import { profileBuildView, type ProfileBuildAgent } from "./profile-build";

const claude: ProfileBuildAgent = { id: "a1", name: "Claude", savesRecords: true, sources: ["Gmail", "Google Drive"] };
const base = { done: false, agents: [] as ProfileBuildAgent[], waitingRecords: 0, waitingAboutYou: 0 };

test("nothing shows once the step is done", () => {
  assert.equal(profileBuildView({ ...base, done: true, agents: [claude] }), null);
});

test("what waits for the person comes first", () => {
  assert.deepEqual(profileBuildView({ ...base, agents: [claude], waitingRecords: 10, waitingAboutYou: 2 }), { state: "waiting", records: 10, aboutYou: 2 });
});

test("ready names the first agent that can read and save, and what it can read", () => {
  const chat: ProfileBuildAgent = { id: "a2", name: "ChatGPT", savesRecords: true, sources: [] };
  assert.deepEqual(profileBuildView({ ...base, agents: [chat, claude] }), { state: "ready", agentName: "Claude", sources: ["Gmail", "Google Drive"] });
});

test("otherwise it says what's missing, and where to fix it", () => {
  assert.deepEqual(profileBuildView(base), { state: "no_agent" });
  assert.deepEqual(profileBuildView({ ...base, agents: [{ ...claude, sources: [] }] }), { state: "no_sources", agentName: "Claude", agentHref: "/agents/a1?section=connectors" });
  assert.deepEqual(profileBuildView({ ...base, agents: [{ ...claude, savesRecords: false }] }), { state: "no_records", agentName: "Claude", agentHref: "/agents/a1?section=settings" });
});
