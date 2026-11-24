// The founder's scenarios through the MCP record tools (docs/adr/life-admin-profile.md,
// life-admin-journal.md): an agent suggests a category of the person's own — with a thing other
// records belong to — in one call; every booking stays findable live and finished with its log; and
// one agent (Instinct) hands a live item to another (Muse), who reads the log and takes it over.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";

import { createListRecordsTool, createSaveRecordTool, createUpdateRecordTool } from "./records";
import { createGetContextTool } from "./get-context";
import { createUser } from "../../db/users";
import { createAgent } from "../../db/agents";
import { upsertPermissions } from "../../db/agent-permissions";
import { listCategoryRows } from "../../db/life-admin-categories";
import { freshDb } from "../../../test/db";
import { localAesKeyWrapper } from "../../crypto/key-wrapper";
import { buildCatalogue } from "../../../domain/life-admin/catalogue";
import { confirmRecordFor, declineCustomCategory } from "../../life-admin/record-service";
import type { Clock } from "../../seams/clock";
import type { AgentConnection } from "../context";

function movableClock(start: string) {
  let now = new Date(start);
  return { clock: { now: () => new Date(now) } as Clock, set: (iso: string) => { now = new Date(iso); } };
}

async function setup(start = "2026-11-18T01:00:00Z") {
  const db = await freshDb();
  const keyWrapper = localAesKeyWrapper(randomBytes(32));
  const dek = randomBytes(32);
  const user = await createUser(db, { email: `${randomUUID()}@warthog.com.au`, wrappedDek: await keyWrapper.wrap(dek) });
  const time = movableClock(start);
  const agent = async (name: string): Promise<AgentConnection> => {
    const connectionId = randomUUID();
    const created = await createAgent(db, { userId: user.id, connectionId, displayName: name, platform: "other" }, time.clock);
    await upsertPermissions(db, {
      userId: user.id, connectionId, grantedConnectors: [], readTools: true, changeTools: "allow", identityAccess: true,
      highTierAccess: false, cardAccess: false, cardBudget: null, skillsScope: [], memoryRead: true, sharing: false,
      rulesScope: [], rateLimit: 120, recordsAccess: true, tasksAccess: true,
    } as Parameters<typeof upsertPermissions>[1]);
    return { userId: user.id, connectionId, agentId: created.id, active: true } as unknown as AgentConnection;
  };
  const deps = { db, keyWrapper, clock: time.clock };
  return {
    db, dek, userId: user.id, time, agent,
    save: createSaveRecordTool(deps), list: createListRecordsTool(deps), update: createUpdateRecordTool(deps), context: createGetContextTool(deps),
  };
}

test("an agent suggests a category of the person's own, with a thing other records belong to", async () => {
  const t = await setup();
  try {
    const claude = await t.agent("Claude");
    const result = await t.save.handle({
      newCategory: {
        label: "Rowing club",
        description: "Membership, regattas and the club's boats.",
        lifeArea: "everyday",
        icon: "trophy",
        why: "12 emails from the rowing club: fees, regattas and boat bookings.",
        kinds: [
          { key: "shell", label: "Boat", lifecycle: "standing", use: "A racing boat the person rows.", anchor: true, fields: [{ key: "hull", label: "Hull name", kind: "text" }], identity: ["hull"] },
          { key: "mooring", label: "Mooring", lifecycle: "standing", use: "Where a boat is kept.", belongsTo: ["self.shell"], due: { means: "renews", label: "Renews" }, fields: [{ key: "berth", label: "Berth", kind: "text" }] },
        ],
      },
      records: [
        { ref: "kestrel", type: "new.shell", fields: { hull: "Kestrel" } },
        { parentRef: "kestrel", type: "new.mooring", fields: { berth: "B12", provider: "Club marina" }, dueDate: "2027-03-01" },
        { parentRef: "kestrel", type: "insurance.other", fields: { provider: "Marine Co", reference: "M-1", covers: "Hull and liability" } },
      ],
    }, claude);
    assert.equal(result.status, "ok");
    if (result.status !== "ok") return;
    assert.deepEqual(result.results.map((item) => item.action), ["created", "created", "created"]);
    const category = (result as { category?: { id: string; state: string } }).category!;
    assert.equal(category.state, "suggested");
    assert.match(category.id, /^x_[a-z2-9]{6}$/);

    const shell = result.results[0]!.id!;
    const belonging = await t.list.handle({ parentId: shell }, claude);
    if (belonging.status !== "ok" || !("records" in belonging)) throw new Error("refused");
    assert.deepEqual(belonging.records.map((record) => record.type).sort(), [`${category.id}.mooring`, `${category.id}.shell`, "insurance.other"].sort());
    assert.ok(belonging.records.every((record) => record.id === shell || record.parentId === shell));
    assert.ok(belonging.records.some((record) => record.inSuggestedCategory));

    const categories = await t.list.handle({ view: "categories" }, claude);
    if (categories.status !== "ok" || !("categories" in categories)) throw new Error("refused");
    assert.ok((categories.categories as { id: string; label: string }[]).some((cat) => cat.id === category.id && cat.label === "Rowing club"));
    // Dogfood, 25 Nov 2026: how many records each category has, so a profile build can skip
    // the ones already filled in.
    const counts = new Map((categories.categories as { id: string; records: number }[]).map((cat) => [cat.id, cat.records]));
    assert.equal(counts.get(category.id), 2, "the boat and its mooring");
    assert.equal(counts.get("insurance"), 1);
    assert.equal(counts.get("pets"), 0);

    // The person declines it: a re-suggestion is refused.
    const rows = await listCategoryRows(t.db, t.userId, t.dek);
    await declineCustomCategory({ db: t.db, dek: t.dek, userId: t.userId, catalogue: buildCatalogue(rows.custom), zone: "UTC", now: new Date() }, category.id);
    const again = await t.save.handle({ newCategory: { label: "Rowing Clubs", description: "d", lifeArea: "everyday", why: "w", kinds: [{ key: "fees", label: "Fees", lifecycle: "standing", use: "Fees.", fields: [] }] }, records: [{ type: "new.fees", fields: { name: "x" } }] }, claude);
    assert.equal(again.status, "refused");
  } finally { await t.db.close(); }
});

