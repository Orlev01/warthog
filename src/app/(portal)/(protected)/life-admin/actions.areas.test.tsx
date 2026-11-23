// Life admin's per-person categories, bookings and hand-over journal through the page actions
// (`./actions.ts`; docs/adr/life-admin-profile.md, life-admin-journal.md), against a real
// migrated database.
//
// The person's page loads their own catalogue: built-in categories show once they have
// records or the person chose Show, the ones they said are "not for me" stay hidden, and a
// category an agent suggested waits under To check with its reason, kinds and records. They
// keep or decline it (declining removes its suggested records and moves confirmed ones to
// "Something else"), show or hide a built-in one, add a note, decision or next step to any
// item (refused, naming the place and never the text, when it holds an identifier Warthog
// never keeps), mark a next step done, and say which agent is handling an item. An item's own
// page has the whole journal, finished items included. Every action is member-scoped, takes
// its ids from the boundary as uuids, and is audited with field names and ids only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";

import { createLifeAdminActions } from "./actions";
import { recordFields } from "./form-inputs";
import { createUser } from "@/server/db/users";
import { createAgent } from "@/server/db/agents";
import { getRecordForUser, listRecordsForUser } from "@/server/db/life-admin-records";
import { createCustomCategory, listCategoryRows } from "@/server/db/life-admin-categories";
import { addJournal, saveTypedRecord, type ServiceContext } from "@/server/life-admin/record-service";
import { listActivity } from "@/server/activity/list";
import { BUILT_IN, buildCatalogue, type Catalogue } from "@/domain/life-admin/catalogue";
import { createInMemoryBlobStore } from "@/server/storage/blob";
import { HttpError } from "@/server/http/validate";
import { localAesKeyWrapper, type KeyWrapper } from "@/server/crypto/key-wrapper";
import { fixedClock } from "@/server/seams/clock";
import { freshDb } from "@/test/db";
import type { Db } from "@/server/db/index";
import type { Session } from "@/server/auth/session";

const NOW = new Date("2026-11-23T01:00:00.000Z");
const clock = fixedClock(NOW);

type Ctx = { db: Db; keyWrapper: KeyWrapper; actions: ReturnType<typeof createLifeAdminActions> };
type Person = { userId: string; dek: Uint8Array; session: Session };

async function withDb(run: (ctx: Ctx) => Promise<void>): Promise<void> {
  const db = await freshDb();
  const keyWrapper = localAesKeyWrapper(randomBytes(32));
  try {
    await run({ db, keyWrapper, actions: createLifeAdminActions({ db, keyWrapper, clock, blob: createInMemoryBlobStore() }) });
  } finally {
    await db.close();
  }
}

async function person(ctx: Ctx, who: string): Promise<Person> {
  const dek = randomBytes(32);
  const user = await createUser(ctx.db, { email: `${who}-${randomUUID()}@warthog.com.au`, wrappedDek: await ctx.keyWrapper.wrap(dek) });
  return { userId: user.id, dek, session: { id: `sess-${user.id}`, userId: user.id, createdAt: NOW, lastSeenAt: NOW, steppedUpAt: null } };
}

async function agentOf(ctx: Ctx, me: Person, displayName: string, status: "connected" | "disconnected" = "connected") {
  const agent = await createAgent(ctx.db, { userId: me.userId, connectionId: randomUUID(), displayName, platform: "chatgpt", status }, clock);
  return { kind: "agent" as const, agentId: agent.id };
}

function service(ctx: Ctx, me: Person, catalogue: Catalogue = BUILT_IN): ServiceContext {
  return { db: ctx.db, dek: me.dek, userId: me.userId, catalogue, zone: "Australia/Sydney", now: NOW };
}

async function rejects4xx(label: string, fn: () => Promise<unknown>): Promise<void> {
  await assert.rejects(fn, (error: unknown) => error instanceof HttpError && error.status >= 400 && error.status < 500, label);
}

// The person's own audit entries: kind, the recorded changes and the linked records.
async function audit(ctx: Ctx, me: Person) {
  const entries = await listActivity(ctx.db, me.userId, {}, me.dek);
  const links = (await ctx.db.query("SELECT entry_seq, record_id FROM activity_entry_records WHERE user_id = $1", [me.userId])).rows;
  return entries
    .filter((entry) => entry.kind.startsWith("life_admin_"))
    .map((entry) => ({
      kind: entry.kind,
      changes: (entry.payload as { changes?: Record<string, unknown> }).changes ?? {},
      records: links.filter((row) => Number(row.entry_seq) === entry.seq).map((row) => row.record_id as string),
    }));
}

