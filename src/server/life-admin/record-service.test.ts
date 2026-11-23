// Saving and changing life-admin records (`./record-service.ts`) against a real migrated database:
// matching instead of duplicating (including a booking that gains its reference later), agent
// suggestions versus the person's confirmed records, proposals that wait, tombstones, generic links
// (built-in and custom anchors), the journal on every item, stewards and hand-over, and declining
// a category of the person's own.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";

import { BUILT_IN, buildCatalogue, type Catalogue } from "../../domain/life-admin/catalogue";
import { createRecord, getRecordForUser, listDueForReminder, listRecordsForUser } from "../db/life-admin-records";
import { createCustomCategory, listCategoryRows } from "../db/life-admin-categories";
import { listJournal } from "../db/life-admin-journal";
import { createAgent } from "../db/agents";
import { dismissRecordWithFiles } from "../storage/receipt-files";
import { createInMemoryBlobStore } from "../storage/blob";
import { createUser } from "../db/users";
import { fixedClock } from "../seams/clock";
import { freshDb } from "../../test/db";
import type { Db } from "../db/index";
import {
  acceptPendingChange,
  changeRecord,
  confirmRecordFor,
  declineCustomCategory,
  declinePendingChange,
  saveTypedRecord,
  setStewardFor,
  type ServiceContext,
} from "./record-service";

const NOW = new Date("2026-11-23T01:00:00Z");
const SYD = "Australia/Sydney";
const person = { kind: "person" as const };
const type = (id: string, catalogue: Catalogue = BUILT_IN) => catalogue.type(id)!;

async function setup() {
  const db = await freshDb();
  const user = await createUser(db, { email: `${randomBytes(4).toString("hex")}@warthog.com.au`, wrappedDek: "d3JhcHBlZA==" });
  const dek = randomBytes(32);
  const agentOf = async (name: string) => (await createAgent(db, { userId: user.id, connectionId: randomUUID(), displayName: name, platform: "other" }, fixedClock(NOW))).id;
  const instinct = { kind: "agent" as const, agentId: await agentOf("Instinct") };
  const muse = { kind: "agent" as const, agentId: await agentOf("Muse") };
  const ctx = (overrides: Partial<ServiceContext> = {}): ServiceContext => ({ db, dek, userId: user.id, catalogue: BUILT_IN, zone: SYD, now: NOW, ...overrides });
  return { db, dek, userId: user.id, instinct, muse, ctx };
}

async function closing(db: Db, body: () => Promise<void>) {
  try { await body(); } finally { await db.close(); }
}

const created = <T extends { action: string; record?: unknown }>(outcome: T) => {
  if (outcome.action === "skipped" || outcome.action === "refused") throw new Error(`expected a record, got ${outcome.action}`);
  return outcome as T & { record: Awaited<ReturnType<typeof getRecordForUser>> & object };
};

test("an agent's save is a typed suggestion with its provenance and its kind's reminders", async () => {
  const t = await setup();
  await closing(t.db, async () => {
    const found = { service: "gmail", messageId: "18c2", sender: "service.nsw.gov.au", date: "2026-10-02", seenByWarthog: true };
    const saved = created(await saveTypedRecord(t.ctx(), t.instinct, { type: type("vehicles.registration"), fields: { plate: "BX12AB", state: "NSW", expiry: "2026-12-14" }, foundIn: found }));
    assert.equal(saved.action, "created");
    assert.equal(saved.record.reviewState, "suggested");
    assert.equal(saved.record.type, "vehicles.registration");
    assert.equal(saved.record.kind, "item", "the plaintext kind never names the category");
    assert.equal(saved.record.dueDate, "2026-12-14");
    assert.equal(saved.record.remindUntil, "2026-12-21");
    assert.deepEqual(saved.record.reminderOffsets, [30, 7]);
    const stored = await getRecordForUser(t.db, t.userId, saved.record.id, t.dek);
    assert.deepEqual(stored?.foundIn, found);
    const journal = await listJournal(t.db, t.userId, saved.record.id, t.dek);
    assert.deepEqual(journal.map((entry) => [entry.kind, entry.body.change?.event]), [["change", "created"]], "Warthog records the creation itself");
  });
});

