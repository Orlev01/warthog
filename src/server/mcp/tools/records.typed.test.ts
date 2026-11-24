// Typed life-admin records through the MCP record tools (docs/adr/life-admin-profile.md):
// typed and batched saves, parent links within a batch, refusals that never echo a value,
// filtered and labelled reads with monthly totals, and provenance Warthog checks itself.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";

import { createListRecordsTool, createSaveRecordTool, createUpdateRecordTool, saveRecordSchema, updateRecordSchema } from "./records";
import { listRecordsForUser } from "../../db/life-admin-records";
import { createUser } from "../../db/users";
import { createAgent } from "../../db/agents";
import { upsertPermissions } from "../../db/agent-permissions";
import { recordReadExposure } from "../../db/read-exposures";
import { freshDb } from "../../../test/db";
import { localAesKeyWrapper } from "../../crypto/key-wrapper";
import { fixedClock } from "../../seams/clock";
import type { AgentConnection } from "../context";
import type { Db } from "../../db/index";

const NOW = new Date("2026-11-23T01:00:00.000Z");
const clock = fixedClock(NOW);

async function setup(options: { recordIds?: string[] } = {}) {
  const db = await freshDb();
  const keyWrapper = localAesKeyWrapper(randomBytes(32));
  const dek = randomBytes(32);
  const user = await createUser(db, { email: `${randomUUID()}@warthog.com.au`, wrappedDek: await keyWrapper.wrap(dek) });
  const connectionId = randomUUID();
  const agent = await createAgent(db, { userId: user.id, connectionId, displayName: "ChatGPT", platform: "chatgpt" }, clock);
  await upsertPermissions(db, {
    userId: user.id, connectionId, grantedConnectors: [], readTools: true, changeTools: "allow", identityAccess: true,
    highTierAccess: false, cardAccess: false, cardBudget: null, skillsScope: [], memoryRead: true, sharing: false,
    rulesScope: [], rateLimit: 120, recordsAccess: true,
    ...(options.recordIds ? { resourceControls: { recordIds: options.recordIds } } : {}),
  } as Parameters<typeof upsertPermissions>[1]);
  const connection = { userId: user.id, connectionId, agentId: agent.id, active: true } as unknown as AgentConnection;
  const deps = { db, keyWrapper, clock };
  return { db, dek, connection, userId: user.id, agentId: agent.id, save: createSaveRecordTool(deps), list: createListRecordsTool(deps), update: createUpdateRecordTool(deps) };
}

async function closing(db: Db, body: () => Promise<void>) {
  try { await body(); } finally { await db.close(); }
}

test("a batch saves a vehicle with its rego and insurance, linked by ref, as suggestions", async () => {
  const t = await setup();
  await closing(t.db, async () => {
    const result = await t.save.handle({
      records: [
        { ref: "bike", type: "vehicles.vehicle", fields: { name: "Honda CB500X", body: "motorcycle", plate: "BX12AB", state: "NSW" } },
        { parentRef: "bike", type: "vehicles.registration", fields: { plate: "BX12AB", expiry: "2026-12-14", renewal_cost: "412" }, source: { service: "gmail", sender: "noreply@service.nsw.gov.au", date: "2026-10-02" } },
        { parentRef: "bike", type: "vehicles.insurance", fields: { insurer: "AAMI", policy_number: "MPA-2045" }, dueDate: "2027-01-20" },
      ],
    }, t.connection);
    assert.equal(result.status, "ok");
    if (result.status !== "ok") return;
    assert.deepEqual(result.results.map((item) => item.action), ["created", "created", "created"]);
    const records = await listRecordsForUser(t.db, t.userId, t.dek);
    const bike = records.find((record) => record.type === "vehicles.vehicle")!;
    const rego = records.find((record) => record.type === "vehicles.registration")!;
    assert.equal(rego.parentId, bike.id);
    assert.equal(rego.dueDate, "2026-12-14");
    assert.equal(rego.reviewState, "suggested");
    assert.deepEqual(rego.foundIn, { service: "gmail", date: "2026-10-02", sender: "service.nsw.gov.au", seenByWarthog: false });

    const again = await t.save.handle({ type: "vehicles.insurance", fields: { provider: "AAMI", reference: "MPA-2045", premium: "1250.50", cycle: "yearly" } }, t.connection);
    assert.equal(again.status, "saved");
    if (again.status === "saved") assert.equal(again.action, "updated", "a second scan updates the same policy");
    assert.equal((await listRecordsForUser(t.db, t.userId, t.dek)).length, 3);
  });
});