const ROWING = {
  label: "Rowing club",
  description: "Your rowing club membership and regattas.",
  lifeArea: "everyday" as const,
  icon: "trophy" as const,
  why: "Three emails from Sydney Rowing Club about fees and a regatta.",
  kinds: [
    { key: "membership", label: "Club membership", lifecycle: "standing" as const, use: "The membership.", fields: [{ key: "boat_rack", label: "Boat rack", kind: "text" as const }], identity: ["boat_rack"] },
    { key: "regatta", label: "Regatta", lifecycle: "booking" as const, use: "A regatta entry.", fields: [] },
  ],
};

async function suggestRowing(ctx: Ctx, me: Person, agentId: string): Promise<{ slug: string; catalogue: Catalogue }> {
  const { slug } = await createCustomCategory(ctx.db, { userId: me.userId, state: "suggested", origin: { kind: "agent", agentId }, definition: ROWING }, me.dek, clock);
  return { slug, catalogue: buildCatalogue((await listCategoryRows(ctx.db, me.userId, me.dek)).custom) };
}

// ─── the page's categories ───────────────────────────────────────────────────────────

test("load: built-in categories show once used or chosen, hidden ones stay hidden, and a suggested category waits with its reason, kinds and records", async () => {
  await withDb(async (ctx) => {
    const me = await person(ctx, "load-areas");
    const instinct = await agentOf(ctx, me, "Instinct");
    await ctx.actions.saveRecord(me.session, { type: "health.insurance", fields: { provider: "Medibank" } });
    await ctx.actions.setCategoryVisibility(me.session, { category: "pets", setting: "show" });
    await ctx.actions.setCategoryVisibility(me.session, { category: "legal", setting: "not_for_me" });
    const { slug, catalogue } = await suggestRowing(ctx, me, instinct.agentId);
    await saveTypedRecord(service(ctx, me, catalogue), instinct, { type: catalogue.type(`${slug}.membership`)!, fields: { provider: "Sydney Rowing Club", boat_rack: "B12" } });

    const data = await ctx.actions.load(me.session);
    const state = (id: string) => data.categories.find((category) => category.id === id);
    assert.deepEqual(state("health"), { id: "health", visibility: "shown", records: 1 });
    assert.deepEqual(state("pets"), { id: "pets", visibility: "shown", records: 0 }, "the person chose Show");
    assert.deepEqual(state("legal"), { id: "legal", visibility: "not_for_me", records: 0 });
    assert.deepEqual(state("vehicles"), { id: "vehicles", visibility: "available", records: 0 });
    assert.deepEqual(state(slug), { id: slug, visibility: "shown", records: 1 }, "their own category shows");
    assert.ok(data.catalogue.types.some((type) => type.id === `${slug}.regatta`), "the page's catalogue has their own kinds");
    assert.deepEqual(data.suggestedCategories, [{
      slug,
      label: "Rowing club",
      description: "Your rowing club membership and regattas.",
      suggestedBy: "Instinct",
      why: "Three emails from Sydney Rowing Club about fees and a regatta.",
      kinds: ["Club membership", "Regatta"],
      records: 1,
      suggestedRecords: 1,
      confirmedRecords: 0,
    }]);
    assert.equal(data.zone, "Australia/Sydney", "a person with no zone of their own reads in the account default");
  });
});

