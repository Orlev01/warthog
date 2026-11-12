// Review fix A2 (the access-key twin of the consent decision) — Standard and Custom
// include tasks and life-admin records, Minimal does not, whether or not any service is
// ticked. Until this fix both flows derived those from the connector tool classes, so a
// Standard access-key agent with no services was refused every tasks and records tool.

import { test } from "node:test";
import assert from "node:assert/strict";

import { createAccessKeyActions, type AccessKeyInput } from "./actions";
import { listAgentsForUser } from "../../../../../server/db/agents";
import { getConnectionPermissions } from "../../../../../server/db/agent-permissions";
import { createUser } from "../../../../../server/db/users";
import { fixedClock } from "../../../../../server/seams/clock";
import { systemRandom } from "../../../../../server/seams/random";
import { freshDb } from "../../../../../test/db";
import type { Session } from "../../../../../server/auth/session";

const NOW = new Date("2026-06-01T00:00:00.000Z");

test("custom access-key permissions persist explicit denials and independent memory write", async () => {
  const db = await freshDb();
  try {
    const user = await createUser(db, { email: "ak-custom-edits@example.com", wrappedDek: "d3JhcHBlZA==" });
    const actions = createAccessKeyActions({ keyWrapper: { wrap: async () => "test-wrapped", unwrap: async () => new Uint8Array(32).fill(7) }, db, clock: fixedClock(NOW), random: systemRandom, alerts: { emailSender: { sendEmail: async () => {} } } });
    assert.ok((await actions.create(sessionFor(user.id), {
      name: "Research", platform: "Other", template: "custom",
      identity: false, memoryRead: true, memoryWrite: false, tasks: false, records: false,
    })).ok);
    const [agent] = await listAgentsForUser(db, user.id);
    const grants = await getConnectionPermissions(db, user.id, agent!.connectionId);
    assert.equal(grants?.identityAccess, false);
    assert.equal(grants?.memoryRead, true);
    assert.equal(grants?.memoryWrite, false);
    assert.equal(grants?.tasksAccess, false);
    assert.equal(grants?.recordsAccess, false);
  } finally { await db.close(); }
});

function sessionFor(userId: string): Session {
  return { id: `sess-${userId}`, userId, createdAt: NOW, lastSeenAt: NOW, steppedUpAt: NOW };
}

for (const [template, expected] of [
  ["standard", true],
  ["custom", true],
  ["minimal", false],
] as const) {
  test(`an access-key agent on ${template} with no services ticked: tasks and records ${expected ? "granted" : "not granted"}`, async () => {
    const db = await freshDb();
    try {
      const user = await createUser(db, { email: `ak-${template}@warthog.com.au`, wrappedDek: "d3JhcHBlZA==" });
      const actions = createAccessKeyActions({ keyWrapper: { wrap: async () => "test-wrapped", unwrap: async () => new Uint8Array(32).fill(7) }, db, clock: fixedClock(NOW), random: systemRandom, alerts: { emailSender: { sendEmail: async () => {} } } });
      const input: AccessKeyInput = { name: "My Grok", platform: "grok", template } as AccessKeyInput;
      const result = await actions.create(sessionFor(user.id), input);
      assert.ok(result.ok);
      const [agent] = await listAgentsForUser(db, user.id);
      const grants = await getConnectionPermissions(db, user.id, agent!.connectionId);
      assert.equal(grants?.tasksAccess, expected);
      assert.equal(grants?.recordsAccess, expected);
      assert.equal(grants?.readTools, false, "no connector read tools without a ticked service");
    } finally {
      await db.close();
    }
  });
}
