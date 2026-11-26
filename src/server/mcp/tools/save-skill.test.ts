// The `save_skill` core tool (docs/adr/agent-saved-skills.md): an agent saves a skill it wrote
// with the person, switched off, for the person to check. Pinned here: the person and agent come
// from the connection; the person's "Let it save skills" switch refuses it; the input is checked
// at the boundary; the agent is told where the skill waits; and, through the real pipeline, the
// call is recorded as Warthog's own activity entry.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";

import { createSaveSkillTool, type SaveSkillResult } from "./save-skill";
import { createToolRegistry } from "./registry";
import { createGetContextTool } from "./get-context";
import { coreToolMetadata } from "./metadata";
import { createAgentCallPipeline, type AgentCall } from "../pipeline";
import { createRateLimiter } from "../rate-limit";
import { createInMemoryRecorder, type ActivityEntryInput } from "../../activity/recorder";
import { createUser } from "../../db/users";
import { upsertPermissions } from "../../db/agent-permissions";
import { listSkillsForUser } from "../../db/skills";
import { listPackageSummaries } from "../../db/skill-packages";
import { freshDb } from "../../../test/db";
import { localAesKeyWrapper } from "../../crypto/key-wrapper";
import { fixedClock } from "../../seams/clock";
import { HttpError } from "../../http/validate";
import { makeSkillFile } from "../../../domain/skills/package";
import type { AgentConnection } from "../context";
import type { Db } from "../../db/index";

const NOW = new Date("2026-11-26T01:00:00.000Z");
const SKILLS_PAGE = "https://app.warthog.test/skills";
const SKILL_MD = makeSkillFile("Trip planner", "When I ask you to plan a trip", "1. Ask where and when.");

async function setUp(db: Db, grants: { skillsWrite?: boolean } = {}) {
  const keyWrapper = localAesKeyWrapper(randomBytes(32));
  const dek = randomBytes(32);
  const user = await createUser(db, { email: `${randomUUID()}@example.test`, wrappedDek: await keyWrapper.wrap(dek) });
  const connectionId = randomUUID();
  const connection: AgentConnection = { userId: user.id, connectionId, agentId: randomUUID(), active: true };
  await upsertPermissions(db, {
    userId: user.id, connectionId, readTools: false, changeTools: "off", identityAccess: false, highTierAccess: false,
    cardAccess: false, cardBudget: null, skillsScope: [], memoryRead: false, sharing: false, rulesScope: [], rateLimit: 120,
    ...(grants.skillsWrite === undefined ? {} : { resourceControls: { skillsWrite: grants.skillsWrite } }),
  });
  const tool = createSaveSkillTool({ db, keyWrapper, clock: fixedClock(NOW), skillsPage: SKILLS_PAGE });
  return { tool, connection, dek, keyWrapper, userId: user.id };
}

test("save_skill saves the skill switched off, as the connection's agent, and says where it waits", async () => {
  const db = await freshDb();
  try {
    const { tool, connection, dek, userId } = await setUp(db);
    // A person or agent smuggled into the input is ignored: it isn't part of the schema.
    const result = await tool.handle({ skill_md: SKILL_MD, userId: randomUUID(), agentId: randomUUID() }, connection);
    assert.equal(result.status, "saved");
    const saved = result as Extract<SaveSkillResult, { status: "saved" }>;
    assert.equal(saved.skills_page, SKILLS_PAGE);
    assert.match(saved.message, /switched off/);
    const [skill] = await listSkillsForUser(db, userId, dek);
    assert.equal(skill!.enabled, false);
    const [pkg] = await listPackageSummaries(db, userId, dek);
    assert.equal(pkg!.savedByAgentId, connection.agentId);
  } finally {
    await db.close();
  }
});

test("save_skill is refused when the person has turned off \"Let it save skills\" for the agent", async () => {
  const db = await freshDb();
  try {
    const { tool, connection, dek, userId } = await setUp(db, { skillsWrite: false });
    const result = await tool.handle({ skill_md: SKILL_MD }, connection);
    assert.equal(result.status, "refused");
    assert.match((result as { reason: string }).reason, /Let it save skills/);
    assert.equal((await listSkillsForUser(db, userId, dek)).length, 0);
  } finally {
    await db.close();
  }
});

test("save_skill checks its input before touching anything", async () => {
  const db = await freshDb();
  try {
    const { tool, connection } = await setUp(db);
    await assert.rejects(() => tool.handle({}, connection), HttpError, "neither skill_md nor its parts");
    await assert.rejects(() => tool.handle({ name: "Only a name" }, connection), HttpError);
    await assert.rejects(() => tool.handle({ skill_md: SKILL_MD, id: "not-a-uuid" }, connection), HttpError);
    await assert.rejects(() => tool.handle({ skill_md: "x".repeat(200_001) }, connection), HttpError);
  } finally {
    await db.close();
  }
});

test("save_skill is a core tool that says it makes a change, and runs through the pipeline", async () => {
  const db = await freshDb();
  try {
    const { tool, connection, keyWrapper, dek, userId } = await setUp(db);
    const registry = createToolRegistry({
      pipeline: { async handleAgentCall() { return { status: "executed", result: {} }; }, async executeApprovedHold() { return { status: "refused" as const, reason: "unused" }; } },
    });
    assert.ok(registry.coreTools.some((t) => t.name === "save_skill"));
    assert.equal(coreToolMetadata("save_skill").annotations.readOnlyHint, false);

    const inputs: ActivityEntryInput[] = [];
    const base = createInMemoryRecorder({ clock: fixedClock(NOW) });
    const pipeline = createAgentCallPipeline({
      db,
      keyWrapper,
      clock: fixedClock(NOW),
      rateLimiter: createRateLimiter(fixedClock(NOW)),
      recorder: { async record(input: ActivityEntryInput) { inputs.push(input); return base.record(input); } },
      executeTool: async (call: AgentCall, conn: AgentConnection) => tool.handle(call.params, conn),
    });
    const outcome = await pipeline.handleAgentCall(connection, { connector: null, tool: "save_skill", makesChange: true, params: { skill_md: SKILL_MD } });
    assert.equal(outcome.status, "executed");
    assert.equal((outcome as { result: { status: string } }).result.status, "saved");
    assert.equal((await listSkillsForUser(db, userId, dek)).length, 1);
    const entries = inputs.filter((e) => e.tool === "save_skill" && e.kind === "tool_call");
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.source, "warthog");
    assert.equal(entries[0]!.agentId, connection.agentId);
  } finally {
    await db.close();
  }
});

test("get_context tells the agent whether it may save skills", async () => {
  const db = await freshDb();
  try {
    const allowed = await setUp(db);
    const view = await createGetContextTool({ db, keyWrapper: allowed.keyWrapper, clock: fixedClock(NOW) }).handle(allowed.connection);
    assert.equal(view.permissions?.resources?.skills.write, true);
    const stopped = await setUp(db, { skillsWrite: false });
    const off = await createGetContextTool({ db, keyWrapper: stopped.keyWrapper, clock: fixedClock(NOW) }).handle(stopped.connection);
    assert.equal(off.permissions?.resources?.skills.write, false);
  } finally {
    await db.close();
  }
});
