// Life admin's typed records through the page actions (`./actions.ts`,
// docs/adr/life-admin-profile.md), against a real migrated database.
//
// The person adds a record of a catalogue type and edits one through the record service, so
// their values are normalised the way an agent's are; the person's input is refused when it
// holds an identifier Warthog never keeps, naming the field and never the value; an edit
// changes only what the person changed and never flattens a list or object an older agent
// saved (engineering finding M4); the person confirms what agents suggest (one by one or all
// at once), says a suggestion isn't theirs (a tombstone, so it isn't added again), and
// accepts (one by one or all at once) or declines an agent's change to a confirmed record.
// Every action is member-scoped and validates its ids at the boundary.

import * as React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { renderToStaticMarkup } from "react-dom/server";

import { createLifeAdminActions, editChanges } from "./actions";
import { LifeAdminView } from "@/components/life-admin/life-admin-view";
import { createUser } from "@/server/db/users";
import { createAgent } from "@/server/db/agents";
import { createRecord, getRecordForUser, listRecordsForUser, setPendingChange, type PendingChange } from "@/server/db/life-admin-records";
import { changeRecord, saveTypedRecord } from "@/server/life-admin/record-service";
import { BUILT_IN } from "@/domain/life-admin/catalogue";
import type { ServiceContext } from "@/server/life-admin/record-service";
import { createInMemoryBlobStore } from "@/server/storage/blob";
import { HttpError } from "@/server/http/validate";
import { localAesKeyWrapper, type KeyWrapper } from "@/server/crypto/key-wrapper";
import { fixedClock, systemClock } from "@/server/seams/clock";
import { freshDb } from "@/test/db";
import type { Db } from "@/server/db/index";
import type { Session } from "@/server/auth/session";

const NOW = new Date("2026-11-23T01:00:00.000Z");
const type = (id: string) => BUILT_IN.type(id)!;
const svc = (ctx: { db: Db }, who: { userId: string; dek: Uint8Array }): ServiceContext => ({ db: ctx.db, dek: who.dek, userId: who.userId, catalogue: BUILT_IN, zone: "UTC", now: NOW });

type Ctx = { db: Db; keyWrapper: KeyWrapper; actions: ReturnType<typeof createLifeAdminActions> };

async function withDb(run: (ctx: Ctx) => Promise<void>): Promise<void> {
  const db = await freshDb();
  const keyWrapper = localAesKeyWrapper(randomBytes(32));
  try {
    await run({ db, keyWrapper, actions: createLifeAdminActions({ db, keyWrapper, clock: fixedClock(NOW), blob: createInMemoryBlobStore() }) });
  } finally {
    await db.close();
  }
}

async function person(ctx: Ctx, who: string): Promise<{ userId: string; dek: Uint8Array; session: Session }> {
  const dek = randomBytes(32);
  const user = await createUser(ctx.db, { email: `${who}-${randomUUID()}@warthog.com.au`, wrappedDek: await ctx.keyWrapper.wrap(dek) });
  return {
    userId: user.id,
    dek,
    session: { id: `sess-${user.id}`, userId: user.id, createdAt: NOW, lastSeenAt: NOW, steppedUpAt: null },
  };
}

async function agentOf(ctx: Ctx, userId: string, displayName: string): Promise<{ kind: "agent"; agentId: string }> {
  const agent = await createAgent(ctx.db, { userId, connectionId: randomUUID(), displayName, platform: "chatgpt" }, systemClock);
  return { kind: "agent", agentId: agent.id };
}

async function rejects4xx(label: string, fn: () => Promise<unknown>): Promise<void> {
  await assert.rejects(fn, (error: unknown) => error instanceof HttpError && error.status >= 400 && error.status < 500, label);
}

// ─── adding ──────────────────────────────────────────────────────────────────────────