test("keepCategory keeps a suggested category; declineCategory removes its suggestions and moves what was confirmed to Something else", async () => {
  await withDb(async (ctx) => {
    const me = await person(ctx, "keep-decline");
    const other = await person(ctx, "keep-decline-other");
    const instinct = await agentOf(ctx, me, "Instinct");
    const { slug, catalogue } = await suggestRowing(ctx, me, instinct.agentId);
    const svc = service(ctx, me, catalogue);
    const suggested = await saveTypedRecord(svc, instinct, { type: catalogue.type(`${slug}.membership`)!, fields: { provider: "Sydney Rowing Club", boat_rack: "B12" } });
    const confirmed = await saveTypedRecord(svc, instinct, { type: catalogue.type(`${slug}.membership`)!, fields: { provider: "Mosman Rowing", boat_rack: "C3" } });
    await ctx.actions.confirmRecord(me.session, { id: confirmed.record!.id });
    // Confirming one of its records keeps the category already; decline it all the same.
    assert.deepEqual(await ctx.actions.keepCategory(other.session, { slug }), { ok: false, reason: "not_found" }, "another person's category is never touched");
    await rejects4xx("a slug that isn't one", () => ctx.actions.keepCategory(me.session, { slug: "rowing" }));

    const declined = await ctx.actions.declineCategory(me.session, { slug });
    assert.deepEqual(declined, { ok: true, outcome: "declined", count: 2 });
    const left = await listRecordsForUser(ctx.db, me.userId, me.dek);
    assert.deepEqual(left.map((record) => [record.type, record.fields.provider]), [["other.item", "Mosman Rowing"]], "the suggestion is gone, the confirmed one is kept as Something else");
    assert.equal(await getRecordForUser(ctx.db, me.userId, suggested.record!.id, me.dek), null);
    const data = await ctx.actions.load(me.session);
    assert.deepEqual(data.suggestedCategories, []);
    assert.ok(!data.catalogue.categories.some((category) => category.id === slug));
    const entries = await audit(ctx, me);
    assert.ok(entries.some((entry) => entry.kind === "life_admin_category_declined" && entry.changes.category === slug && entry.changes.removed === 1 && entry.changes.moved === 1));
  });
});

test("keepCategory makes a suggestion the person's own", async () => {
  await withDb(async (ctx) => {
    const me = await person(ctx, "keep");
    const instinct = await agentOf(ctx, me, "Instinct");
    const { slug } = await suggestRowing(ctx, me, instinct.agentId);
    assert.deepEqual(await ctx.actions.keepCategory(me.session, { slug }), { ok: true, outcome: "kept" });
    assert.deepEqual(await ctx.actions.keepCategory(me.session, { slug }), { ok: false, reason: "not_found" }, "already kept");
    assert.equal((await ctx.actions.load(me.session)).suggestedCategories.length, 0);
    assert.deepEqual((await audit(ctx, me)).map((entry) => [entry.kind, entry.changes]), [["life_admin_category_kept", { category: slug }]]);
  });
});

test("setCategoryVisibility shows, hides and clears a built-in category; an unknown one is a 4xx", async () => {
  await withDb(async (ctx) => {
    const me = await person(ctx, "visibility");
    assert.deepEqual(await ctx.actions.setCategoryVisibility(me.session, { category: "pets", setting: "show" }), { ok: true, outcome: "shown" });
    assert.deepEqual(await ctx.actions.setCategoryVisibility(me.session, { category: "pets", setting: "not_for_me" }), { ok: true, outcome: "hidden" });
    assert.equal((await ctx.actions.load(me.session)).categories.find((category) => category.id === "pets")!.visibility, "not_for_me");
    assert.deepEqual(await ctx.actions.setCategoryVisibility(me.session, { category: "pets", setting: "clear" }), { ok: true, outcome: "cleared" });
    assert.equal((await ctx.actions.load(me.session)).categories.find((category) => category.id === "pets")!.visibility, "available");
    await rejects4xx("not a built-in category", () => ctx.actions.setCategoryVisibility(me.session, { category: "x_7kq2mz", setting: "show" }));
    await rejects4xx("not a setting", () => ctx.actions.setCategoryVisibility(me.session, { category: "pets", setting: "maybe" }));
  });
});

// ─── bookings, date-times and lifecycle statuses ─────────────────────────────────────