test("a receipt bought for a trip and a business's subscription are saved under them, and list_records finds them by parent", async () => {
  const t = await setup();
  await closing(t.db, async () => {
    const result = await t.save.handle({
      records: [
        { ref: "qt", type: "travel.trip", fields: { name: "Queenstown, Aug 2026", destination: "Queenstown" } },
        { parentRef: "qt", type: "belongings.receipt", fields: { provider: "Airalo", item: "New Zealand 3 GB, 7 days", order_number: "97207280", amount: "14.50", currency: "AUD" } },
        { ref: "nava", type: "business.entity", fields: { name: "NAVA" } },
        { parentRef: "nava", type: "subscriptions.service", fields: { name: "GitHub Team", provider: "GitHub", amount: "16", currency: "USD", cycle: "monthly" } },
      ],
    }, t.connection);
    assert.equal(result.status, "ok");
    if (result.status !== "ok") return;
    assert.deepEqual(result.results.map((item) => item.problems ?? []), [[], [], [], []], "nothing refused the links");
    const [trip, , business] = result.results.map((item) => item.id!);
    const underTrip = await t.list.handle({ parentId: trip }, t.connection);
    assert.equal(underTrip.status, "ok");
    if (underTrip.status === "ok" && "records" in underTrip) assert.deepEqual(underTrip.records.map((record) => record.type).sort(), ["belongings.receipt", "travel.trip"]);
    const underBusiness = await t.list.handle({ parentId: business }, t.connection);
    if (underBusiness.status === "ok" && "records" in underBusiness) assert.deepEqual(underBusiness.records.map((record) => record.type).sort(), ["business.entity", "subscriptions.service"]);
  });
});

test("values that must never be kept are refused at the schema, naming the field but not the value", () => {
  for (const fields of [{ tfn: "123456782" }, { notes: "My TFN is 123 456 782" }, { notes: "Medicare 2123 45670 1" }, { passport_number: "PA1234567" }, { bsb: "062-000" }, { notes: "password: hunter2" }]) {
    const parsed = saveRecordSchema.safeParse({ type: "other.item", fields });
    assert.equal(parsed.success, false, JSON.stringify(fields));
    const messages = parsed.error!.issues.map((issue) => issue.message).join(" ");
    for (const value of Object.values(fields)) assert.ok(!messages.includes(value), "the refusal never repeats the value");
  }
  const batch = saveRecordSchema.safeParse({ records: [{ type: "id.passport", fields: { country: "Australia" } }, { type: "id.passport", fields: { country: "NZ", notes: "number LA1234567" } }] });
  assert.equal(batch.success, false);
  assert.deepEqual(batch.error!.issues[0]!.path, ["records", 1, "fields", "notes"]);
  assert.equal(updateRecordSchema.safeParse({ id: "x", set: { pin: "4821" } }).success, false);
  assert.equal(updateRecordSchema.safeParse({ id: "x", set: { pin: null } }).success, true, "removing a field is always allowed");
  assert.equal(saveRecordSchema.safeParse({ type: "health.insurance", fields: { provider: "Bupa", reference: "4012345678" } }).success, true, "a membership number is fine");
});

