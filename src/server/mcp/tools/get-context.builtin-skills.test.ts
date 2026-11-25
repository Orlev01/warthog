// Warthog's own skills over MCP (docs/adr/editable-builtin-skills.md): what the person changes
// reaches agents, and nothing they change stops Warthog's rules reaching them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";

import { createGetContextTool } from "./get-context";
import { createGetSkillTool } from "./get-skill";
import { createUser } from "../../db/users";
import { createAgent } from "../../db/agents";
import { createSkill } from "../../db/skills";
import { changeBuiltinSkill } from "../../db/builtin-skills";
import { upsertPermissions } from "../../db/agent-permissions";
import { freshDb } from "../../../test/db";
import { localAesKeyWrapper } from "../../crypto/key-wrapper";
import { fixedClock } from "../../seams/clock";
import { HOUSE_RULES } from "../../../domain/skills/house";
import { LIFE_ADMIN_RULES } from "../../../domain/life-admin/skill";
import type { AgentConnection } from "../context";
import { grantServices } from "../../../test/grants";

const clock = fixedClock(new Date("2026-11-25T01:00:00.000Z"));

async function setup(grants: { recordsAccess?: boolean; cardAccess?: boolean } = {}) {
  const db = await freshDb();
  const keyWrapper = localAesKeyWrapper(randomBytes(32));
  const dek = randomBytes(32);
  const user = await createUser(db, { email: `${randomUUID()}@warthog.com.au`, wrappedDek: await keyWrapper.wrap(dek) });
  const connectionId = randomUUID();
  const agent = await createAgent(db, { userId: user.id, connectionId, displayName: "Claude", platform: "claude" }, clock);
  await grantServices(db, {
    userId: user.id, connectionId, grantedConnectors: [], readTools: true, changeTools: "allow",
    identityAccess: true, highTierAccess: false, cardAccess: grants.cardAccess ?? false, cardBudget: grants.cardAccess ? { amount: 200, currency: "AUD", period: "month" } : null, skillsScope: [], memoryRead: true,
    sharing: false, rulesScope: [], rateLimit: 120, recordsAccess: grants.recordsAccess ?? true, tasksAccess: true,
  } as Parameters<typeof upsertPermissions>[1]);
  const connection = { userId: user.id, connectionId, agentId: agent.id, active: true } as unknown as AgentConnection;
  const deps = { db, keyWrapper, clock };
  const change = (key: string, next: Parameters<typeof changeBuiltinSkill>[3]) => changeBuiltinSkill(db, user.id, key, next, { state: "on" }, dek);
  return { db, dek, userId: user.id, agentId: agent.id, connection, context: createGetContextTool(deps), skill: createGetSkillTool(deps), change };
}

const titlesOf = (view: { skills: readonly { title: string }[] }) => view.skills.map((skill) => skill.title);
const hasAll = (text: string, rules: readonly string[]) => rules.every((rule) => text.includes(rule));

test("the house rules reach the agent however the person changes Using Warthog; its guidance only while it's given", async () => {
  const t = await setup();
  try {
    let view = await t.context.handle(t.connection);
    assert.equal(titlesOf(view)[0], "Using Warthog");
    assert.ok(hasAll(view.instructions, HOUSE_RULES));
    assert.match(view.instructions, /Keep each conversation together/);

    await t.change("using_warthog", { guidance: "Be brief with me.", basedOnVersion: 1 });
    view = await t.context.handle(t.connection);
    assert.ok(hasAll(view.instructions, HOUSE_RULES), "edited: the rules stay");
    assert.match(view.instructions, /^Be brief with me\./, "and the person's wording comes first");
    assert.doesNotMatch(view.instructions, /Keep each conversation together/);

    for (const state of ["off", "removed"] as const) {
      await t.change("using_warthog", { state });
      view = await t.context.handle(t.connection);
      assert.ok(!titlesOf(view).includes("Using Warthog"), `${state}: not listed`);
      assert.ok(hasAll(view.instructions, HOUSE_RULES), `${state}: the rules still reach the agent`);
      assert.doesNotMatch(view.instructions, /Be brief with me/, `${state}: the guidance doesn't`);
      assert.equal((await t.skill.handle({ title: "Using Warthog" }, t.connection)).status, "not_available");
    }

    await t.change("using_warthog", { state: "on", scope: { type: "agents", agentIds: [randomUUID()] } });
    view = await t.context.handle(t.connection);
    assert.ok(!titlesOf(view).includes("Using Warthog"), "another agent's only: not listed for this one");
    assert.ok(hasAll(view.instructions, HOUSE_RULES));
  } finally {
    await t.db.close();
  }
});

