// The new life-admin tables (db/migrations/0118; docs/adr/life-admin-journal.md) under the
// production roles: a person's own categories are ordinary data; the journal and the activity
// links are append-only for the runtime role, yet deleting a record still removes its journal (the
// cascade runs as the table owner); a purge removes everything. Plus the activity filter for one
// item, and tasks that are about a record.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";

import { createRecord } from "./life-admin-records";
import { createTask, listTasksForUser, updateTask } from "./tasks";
import { changeTaskAsAgent } from "./task-handoffs";
import { listJournal } from "./life-admin-journal";
import { createUser } from "./users";
import { createDbRecorder } from "../activity/writer";
import { listActivity } from "../activity/list";
import { fixedClock } from "../seams/clock";
import { freshDb } from "../../test/db";

const clock = fixedClock(new Date("2026-11-23T01:00:00Z"));

test("categories are ordinary data; the journal and activity links are append-only; a record's delete still cascades", async () => {
  const db = await freshDb();
  try {
    const dek = randomBytes(32);
    const user = await createUser(db, { email: "areas-roles@warthog.com.au", wrappedDek: "synthetic" });
    const record = await createRecord(db, { userId: user.id, kind: "item", type: "other.item", fields: { name: "x" }, status: "active", source: { kind: "person" } }, dek);
    const recorder = createDbRecorder({ db, clock, dekFor: async () => dek });
    const entry = await recorder.record({ userId: user.id, kind: "tool_call", source: "warthog", tool: "save_record", outcome: "executed", payload: {}, recordIds: [record.id, "not-a-uuid"] });

    await db.query("SET ROLE warthog_app");
    const category = randomUUID();
    await db.query("INSERT INTO life_admin_categories (user_id, id, slug, state, origin_kind, definition, created_at, updated_at) VALUES ($1, $2, 'x_bcdfgh', 'suggested', 'person', 'v1:x', now(), now())", [user.id, category]);
    await db.query("UPDATE life_admin_categories SET state = 'active' WHERE user_id = $1 AND id = $2", [user.id, category]);
    await db.query("DELETE FROM life_admin_categories WHERE user_id = $1 AND id = $2", [user.id, category]);

    await db.query("INSERT INTO life_admin_journal (user_id, id, record_id, seq, kind, actor_kind, at, body) VALUES ($1, $2, $3, 1, 'note', 'person', now(), 'v1:x')", [user.id, randomUUID(), record.id]);
    await assert.rejects(db.query("UPDATE life_admin_journal SET body = body WHERE false"), /permission denied/);
    await assert.rejects(db.query("DELETE FROM life_admin_journal WHERE false"), /permission denied/);
    await assert.rejects(db.query("UPDATE activity_entry_records SET record_id = record_id WHERE false"), /permission denied/);
    await assert.rejects(db.query("DELETE FROM activity_entry_records WHERE false"), /permission denied/);

    // Deleting the record (what "not mine" and delete do) removes its journal through the cascade.
    await db.query("DELETE FROM life_admin_records WHERE user_id = $1 AND id = $2", [user.id, record.id]);
    assert.equal(Number((await db.query("SELECT count(*)::int AS n FROM life_admin_journal WHERE user_id = $1", [user.id])).rows[0]!.n), 0);
    await db.query("RESET ROLE");

    // The activity link outlives the record, so Activity still shows what happened to it.
    const linked = await listActivity(db, user.id, { recordId: record.id }, dek);
    assert.deepEqual(linked.map((item) => item.seq), [entry.seq]);
    assert.deepEqual(await listActivity(db, user.id, { recordId: "nope" }, dek), []);

    await db.query("SET ROLE warthog_purge");
    await db.query("DELETE FROM users WHERE id = $1", [user.id]);
    await db.query("RESET ROLE");
    for (const table of ["life_admin_categories", "life_admin_journal", "activity_entry_records"]) {
      const left = await db.query(`SELECT count(*)::int AS n FROM ${table} WHERE user_id = $1`, [user.id]);
      assert.equal(Number(left.rows[0]?.n), 0, `the purged account's ${table} are gone`);
    }
  } finally { await db.query("RESET ROLE"); await db.close(); }
});