test("list_records filters, labels and totals what an agent asks about", async () => {
  const t = await setup();
  await closing(t.db, async () => {
    await t.save.handle({
      records: [
        { type: "vehicles.registration", fields: { plate: "BX12AB" }, dueDate: "2026-12-14" },
        { type: "health.insurance", fields: { provider: "Bupa", reference: "401", hospital_cover: "silver plus" }, dueDate: "2027-04-01" },
        { type: "subscriptions.service", fields: { name: "Netflix", amount: "18.99", cycle: "monthly", currency: "AUD" } },
        { type: "subscriptions.service", fields: { name: "Domain renewal", amount: "120", cycle: "yearly", currency: "AUD" } },
        { type: "subscriptions.service", fields: { name: "Old gym" }, status: "cancelled" },
      ],
    }, t.connection);

    const rego = await t.list.handle({ category: "vehicles" }, t.connection);
    assert.equal(rego.status, "ok");
    if (rego.status !== "ok") return;
    assert.equal(rego.today, "2026-11-23");
    assert.equal(rego.records.length, 1);
    const [view] = rego.records;
    assert.equal(view!.typeLabel, "Registration");
    assert.deepEqual(view!.due, { date: "2026-12-14", means: "expires", label: "Expires", inDays: 21 });
    assert.equal(view!.checkedByPerson, false);
    assert.equal(view!.labels.plate, "Number plate");
    assert.deepEqual(view!.savedBy, { kind: "you" });

    const subs = await t.list.handle({ category: "subscriptions" }, t.connection);
    if (subs.status !== "ok") throw new Error("refused");
    assert.equal(subs.records.length, 2, "cancelled ones are left out by default");
    assert.deepEqual(subs.monthlyCost, [{ currency: "AUD", amount: 28.99, records: 2 }]);
    const all = await t.list.handle({ category: "subscriptions", include: "all" }, t.connection);
    if (all.status === "ok") assert.equal(all.records.length, 3);

    const insurance = await t.list.handle({ type: "*.insurance" }, t.connection);
    if (insurance.status === "ok") assert.deepEqual(insurance.records.map((record) => record.type), ["health.insurance"]);
    const soon = await t.list.handle({ dueWithinDays: 60 }, t.connection);
    if (soon.status === "ok") assert.deepEqual(soon.records.map((record) => record.type), ["vehicles.registration"]);
    const found = await t.list.handle({ query: "silver bupa" }, t.connection);
    if (found.status === "ok") assert.equal(found.records.length, 1);
  });
});

test("list_records pages with a cursor and refuses one it didn't issue", async () => {
  const t = await setup();
  await closing(t.db, async () => {
    await t.save.handle({ records: Array.from({ length: 5 }, (_, index) => ({ type: "other.item", fields: { name: `Thing ${index}` }, dueDate: `2027-01-0${index + 1}` })) }, t.connection);
    const first = await t.list.handle({ limit: 2 }, t.connection);
    if (first.status !== "ok") throw new Error("refused");
    assert.equal(first.records.length, 2);
    const second = await t.list.handle({ limit: 2, cursor: first.nextCursor! }, t.connection);
    const third = second.status === "ok" ? await t.list.handle({ limit: 2, cursor: second.nextCursor! }, t.connection) : second;
    const names = [first, second, third].flatMap((page) => (page.status === "ok" ? page.records.map((record) => record.name) : []));
    assert.deepEqual(names, ["Thing 0", "Thing 1", "Thing 2", "Thing 3", "Thing 4"]);
    if (third.status === "ok") assert.equal(third.nextCursor, null);
    assert.equal((await t.list.handle({ cursor: "not-a-cursor" }, t.connection)).status, "refused");
  });
});

test("Warthog marks a source it saw: the agent had just read mail from that sender through it", async () => {
  const t = await setup();
  await closing(t.db, async () => {
    await recordReadExposure(t.db, { userId: t.userId, agentId: t.agentId, source: { service: "google-gmail", kind: "email", sender: "renewals@aami.com.au" }, at: new Date(NOW.getTime() - 60_000) }, t.dek);
    await t.save.handle({ type: "vehicles.insurance", fields: { provider: "AAMI", reference: "P1" }, source: { service: "gmail", sender: "aami.com.au" } }, t.connection);
    await t.save.handle({ type: "vehicles.insurance", fields: { provider: "Youi", reference: "P2" }, source: { service: "gmail", sender: "youi.com.au" } }, t.connection);
    const views = await t.list.handle({ category: "vehicles" }, t.connection);
    if (views.status !== "ok") throw new Error("refused");
    const byProvider = Object.fromEntries(views.records.map((record) => [record.fields.provider, record.foundIn?.readThroughWarthog]));
    assert.deepEqual(byProvider, { AAMI: true, Youi: false });
  });
});