test("a booking added from the form keeps its date-time in its own zone, takes a booking status, and its phase is worked out", async () => {
  await withDb(async (ctx) => {
    const me = await person(ctx, "booking-form");
    const form = new FormData();
    form.set("recordFormVersion", "2");
    form.set("field:provider", "Sushi Saito");
    form.set("field:starts_at", "2026-12-03T19:30");
    form.set("zone:starts_at", "Asia/Tokyo");
    form.set("field:party_size", "2 people");
    form.set("field:card_held", "yes");
    const saved = await ctx.actions.saveRecord(me.session, { type: "outings.restaurant", fields: recordFields(form), status: "pending" });
    assert.equal(saved.ok, true);
    const stored = (await getRecordForUser(ctx.db, me.userId, (saved as { recordId: string }).recordId, me.dek))!;
    assert.deepEqual(stored.fields, { provider: "Sushi Saito", starts_at: "2026-12-03T19:30+09:00[Asia/Tokyo]", party_size: "2", card_held: "yes" });
    assert.equal(stored.dueDate, "2026-12-03", "its start sets the due date");
    assert.equal(stored.state, "pending");
    const view = (await ctx.actions.load(me.session)).records[0]!;
    assert.deepEqual([view.phase?.phase, view.phase?.label, view.state], ["pending", "Waiting to be confirmed", "pending"]);
    await rejects4xx("a standing status on a booking", () => ctx.actions.saveRecord(me.session, { type: "outings.restaurant", fields: { provider: "X" }, status: "expired" }));
    await rejects4xx("a kind that isn't in the catalogue", () => ctx.actions.saveRecord(me.session, { type: "vehicle.registration", fields: { plate: "A" } }));
  });
});

test("load works out each record's phase and a trip's dates from its bookings; who is handling it and its next step; next steps due across items", async () => {
  await withDb(async (ctx) => {
    const me = await person(ctx, "phases");
    const instinct = await agentOf(ctx, me, "Instinct");
    const svc = service(ctx, me);
    const trip = await saveTypedRecord(svc, { kind: "person" }, { type: BUILT_IN.type("travel.trip")!, fields: { name: "Tokyo" } });
    await saveTypedRecord(svc, { kind: "person" }, { type: BUILT_IN.type("travel.flight")!, fields: { provider: "Qantas", reference: "QF25", starts_at: "2026-12-03T09:00+11:00[Australia/Sydney]" }, parentId: trip.record!.id });
    await saveTypedRecord(svc, { kind: "person" }, { type: BUILT_IN.type("travel.stay")!, fields: { provider: "Park Hyatt", reference: "PH1", starts_at: "2026-12-03T18:00+09:00[Asia/Tokyo]", ends_at: "2026-12-10T11:00+09:00[Asia/Tokyo]" }, parentId: trip.record!.id });
    const dinner = await saveTypedRecord(svc, { kind: "person" }, { type: BUILT_IN.type("outings.restaurant")!, fields: { provider: "Ester", starts_at: "2026-10-02T19:00+10:00[Australia/Sydney]" } });
    const insurance = await saveTypedRecord(svc, instinct, { type: BUILT_IN.type("vehicles.insurance")!, fields: { provider: "Swann", reference: "SW-1" }, dueDate: "2026-12-01", journal: { decision: "Swann, $212/yr cheaper", next: { text: "Book the roadworthy", due: "2026-11-28" } } });

    const data = await ctx.actions.load(me.session);
    const view = (id: string) => data.records.find((record) => record.id === id)!;
    assert.deepEqual([view(trip.record!.id).phase?.phase, view(trip.record!.id).phase?.starts, view(trip.record!.id).phase?.ends],
      ["upcoming", "2026-12-02T22:00:00.000Z", "2026-12-10T02:00:00.000Z"], "the trip spans its flight and stay");
    assert.equal(view(dinner.record!.id).phase?.bucket, "finished", "a dinner that's over is finished");
    assert.deepEqual(view(insurance.record!.id).handling, { steward: "Instinct", next: { id: data.nextSteps[0]!.id, text: "Book the roadworthy", due: "2026-11-28" } });
    assert.deepEqual(data.nextSteps.map((step) => [step.recordId, step.recordName, step.text, step.due]), [[insurance.record!.id, "Swann", "Book the roadworthy", "2026-11-28"]]);
  });
});

// ─── the journal: notes, decisions, next steps ───────────────────────────────────────

