// A committed account deletion is one `account.deleted` event with no dimensions
// (docs/design/admin-portal.md §4); a refused deletion records nothing; a throwing seam
// never changes the outcome.
import { test } from "node:test";
import assert from "node:assert/strict";

import { deleteAccount } from "./delete";
import { createUser } from "../db/users";
import { freshDb } from "../../test/db";
import type { RecordMetricInput } from "../metrics/record";

const senders = { email: { sendEmail: async () => {} }, push: { sendPush: async () => {} }, sms: { sendSms: async () => {} } };
const revoker = { revokeAgentsAndConnections: async () => {} };

test("deleting an account records account.deleted once and nothing about the person", async () => {
  const db = await freshDb();
  try {
    const metrics: RecordMetricInput[] = [];
    const person = await createUser(db, { email: "leaving@example.test", wrappedDek: "wrapped" });
    const result = await deleteAccount({ db, revoker, senders, recordMetric: async (m) => { metrics.push(m); } }, { userId: person.id });
    assert.deepEqual(result, { ok: true });
    assert.deepEqual(metrics, [{ name: "account.deleted", value: 1 }]);

    const owner = await createUser(db, { email: "owner@example.test", wrappedDek: "wrapped" });
    await db.query("INSERT INTO households (owner_id, currency) VALUES ($1, 'AUD')", [owner.id]);
    const refused = await deleteAccount({ db, revoker, senders, recordMetric: async (m) => { metrics.push(m); } }, { userId: owner.id });
    assert.equal(refused.ok, false);
    assert.equal(metrics.length, 1, "a refused deletion records nothing");

    const other = await createUser(db, { email: "other@example.test", wrappedDek: "wrapped" });
    assert.deepEqual(await deleteAccount({ db, revoker, senders, recordMetric: async () => { throw new Error("metrics down"); } }, { userId: other.id }), { ok: true });
  } finally {
    await db.close();
  }
});