test("a task can be about one of the same person's records, and the link clears when the record goes", async () => {
  const db = await freshDb();
  try {
    const dek = randomBytes(32);
    const user = await createUser(db, { email: "task-record@warthog.com.au", wrappedDek: "synthetic" });
    const other = await createUser(db, { email: "task-record-other@warthog.com.au", wrappedDek: "synthetic" });
    const record = await createRecord(db, { userId: user.id, kind: "item", type: "vehicles.insurance", fields: { provider: "Swann" }, status: "active", source: { kind: "person" } }, dek);
    const task = await createTask(db, { userId: user.id, title: "Finalise the motorcycle insurance", assignee: "any", createdBy: { kind: "person" }, recordId: record.id }, dek);
    assert.equal((await listTasksForUser(db, user.id, dek))[0]!.recordId, record.id);
    await assert.rejects(createTask(db, { userId: other.id, title: "x", assignee: "any", createdBy: { kind: "person" }, recordId: record.id }, dek), "another person's record is refused by the database");
    await db.query("DELETE FROM life_admin_records WHERE id = $1", [record.id]);
    const after = (await listTasksForUser(db, user.id, dek)).find((t) => t.id === task.id)!;
    assert.equal(after.recordId, undefined);
  } finally { await db.close(); }
});

test("finishing a task about an item goes in that item's journal, once", async () => {
  const db = await freshDb();
  try {
    const dek = randomBytes(32);
    const user = await createUser(db, { email: "task-done@warthog.com.au", wrappedDek: "synthetic" });
    const agent = await db.query("INSERT INTO agents (user_id, connection_id, display_name, platform, status, connected_at) VALUES ($1, gen_random_uuid(), 'Muse', 'other', 'connected', now()) RETURNING id", [user.id]);
    const agentId = String(agent.rows[0]!.id);
    const record = await createRecord(db, { userId: user.id, kind: "item", type: "vehicles.insurance", fields: { provider: "Swann" }, status: "active", source: { kind: "person" } }, dek);
    const byAgent = await createTask(db, { userId: user.id, title: "Pay Swann", assignee: "any", createdBy: { kind: "person" }, recordId: record.id }, dek);
    const byPerson = await createTask(db, { userId: user.id, title: "File the roadworthy", assignee: "any", createdBy: { kind: "person" }, recordId: record.id }, dek);
    const plain = await createTask(db, { userId: user.id, title: "Unrelated", assignee: "any", createdBy: { kind: "person" } }, dek);

    assert.ok(await changeTaskAsAgent(db, { userId: user.id, agentId, id: byAgent.id, status: "done" }, dek, new Date("2026-11-23T02:00:00Z")));
    await updateTask(db, { userId: user.id, id: byPerson.id, title: "File the roadworthy", assignee: "any", status: "done", now: new Date("2026-11-23T03:00:00Z") }, dek);
    await updateTask(db, { userId: user.id, id: byPerson.id, title: "File the roadworthy (renamed)", assignee: "any", status: "done" }, dek);
    await updateTask(db, { userId: user.id, id: plain.id, title: "Unrelated", assignee: "any", status: "done" }, dek);

    const entries = await listJournal(db, user.id, record.id, dek, { limit: 10 });
    const done = entries.filter((entry) => entry.kind === "change" && entry.body.change?.event === "task_done");
    assert.deepEqual(done.map((entry) => [entry.actorKind, entry.at]).sort(), [["agent", "2026-11-23T02:00:00.000Z"], ["person", "2026-11-23T03:00:00.000Z"]]);
  } finally { await db.close(); }
});