test("addJournalEntry adds a note, a decision and a next step with a due date; markNextDone closes the step", async () => {
  await withDb(async (ctx) => {
    const me = await person(ctx, "journal");
    const other = await person(ctx, "journal-other");
    const saved = (await ctx.actions.saveRecord(me.session, { type: "vehicles.insurance", fields: { provider: "Swann", reference: "SW-1" }, dueDate: "2026-12-01" })) as { recordId: string };
    const id = saved.recordId;
    assert.deepEqual(await ctx.actions.addJournalEntry(me.session, { id, kind: "decision", text: "Stay with Swann: $212 a year cheaper." }), { ok: true, outcome: "added", recordId: id, problems: [] });
    assert.equal((await ctx.actions.addJournalEntry(me.session, { id, kind: "note", text: "Called them on Friday." })).ok, true);
    assert.equal((await ctx.actions.addJournalEntry(me.session, { id, kind: "next", text: "Book the roadworthy", due: "2026-11-28" })).ok, true);
    let item = (await ctx.actions.loadItem(me.session, id))!;
    assert.deepEqual(item.decisions.map((entry) => [entry.text, entry.by]), [["Stay with Swann: $212 a year cheaper.", "You"]]);
    assert.deepEqual(item.notes.map((entry) => entry.text), ["Called them on Friday."]);
    assert.deepEqual(item.openSteps.map((entry) => [entry.text, entry.due]), [["Book the roadworthy", "2026-11-28"]]);
    assert.match(item.whereItStands, /^Swann · renews 1 Dec, in 8 days · decided: Stay with Swann: \$212 a year cheaper\. \(you, 23 Nov\) · next: Book the roadworthy, due 28 Nov · handled by no one · last touched today by you$/);

    assert.deepEqual(await ctx.actions.markNextDone(other.session, { id, stepId: item.openSteps[0]!.id }), { ok: false, reason: "not_found" }, "another person can't close it");
    assert.deepEqual(await ctx.actions.markNextDone(me.session, { id, stepId: randomUUID() }), { ok: false, reason: "not_found" }, "not a step on this record");
    assert.deepEqual(await ctx.actions.markNextDone(me.session, { id, stepId: item.openSteps[0]!.id }), { ok: true, outcome: "done", recordId: id });
    item = (await ctx.actions.loadItem(me.session, id))!;
    assert.deepEqual([item.openSteps.length, item.doneSteps.map((step) => [step.text, step.doneBy])], [0, [["Book the roadworthy", "You"]]]);

    await rejects4xx("an unknown entry kind", () => ctx.actions.addJournalEntry(me.session, { id, kind: "handover", text: "x" }));
    await rejects4xx("more than 280 characters", () => ctx.actions.addJournalEntry(me.session, { id, kind: "note", text: "a".repeat(281) }));
    await rejects4xx("an empty entry", () => ctx.actions.addJournalEntry(me.session, { id, kind: "note", text: "   " }));
    await rejects4xx("a malformed id", () => ctx.actions.addJournalEntry(me.session, { id: "1", kind: "note", text: "x" }));
    assert.deepEqual(await ctx.actions.addJournalEntry(other.session, { id, kind: "note", text: "Not yours" }), { ok: false, reason: "not_found" });

    const entries = await audit(ctx, me);
    const journal = entries.filter((entry) => entry.kind === "life_admin_journal_added");
    assert.deepEqual(journal.map((entry) => entry.changes), [{ recordId: id, entry: "next" }, { recordId: id, entry: "note" }, { recordId: id, entry: "decision" }], "the kind only, never the text");
    assert.ok(journal.every((entry) => entry.records.includes(id)), "each audit entry is linked to the record");
    assert.doesNotMatch(JSON.stringify(entries), /Swann:|Called them|roadworthy/, "no journal text reaches the activity record");
  });
});

test("addJournalEntry refuses text that holds an identifier Warthog never keeps, naming the place, never the text; nothing is written", async () => {
  await withDb(async (ctx) => {
    const me = await person(ctx, "journal-forbidden");
    const { recordId } = (await ctx.actions.saveRecord(me.session, { type: "government.lodgement", fields: { provider: "ATO" } })) as { recordId: string };
    const cases: [string, string, string, string][] = [
      ["note", "My TFN is 123 456 782", "tax_file_number", "Note"],
      ["decision", "Pay with BPAY biller 12345 ref 9876543", "payment_details", "Decision"],
      ["next", "Log in: the password is hunter2", "secret", "Next step"],
    ];
    for (const [kind, text, rule, field] of cases) {
      assert.deepEqual(await ctx.actions.addJournalEntry(me.session, { id: recordId, kind, text }), { ok: false, reason: "forbidden", refusal: { rule, field } }, `${kind}: ${rule}`);
    }
    const item = (await ctx.actions.loadItem(me.session, recordId))!;
    assert.deepEqual([item.notes.length, item.decisions.length, item.openSteps.length], [0, 0, 0]);
    assert.ok(!(await audit(ctx, me)).some((entry) => entry.kind === "life_admin_journal_added"));
  });
});