test("saveRecord adds a typed record the person's way: normalised, confirmed, linked to their own asset", async () => {
  await withDb(async (ctx) => {
    const me = await person(ctx, "add-typed");
    const bike = await ctx.actions.saveRecord(me.session, { type: "vehicles.vehicle", fields: { name: "Honda CB500X", plate: "bx12ab" } });
    assert.equal(bike.ok, true);
    const bikeId = (bike as { recordId: string }).recordId;
    const rego = await ctx.actions.saveRecord(me.session, {
      type: "vehicles.registration",
      fields: { plate: "BX12AB", amount: "$412.50", currency: "aud", cycle: "Yearly", notes: "" },
      dueDate: "2026-12-14",
      status: "active",
      parentId: bikeId,
    });
    assert.deepEqual({ ok: rego.ok, outcome: (rego as { outcome?: string }).outcome, problems: (rego as { problems?: string[] }).problems }, { ok: true, outcome: "created", problems: [] });
    const stored = await getRecordForUser(ctx.db, me.userId, (rego as { recordId: string }).recordId, me.dek);
    assert.deepEqual(stored!.fields, { plate: "BX12AB", amount: "412.50", currency: "AUD", cycle: "yearly" }, "normalised; the empty note is not kept");
    assert.equal(stored!.parentId, bikeId);
    assert.equal(stored!.dueDate, "2026-12-14");
    assert.deepEqual(stored!.reminderOffsets, [30, 7], "the type's own reminders");
    assert.equal(stored!.reviewState, "confirmed");
  });
});

test("a person's save without the details that identify it is still a clean save (that hint is for agents)", async () => {
  await withDb(async (ctx) => {
    const me = await person(ctx, "add-no-identity");
    const saved = await ctx.actions.saveRecord(me.session, { type: "health.insurance", fields: { provider: "Medibank" } });
    assert.deepEqual((saved as { problems?: string[] }).problems, [], "no reference number is not something the person left out");
    const bad = await ctx.actions.saveRecord(me.session, { type: "belongings.receipt", fields: { item: "Kettle", purchased_on: "last spring" } });
    assert.equal((bad as { problems?: string[] }).problems?.length, 1, "a value Warthog couldn't read is reported");
  });
});

test("saveRecord links only to one of the person's own assets of an allowed type", async () => {
  await withDb(async (ctx) => {
    const me = await person(ctx, "add-parent");
    const other = await person(ctx, "add-parent-other");
    const pet = (await ctx.actions.saveRecord(me.session, { type: "pets.pet", fields: { name: "Biscuit" } })) as { recordId: string };
    const theirs = (await ctx.actions.saveRecord(other.session, { type: "vehicles.vehicle", fields: { name: "Their car" } })) as { recordId: string };
    for (const parentId of [pet.recordId, theirs.recordId]) {
      const saved = await ctx.actions.saveRecord(me.session, { type: "vehicles.service", fields: { provider: `Workshop ${parentId.slice(0, 4)}` }, parentId });
      assert.equal(saved.ok, true);
      assert.ok((saved as { problems: string[] }).problems.length > 0, "the person is told it wasn't linked");
      assert.equal((await getRecordForUser(ctx.db, me.userId, (saved as { recordId: string }).recordId, me.dek))!.parentId, null);
    }
  });
});

test("saveRecord updates the record it matches instead of adding a copy", async () => {
  await withDb(async (ctx) => {
    const me = await person(ctx, "add-match");
    await ctx.actions.saveRecord(me.session, { type: "vehicles.registration", fields: { plate: "BX12AB" }, dueDate: "2026-12-14" });
    const again = await ctx.actions.saveRecord(me.session, { type: "vehicles.registration", fields: { plate: "bx 12ab", provider: "Transport for NSW" }, dueDate: "2027-12-14" });
    assert.equal((again as { outcome?: string }).outcome, "updated");
    const records = await listRecordsForUser(ctx.db, me.userId, me.dek);
    assert.equal(records.length, 1, "still one registration");
    assert.equal(records[0]!.dueDate, "2027-12-14");
  });
});

