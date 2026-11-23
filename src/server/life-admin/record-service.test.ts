// Saving and changing typed life-admin records (`./record-service.ts`,
// docs/adr/life-admin-profile.md) against a real migrated database: matching instead of
// duplicating, agent suggestions versus the person's confirmed records, proposals that wait
// for the person, tombstones that stop a dismissed suggestion coming back, and links to assets.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

import { recordType } from "../../domain/life-admin/record-types";
import {
  confirmRecord,
  createRecord,
  getRecordForUser,
  listDueForReminder,
  listRecordsForUser,
} from "../db/life-admin-records";
import { dismissRecordWithFiles } from "../storage/receipt-files";
import { createInMemoryBlobStore } from "../storage/blob";
import { createUser } from "../db/users";
import { freshDb } from "../../test/db";
import type { Db } from "../db/index";
import { acceptPendingChange, changeRecord, declinePendingChange, saveTypedRecord } from "./record-service";

const NOW = new Date("2026-11-23T01:00:00Z");
const person = { kind: "person" as const };
const agent = (agentId = "agent-chatgpt") => ({ kind: "agent" as const, agentId });
const type = (id: string) => recordType(id)!;

async function setup(): Promise<{ db: Db; userId: string; dek: Uint8Array }> {
  const db = await freshDb();
  const user = await createUser(db, { email: `${randomBytes(4).toString("hex")}@warthog.com.au`, wrappedDek: "d3JhcHBlZA==" });
  return { db, userId: user.id, dek: randomBytes(32) };
}

test("an agent's save is a typed suggestion with its provenance; the person's is confirmed", async () => {
  const { db, userId, dek } = await setup();
  try {
    const found = { service: "google-gmail", messageId: "18c2", sender: "service.nsw.gov.au", date: "2026-10-02", seenByWarthog: true };
    const byAgent = await saveTypedRecord(db, dek, userId, agent(), { type: type("vehicle.registration"), fields: { plate: "BX12AB", state: "NSW", expiry: "2026-12-14" }, foundIn: found }, NOW);
    assert.equal(byAgent.action, "created");
    if (byAgent.action === "skipped") throw new Error("unreachable");
    assert.equal(byAgent.record.reviewState, "suggested");
    assert.equal(byAgent.record.type, "vehicle.registration");
    assert.equal(byAgent.record.kind, "item", "the plaintext kind never names the category");
    assert.equal(byAgent.record.dueDate, "2026-12-14", "the expiry became the due date");
    assert.deepEqual(byAgent.record.reminderOffsets, [30, 7], "the type's reminder schedule");

    const stored = await getRecordForUser(db, userId, byAgent.record.id, dek);
    assert.deepEqual(stored?.foundIn, found);
    assert.deepEqual(stored?.changedBy, agent());

    const byPerson = await saveTypedRecord(db, dek, userId, person, { type: type("health.insurance"), fields: { provider: "Bupa", reference: "4012345678" } }, NOW);
    if (byPerson.action === "skipped") throw new Error("unreachable");
    assert.equal(byPerson.record.reviewState, "confirmed");
  } finally { await db.close(); }
});

test("saving the same thing again updates it instead of adding a copy", async () => {
  const { db, userId, dek } = await setup();
  try {
    const first = await saveTypedRecord(db, dek, userId, agent(), { type: type("vehicle.insurance"), fields: { insurer: "AAMI", policy_number: "MPA-2045", premium: "1100" } }, NOW);
    const second = await saveTypedRecord(db, dek, userId, agent(), { type: type("vehicle.insurance"), fields: { provider: "aami", reference: "mpa 2045", amount: "1250.50" }, dueDate: "2027-01-20" }, NOW);
    assert.equal(first.action, "created");
    assert.equal(second.action, "updated");
    const records = await listRecordsForUser(db, userId, dek);
    assert.equal(records.length, 1);
    assert.equal(records[0]!.fields.amount, "1250.50");
    assert.equal(records[0]!.dueDate, "2027-01-20");

    const again = await saveTypedRecord(db, dek, userId, agent(), { type: type("vehicle.insurance"), fields: { provider: "aami", reference: "mpa 2045", amount: "1250.50" } }, NOW);
    assert.equal(again.action, "unchanged", "the same values change nothing");
    const another = await saveTypedRecord(db, dek, userId, agent(), { type: type("vehicle.insurance"), fields: { provider: "AAMI", reference: "MPA-2045" }, onMatch: "create" }, NOW);
    assert.equal(another.action, "created");
  } finally { await db.close(); }
});