test("saving the same thing again updates it; a booking matches before and after it gets its reference", async () => {
  const t = await setup();
  await closing(t.db, async () => {
    await saveTypedRecord(t.ctx(), t.instinct, { type: type("vehicles.insurance"), fields: { insurer: "AAMI", policy_number: "MPA-2045", premium: "1100" } });
    const again = await saveTypedRecord(t.ctx(), t.instinct, { type: type("vehicles.insurance"), fields: { provider: "aami", reference: "mpa 2045", amount: "1250.50" }, dueDate: "2027-01-20" });
    assert.equal(again.action, "updated");
    assert.equal((await saveTypedRecord(t.ctx(), t.instinct, { type: type("vehicles.insurance"), fields: { provider: "aami", reference: "mpa 2045", amount: "1250.50" } })).action, "unchanged");

    const dinner = type("outings.restaurant");
    const first = created(await saveTypedRecord(t.ctx(), t.muse, { type: dinner, fields: { provider: "Bistro", starts_at: "2026-12-03T19:30[Australia/Sydney]", party_size: "6" } }));
    assert.equal(first.record.dueDate, "2026-12-03", "a booking's due date is its local start date");
    assert.equal(first.record.state, "confirmed");
    const withRef = await saveTypedRecord(t.ctx(), t.muse, { type: dinner, fields: { provider: "Bistro", reference: "R-77", starts_at: "2026-12-03T19:30[Australia/Sydney]", party_size: "8" } });
    assert.equal(withRef.action, "updated", "provider + start date matched");
    const later = await saveTypedRecord(t.ctx(), t.muse, { type: dinner, fields: { provider: "Bistro", reference: "R-77", starts_at: "2026-12-03T20:00[Australia/Sydney]" }, status: "cancelled" });
    assert.equal(later.action, "updated", "provider + reference matched after the time moved");
    const [booking] = (await listRecordsForUser(t.db, t.userId, t.dek)).filter((record) => record.type === "outings.restaurant");
    assert.equal(booking!.state, "cancelled");
    assert.equal(booking!.status, "cancelled", "the plaintext status is only the coarse word");
    assert.equal(booking!.remindUntil, null, "a cancelled booking reminds no one");
  });
});

test("an agent's change to a confirmed record waits; accepting or declining is journaled", async () => {
  const t = await setup();
  await closing(t.db, async () => {
    const saved = created(await saveTypedRecord(t.ctx(), person, { type: type("investing.super"), fields: { provider: "AustralianSuper", reference: "1234567" } }));
    const proposed = await saveTypedRecord(t.ctx(), t.instinct, { type: type("investing.super"), fields: { provider: "AustralianSuper", reference: "1234567", employer: "Acme" } });
    assert.equal(proposed.action, "proposed");
    let stored = await getRecordForUser(t.db, t.userId, saved.record.id, t.dek);
    assert.equal(stored?.fields.employer, undefined);
    assert.deepEqual(stored?.pending?.set, { employer: "Acme" });
    assert.equal(await declinePendingChange(t.ctx(), saved.record.id), true);
    stored = await getRecordForUser(t.db, t.userId, saved.record.id, t.dek);
    await changeRecord(t.ctx(), stored!, t.instinct, { set: { employer: "Acme" } });
    const accepted = await acceptPendingChange(t.ctx(), saved.record.id);
    assert.equal(accepted?.fields.employer, "Acme");
    assert.equal(accepted?.reviewState, "confirmed");
    const events = (await listJournal(t.db, t.userId, saved.record.id, t.dek)).map((entry) => entry.body.change?.event).reverse();
    assert.deepEqual(events, ["created", "proposed", "declined", "proposed", "accepted"]);
  });
});