test("saveRecord refuses an identifier Warthog never keeps, naming the field by its label and never the value; nothing is stored", async () => {
  await withDb(async (ctx) => {
    const me = await person(ctx, "add-forbidden");
    const cases: [string, Record<string, string>, string, string][] = [
      ["government.lodgement", { notes: "My TFN is 123 456 782" }, "tax_file_number", "Notes"],
      ["id.passport", { country: "Australia", notes: "PA1234567" }, "government_id", "Notes"],
      ["subscriptions.service", { name: "Bank portal", password: "hunter2" }, "secret", "Password"],
      ["banking.account", { provider: "CBA", notes: "BSB 062-000 account 12345678" }, "bank_account", "Notes"],
      ["id.medicare", { people: "Me", notes: "2123 45670 1" }, "medicare", "Notes"],
    ];
    for (const [typeId, fields, rule, field] of cases) {
      const result = await ctx.actions.saveRecord(me.session, { type: typeId, fields });
      assert.deepEqual(result, { ok: false, reason: "forbidden", refusal: { rule, field } }, typeId);
      for (const value of Object.values(fields)) {
        if (value.length > 6) assert.ok(!JSON.stringify(result).includes(value), "the refusal never carries the value");
      }
    }
    assert.deepEqual(await listRecordsForUser(ctx.db, me.userId, me.dek), []);
  });
});

test("saveRecord refuses a form with nothing filled in, and an unknown type at the boundary", async () => {
  await withDb(async (ctx) => {
    const me = await person(ctx, "add-empty");
    assert.deepEqual(await ctx.actions.saveRecord(me.session, { type: "other.item", fields: { name: "  ", notes: "" } }), { ok: false, reason: "empty" });
    await rejects4xx("unknown type", () => ctx.actions.saveRecord(me.session, { type: "vehicles.spaceship", fields: { name: "x" } }));
    await rejects4xx("prototype key", () => ctx.actions.saveRecord(me.session, { type: "__proto__", fields: { name: "x" } }));
    await rejects4xx("malformed parent", () => ctx.actions.saveRecord(me.session, { type: "vehicles.service", fields: { provider: "x" }, parentId: "1" }));
    assert.deepEqual(await listRecordsForUser(ctx.db, me.userId, me.dek), []);
  });
});

// ─── editing ─────────────────────────────────────────────────────────────────────────

test("editChanges sets what changed, removes what was emptied, leaves the rest and never touches a list or object", () => {
  const health = type("health.insurance");
  assert.deepEqual(
    editChanges(health, { provider: "Medibank", notes: "Old", extras: { dental: 120 }, tags: ["a"], reference: "ABC" }, {
      provider: "Medibank",
      notes: "",
      reference: " ABD ",
      excess: "500",
      extras: "[object Object]",
      tags: "a",
      scale: "",
    }),
    { set: { reference: "ABD", excess: "500" }, remove: ["notes"] },
  );
  // A changed detail saved under another name moves to the type's own field.
  assert.deepEqual(editChanges(type("subscriptions.service"), { service: "Spotify" }, { service: "Spotify Family", provider: "" }), {
    set: { service: "Spotify Family" },
    remove: ["service"],
  });
});

test("updateRecord changes only what the person changed and keeps a list or object an older agent saved (M4)", async () => {
  await withDb(async (ctx) => {
    const me = await person(ctx, "edit-merge");
    const record = await createRecord(
      ctx.db,
      {
        userId: me.userId,
        kind: "subscription",
        fields: { name: "Gym", plan: "Basic", notes: "Old note", extras: { towel: true, locker: 12 }, tags: ["fitness", "weekly"] },
        dueDate: "2027-01-01",
        status: "active",
        source: { kind: "person" },
      },
      me.dek,
    );
    // The Edit form posts every field it shows; a crafted form can't post the object back as text.
    const result = await ctx.actions.updateRecord(me.session, {
      id: record.id,
      fields: { name: "Gym", plan: "Premium", notes: "", provider: "", extras: "[object Object]" },
      dueDate: "2027-01-01",
      status: "active",
    });
    assert.equal(result.ok, true);
    const after = await getRecordForUser(ctx.db, me.userId, record.id, me.dek);
    assert.deepEqual(after!.fields, { name: "Gym", plan: "Premium", extras: { towel: true, locker: 12 }, tags: ["fitness", "weekly"] });

    // The loader shows them read-only, summarised, and never as "[object Object]".
    const data = await ctx.actions.load(me.session);
    const view = data.records.find((r) => r.id === record.id)!;
    assert.deepEqual(view.heldFields, { extras: "Towel: yes; Locker: 12", tags: "fitness, weekly" });
    assert.ok(!("extras" in view.fields) && !("tags" in view.fields));
    assert.doesNotMatch(JSON.stringify(data), /\[object Object\]/);
    assert.doesNotMatch(renderToStaticMarkup(<LifeAdminView today={data.today} records={data.records} />), /\[object Object\]/);
  });
});