test("every booking stays findable, live and finished, with its log", async () => {
  const t = await setup("2026-11-20T01:00:00Z");
  try {
    const muse = await t.agent("Muse");
    await t.save.handle({ records: [
      { type: "outings.restaurant", fields: { provider: "Bistro", starts_at: "2026-11-21T19:30[Australia/Sydney]", party_size: "6" }, journal: { note: "Card hold added for the group." } },
      { type: "outings.restaurant", fields: { provider: "Cafe", starts_at: "2026-11-22T12:00[Australia/Sydney]" }, status: "cancelled" },
      { type: "travel.flight", fields: { provider: "Qantas", reference: "ABC123", flight_number: "QF1", starts_at: "2026-12-10T15:00[Australia/Sydney]" } },
    ] }, muse);
    t.time.set("2026-11-23T01:00:00Z"); // the dinner is over

    const live = await t.list.handle({ lifecycle: "booking" }, muse);
    if (live.status !== "ok" || !("records" in live)) throw new Error("refused");
    assert.equal(live.records.length, 1, "only the flight is live");
    assert.equal(live.records[0]!.phase.phase, "upcoming");

    const all = await t.list.handle({ lifecycle: "booking", include: "all" }, muse);
    if (all.status !== "ok" || !("records" in all)) throw new Error("refused");
    assert.deepEqual(all.records.map((record) => record.phase.phase), ["upcoming", "cancelled", "completed"], "live first, then finished newest first");
    const dinner = all.records.find((record) => record.fields.provider === "Bistro")!;
    assert.equal(dinner.journal?.entries, 2, "a finished booking keeps its log");

    const full = await t.list.handle({ id: dinner.id, journal: "full" }, muse);
    if (full.status !== "ok" || !("journal" in full) || !full.journal) throw new Error("no journal");
    assert.deepEqual((full.journal.entries as { kind: string }[]).map((entry) => entry.kind), ["note", "change"]);
  } finally { await t.db.close(); }
});