// ─── who is handling it ──────────────────────────────────────────────────────────────

test("setSteward names one of the person's connected agents, or no one; anyone else's agent, or a disconnected one, is refused", async () => {
  await withDb(async (ctx) => {
    const me = await person(ctx, "steward");
    const other = await person(ctx, "steward-other");
    const muse = await agentOf(ctx, me, "Muse");
    const gone = await agentOf(ctx, me, "Old agent", "disconnected");
    const theirs = await agentOf(ctx, other, "Theirs");
    const { recordId } = (await ctx.actions.saveRecord(me.session, { type: "vehicles.insurance", fields: { provider: "Swann" }, dueDate: "2026-12-01" })) as { recordId: string };
    assert.deepEqual(await ctx.actions.setSteward(me.session, { id: recordId, agentId: muse.agentId }), { ok: true, outcome: "assigned", recordId });
    let item = (await ctx.actions.loadItem(me.session, recordId))!;
    assert.deepEqual(item.steward, { agentId: muse.agentId, name: "Muse" });
    assert.deepEqual(item.agents.map((agent) => agent.name), ["Muse"], "only connected agents are offered");
    assert.match(item.whereItStands, /handled by Muse/);
    assert.deepEqual(await ctx.actions.setSteward(me.session, { id: recordId, agentId: gone.agentId }), { ok: false, reason: "unknown_agent" });
    assert.deepEqual(await ctx.actions.setSteward(me.session, { id: recordId, agentId: theirs.agentId }), { ok: false, reason: "unknown_agent" });
    assert.deepEqual(await ctx.actions.setSteward(other.session, { id: recordId, agentId: theirs.agentId }), { ok: false, reason: "not_found" });
    await rejects4xx("not an agent id", () => ctx.actions.setSteward(me.session, { id: recordId, agentId: "Muse" }));
    assert.deepEqual(await ctx.actions.setSteward(me.session, { id: recordId, agentId: "none" }), { ok: true, outcome: "unassigned", recordId });
    item = (await ctx.actions.loadItem(me.session, recordId))!;
    assert.equal(item.steward, null);
    assert.deepEqual(item.history[0]!.groups[0]!.lines.slice(0, 2), ["You cleared who is handling this", "Muse is handling this"]);
    assert.deepEqual((await audit(ctx, me)).filter((entry) => entry.kind === "life_admin_steward_set").map((entry) => entry.changes.steward), ["none", muse.agentId]);
  });
});

// ─── an item's own page ──────────────────────────────────────────────────────────────

test("loadItem: a finished booking keeps its whole history, decisions a later one replaced, and its hand-over notes", async () => {
  await withDb(async (ctx) => {
    const me = await person(ctx, "item-finished");
    const instinct = await agentOf(ctx, me, "Instinct");
    const muse = await agentOf(ctx, me, "Muse");
    const svc = service(ctx, me);
    // Instinct books it on the 17th, Muse carries it on on the 19th; it is over by the 23rd.
    const saved = await saveTypedRecord({ ...svc, now: new Date("2026-11-17T01:00:00.000Z") }, instinct, {
      type: BUILT_IN.type("outings.restaurant")!,
      fields: { provider: "Ester", reference: "E-77", starts_at: "2026-11-20T19:00+11:00[Australia/Sydney]" },
      journal: { decision: "Book Ester for Sam's birthday", next: { text: "Confirm numbers", due: "2026-11-18" } },
    });
    const record = (await getRecordForUser(ctx.db, me.userId, saved.record!.id, me.dek))!;
    const first = (await ctx.actions.loadItem(me.session, record.id))!;
    await addJournal({ ...svc, now: new Date("2026-11-19T01:00:00.000Z") }, record, muse, {
      decision: "Move to the 8 pm sitting",
      replaces: first.decisions[0]!.id,
      doneNextIds: [first.openSteps[0]!.id],
      handover: "All set; deposit paid on the card.",
    });
    await ctx.actions.confirmRecord(me.session, { id: record.id });

    const item = (await ctx.actions.loadItem(me.session, record.id))!;
    assert.deepEqual([item.kindLabel, item.categoryLabel, item.lifecycle, item.record.phase?.phase], ["Restaurant", "Going out", "booking", "completed"]);
    assert.deepEqual(item.decisions.map((entry) => [entry.text, entry.by]), [["Move to the 8 pm sitting", "Muse"]]);
    assert.deepEqual(item.replaced.map((entry) => [entry.text, entry.by, entry.replacedBy]), [["Book Ester for Sam's birthday", "Instinct", "Move to the 8 pm sitting"]]);
    assert.deepEqual(item.doneSteps.map((entry) => [entry.text, entry.doneBy, entry.doneWhen]), [["Confirm numbers", "Muse", "19 Nov"]]);
    assert.deepEqual(item.handovers.map((entry) => [entry.text, entry.by]), [["All set; deposit paid on the card.", "Muse"]]);
    assert.deepEqual(item.history.map((day) => [day.day, day.groups.map((group) => [group.by, group.lines])]), [
      ["Mon 23 Nov 2026", [["You", ["You confirmed this"]]]],
      ["Tue 17 Nov 2026", [["Instinct", ["Instinct is handling this", "Instinct added this"]]]],
    ], "Warthog's own changes, newest first, by day and by who");
    assert.ok(item.entries >= 7, "every entry is read, the finished item's included");
    assert.match(item.whereItStands, /^Ester · Completed \(20 Nov\) · decided: Move to the 8 pm sitting \(Muse, 19 Nov\) · handled by Instinct · last touched today by you$/);
  });
});