test("switching Life admin records off moves its rules into the instructions of an agent that can still use Life admin", async () => {
  const t = await setup();
  try {
    let view = await t.context.handle(t.connection);
    assert.ok(titlesOf(view).includes("Life admin records"));
    assert.ok(!hasAll(view.instructions, LIFE_ADMIN_RULES), "while it's given, its rules come with the skill");
    await t.change("life_admin_records", { state: "off" });
    view = await t.context.handle(t.connection);
    assert.ok(!titlesOf(view).includes("Life admin records"));
    assert.ok(hasAll(view.instructions, LIFE_ADMIN_RULES), "off: its rules still reach the agent");
    assert.equal(view.lifeAdmin?.next, undefined, "and no offer sends it to a skill it doesn't have");

    const without = await setup({ recordsAccess: false });
    try {
      assert.ok(!hasAll((await without.context.handle(without.connection)).instructions, LIFE_ADMIN_RULES), "an agent without Life admin doesn't get them");
    } finally {
      await without.db.close();
    }
  } finally {
    await t.db.close();
  }
});

test("defaults follow the agent's permissions, packs start off, and a pack the person switches on is listed", async () => {
  const t = await setup();
  try {
    let titles = titlesOf(await t.context.handle(t.connection));
    assert.ok(titles.includes("What needs me this week") && titles.includes("Tax time"));
    assert.ok(!titles.includes("Paying for something"), "no card access");
    assert.ok(!titles.includes("Inbox catch-up"), "no mail it can read");
    assert.ok(!titles.includes("Sole trader"), "packs start off");
    assert.equal((await t.skill.handle({ title: "Sole trader" }, t.connection)).status, "not_available");
    await t.change("sole_trader", { state: "on" });
    titles = titlesOf(await t.context.handle(t.connection));
    assert.ok(titles.includes("Sole trader"));
    assert.equal((await t.skill.handle({ title: "sole TRADER" }, t.connection)).status, "found", "by title, whatever the case");

    const cards = await setup({ cardAccess: true });
    try {
      assert.ok(titlesOf(await cards.context.handle(cards.connection)).includes("Paying for something"));
    } finally {
      await cards.db.close();
    }
  } finally {
    await t.db.close();
  }
});

test("an older skill of the person's own with a title Warthog now uses stays reachable when Warthog's isn't given", async () => {
  const t = await setup();
  try {
    await createSkill(t.db, { userId: t.userId, title: "Tax time", useThisWhen: "when it's tax time", fullText: "My own tax notes.", scope: "all", scopedAgentIds: [] }, t.dek);
    const warthogs = await t.skill.handle({ title: "Tax time" }, t.connection);
    assert.equal(warthogs.status, "found");
    assert.doesNotMatch((warthogs as { text: string }).text, /My own tax notes/, "Warthog's, while it's given");
    await t.change("tax_time", { state: "off" });
    const mine = await t.skill.handle({ title: "Tax time" }, t.connection);
    assert.match((mine as { text?: string }).text ?? "", /My own tax notes/, "the person's own once Warthog's is off");
  } finally {
    await t.db.close();
  }
});