test("updateRecord refuses an identifier in what the person changed, and leaves the record as it was", async () => {
  await withDb(async (ctx) => {
    const me = await person(ctx, "edit-forbidden");
    const saved = (await ctx.actions.saveRecord(me.session, { type: "banking.account", fields: { provider: "CBA", last4: "1234" } })) as { recordId: string };
    const result = await ctx.actions.updateRecord(me.session, { id: saved.recordId, fields: { provider: "CBA", notes: "My PIN is 4821" } });
    assert.deepEqual(result, { ok: false, reason: "forbidden", refusal: { rule: "secret", field: "Notes" } });
    assert.deepEqual((await getRecordForUser(ctx.db, me.userId, saved.recordId, me.dek))!.fields, { provider: "CBA", last4: "1234" });
  });
});

test("the person's edit confirms an agent's suggestion, even one that changed nothing", async () => {
  await withDb(async (ctx) => {
    const me = await person(ctx, "edit-confirms");
    const agent = await agentOf(ctx, me.userId, "ChatGPT");
    const a = await saveTypedRecord(svc(ctx, me), agent, { type: type("health.insurance"), fields: { provider: "Medibank", reference: "M-1" } });
    const b = await saveTypedRecord(svc(ctx, me), agent, { type: type("health.ambulance"), fields: { provider: "Ambulance Vic", reference: "A-1" } });
    const unchanged = await ctx.actions.updateRecord(me.session, { id: a.record!.id, fields: { provider: "Medibank", reference: "M-1" } });
    assert.equal((unchanged as { outcome?: string }).outcome, "confirmed");
    assert.equal((await getRecordForUser(ctx.db, me.userId, a.record!.id, me.dek))!.reviewState, "confirmed");
    await ctx.actions.updateRecord(me.session, { id: b.record!.id, fields: { provider: "Ambulance Victoria" } });
    const edited = await getRecordForUser(ctx.db, me.userId, b.record!.id, me.dek);
    assert.equal(edited!.reviewState, "confirmed");
    assert.deepEqual(edited!.changedBy, { kind: "person" });
  });
});

// ─── checking what agents found ──────────────────────────────────────────────────────

test("the loader shows who added a record, where the agent says it found it, and an agent named like the person is quoted", async () => {
  await withDb(async (ctx) => {
    const me = await person(ctx, "load-provenance");
    const chatgpt = await agentOf(ctx, me.userId, "ChatGPT");
    const sly = await agentOf(ctx, me.userId, "You");
    const foundIn = { service: "google-gmail", messageId: "18c2", sender: "service.nsw.gov.au", date: "2026-10-02", seenByWarthog: true };
    const rego = await saveTypedRecord(svc(ctx, me), chatgpt, { type: type("vehicles.registration"), fields: { plate: "BX12AB" }, dueDate: "2026-12-14", foundIn });
    await saveTypedRecord(svc(ctx, me), sly, { type: type("pets.pet"), fields: { name: "Biscuit" } });
    const data = await ctx.actions.load(me.session);
    const view = data.records.find((r) => r.id === rego.record!.id)!;
    assert.equal(view.reviewState, "suggested");
    assert.deepEqual(view.addedBy, { kind: "agent", agentId: chatgpt.agentId, name: "ChatGPT" });
    assert.deepEqual(view.foundIn, { service: "google-gmail", sender: "service.nsw.gov.au", date: "2026-10-02", seenByWarthog: true });
    const markup = renderToStaticMarkup(<LifeAdminView today={data.today} records={data.records} />);
    assert.match(markup, /Found by ChatGPT in an email from service\.nsw\.gov\.au \(2 Oct 2026\)\. ChatGPT read it through Warthog\./);
    assert.match(markup, /Added by an agent called “You”\./);
    assert.doesNotMatch(markup, /Added by You\./);
  });
});