test("the journal: decisions and next steps make an agent the steward; a field-only save doesn't", async () => {
  const t = await setup();
  await closing(t.db, async () => {
    const scan = created(await saveTypedRecord(t.ctx(), t.muse, { type: type("vehicles.insurance"), fields: { provider: "Swann", reference: "S-1" } }));
    assert.equal(scan.record.steward, null, "an email scan doesn't make the agent the one handling it");

    const insurance = created(await saveTypedRecord(t.ctx(), t.instinct, {
      type: type("vehicles.insurance"),
      fields: { provider: "Swann", reference: "S-1", premium: "780" },
      dueDate: "2026-12-01",
      journal: { decision: "Chose Swann over Bikesure: $212/yr cheaper, same agreed value.", next: { text: "Get the roadworthy at Ryde Motorcycles", due: "2026-11-28" } },
    }));
    assert.equal(insurance.journal?.steward, "Instinct");
    let record = (await getRecordForUser(t.db, t.userId, insurance.record.id, t.dek))!;
    assert.equal(record.steward?.agentId, t.instinct.agentId);

    const nextId = insurance.journal!.added.find((entry) => entry.kind === "next")!.id;
    const decisionId = insurance.journal!.added.find((entry) => entry.kind === "decision")!.id;
    const takeover = await changeRecord(t.ctx({ now: new Date("2026-11-27T00:00:00Z") }), record, t.muse, {
      set: {},
      takeOver: true,
      journal: { decision: "Paid in the Swann app after the roadworthy passed.", replaces: decisionId, doneNextIds: [nextId] },
    });
    if (takeover.action === "refused") throw new Error("refused");
    assert.equal(takeover.journal?.tookOverFrom, "Instinct");
    record = (await getRecordForUser(t.db, t.userId, insurance.record.id, t.dek))!;
    assert.equal(record.steward?.agentId, t.muse.agentId);

    const journal = await listJournal(t.db, t.userId, record.id, t.dek);
    const steward = journal.find((entry) => entry.body.change?.event === "steward" && entry.body.change.from);
    assert.deepEqual(steward?.body.change, { event: "steward", from: "Instinct", to: "Muse" });
    assert.ok(journal.some((entry) => entry.kind === "next_done" && entry.refId === nextId));
    assert.ok(journal.some((entry) => entry.kind === "decision" && entry.refId === decisionId));

    // Finishing it keeps the whole log.
    await changeRecord(t.ctx(), record, person, { set: {}, status: "done" });
    const after = await listJournal(t.db, t.userId, record.id, t.dek);
    assert.ok(after.length >= journal.length + 1);

    const again = await changeRecord(t.ctx(), record, t.muse, { set: {}, journal: { doneNextIds: [nextId] } });
    assert.ok(again.action !== "refused" && again.problems.some((problem) => problem.includes("already")), "a step is closed once");
  });
});

test("the person assigns or clears who is handling an item", async () => {
  const t = await setup();
  await closing(t.db, async () => {
    const saved = created(await saveTypedRecord(t.ctx(), person, { type: type("government.fine"), fields: { provider: "Revenue NSW", reference: "F-1" } }));
    assert.equal(await setStewardFor(t.ctx(), saved.record, t.muse.agentId), true);
    const record = (await getRecordForUser(t.db, t.userId, saved.record.id, t.dek))!;
    assert.deepEqual([record.steward?.agentId, record.steward?.setBy], [t.muse.agentId, "person"]);
    assert.equal(await setStewardFor(t.ctx(), record, null), true);
    assert.equal((await getRecordForUser(t.db, t.userId, saved.record.id, t.dek))!.steward, null);
  });
});

