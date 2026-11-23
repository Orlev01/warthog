import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { freshDb } from "@/test/db";
import { createUser } from "@/server/db/users";
import { createAgent } from "@/server/db/agents";
import { createSkill, skillsForAgent, getSkillText } from "@/server/db/skills";
import {
  getAgentDefaults,
  saveAgentDefaults,
} from "@/server/db/agent-defaults";
import { setAgentSkillAccess } from "@/server/agents/skill-access";
import {
  upsertPermissions,
  getConnectionPermissions,
} from "@/server/db/agent-permissions";
import {
  createRememberTool,
  createSearchMemoryTool,
} from "@/server/mcp/tools/memory";
import { localAesKeyWrapper } from "@/server/crypto/key-wrapper";
import { fixedClock } from "@/server/seams/clock";

import { grantServices } from "../../test/grants";
const clock = fixedClock(new Date("2026-11-10T00:00:00Z"));

test("global defaults are account scoped and do not rewrite existing agent grants", async () => {
  const db = await freshDb();
  try {
    const user = await createUser(db, {
      email: "owner@example.com",
      wrappedDek: "wrapped",
    });
    const other = await createUser(db, {
      email: "other@example.com",
      wrappedDek: "wrapped",
    });
    assert.deepEqual(await getAgentDefaults(db, user.id), {
      template: "standard",
      rateLimit: 120,
    });
    const existing = await createAgent(
      db,
      {
        userId: user.id,
        connectionId: randomUUID(),
        displayName: "Existing",
        platform: "Other",
      },
      clock,
    );
    await grantServices(db, {
      userId: user.id,
      connectionId: existing.connectionId,
      grantedConnectors: [],
      readTools: false,
      changeTools: "off",
      identityAccess: true,
      highTierAccess: false,
      cardAccess: false,
      cardBudget: null,
      skillsScope: [],
      memoryRead: true,
      memoryWrite: true,
      sharing: false,
      rulesScope: [],
      rateLimit: 120,
    });
    await saveAgentDefaults(db, user.id, {
      template: "minimal",
      rateLimit: 30,
    });
    const unchanged = await getConnectionPermissions(
      db,
      user.id,
      existing.connectionId,
    );
    assert.equal(unchanged?.rateLimit, 120);
    assert.equal(unchanged?.memoryWrite, true);
    assert.deepEqual(await getAgentDefaults(db, user.id), {
      template: "minimal",
      rateLimit: 30,
    });
    assert.deepEqual(await getAgentDefaults(db, other.id), {
      template: "standard",
      rateLimit: 120,
    });
    await assert.rejects(() =>
      saveAgentDefaults(db, user.id, { template: "standard", rateLimit: 0 }),
    );
  } finally {
    await db.close();
  }
});

test("per-agent skill overrides affect context and direct fetch without changing other or future agents", async () => {
  const db = await freshDb();
  try {
    const dek = randomBytes(32);
    const user = await createUser(db, {
      email: "skills@example.com",
      wrappedDek: "wrapped",
    });
    const other = await createUser(db, {
      email: "stranger@example.com",
      wrappedDek: "wrapped",
    });
    const agent = await createAgent(
      db,
      {
        userId: user.id,
        connectionId: randomUUID(),
        displayName: "A",
        platform: "Other",
      },
      clock,
    );
    const sibling = await createAgent(
      db,
      {
        userId: user.id,
        connectionId: randomUUID(),
        displayName: "B",
        platform: "Other",
      },
      clock,
    );
    const skill = await createSkill(
      db,
      {
        userId: user.id,
        title: "Shared",
        useThisWhen: "Always",
        fullText: "Instructions",
        scope: "all",
      },
      dek,
    );
    assert.equal(
      await setAgentSkillAccess(db, other.id, agent.id, [
        { id: skill.id, granted: false },
      ]),
      false,
    );
    assert.equal(
      await setAgentSkillAccess(db, user.id, agent.id, [
        { id: skill.id, granted: false },
      ]),
      true,
    );
    assert.deepEqual(await skillsForAgent(db, user.id, agent.id, dek), []);
    assert.equal(
      await getSkillText(db, user.id, agent.id, "Shared", dek),
      null,
    );
    assert.equal(
      (await skillsForAgent(db, user.id, sibling.id, dek)).length,
      1,
    );
    await setAgentSkillAccess(db, user.id, agent.id, [
      { id: skill.id, granted: true },
    ]);
    assert.equal(
      await getSkillText(db, user.id, agent.id, "Shared", dek),
      "Instructions",
    );
    const privateSkill = await createSkill(
      db,
      {
        userId: user.id,
        title: "Chosen",
        useThisWhen: "Sometimes",
        fullText: "Private",
        scope: "chosen",
        scopedAgentIds: [],
      },
      dek,
    );
    await setAgentSkillAccess(db, user.id, agent.id, [
      { id: privateSkill.id, granted: true },
    ]);
    assert.equal(
      await getSkillText(db, user.id, agent.id, "Chosen", dek),
      "Private",
    );
    assert.equal(
      await getSkillText(db, user.id, sibling.id, "Chosen", dek),
      null,
    );
    await db.query("UPDATE skills SET enabled = false WHERE id = $1", [
      privateSkill.id,
    ]);
    assert.equal(
      await getSkillText(db, user.id, agent.id, "Chosen", dek),
      null,
    );
  } finally {
    await db.close();
  }
});

