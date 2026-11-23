// get_context's life-admin summary and the "Life admin records" built-in skill
// (docs/adr/life-admin-profile.md): only an agent with the records permission gets them, the
// summary counts only what that agent may see, and only an agent that can read the person's
// mail is told it may offer to fill life admin in.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";

import { createGetContextTool } from "./get-context";
import { createGetSkillTool } from "./get-skill";
import { createSaveRecordTool } from "./records";
import { createRecord } from "../../db/life-admin-records";
import { createUser } from "../../db/users";
import { createAgent } from "../../db/agents";
import { upsertPermissions } from "../../db/agent-permissions";
import { freshDb } from "../../../test/db";
import { localAesKeyWrapper } from "../../crypto/key-wrapper";
import { fixedClock } from "../../seams/clock";
import { LIFE_ADMIN_SKILL } from "../../../domain/life-admin/skill";
import type { AgentConnection } from "../context";

const clock = fixedClock(new Date("2026-11-23T01:00:00.000Z"));

async function setup(grants: { recordsAccess: boolean; grantedConnectors?: string[]; recordIds?: string[] }) {
  const db = await freshDb();
  const keyWrapper = localAesKeyWrapper(randomBytes(32));
  const dek = randomBytes(32);
  const user = await createUser(db, { email: `${randomUUID()}@warthog.com.au`, wrappedDek: await keyWrapper.wrap(dek) });
  const connectionId = randomUUID();
  const agent = await createAgent(db, { userId: user.id, connectionId, displayName: "Claude", platform: "claude" }, clock);
  await upsertPermissions(db, {
    userId: user.id, connectionId, grantedConnectors: grants.grantedConnectors ?? [], readTools: true, changeTools: "allow",
    identityAccess: true, highTierAccess: false, cardAccess: false, cardBudget: null, skillsScope: [], memoryRead: true,
    sharing: false, rulesScope: [], rateLimit: 120, recordsAccess: grants.recordsAccess, tasksAccess: true,
    ...(grants.recordIds ? { resourceControls: { recordIds: grants.recordIds } } : {}),
  } as Parameters<typeof upsertPermissions>[1]);
  const connection = { userId: user.id, connectionId, agentId: agent.id, active: true } as unknown as AgentConnection;
  const deps = { db, keyWrapper, clock };
  return { db, dek, userId: user.id, connection, context: createGetContextTool(deps), skill: createGetSkillTool(deps), save: createSaveRecordTool(deps) };
}

test("an agent with records access gets the summary and the skill; one without gets neither", async () => {
  const withAccess = await setup({ recordsAccess: true });
  try {
    await withAccess.save.handle({ type: "vehicles.registration", fields: { plate: "BX12AB" }, dueDate: "2026-12-14" }, withAccess.connection);
    const view = await withAccess.context.handle(withAccess.connection);
    assert.equal(view.lifeAdmin?.total, 1);
    assert.equal(view.lifeAdmin?.dueSoon[0]?.due.label, "Expires");
    assert.equal(view.lifeAdmin?.waitingForPerson, 1);
    assert.ok(view.skills.some((entry) => entry.title === LIFE_ADMIN_SKILL.title));
    const found = await withAccess.skill.handle({ title: LIFE_ADMIN_SKILL.title }, withAccess.connection);
    assert.equal(found.status, "found");
  } finally { await withAccess.db.close(); }

  const without = await setup({ recordsAccess: false });
  try {
    const view = await without.context.handle(without.connection);
    assert.equal(view.lifeAdmin, null);
    assert.ok(!view.skills.some((entry) => entry.title === LIFE_ADMIN_SKILL.title));
    assert.equal((await without.skill.handle({ title: LIFE_ADMIN_SKILL.title }, without.connection)).status, "not_available");
  } finally { await without.db.close(); }
});

test("the summary counts only the records this agent may see", async () => {
  const t = await setup({ recordsAccess: true, recordIds: [] });
  try {
    await createRecord(t.db, { userId: t.userId, kind: "item", type: "health.insurance", fields: { provider: "Bupa" }, status: "active", source: { kind: "person" } }, t.dek);
    const view = await t.context.handle(t.connection);
    assert.equal(view.lifeAdmin?.total, 0);
    assert.deepEqual(view.lifeAdmin?.byCategory, {});
  } finally { await t.db.close(); }
});

test("only an agent that can read the person's mail is offered the chance to fill life admin in", async () => {
  const mail = await setup({ recordsAccess: true, grantedConnectors: ["google-gmail"] });
  try {
    assert.match((await mail.context.handle(mail.connection)).lifeAdmin?.next ?? "", /look through your email/);
  } finally { await mail.db.close(); }
  const noMail = await setup({ recordsAccess: true, grantedConnectors: ["google-calendar"] });
  try {
    assert.equal((await noMail.context.handle(noMail.connection)).lifeAdmin?.next, undefined);
  } finally { await noMail.db.close(); }
});