test("links follow one rule: built-in and custom anchors, never another person's", async () => {
  const t = await setup();
  await closing(t.db, async () => {
    const bike = created(await saveTypedRecord(t.ctx(), person, { type: type("vehicles.vehicle"), fields: { name: "Honda CB500X", plate: "BX12AB" } }));
    const pet = created(await saveTypedRecord(t.ctx(), person, { type: type("pets.pet"), fields: { name: "Biscuit" } }));
    const rego = created(await saveTypedRecord(t.ctx(), t.instinct, { type: type("vehicles.registration"), fields: { plate: "BX12AB" }, parentId: bike.record.id }));
    assert.equal(rego.record.parentId, bike.record.id);
    const wrong = created(await saveTypedRecord(t.ctx(), t.instinct, { type: type("vehicles.service"), fields: {}, parentId: pet.record.id }));
    assert.equal(wrong.record.parentId, null);
    assert.ok(wrong.problems.some((problem) => problem.startsWith("Not linked")));

    const { slug } = await createCustomCategory(t.db, { userId: t.userId, state: "suggested", origin: t.instinct, definition: {
      label: "Rowing club", description: "Club", lifeArea: "everyday", icon: "trophy",
      kinds: [{ key: "shell", label: "Boat", lifecycle: "standing", use: "A boat.", anchor: true, fields: [{ key: "hull", label: "Hull", kind: "text" }], identity: ["hull"] }],
    } }, t.dek, fixedClock(NOW));
    const catalogue = buildCatalogue((await listCategoryRows(t.db, t.userId, t.dek)).custom);
    const shell = created(await saveTypedRecord(t.ctx({ catalogue }), t.instinct, { type: catalogue.type(`${slug}.shell`)!, fields: { hull: "Kestrel" } }));
    const cover = created(await saveTypedRecord(t.ctx({ catalogue }), t.instinct, { type: catalogue.type("insurance.other")!, fields: { provider: "Marine Co", reference: "M-1" }, parentId: shell.record.id }));
    assert.equal(cover.record.parentId, shell.record.id, "built-in insurance belongs to a custom anchor");

    const other = await setup();
    await closing(other.db, async () => {
      const foreign = created(await saveTypedRecord(other.ctx(), person, { type: type("vehicles.service"), fields: {}, parentId: bike.record.id }));
      assert.equal(foreign.record.parentId, null);
    });
  });
});

test("declining a custom category tombstones its suggestions, moves confirmed records, and unlinks", async () => {
  const t = await setup();
  await closing(t.db, async () => {
    const { slug } = await createCustomCategory(t.db, { userId: t.userId, state: "suggested", origin: t.instinct, definition: {
      label: "Rowing club", description: "Club", lifeArea: "everyday", icon: "trophy",
      kinds: [
        { key: "shell", label: "Boat", lifecycle: "standing", use: "A boat.", anchor: true, fields: [{ key: "hull", label: "Hull", kind: "text" }], identity: ["hull"] },
        { key: "fees", label: "Fees", lifecycle: "standing", use: "Fees.", fields: [] },
      ],
    } }, t.dek, fixedClock(NOW));
    let catalogue = buildCatalogue((await listCategoryRows(t.db, t.userId, t.dek)).custom);
    const shell = created(await saveTypedRecord(t.ctx({ catalogue }), t.instinct, { type: catalogue.type(`${slug}.shell`)!, fields: { hull: "Kestrel" } }));
    const fees = created(await saveTypedRecord(t.ctx({ catalogue }), person, { type: catalogue.type(`${slug}.fees`)!, fields: { name: "2027 fees" } }));
    assert.equal((await listCategoryRows(t.db, t.userId, t.dek)).custom[0]!.state, "active", "the person's own record keeps the category");
    const cover = created(await saveTypedRecord(t.ctx({ catalogue }), person, { type: catalogue.type("insurance.other")!, fields: { provider: "Marine Co", reference: "M-1" }, parentId: shell.record.id }));

    catalogue = buildCatalogue((await listCategoryRows(t.db, t.userId, t.dek)).custom);
    const result = await declineCustomCategory(t.ctx({ catalogue }), slug);
    assert.deepEqual(result, { declined: true, removed: 1, moved: 1 });
    const rows = await listCategoryRows(t.db, t.userId, t.dek);
    assert.deepEqual([rows.custom.length, rows.declined], [0, ["Rowing club"]]);
    assert.equal((await getRecordForUser(t.db, t.userId, fees.record.id, t.dek))?.type, "other.item");
    assert.equal((await getRecordForUser(t.db, t.userId, cover.record.id, t.dek))?.parentId, null, "a dismissed anchor's records are unlinked");
  });
});

test("a dismissed suggestion is not added again by an agent, and its journal goes with it", async () => {
  const t = await setup();
  await closing(t.db, async () => {
    const saved = created(await saveTypedRecord(t.ctx(), t.instinct, { type: type("subscriptions.membership"), fields: { provider: "Evil Gym", reference: "EG-1" }, journal: { note: "From an email." } }));
    assert.equal(await dismissRecordWithFiles(t.db, createInMemoryBlobStore(), { userId: t.userId, recordId: saved.record.id }, t.dek), true);
    assert.equal((await listRecordsForUser(t.db, t.userId, t.dek)).length, 0);
    assert.deepEqual(await listJournal(t.db, t.userId, saved.record.id, t.dek), [], "\"not mine\" removes its log");
    assert.equal((await saveTypedRecord(t.ctx(), t.muse, { type: type("subscriptions.membership"), fields: { provider: "Evil Gym", reference: "EG-1" } })).action, "skipped");
    assert.equal((await saveTypedRecord(t.ctx(), person, { type: type("subscriptions.membership"), fields: { provider: "Evil Gym", reference: "EG-1" } })).action, "created");
  });
});