test("an agent's change to a confirmed record waits for the person", async () => {
  const { db, userId, dek } = await setup();
  try {
    const saved = await saveTypedRecord(db, dek, userId, person, { type: type("money.super"), fields: { provider: "AustralianSuper", reference: "1234567" } }, NOW);
    if (saved.action === "skipped") throw new Error("unreachable");

    const proposed = await saveTypedRecord(db, dek, userId, agent(), { type: type("money.super"), fields: { provider: "AustralianSuper", reference: "1234567", employer: "Acme" } }, NOW);
    assert.equal(proposed.action, "proposed");
    let stored = await getRecordForUser(db, userId, saved.record.id, dek);
    assert.equal(stored?.fields.employer, undefined, "the confirmed record is untouched");
    assert.deepEqual(stored?.pending?.set, { employer: "Acme" });
    assert.equal(stored?.pending?.byAgentId, "agent-chatgpt");

    const byId = await changeRecord(db, dek, stored!, agent(), { set: { provider: "Hostplus" } }, NOW);
    assert.equal(byId.action, "proposed", "a change by id is held too");

    assert.equal(await declinePendingChange(db, userId, saved.record.id), true);
    stored = await getRecordForUser(db, userId, saved.record.id, dek);
    assert.equal(stored?.pending, null);
    assert.equal(stored?.fields.provider, "AustralianSuper");

    await changeRecord(db, dek, stored!, agent(), { set: { employer: "Acme" } }, NOW);
    const accepted = await acceptPendingChange(db, dek, userId, saved.record.id);
    assert.equal(accepted?.fields.employer, "Acme");
    assert.equal(accepted?.reviewState, "confirmed");
    assert.equal(accepted?.pending, null);
    assert.deepEqual(accepted?.changedBy, person);
  } finally { await db.close(); }
});

test("an agent refines its own suggestion directly, and the record says it changed it", async () => {
  const { db, userId, dek } = await setup();
  try {
    const saved = await saveTypedRecord(db, dek, userId, agent("a1"), { type: type("subscription.service"), fields: { name: "Netflix", amount: "18.99", cycle: "monthly" } }, NOW);
    if (saved.action === "skipped") throw new Error("unreachable");
    const changed = await changeRecord(db, dek, saved.record, agent("a2"), { set: { amount: "22.99" }, remove: ["cycle"] }, NOW);
    assert.equal(changed.action, "updated");
    if (changed.action === "refused") throw new Error("unreachable");
    assert.equal(changed.record.fields.amount, "22.99");
    assert.equal(changed.record.fields.cycle, undefined);
    assert.equal(changed.record.reviewState, "suggested");
    assert.deepEqual(changed.record.changedBy, agent("a2"));
    assert.deepEqual(changed.record.source, agent("a1"), "who first saved it is kept");
  } finally { await db.close(); }
});

test("the person's edit confirms a suggestion; confirming leaves it theirs", async () => {
  const { db, userId, dek } = await setup();
  try {
    const one = await saveTypedRecord(db, dek, userId, agent(), { type: type("utility.energy"), fields: { retailer: "AGL", account_number: "88123" } }, NOW);
    const two = await saveTypedRecord(db, dek, userId, agent(), { type: type("utility.internet"), fields: { provider: "Aussie Broadband", reference: "AB-1" } }, NOW);
    if (one.action === "skipped" || two.action === "skipped") throw new Error("unreachable");
    const edited = await changeRecord(db, dek, one.record, person, { set: { plan: "Value Saver" } }, NOW);
    if (edited.action === "refused") throw new Error("unreachable");
    assert.equal(edited.record.reviewState, "confirmed");
    assert.equal(await confirmRecord(db, userId, two.record.id), true);
    assert.equal((await getRecordForUser(db, userId, two.record.id, dek))?.reviewState, "confirmed");
    assert.equal(await confirmRecord(db, userId, two.record.id), false, "only a suggestion can be confirmed");
  } finally { await db.close(); }
});

test("a dismissed suggestion is not added again by an agent, but the person can still add it", async () => {
  const { db, userId, dek } = await setup();
  try {
    const blob = createInMemoryBlobStore();
    const saved = await saveTypedRecord(db, dek, userId, agent(), { type: type("subscription.membership"), fields: { provider: "Evil Gym", reference: "EG-1", notes: "fake" } }, NOW);
    if (saved.action === "skipped") throw new Error("unreachable");
    assert.equal(await dismissRecordWithFiles(db, blob, { userId, recordId: saved.record.id }, dek), true);
    assert.equal((await listRecordsForUser(db, userId, dek)).length, 0, "a tombstone is never listed");
    assert.equal(await getRecordForUser(db, userId, saved.record.id, dek), null);

    const tombstone = (await db.query("SELECT fields, due_date, review_state FROM life_admin_records WHERE id = $1", [saved.record.id])).rows[0];
    assert.equal(tombstone?.review_state, "dismissed");
    assert.equal(tombstone?.due_date, null);

    const rescan = await saveTypedRecord(db, dek, userId, agent("another"), { type: type("subscription.membership"), fields: { provider: "Evil Gym", reference: "EG-1" } }, NOW);
    assert.equal(rescan.action, "skipped");
    const own = await saveTypedRecord(db, dek, userId, person, { type: type("subscription.membership"), fields: { provider: "Evil Gym", reference: "EG-1" } }, NOW);
    assert.equal(own.action, "created");
  } finally { await db.close(); }
});

