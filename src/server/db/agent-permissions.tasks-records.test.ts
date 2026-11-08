// Review fix A2 — a connection's tasks and life-admin records grants are their own
// flags (`tasksAccess`, `recordsAccess`), no longer the connector tool-class settings.
//
// Until this fix the tasks and records tools gated on `readTools` / `changeTools`, which
// the consent screen set from the ticked services only — so a Standard agent with no
// services ticked was refused every tasks and records tool. These tests pin the store's
// side: the flags round-trip; a caller that does not state them (an older caller, or one
// that only edits other grants) gets the legacy derivation on insert and keeps the stored
// value on update — never a silent change.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { getConnectionPermissions, upsertPermissions, type PermissionGrants } from "./agent-permissions";
import { createUser } from "./users";
import { freshDb } from "../../test/db";
import type { Db } from "./index";

async function makeUser(db: Db): Promise<string> {
  const user = await createUser(db, { email: `${randomUUID()}@warthog.com.au`, wrappedDek: "d3JhcHBlZA==" });
  return user.id;
}

function grants(userId: string, connectionId: string, overrides: Partial<PermissionGrants> = {}): PermissionGrants {
  return {
    userId,
    connectionId,
    grantedConnectors: [],
    readTools: false,
    changeTools: "off",
    identityAccess: true,
    highTierAccess: false,
    cardAccess: false,
    cardBudget: null,
    skillsScope: [],
    memoryRead: true,
    sharing: false,
    rulesScope: [],
    rateLimit: 120,
    ...overrides,
  };
}

test("tasks and records grants round-trip independently of the connector tool classes", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db);
    const connectionId = randomUUID();
    await upsertPermissions(db, grants(userId, connectionId, { tasksAccess: true, recordsAccess: false }));
    const stored = await getConnectionPermissions(db, userId, connectionId);
    assert.equal(stored?.tasksAccess, true, "tasks granted with no connector tool class on");
    assert.equal(stored?.recordsAccess, false, "records stay off when not granted");
    assert.equal(stored?.readTools, false);
    assert.equal(stored?.changeTools, "off");
  } finally {
    await db.close();
  }
});

test("an insert that does not state the flags derives them from the tool classes (the old gate)", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db);
    const withTools = randomUUID();
    const withoutTools = randomUUID();
    await upsertPermissions(db, grants(userId, withTools, { readTools: true, changeTools: "ask_first" }));
    await upsertPermissions(db, grants(userId, withoutTools));
    const a = await getConnectionPermissions(db, userId, withTools);
    const b = await getConnectionPermissions(db, userId, withoutTools);
    assert.equal(a?.tasksAccess, true);
    assert.equal(a?.recordsAccess, true);
    assert.equal(b?.tasksAccess, false);
    assert.equal(b?.recordsAccess, false);
  } finally {
    await db.close();
  }
});

test("an update that does not state the flags keeps the stored ones", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db);
    const connectionId = randomUUID();
    await upsertPermissions(db, grants(userId, connectionId, { tasksAccess: true, recordsAccess: true }));
    // e.g. the per-agent permissions page saving a different grant
    await upsertPermissions(db, grants(userId, connectionId, { sharing: true }));
    const stored = await getConnectionPermissions(db, userId, connectionId);
    assert.equal(stored?.sharing, true, "the edited grant is saved");
    assert.equal(stored?.tasksAccess, true, "tasks access is kept");
    assert.equal(stored?.recordsAccess, true, "records access is kept");

    await upsertPermissions(db, grants(userId, connectionId, { tasksAccess: false }));
    const revoked = await getConnectionPermissions(db, userId, connectionId);
    assert.equal(revoked?.tasksAccess, false, "an explicit false revokes tasks");
    assert.equal(revoked?.recordsAccess, true, "records untouched");
  } finally {
    await db.close();
  }
});