test("an agent limited to chosen records sees only those and its own, and can't change the rest", async () => {
  const t = await setup({ recordIds: [] });
  await closing(t.db, async () => {
    const own = await t.save.handle({ type: "other.item", fields: { name: "Mine" } }, t.connection);
    assert.equal(own.status, "saved");
    const { createRecord } = await import("../../db/life-admin-records");
    const hidden = await createRecord(t.db, { userId: t.userId, kind: "item", type: "investing.super", fields: { provider: "Hostplus" }, status: "active", source: { kind: "person" } }, t.dek);
    const listed = await t.list.handle({}, t.connection);
    if (listed.status === "ok") assert.deepEqual(listed.records.map((record) => record.name), ["Mine"]);
    assert.equal((await t.update.handle({ id: hidden.id, set: { provider: "x" } }, t.connection)).status, "refused");
  });
});

test("update_record links only to a parent this agent may see", async () => {
  const t = await setup({ recordIds: [] });
  await closing(t.db, async () => {
    const { createRecord } = await import("../../db/life-admin-records");
    const hiddenBike = await createRecord(t.db, { userId: t.userId, kind: "item", type: "vehicles.vehicle", fields: { plate: "ZZ99" }, status: "active", source: { kind: "person" } }, t.dek);
    const rego = await t.save.handle({ type: "vehicles.registration", fields: { plate: "ZZ99" } }, t.connection);
    if (rego.status !== "saved") throw new Error("not saved");
    assert.equal((await t.update.handle({ id: rego.id, parentId: hiddenBike.id }, t.connection)).status, "refused");
  });
});

test("a trip takes its dates from its bookings for agents too, so a past trip is finished, not upcoming", async () => {
  const t = await setup();
  await closing(t.db, async () => {
    const saved = await t.save.handle({
      records: [
        { ref: "qt", type: "travel.trip", fields: { name: "Queenstown, Aug 2026", destination: "Queenstown" } },
        { parentRef: "qt", type: "travel.stay", fields: { provider: "Goodstays", reference: "HMQ5", starts_at: "2026-08-27[Pacific/Auckland]", ends_at: "2026-08-31[Pacific/Auckland]" } },
      ],
    }, t.connection);
    assert.equal(saved.status, "ok");
    const live = await t.list.handle({ type: "travel.trip" }, t.connection);
    assert.equal(live.status, "ok");
    if (live.status === "ok" && "records" in live) assert.equal(live.records.length, 0, "a trip whose bookings are over isn't live");
    const all = await t.list.handle({ type: "travel.trip", include: "all" }, t.connection);
    if (all.status === "ok" && "records" in all) {
      const trip = all.records[0] as unknown as { phase: { phase: string; live: boolean } };
      assert.equal(trip.phase.phase, "completed");
      assert.equal(trip.phase.live, false);
    } else assert.fail("expected records");
  });
});

test("Warthog's check needs the same sender domain, not a part of it, and the same address on a shared mail domain", async () => {
  const t = await setup();
  await closing(t.db, async () => {
    const read = (sender: string) => recordReadExposure(t.db, { userId: t.userId, agentId: t.agentId, source: { service: "google-gmail", kind: "email", sender }, at: new Date(NOW.getTime() - 60_000) }, t.dek);
    await read("noreply@ato.gov.au");
    await read("friend@gmail.com");
    const save = (name: string, sender: string) => t.save.handle({ type: "other.item", fields: { name }, source: { service: "gmail", sender } }, t.connection);
    await save("Part of a domain", "gov.au");
    await save("Same domain", "ato.gov.au");
    await save("Anyone on gmail", "gmail.com");
    await save("Same gmail address", "friend@gmail.com");
    const views = await t.list.handle({}, t.connection);
    if (views.status !== "ok") throw new Error("refused");
    const byName = Object.fromEntries(views.records.map((record) => [record.name, record.foundIn?.readThroughWarthog]));
    assert.deepEqual(byName, { "Part of a domain": false, "Same domain": true, "Anyone on gmail": false, "Same gmail address": true });
  });
});