test("confirmRecord makes a suggestion the person's; another person's or a malformed id is refused", async () => {
  await withDb(async (ctx) => {
    const me = await person(ctx, "confirm-one");
    const other = await person(ctx, "confirm-other");
    const agent = await agentOf(ctx, me.userId, "ChatGPT");
    const theirAgent = await agentOf(ctx, other.userId, "Claude");
    const mine = await saveTypedRecord(svc(ctx, me), agent, { type: type("investing.super"), fields: { provider: "AustralianSuper", reference: "S-1" } });
    const theirs = await saveTypedRecord(svc(ctx, other), theirAgent, { type: type("investing.super"), fields: { provider: "Hostplus", reference: "H-1" } });
    assert.equal((await ctx.actions.confirmRecord(me.session, { id: mine.record!.id })).ok, true);
    assert.equal((await getRecordForUser(ctx.db, me.userId, mine.record!.id, me.dek))!.reviewState, "confirmed");
    assert.equal((await ctx.actions.confirmRecord(me.session, { id: mine.record!.id })).ok, false, "already confirmed");
    assert.equal((await ctx.actions.confirmRecord(me.session, { id: theirs.record!.id })).ok, false);
    assert.equal((await getRecordForUser(ctx.db, other.userId, theirs.record!.id, other.dek))!.reviewState, "suggested", "theirs is untouched");
    for (const bad of ["5", "", "x'; DROP TABLE life_admin_records; --"]) {
      await rejects4xx(`confirmRecord(${bad})`, () => ctx.actions.confirmRecord(me.session, { id: bad }));
    }
  });
});

test("confirmAll confirms every one of the person's suggestions it is given, and nothing of anyone else's", async () => {
  await withDb(async (ctx) => {
    const me = await person(ctx, "confirm-all");
    const other = await person(ctx, "confirm-all-other");
    const agent = await agentOf(ctx, me.userId, "ChatGPT");
    const theirAgent = await agentOf(ctx, other.userId, "Claude");
    const ids: string[] = [];
    for (const provider of ["Origin", "Sydney Water"]) {
      ids.push((await saveTypedRecord(svc(ctx, me), agent, { type: type("utilities.water"), fields: { provider, reference: provider } })).record!.id);
    }
    const theirs = (await saveTypedRecord(svc(ctx, other), theirAgent, { type: type("utilities.water"), fields: { provider: "Theirs", reference: "T" } })).record!.id;

    await rejects4xx("an empty list", () => ctx.actions.confirmAll(me.session, { ids: [] }));
    await rejects4xx("a malformed id among them", () => ctx.actions.confirmAll(me.session, { ids: [ids[0]!, "nope"] }));
    assert.equal((await getRecordForUser(ctx.db, me.userId, ids[0]!, me.dek))!.reviewState, "suggested", "nothing confirmed by a refused list");
    assert.equal((await ctx.actions.confirmAll(me.session, { ids: [theirs] })).ok, false, "none of them mine");

    const result = await ctx.actions.confirmAll(me.session, { ids: [...ids, theirs, ids[0]!] });
    assert.deepEqual(result, { ok: true, outcome: "confirmed", count: 2 });
    for (const id of ids) assert.equal((await getRecordForUser(ctx.db, me.userId, id, me.dek))!.reviewState, "confirmed");
    assert.equal((await getRecordForUser(ctx.db, other.userId, theirs, other.dek))!.reviewState, "suggested");
  });
});

