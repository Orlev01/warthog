// Review fix W2.3 (follow-through) — get_context lists the agent's open tasks by the agent's
// own TASKS grant (`tasksAccess`, migration 0068), the same grant list_tasks checks and the one
// the per-agent permissions page now switches, not by the connector read-tools class.
//
// Before: get_context gated its task list on `readTools`, so an agent given "Your tasks" on the
// permissions page (but no connected service) saw no tasks in get_context while list_tasks
// worked, and an agent with a service but no tasks grant saw them.
//
// Driven through the real tool over an isolated PGlite with the real migrations.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";

import { createGetContextTool } from "./get-context";
import { createUser } from "../../db/users";
import { upsertPermissions } from "../../db/agent-permissions";
import { createTask } from "../../db/tasks";
import { freshDb } from "../../../test/db";
import { localAesKeyWrapper } from "../../crypto/key-wrapper";
import { fixedClock } from "../../seams/clock";
import type { Db } from "../../db/index";

const NOW = new Date("2026-11-15T12:00:00.000Z");
const keyWrapper = localAesKeyWrapper(randomBytes(32));

async function setUp(db: Db, grants: { readTools: boolean; tasksAccess: boolean }) {
  const dek = randomBytes(32);
  const user = await createUser(db, { email: `alice-${randomUUID()}@warthog.com.au`, wrappedDek: await keyWrapper.wrap(dek) });
  const connectionId = randomUUID();
  await upsertPermissions(db, {
    userId: user.id,
    connectionId,
    grantedConnectors: grants.readTools ? ["notion"] : [],
    readTools: grants.readTools,
    changeTools: grants.readTools ? "ask_first" : "off",
    identityAccess: false,
    highTierAccess: false,
    cardAccess: false,
    cardBudget: null,
    skillsScope: [],
    memoryRead: false,
    sharing: false,
    rulesScope: [],
    rateLimit: 120,
    tasksAccess: grants.tasksAccess,
    recordsAccess: false,
  });
  await createTask(db, { userId: user.id, title: "Renew the rego", assignee: "any", createdBy: { kind: "person" } }, dek);
  return { userId: user.id, connectionId };
}

test("an agent with the tasks grant (and no connected service) sees its open tasks", async () => {
  const db = await freshDb();
  try {
    const { userId, connectionId } = await setUp(db, { readTools: false, tasksAccess: true });
    const view = await createGetContextTool({ db, keyWrapper, clock: fixedClock(NOW) }).handle({
      userId,
      connectionId,
      agentId: connectionId,
      active: true,
    });
    assert.deepEqual(view.tasks.map((t) => t.title), ["Renew the rego"]);
  } finally {
    await db.close();
  }
});

test("an agent without the tasks grant sees no tasks, whatever its connector read tools", async () => {
  const db = await freshDb();
  try {
    const { userId, connectionId } = await setUp(db, { readTools: true, tasksAccess: false });
    const view = await createGetContextTool({ db, keyWrapper, clock: fixedClock(NOW) }).handle({
      userId,
      connectionId,
      agentId: connectionId,
      active: true,
    });
    assert.deepEqual(view.tasks, []);
  } finally {
    await db.close();
  }
});
