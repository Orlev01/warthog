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
import { PROFILE_SKILL } from "../../../domain/life-admin/profile-skill";
import type { AgentConnection } from "../context";

import { grantServices } from "../../../test/grants";
const clock = fixedClock(new Date("2026-11-23T01:00:00.000Z"));

async function setup(grants: { recordsAccess: boolean; grantedConnectors?: string[]; recordIds?: string[]; recordsWrite?: boolean }) {
  const db = await freshDb();
  const keyWrapper = localAesKeyWrapper(randomBytes(32));
  const dek = randomBytes(32);
  const user = await createUser(db, { email: `${randomUUID()}@warthog.com.au`, wrappedDek: await keyWrapper.wrap(dek) });
  const connectionId = randomUUID();
  const agent = await createAgent(db, { userId: user.id, connectionId, displayName: "Claude", platform: "claude" }, clock);
  await grantServices(db, {
    userId: user.id, connectionId, grantedConnectors: grants.grantedConnectors ?? [], readTools: true, changeTools: "allow",
    identityAccess: true, highTierAccess: false, cardAccess: false, cardBudget: null, skillsScope: [], memoryRead: true,
    sharing: false, rulesScope: [], rateLimit: 120, recordsAccess: grants.recordsAccess, tasksAccess: true,
    ...(grants.recordIds || grants.recordsWrite === false
      ? { resourceControls: { ...(grants.recordIds ? { recordIds: grants.recordIds } : {}), ...(grants.recordsWrite === false ? { recordsWrite: false } : {}) } }
      : {}),
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

// Building a profile (docs/adr/profile-build.md): the offer goes to an agent that can read the
// person's email, calendar or files through Warthog's own connectors (connected, and readable by
// this agent) and save records, and names only what it can read.
test("an agent that can read the person's email, calendar or files is offered the chance to build their profile", async () => {
  const mail = await setup({ recordsAccess: true, grantedConnectors: ["google-gmail"] });
  try {
    const next = (await mail.context.handle(mail.connection)).lifeAdmin?.next ?? "";
    assert.match(next, /build your profile/);
    assert.match(next, /go through your email for/);
    assert.match(next, new RegExp(`"${PROFILE_SKILL.title}"`));
  } finally { await mail.db.close(); }
  const calendar = await setup({ recordsAccess: true, grantedConnectors: ["google-calendar", "google-drive"] });
  try {
    assert.match((await calendar.context.handle(calendar.connection)).lifeAdmin?.next ?? "", /go through your calendar and files/);
  } finally { await calendar.db.close(); }
});

test("no offer for a service that asks before every read, an account that needs reconnecting, or an agent that can't save records", async () => {
  const notion = await setup({ recordsAccess: true, grantedConnectors: ["notion"] });
  try {
    assert.equal((await notion.context.handle(notion.connection)).lifeAdmin?.next, undefined);
  } finally { await notion.db.close(); }
  const expired = await setup({ recordsAccess: true, grantedConnectors: ["google-gmail"] });
  try {
    await expired.db.query("UPDATE connections SET status = 'needs_reconnect' WHERE user_id = $1", [expired.userId]);
    assert.equal((await expired.context.handle(expired.connection)).lifeAdmin?.next, undefined);
  } finally { await expired.db.close(); }
  const readOnly = await setup({ recordsAccess: true, grantedConnectors: ["google-gmail"], recordsWrite: false });
  try {
    const view = await readOnly.context.handle(readOnly.connection);
    assert.equal(view.lifeAdmin?.next, undefined);
    assert.ok(!view.skills.some((entry) => entry.title === PROFILE_SKILL.title), "no profile skill without records write");
    assert.equal((await readOnly.skill.handle({ title: PROFILE_SKILL.title }, readOnly.connection)).status, "not_available");
  } finally { await readOnly.db.close(); }
});

test("the profile skill is listed for an agent that may save records, and names only what it can read", async () => {
  const t = await setup({ recordsAccess: true, grantedConnectors: ["google-gmail", "google-drive"] });
  try {
    const view = await t.context.handle(t.connection);
    assert.ok(view.skills.some((entry) => entry.title === PROFILE_SKILL.title));
    const found = await t.skill.handle({ title: PROFILE_SKILL.title }, t.connection);
    assert.equal(found.status, "found");
    const text = (found as { text: string }).text;
    assert.match(text, /^Email$/m);
    assert.match(text, /^Files$/m);
    assert.doesNotMatch(text, /^Calendar$/m);
  } finally { await t.db.close(); }
  const none = await setup({ recordsAccess: true });
  try {
    const found = await none.skill.handle({ title: PROFILE_SKILL.title }, none.connection);
    assert.match((found as { text: string }).text, /You can't read anything through Warthog yet/, "the skill still explains how to start");
  } finally { await none.db.close(); }
  const without = await setup({ recordsAccess: false, grantedConnectors: ["google-gmail"] });
  try {
    assert.equal((await without.skill.handle({ title: PROFILE_SKILL.title }, without.connection)).status, "not_available");
  } finally { await without.db.close(); }
});

test("the profile skill tells an agent that can read About you how to suggest details, and one that can't to name what's missing", async () => {
  const reads = await setup({ recordsAccess: true, grantedConnectors: ["google-gmail"] });
  try {
    const text = ((await reads.skill.handle({ title: PROFILE_SKILL.title }, reads.connection)) as { text: string }).text;
    assert.match(text, /save_record aboutYou/);
  } finally { await reads.db.close(); }
  const blind = await setup({ recordsAccess: true, grantedConnectors: ["google-gmail"] });
  try {
    await blind.db.query("UPDATE agent_permissions SET identity_access = false WHERE user_id = $1", [blind.userId]);
    const text = ((await blind.skill.handle({ title: PROFILE_SKILL.title }, blind.connection)) as { text: string }).text;
    assert.match(text, /You can't suggest About you details/);
  } finally { await blind.db.close(); }
});