test("memory read and write are independent permissions and partial edits preserve write permission", async () => {
  const db = await freshDb();
  try {
    const dek = randomBytes(32),
      keyWrapper = localAesKeyWrapper(randomBytes(32));
    const user = await createUser(db, {
      email: "memory@example.com",
      wrappedDek: await keyWrapper.wrap(dek),
    });
    const agent = await createAgent(
      db,
      {
        userId: user.id,
        connectionId: randomUUID(),
        displayName: "A",
        platform: "Other",
      },
      clock,
    );
    const grants = {
      userId: user.id,
      connectionId: agent.connectionId,
      grantedConnectors: [],
      readTools: false,
      changeTools: "off" as const,
      identityAccess: false,
      highTierAccess: false,
      cardAccess: false,
      cardBudget: null,
      skillsScope: [],
      memoryRead: true,
      sharing: false,
      rulesScope: [],
      rateLimit: 120,
      memoryWrite: false,
    };
    await grantServices(db, grants);
    const connection = {
      userId: user.id,
      connectionId: agent.connectionId,
      agentId: agent.id,
      active: true,
    };
    const remember = createRememberTool({ db, keyWrapper, clock });
    assert.equal(
      (await remember.handle({ content: "do not save" }, connection)).status,
      "refused",
    );
    await grantServices(db, {
      ...grants,
      memoryRead: false,
      memoryWrite: true,
    });
    assert.equal(
      (await remember.handle({ content: "private note" }, connection)).status,
      "saved",
    );
    assert.equal(
      (
        await createSearchMemoryTool({ db, keyWrapper, clock }).handle(
          {},
          connection,
        )
      ).status,
      "refused",
    );
    const { memoryWrite: _write, ...partial } = grants;
    await grantServices(db, partial);
    assert.equal(
      (await getConnectionPermissions(db, user.id, agent.connectionId))
        ?.memoryWrite,
      true,
    );
  } finally {
    await db.close();
  }
});

test("connector account choice never falls back to another account", async () => {
  const { bindAccount } = await import("@/domain/permissions/account-access");
  const one = { id: randomUUID(), connectorId: "service", label: "One", connected: true };
  const two = { ...one, id: randomUUID(), label: "Two" };
  const granted = (...accounts: (typeof one)[]) => accounts.map((account) => ({ account, grant: { accountId: account.id, connectorId: "service" } }));
  const bind = (list: ReturnType<typeof granted>, named?: string) =>
    bindAccount({ serviceName: "Service", granted: list, defaults: { readTools: true, changeTools: "ask_first" }, tool: { name: "service__read", makesChange: false }, ...(named ? { named } : {}) });
  const bound = (result: ReturnType<typeof bind>) => (result.kind === "bound" ? result.account.id : undefined);
  assert.equal(bound(bind(granted(one))), one.id);
  assert.equal(bound(bind(granted(one, two))), undefined, "two granted accounts need a choice");
  assert.equal(bound(bind(granted(one, two), "Two")), two.id);
  assert.equal(bound(bind(granted(one), "Two")), undefined, "an account the agent wasn't given is never used");
  assert.equal(bound(bind(granted(one, { ...two, connected: false }), "Two")), undefined, "an unavailable account is never swapped for another");
});

test("agent permission updates are audited, reject foreign skills, and roll back with the audit write", async () => {
  const { createPermissionsActions } = await import(
    "@/app/(portal)/(protected)/agents/[id]/actions"
  );
  const { listActivity } = await import("@/server/activity/list");
  const db = await freshDb();
  try {
    const dek = randomBytes(32),
      keyWrapper = localAesKeyWrapper(randomBytes(32));
    const user = await createUser(db, {
      email: "audited@example.com",
      wrappedDek: await keyWrapper.wrap(dek),
    });
    const agent = await createAgent(
      db,
      {
        userId: user.id,
        connectionId: randomUUID(),
        displayName: "Agent",
        platform: "Other",
      },
      clock,
    );
    const grants = {
      userId: user.id,
      connectionId: agent.connectionId,
      grantedConnectors: [],
      readTools: false,
      changeTools: "off" as const,
      identityAccess: false,
      highTierAccess: false,
      cardAccess: false,
      cardBudget: null,
      skillsScope: [],
      memoryRead: true,
      sharing: false,
      rulesScope: [],
      rateLimit: 120,
    };
    await grantServices(db, grants);
    const session = {
      id: randomUUID(),
      userId: user.id,
      createdAt: clock.now(),
      lastSeenAt: clock.now(),
      steppedUpAt: null,
    };
    const actions = createPermissionsActions({ db, keyWrapper, clock });
    assert.deepEqual(
      await actions.save(session, agent.id, { memoryWrite: false }),
      { ok: true },
    );
    assert.equal(
      (await listActivity(db, user.id, { agentId: agent.id }, dek))[0]?.kind,
      "permission_change",
    );
    assert.deepEqual(
      await actions.save(session, agent.id, {
        identity: true,
        skills: [{ id: randomUUID(), granted: true }],
      }),
      { ok: false, reason: "invalid_request" },
    );
    assert.equal(
      (await getConnectionPermissions(db, user.id, agent.connectionId))
        ?.identityAccess,
      false,
    );
    const failingDb = {
      ...db,
      transaction: async <T>(fn: (tx: typeof db) => Promise<T>) =>
        db.transaction!((tx) =>
          fn({
            ...tx,
            query: async (sql, values) => {
              if (sql.includes("INSERT INTO activity_entries"))
                throw new Error("audit unavailable");
              return tx.query(sql, values);
            },
          }),
        ),
    };
    await assert.rejects(
      () =>
        createPermissionsActions({ db: failingDb, keyWrapper, clock }).save(
          session,
          agent.id,
          { identity: true },
        ),
      /audit unavailable/,
    );
    assert.equal(
      (await getConnectionPermissions(db, user.id, agent.connectionId))
        ?.identityAccess,
      false,
    );
  } finally {
    await db.close();
  }
});