test("Instinct hands the motorcycle insurance to Muse through its log", async () => {
  const t = await setup("2026-11-18T01:00:00Z");
  try {
    const instinct = await t.agent("Instinct");
    const muse = await t.agent("Muse");

    const saved = await t.save.handle({ records: [
      { ref: "bike", type: "vehicles.vehicle", fields: { name: "Honda CB500X", body: "motorcycle", plate: "BX12AB" } },
      { parentRef: "bike", type: "vehicles.insurance", fields: { name: "Motorcycle insurance", provider: "Swann", reference: "S-1", amount: "780", cycle: "yearly" }, dueDate: "2026-12-01",
        journal: { decision: "Chose Swann over Bikesure: agreed value $9,000, $212/yr cheaper.", next: { text: "Get the roadworthy at Ryde Motorcycles and send it to Swann", due: "2026-11-28" } } },
    ] }, instinct);
    if (saved.status !== "ok") throw new Error("not saved");
    const insuranceId = saved.results[1]!.id!;
    assert.equal(saved.results[1]!.journal?.handledBy, "Instinct");
    assert.equal(saved.results[0]!.journal, undefined, "a field-only save doesn't make an agent the handler");
    await t.update.handle({ id: insuranceId, journal: { decision: "Inspection at Ryde Motorcycles: closest, Saturday slots." } }, instinct);

    t.time.set("2026-11-22T02:00:00Z");
    const context = await t.context.handle(muse);
    const handover = context.lifeAdmin?.handover;
    assert.equal(handover?.items.length, 1);
    assert.equal(handover!.items[0]!.line, "Motorcycle insurance · renews 1 Dec, in 9 days · decided: Inspection at Ryde Motorcycles: closest, Saturday slots. (Instinct, 18 Nov) · next: Get the roadworthy at Ryde Motorcycles and send it to Swann, due 28 Nov · handled by Instinct · last touched 4 days ago by Instinct");
    assert.deepEqual(handover!.items[0]!.steward, { kind: "agent", name: "Instinct" });

    const log = await t.list.handle({ id: insuranceId, journal: "full" }, muse);
    if (log.status !== "ok" || !("journal" in log) || !log.journal) throw new Error("no log");
    const entries = log.journal.entries as { id: string; kind: string; reported: boolean; by: { kind: string; name?: string } }[];
    assert.ok(entries.filter((entry) => entry.kind === "decision").every((entry) => entry.reported && entry.by.name === "Instinct"));
    assert.ok(entries.some((entry) => entry.kind === "change" && !entry.reported));
    const nextId = entries.find((entry) => entry.kind === "next")!.id;

    const taken = await t.update.handle({ id: insuranceId, takeOver: true, journal: { decision: "Paid in the Swann app after the roadworthy passed; cover starts 1 Dec.", doneNextIds: [nextId] } }, muse);
    assert.equal(taken.status, "unchanged", "nothing about the policy itself changed");
    assert.equal((taken as { journal?: { tookOverFrom?: string } }).journal?.tookOverFrom, "Instinct");

    const after = await t.context.handle(muse);
    assert.equal(after.lifeAdmin?.handover, undefined, "nothing left open for anyone");
    const fromInstinct = await t.list.handle({ id: insuranceId, journal: "full" }, instinct);
    if (fromInstinct.status !== "ok" || !("journal" in fromInstinct) || !fromInstinct.journal) throw new Error("no log");
    assert.ok((fromInstinct.journal.entries as { change?: string }[]).some((entry) => entry.change === "Muse took over from Instinct"));
    assert.deepEqual((fromInstinct.records[0]!.handledBy as { name?: string }).name, "Muse");
  } finally { await t.db.close(); }
});

test("after the person confirms an item, another agent's field change waits for them while its log entries apply at once", async () => {
  const t = await setup("2026-11-18T01:00:00Z");
  try {
    const instinct = await t.agent("Instinct");
    const muse = await t.agent("Muse");
    const saved = await t.save.handle({ records: [
      { type: "vehicles.insurance", fields: { name: "Motorcycle insurance", provider: "Swann", reference: "S-1", amount: "780", cycle: "yearly" }, dueDate: "2026-12-01",
        journal: { next: { text: "Send Swann the roadworthy", due: "2026-11-28" } } },
    ] }, instinct);
    if (saved.status !== "ok") throw new Error("not saved");
    const id = saved.results[0]!.id!;
    const rows = await listCategoryRows(t.db, t.userId, t.dek);
    await confirmRecordFor({ db: t.db, dek: t.dek, userId: t.userId, catalogue: buildCatalogue(rows.custom), zone: "UTC", now: new Date("2026-11-19T01:00:00Z") }, id);

    t.time.set("2026-11-22T02:00:00Z");
    const changed = await t.update.handle({ id, set: { amount: "812" }, takeOver: true, journal: { decision: "Premium went up to $812 after the inspection; still cheaper than Bikesure." } }, muse);
    assert.equal(changed.status, "proposed", "the person confirmed it, so the new amount waits for them");
    assert.equal((changed as { journal?: { tookOverFrom?: string } }).journal?.tookOverFrom, "Instinct");

    const view = await t.list.handle({ id, journal: "full" }, muse);
    if (view.status !== "ok" || !("journal" in view) || !view.journal) throw new Error("no log");
    const record = view.records[0]!;
    assert.equal(record.fields.amount, "780", "the confirmed value stands until the person accepts");
    assert.deepEqual(record.handledBy, { kind: "you" }, "Muse reads itself as the one handling it");
    const kinds = (view.journal.entries as { kind: string; change?: string }[]);
    assert.ok(kinds.some((entry) => entry.kind === "decision"), "the decision is in the log already");
    assert.ok(kinds.some((entry) => entry.kind === "change" && /suggested a change/.test(entry.change ?? "")));
  } finally { await t.db.close(); }
});