test("a match the agent can't see is left alone; an older record keeps its free-form status", async () => {
  const t = await setup();
  await closing(t.db, async () => {
    const hidden = created(await saveTypedRecord(t.ctx(), person, { type: type("health.insurance"), fields: { provider: "Bupa", reference: "401" } }));
    const seen = await saveTypedRecord(t.ctx(), t.instinct, { type: type("health.insurance"), fields: { provider: "Bupa", reference: "401", scale: "family" }, canSee: (record) => record.id !== hidden.record.id });
    assert.equal(seen.action, "created");
    const legacy = await createRecord(t.db, { userId: t.userId, kind: "subscription", fields: { name: "Stan" }, status: "price_changed", source: t.instinct }, t.dek);
    const changed = await changeRecord(t.ctx(), legacy, t.instinct, { set: { amount: "12" }, status: "trial" });
    if (changed.action === "refused") throw new Error("refused");
    assert.equal(changed.record.status, "trial");
    assert.equal(changed.record.type, "subscriptions.service");
  });
});

test("reminders follow remind_until: none for dismissed, cancelled or long-past records; bookings until they start", async () => {
  const t = await setup();
  await closing(t.db, async () => {
    const clock = fixedClock(NOW);
    const day = (offset: number) => new Date(Date.UTC(2026, 10, 23 + offset)).toISOString().slice(0, 10);
    const live = created(await saveTypedRecord(t.ctx(), person, { type: type("other.item"), fields: { name: "a" }, dueDate: day(1) }));
    await saveTypedRecord(t.ctx(), person, { type: type("other.item"), fields: { name: "b" }, dueDate: day(1), status: "cancelled" });
    await saveTypedRecord(t.ctx(), person, { type: type("other.item"), fields: { name: "c" }, dueDate: day(-400) });
    const recent = created(await saveTypedRecord(t.ctx(), person, { type: type("other.item"), fields: { name: "d" }, dueDate: day(-2) }));
    const booking = created(await saveTypedRecord(t.ctx(), person, { type: type("outings.restaurant"), fields: { provider: "Bistro", starts_at: `${day(1)}T19:30[Australia/Sydney]` } }));
    const gone = created(await saveTypedRecord(t.ctx(), t.instinct, { type: type("other.item"), fields: { name: "e" }, dueDate: day(1) }));
    await dismissRecordWithFiles(t.db, createInMemoryBlobStore(), { userId: t.userId, recordId: gone.record.id }, t.dek);
    const ids = new Set((await listDueForReminder(t.db, clock)).map((reminder) => reminder.recordId));
    assert.deepEqual([...ids].sort(), [live.record.id, recent.record.id, booking.record.id].sort());
  });
});

test("confirming a record in a suggested category keeps the category", async () => {
  const t = await setup();
  await closing(t.db, async () => {
    const { slug } = await createCustomCategory(t.db, { userId: t.userId, state: "suggested", origin: t.instinct, definition: {
      label: "Rowing club", description: "Club", lifeArea: "everyday", icon: "trophy",
      kinds: [{ key: "fees", label: "Fees", lifecycle: "standing", use: "Fees.", fields: [] }],
    } }, t.dek, fixedClock(NOW));
    const catalogue = buildCatalogue((await listCategoryRows(t.db, t.userId, t.dek)).custom);
    const saved = created(await saveTypedRecord(t.ctx({ catalogue }), t.instinct, { type: catalogue.type(`${slug}.fees`)!, fields: { name: "Fees" } }));
    assert.equal(await confirmRecordFor(t.ctx({ catalogue }), saved.record.id), true);
    assert.equal((await listCategoryRows(t.db, t.userId, t.dek)).custom[0]!.state, "active");
  });
});