test("a record links only to the person's own asset of an allowed type", async () => {
  const { db, userId, dek } = await setup();
  try {
    const bike = await saveTypedRecord(db, dek, userId, person, { type: type("vehicle.vehicle"), fields: { name: "Honda CB500X", plate: "BX12AB" } }, NOW);
    const pet = await saveTypedRecord(db, dek, userId, person, { type: type("pet.pet"), fields: { name: "Biscuit" } }, NOW);
    if (bike.action === "skipped" || pet.action === "skipped") throw new Error("unreachable");

    const rego = await saveTypedRecord(db, dek, userId, agent(), { type: type("vehicle.registration"), fields: { plate: "BX12AB" }, parentId: bike.record.id }, NOW);
    if (rego.action === "skipped") throw new Error("unreachable");
    assert.equal(rego.record.parentId, bike.record.id);

    const wrong = await saveTypedRecord(db, dek, userId, agent(), { type: type("vehicle.service"), fields: {}, parentId: pet.record.id }, NOW);
    if (wrong.action === "skipped") throw new Error("unreachable");
    assert.equal(wrong.record.parentId, null);
    assert.ok(wrong.problems.some((problem) => problem.startsWith("Not linked")));

    const other = await setup();
    try {
      const foreign = await saveTypedRecord(other.db, other.dek, other.userId, person, { type: type("vehicle.service"), fields: {}, parentId: bike.record.id }, NOW);
      if (foreign.action === "skipped") throw new Error("unreachable");
      assert.equal(foreign.record.parentId, null, "another person's record is never a parent");
    } finally { await other.db.close(); }
  } finally { await db.close(); }
});

test("a match the agent can't see is left alone and a separate record is made", async () => {
  const { db, userId, dek } = await setup();
  try {
    const hidden = await saveTypedRecord(db, dek, userId, person, { type: type("health.insurance"), fields: { provider: "Bupa", reference: "401" } }, NOW);
    if (hidden.action === "skipped") throw new Error("unreachable");
    const seen = await saveTypedRecord(db, dek, userId, agent(), { type: type("health.insurance"), fields: { provider: "Bupa", reference: "401", scale: "family" }, canSee: (record) => record.id !== hidden.record.id }, NOW);
    assert.equal(seen.action, "created");
    assert.equal((await getRecordForUser(db, userId, hidden.record.id, dek))?.pending, null);
  } finally { await db.close(); }
});

test("a record saved before types reads as its kind and keeps its free-form status", async () => {
  const { db, userId, dek } = await setup();
  try {
    const legacy = await createRecord(db, { userId, kind: "subscription", fields: { name: "Stan", service: "Stan" }, status: "price_changed", source: agent() }, dek);
    assert.equal(legacy.type, null);
    const changed = await changeRecord(db, dek, legacy, agent(), { set: { amount: "12" }, status: "trial" }, NOW);
    if (changed.action === "refused") throw new Error("unreachable");
    assert.equal(changed.record.status, "trial");
    assert.equal(changed.record.type, "subscription.service", "a change gives an older record its type");
  } finally { await db.close(); }
});

test("reminders skip dismissed, cancelled and long-overdue records", async () => {
  const { db, userId, dek } = await setup();
  try {
    const clock = { now: () => new Date("2026-11-23T01:00:00Z") };
    const due = (offsetDays: number) => new Date(Date.UTC(2026, 10, 23 + offsetDays)).toISOString().slice(0, 10);
    const live = await createRecord(db, { userId, kind: "item", fields: {}, dueDate: due(1), status: "active", source: person }, dek);
    await createRecord(db, { userId, kind: "item", fields: {}, dueDate: due(1), status: "cancelled", source: person }, dek);
    await createRecord(db, { userId, kind: "item", fields: {}, dueDate: due(-400), status: "active", source: person }, dek);
    const recent = await createRecord(db, { userId, kind: "item", fields: {}, dueDate: due(-2), status: "active", source: person }, dek);
    const gone = await saveTypedRecord(db, dek, userId, agent(), { type: type("general.other"), fields: { name: "x" }, dueDate: due(1) }, NOW);
    if (gone.action === "skipped") throw new Error("unreachable");
    await dismissRecordWithFiles(db, createInMemoryBlobStore(), { userId, recordId: gone.record.id }, dek);
    const ids = new Set((await listDueForReminder(db, clock)).map((reminder) => reminder.recordId));
    assert.deepEqual([...ids].sort(), [live.id, recent.id].sort());
  } finally { await db.close(); }
});