test("acceptAllPending accepts every waiting change it is given on the person's records, and nothing of anyone else's", async () => {
  await withDb(async (ctx) => {
    const me = await person(ctx, "accept-all");
    const other = await person(ctx, "accept-all-other");
    const agent = await agentOf(ctx, me.userId, "Claude");
    const theirAgent = await agentOf(ctx, other.userId, "ChatGPT");
    const ids: string[] = [];
    for (const reference of ["M-1", "M-2", "M-3"]) {
      const saved = (await ctx.actions.saveRecord(me.session, { type: "health.insurance", fields: { provider: "Medibank", reference, notes: "Mine" }, dueDate: "2027-03-01" })) as { recordId: string };
      ids.push(saved.recordId);
    }
    for (const id of ids.slice(0, 2)) {
      const existing = (await getRecordForUser(ctx.db, me.userId, id, me.dek))!;
      assert.equal((await changeRecord(svc(ctx, me), existing, agent, { set: { hospital_cover: "gold" }, remove: ["notes"] })).action, "proposed");
    }
    const theirs = (await ctx.actions.saveRecord(other.session, { type: "health.insurance", fields: { provider: "Bupa", reference: "B-1" } })) as { recordId: string };
    const theirRecord = (await getRecordForUser(ctx.db, other.userId, theirs.recordId, other.dek))!;
    await changeRecord(svc(ctx, other), theirRecord, theirAgent, { set: { hospital_cover: "silver" } });

    await rejects4xx("an empty list", () => ctx.actions.acceptAllPending(me.session, { ids: [] }));
    await rejects4xx("a malformed id among them", () => ctx.actions.acceptAllPending(me.session, { ids: [ids[0]!, "nope"] }));
    assert.ok((await getRecordForUser(ctx.db, me.userId, ids[0]!, me.dek))!.pending, "nothing accepted by a refused list");
    assert.equal((await ctx.actions.acceptAllPending(me.session, { ids: [theirs.recordId] })).ok, false, "none of them mine");
    assert.equal((await ctx.actions.acceptAllPending(me.session, { ids: [ids[2]!] })).ok, false, "a record of mine with no waiting change");

    const result = await ctx.actions.acceptAllPending(me.session, { ids: [...ids, theirs.recordId, ids[0]!] });
    assert.deepEqual(result, { ok: true, outcome: "updated", count: 2 });
    for (const id of ids.slice(0, 2)) {
      const accepted = (await getRecordForUser(ctx.db, me.userId, id, me.dek))!;
      assert.deepEqual([accepted.fields.hospital_cover, accepted.fields.notes, accepted.pending], ["gold", undefined, null]);
    }
    assert.equal((await getRecordForUser(ctx.db, me.userId, ids[2]!, me.dek))!.fields.notes, "Mine", "the record with no change is untouched");
    const still = (await getRecordForUser(ctx.db, other.userId, theirs.recordId, other.dek))!;
    assert.deepEqual([still.fields.hospital_cover, still.pending?.set], [undefined, { hospital_cover: "silver" }], "another person's change still waits");
  });
});

test("the loader passes on a waiting change's new kind, and only a kind", async () => {
  await withDb(async (ctx) => {
    const me = await person(ctx, "pending-kind");
    const agent = await agentOf(ctx, me.userId, "ChatGPT");
    const saved = (await ctx.actions.saveRecord(me.session, { type: "other.reminder", fields: { name: "Honda CB500X" } })) as { recordId: string };
    const change = (type: unknown) => ({ set: { name: "Honda CB500X" }, remove: [], byAgentId: agent.agentId, at: NOW.toISOString(), type }) as unknown as PendingChange;
    await setPendingChange(ctx.db, me.userId, saved.recordId, change("vehicles.vehicle"), me.dek);
    assert.equal((await ctx.actions.load(me.session)).records.find((r) => r.id === saved.recordId)!.pending!.type, "vehicles.vehicle");
    await setPendingChange(ctx.db, me.userId, saved.recordId, change({ id: "vehicles.vehicle" }), me.dek);
    assert.equal("type" in (await ctx.actions.load(me.session)).records.find((r) => r.id === saved.recordId)!.pending!, false, "anything but a kind's id is left out");
    await setPendingChange(ctx.db, me.userId, saved.recordId, { ...change("vehicles.vehicle"), parentId: "a3b1c2d4-0000-4000-8000-000000000001" } as PendingChange, me.dek);
    assert.equal((await ctx.actions.load(me.session)).records.find((r) => r.id === saved.recordId)!.pending!.parentId, "a3b1c2d4-0000-4000-8000-000000000001", "and the thing it links the record to");
  });
});

