import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { freshDb } from "../../test/db";
import { createUser } from "../db/users";
import { createAgent } from "../db/agents";
import { createMemory, memoriesForAgent, rescopeMemory } from "../db/memories";
import { systemClock } from "../seams/clock";
import {
  setAgentMemoryAccess,
  highTierRequestAllowed,
  vaultFieldAllowed,
} from "./resource-access";
import { initialGrants } from "./initial-grants";
import {
  upsertPermissions,
  getConnectionPermissions,
} from "../db/agent-permissions";
import { saveHighTierField } from "../db/high-tier-fields";

import { grantServices } from "../../test/grants";
test("memory audiences override source defaults for one agent and a global rescope replaces overrides", async () => {
  const db = await freshDb();
  try {
    const dek = randomBytes(32),
      user = await createUser(db, {
        email: "memory@resources.test",
        wrappedDek: "unused",
      });
    const agent = await createAgent(
      db,
      {
        userId: user.id,
        connectionId: randomUUID(),
        displayName: "A",
        platform: "Other",
      },
      systemClock,
    );
    const b = await createAgent(
      db,
      {
        userId: user.id,
        connectionId: randomUUID(),
        displayName: "B",
        platform: "Other",
      },
      systemClock,
    );
    const shared = await createMemory(
      db,
      {
        userId: user.id,
        content: "Shared",
        sourceAgentId: b.id,
        scope: "shared",
      },
      dek,
      systemClock,
    );
    const own = await createMemory(
      db,
      {
        userId: user.id,
        content: "Private",
        sourceAgentId: null,
        scope: "kept",
      },
      dek,
      systemClock,
    );
    assert.equal(
      await setAgentMemoryAccess(db, user.id, agent.id, [
        { id: shared.id, granted: false },
        { id: own.id, granted: true },
      ]),
      true,
    );
    assert.deepEqual(
      (await memoriesForAgent(db, user.id, agent.id, dek)).map((m) => m.id),
      [own.id],
    );
    assert.deepEqual(
      (await memoriesForAgent(db, user.id, b.id, dek)).map((m) => m.id),
      [shared.id],
    );
    assert.equal(
      await setAgentMemoryAccess(db, randomUUID(), agent.id, [
        { id: shared.id, granted: true },
      ]),
      false,
    );
    await rescopeMemory(db, user.id, shared.id, "shared");
    assert.equal(
      (await memoriesForAgent(db, user.id, agent.id, dek)).length,
      2,
    );
  } finally {
    await db.close();
  }
});

test("field and service grants persist independently and omitted edits preserve them", async () => {
  const db = await freshDb();
  try {
    const user = await createUser(db, {
      email: "vault@resources.test",
      wrappedDek: "unused",
    });
    const field = await saveHighTierField(db, {
      userId: user.id,
      type: "passport",
      label: "Travel",
      ciphertext: "opaque",
    });
    const other = await saveHighTierField(db, {
      userId: user.id,
      type: "passport",
      label: "Other",
      ciphertext: "opaque",
    });
    const base = initialGrants(user.id, randomUUID(), {
      template: "standard",
      highTier: true,
    });
    await grantServices(db, {
      ...base,
      identityFields: [field.id],
      grantedConnectors: ["notion"],
      connectorPolicies: { notion: { readTools: false, changeTools: "off" } },
    });
    // A later edit that leaves the accounts out keeps them, with their own settings.
    const { accounts: _accounts, ...withoutAccounts } = base;
    await grantServices(db, { ...withoutAccounts, rateLimit: 42 });
    const grants = (await getConnectionPermissions(
      db,
      user.id,
      base.connectionId,
    ))!;
    assert.deepEqual(grants.identityFields, [field.id]);
    assert.equal(grants.accounts.find((account) => account.connectorId === "notion")?.changeTools, "off");
    assert.equal(vaultFieldAllowed(grants, field.id), true);
    assert.equal(vaultFieldAllowed(grants, other.id), false);
    assert.equal(
      await highTierRequestAllowed(db, user.id, grants, "passport"),
      true,
    );
    assert.equal(
      await highTierRequestAllowed(db, user.id, grants, other.id),
      false,
    );
    assert.equal(
      await highTierRequestAllowed(db, randomUUID(), grants, "passport"),
      false,
    );
    await grantServices(db, { ...base, identityFields: [] });
    assert.equal(
      await highTierRequestAllowed(
        db,
        user.id,
        (await getConnectionPermissions(db, user.id, base.connectionId))!,
        "passport",
      ),
      false,
    );
  } finally {
    await db.close();
  }
});

test("agent context exposes only permitted low-tier fields and rejects foreign field choices", async () => {
  const db = await freshDb();
  try {
    const { localAesKeyWrapper } = await import("../crypto/key-wrapper");
    const { saveIdentityField } = await import("../db/identity-fields");
    const { createGetContextTool } = await import("../mcp/tools/get-context");
    const { createPermissionsActions } = await import(
      "../../app/(portal)/(protected)/agents/[id]/actions"
    );
    const wrapper = localAesKeyWrapper(randomBytes(32)),
      dek = randomBytes(32);
    const user = await createUser(db, {
      email: "context@resources.test",
      wrappedDek: await wrapper.wrap(dek),
    });
    const other = await createUser(db, {
      email: "foreign@resources.test",
      wrappedDek: await wrapper.wrap(dek),
    });
    const agent = await createAgent(
      db,
      {
        userId: user.id,
        connectionId: randomUUID(),
        displayName: "Agent",
        platform: "Other",
      },
      systemClock,
    );
    const name = await saveIdentityField(
      db,
      { userId: user.id, kind: "name", value: "Chosen name" },
      dek,
    );
    await saveIdentityField(
      db,
      { userId: user.id, kind: "email", value: "hidden@example.test" },
      dek,
    );
    const foreign = await saveIdentityField(
      db,
      { userId: other.id, kind: "name", value: "Foreign" },
      dek,
    );
    await grantServices(db, {
      ...initialGrants(user.id, agent.connectionId, { template: "minimal" }),
      identityFields: [name.id],
    });
    const connection = {
      userId: user.id,
      connectionId: agent.connectionId,
      agentId: agent.id,
      active: true,
    };
    const result = await createGetContextTool({
      db,
      keyWrapper: wrapper,
      clock: systemClock,
    }).handle(connection);
    assert.deepEqual(
      result.profile?.map((f) => f.value),
      ["Chosen name"],
    );
    const session = {
      id: randomUUID(),
      userId: user.id,
      createdAt: new Date(),
      lastSeenAt: new Date(),
      steppedUpAt: null,
    };
    const actions = createPermissionsActions({ db, keyWrapper: wrapper });
    assert.equal(
      (await actions.save(session, agent.id, { identityFields: [foreign.id] }))
        .ok,
      false,
    );
    assert.deepEqual(
      (await getConnectionPermissions(db, user.id, agent.connectionId))
        ?.identityFields,
      [name.id],
    );
  } finally {
    await db.close();
  }
});