test("loadItem is member-scoped and validates the id: another person's item, a removed one or a malformed id is not found", async () => {
  await withDb(async (ctx) => {
    const me = await person(ctx, "item-scope");
    const other = await person(ctx, "item-scope-other");
    const { recordId } = (await ctx.actions.saveRecord(me.session, { type: "pets.pet", fields: { name: "Biscuit" } })) as { recordId: string };
    const child = (await ctx.actions.saveRecord(me.session, { type: "pets.insurance", fields: { provider: "Bow Wow" }, parentId: recordId })) as { recordId: string };
    assert.equal(await ctx.actions.loadItem(other.session, recordId), null);
    assert.equal(await ctx.actions.loadItem(me.session, "not-a-uuid"), null);
    assert.equal(await ctx.actions.loadItem(me.session, "' OR 1=1 --"), null);
    const pet = (await ctx.actions.loadItem(me.session, recordId))!;
    assert.deepEqual(pet.children.map((related) => [related.name, related.kindLabel]), [["Bow Wow", "Pet insurance"]]);
    const insurance = (await ctx.actions.loadItem(me.session, child.recordId))!;
    assert.deepEqual([insurance.parent?.name, insurance.parent?.kindLabel], ["Biscuit", "Pet"]);
    await ctx.actions.deleteRecord(me.session, { id: child.recordId });
    assert.equal(await ctx.actions.loadItem(me.session, child.recordId), null);
  });
});

// ─── audit ───────────────────────────────────────────────────────────────────────────

test("the person's own changes are audited with field names and ids, never values, and linked to the record", async () => {
  await withDb(async (ctx) => {
    const me = await person(ctx, "audit");
    const { recordId } = (await ctx.actions.saveRecord(me.session, { type: "vehicles.registration", fields: { plate: "BX12AB", provider: "Transport for NSW" }, dueDate: "2026-12-14" })) as { recordId: string };
    await ctx.actions.updateRecord(me.session, { id: recordId, fields: { plate: "BX12AC", provider: "Transport for NSW" } });
    await ctx.actions.setRecordReminders(me.session, { id: recordId, reminderOffsets: [7] });
    await ctx.actions.deleteRecord(me.session, { id: recordId });
    const entries = await audit(ctx, me);
    assert.deepEqual(entries.map((entry) => entry.kind), ["life_admin_record_deleted", "life_admin_reminders_changed", "life_admin_record_changed", "life_admin_record_saved"]);
    assert.deepEqual(entries[3]!.changes, { recordId, kind: "vehicles.registration", outcome: "created", fields: ["plate", "provider"] });
    assert.deepEqual(entries[2]!.changes, { recordId, fields: ["plate"], dueDate: false, status: false, parent: false });
    assert.ok(entries.every((entry) => entry.records.includes(recordId)));
    assert.doesNotMatch(JSON.stringify(entries), /BX12A|Transport for NSW/, "no value reaches the activity record");
  });
});