test("dismissRecord ('Not mine') removes the record, and an agent finding it again doesn't add it back", async () => {
  await withDb(async (ctx) => {
    const me = await person(ctx, "dismiss");
    const other = await person(ctx, "dismiss-other");
    const agent = await agentOf(ctx, me.userId, "ChatGPT");
    const found = { type: type("vehicles.registration"), fields: { plate: "ZZ99ZZ" }, dueDate: "2027-01-01" };
    const suggestion = await saveTypedRecord(svc(ctx, me), agent, found);
    assert.equal((await ctx.actions.dismissRecord(other.session, { id: suggestion.record!.id })).ok, false, "another person can't dismiss it");
    assert.equal((await ctx.actions.dismissRecord(me.session, { id: suggestion.record!.id })).ok, true);
    assert.deepEqual((await ctx.actions.load(me.session)).records, [], "gone from Life admin");
    const again = await saveTypedRecord(svc(ctx, me), agent, found);
    assert.equal(again.action, "skipped");
    assert.deepEqual(await listRecordsForUser(ctx.db, me.userId, me.dek), []);
    await rejects4xx("malformed id", () => ctx.actions.dismissRecord(me.session, { id: "-1" }));
  });
});

test("an agent's change to a confirmed record waits; the loader shows it; the person accepts or keeps their own", async () => {
  await withDb(async (ctx) => {
    const me = await person(ctx, "pending");
    const other = await person(ctx, "pending-other");
    const agent = await agentOf(ctx, me.userId, "Claude");
    const make = async (reference: string) =>
      (await ctx.actions.saveRecord(me.session, { type: "health.insurance", fields: { provider: "Medibank", reference, notes: "Mine" }, dueDate: "2027-03-01" })) as { recordId: string };
    const accept = await make("M-1");
    const decline = await make("M-2");
    for (const { recordId } of [accept, decline]) {
      const existing = (await getRecordForUser(ctx.db, me.userId, recordId, me.dek))!;
      const proposed = await changeRecord(svc(ctx, me), existing, agent, { set: { hospital_cover: "gold" }, remove: ["notes"], dueDate: "2028-03-01" });
      assert.equal(proposed.action, "proposed");
    }

    const data = await ctx.actions.load(me.session);
    const view = data.records.find((r) => r.id === accept.recordId)!;
    assert.deepEqual(view.pending, { byName: "Claude", set: { hospital_cover: "gold" }, remove: ["notes"], dueDate: "2028-03-01", foundIn: null });
    assert.deepEqual(view.fields, { provider: "Medibank", reference: "M-1", notes: "Mine" }, "the person's values are unchanged until they decide");

    assert.equal((await ctx.actions.acceptPending(other.session, { id: accept.recordId })).ok, false, "another person can't accept it");
    assert.equal((await ctx.actions.declinePending(other.session, { id: decline.recordId })).ok, false, "or decline it");

    assert.equal((await ctx.actions.acceptPending(me.session, { id: accept.recordId })).ok, true);
    const accepted = (await getRecordForUser(ctx.db, me.userId, accept.recordId, me.dek))!;
    assert.deepEqual(accepted.fields, { provider: "Medibank", reference: "M-1", hospital_cover: "gold" });
    assert.equal(accepted.dueDate, "2028-03-01");
    assert.equal(accepted.pending, null);

    assert.equal((await ctx.actions.declinePending(me.session, { id: decline.recordId })).ok, true);
    const declined = (await getRecordForUser(ctx.db, me.userId, decline.recordId, me.dek))!;
    assert.deepEqual(declined.fields, { provider: "Medibank", reference: "M-2", notes: "Mine" });
    assert.equal(declined.pending, null);
    assert.equal((await ctx.actions.acceptPending(me.session, { id: decline.recordId })).ok, false, "nothing left to accept");
    await rejects4xx("malformed id", () => ctx.actions.acceptPending(me.session, { id: "1.5" }));
    await rejects4xx("malformed id", () => ctx.actions.declinePending(me.session, { id: "" }));
  });
});
