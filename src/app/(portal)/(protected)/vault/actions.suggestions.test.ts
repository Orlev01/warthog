// About you suggestions on the page (docs/adr/profile-build.md): what `load` hands the view and
// what Add / Not mine change (`createIdentityActions`, ./actions).
//
// An agent may SUGGEST a low-tier detail; the person confirms each one on About you. `load` shows
// the person's own waiting suggestions, decrypted, each with the suggesting agent's name (or "An
// agent" when that agent isn't theirs or has gone), hides one About you already holds (the same
// detail once normalised) and marks one that differs from the detail of that kind they have.
// Adding saves it as an everyday detail and removes the suggestion; Not mine declines it so it is
// never suggested again. Both are scoped to the session person: another person's id changes
// nothing, and a malformed id is a 4xx before any query.
//
// Real migrations on PGlite (src/test/db), a real local KeyWrapper and the real stores.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";

import { createIdentityActions } from "./actions";
import { createUser } from "@/server/db/users";
import { createAgent } from "@/server/db/agents";
import { listIdentityFields, saveIdentityField } from "@/server/db/identity-fields";
import {
  listIdentitySuggestions,
  suggestIdentityDetail,
  type NewIdentitySuggestion,
} from "@/server/db/identity-suggestions";
import { HttpError } from "@/server/http/validate";
import { localAesKeyWrapper, type KeyWrapper } from "@/server/crypto/key-wrapper";
import { systemClock } from "@/server/seams/clock";
import { freshDb } from "@/test/db";
import type { Db } from "@/server/db/index";
import type { Session } from "@/server/auth/session";

const NOW = new Date("2026-11-24T00:00:00.000Z");
const SOURCE = { service: "google-gmail", messageId: "msg-77", date: "2026-10-03", sender: "AGL <bills@agl.com.au>" };

async function makeUser(db: Db, keyWrapper: KeyWrapper, who: string): Promise<{ userId: string; dek: Uint8Array }> {
  const dek = randomBytes(32);
  const user = await createUser(db, { email: `${who}-${randomUUID()}@warthog.com.au`, wrappedDek: await keyWrapper.wrap(dek) });
  return { userId: user.id, dek };
}

async function makeAgent(db: Db, userId: string, name: string): Promise<string> {
  const agent = await createAgent(db, { userId, connectionId: randomUUID(), displayName: name, platform: "claude" }, systemClock);
  return agent.id;
}

function sessionFor(userId: string): Session {
  return { id: `sess-${userId}`, userId, createdAt: NOW, lastSeenAt: NOW, steppedUpAt: null };
}

async function suggest(db: Db, dek: Uint8Array, input: Omit<NewIdentitySuggestion, "source"> & { source?: NewIdentitySuggestion["source"] }): Promise<string> {
  const made = await suggestIdentityDetail(db, { source: SOURCE, ...input }, dek);
  assert.equal(made.outcome, "suggested", "fixture: the suggestion is stored");
  return made.id!;
}

async function suggestionStates(db: Db, userId: string): Promise<Array<{ id: string; state: string }>> {
  const result = await db.query("SELECT id, state FROM identity_suggestions WHERE user_id = $1 ORDER BY created_at, id", [userId]);
  return result.rows.map((row) => ({ id: String(row.id), state: String(row.state) }));
}

async function assertRejects4xx(label: string, fn: () => Promise<unknown>): Promise<void> {
  await assert.rejects(fn, (err: unknown) => {
    assert.ok(err instanceof HttpError, `${label}: rejected at the boundary, got ${String(err)}`);
    assert.ok(err.status >= 400 && err.status < 500, `${label}: a 4xx, got ${err.status}`);
    return true;
  });
}

test("load lists the person's own waiting suggestions, decrypted, with the suggesting agent's name", async () => {
  const db = await freshDb();
  const keyWrapper = localAesKeyWrapper(randomBytes(32));
  try {
    const { userId, dek } = await makeUser(db, keyWrapper, "sugg-load");
    const other = await makeUser(db, keyWrapper, "sugg-load-other");
    const claude = await makeAgent(db, userId, "Claude");
    const strangersAgent = await makeAgent(db, other.userId, "Not yours");

    const phone = await suggest(db, dek, { userId, kind: "phone", value: "0412 345 678", agentId: claude });
    const postal = await suggest(db, dek, {
      userId,
      kind: "postal_address",
      value: "12 Example St, Bondi NSW 2026",
      movingOn: "2027-01-15",
      agentId: strangersAgent,
      source: { service: "google-calendar", date: "2026-11-01" },
    });
    const gone = await suggest(db, dek, { userId, kind: "time_zone", value: "Australia/Sydney", agentId: randomUUID() });
    await suggest(db, other.dek, { userId: other.userId, kind: "email", value: "theirs@example.com", agentId: strangersAgent });

    const { suggestions } = await createIdentityActions({ db, keyWrapper }).load(sessionFor(userId));
    const byId = new Map(suggestions.map((s) => [s.id, s]));
    assert.deepEqual([...byId.keys()].sort(), [phone, postal, gone].sort(), "only this person's waiting suggestions");

    const p = byId.get(phone)!;
    assert.equal(p.kind, "phone");
    assert.equal(p.value, "0412 345 678", "the value is decrypted");
    assert.equal(p.movingOn, null);
    assert.equal(p.agentName, "Claude", "named by the person's own agent's name");
    assert.deepEqual(p.source, { service: "google-gmail", date: "2026-10-03", sender: "AGL <bills@agl.com.au>" }, "where it was found, without the message id");
    assert.ok(!p.differsFrom, "nothing of this kind is saved, so it differs from nothing");

    const a = byId.get(postal)!;
    assert.equal(a.value, "12 Example St, Bondi NSW 2026");
    assert.equal(a.movingOn, "2027-01-15", "an address keeps its moving-on date");
    assert.equal(a.agentName, "An agent", "another person's agent is never named");
    assert.deepEqual(a.source, { service: "google-calendar", date: "2026-11-01" });

    assert.equal(byId.get(gone)!.agentName, "An agent", "an agent that is no longer there");
    assert.ok(!JSON.stringify(suggestions).includes("theirs@example.com"), "another person's suggestion is never read");
    assert.ok(!JSON.stringify(suggestions).includes("msg-77"), "the message id never reaches the page");
  } finally {
    await db.close();
  }
});

test("load lists no suggestions when none are waiting", async () => {
  const db = await freshDb();
  const keyWrapper = localAesKeyWrapper(randomBytes(32));
  try {
    const { userId } = await makeUser(db, keyWrapper, "sugg-none");
    const data = await createIdentityActions({ db, keyWrapper }).load(sessionFor(userId));
    assert.deepEqual(data.suggestions, []);
  } finally {
    await db.close();
  }
});

test("an agent whose name would read as the person is quoted", async () => {
  const db = await freshDb();
  const keyWrapper = localAesKeyWrapper(randomBytes(32));
  try {
    const { userId, dek } = await makeUser(db, keyWrapper, "sugg-you");
    const sneaky = await makeAgent(db, userId, "You");
    await suggest(db, dek, { userId, kind: "language", value: "English", agentId: sneaky });
    const [only] = (await createIdentityActions({ db, keyWrapper }).load(sessionFor(userId))).suggestions;
    assert.equal(only!.agentName, "an agent called “You”");
  } finally {
    await db.close();
  }
});

test("a suggestion About you already holds is hidden; one that differs from the saved detail is marked", async () => {
  const db = await freshDb();
  const keyWrapper = localAesKeyWrapper(randomBytes(32));
  try {
    const { userId, dek } = await makeUser(db, keyWrapper, "sugg-stale");
    const agentId = await makeAgent(db, userId, "Claude");
    const stale = await suggest(db, dek, { userId, kind: "email", value: "phil@example.com", agentId });
    const differs = await suggest(db, dek, { userId, kind: "phone", value: "0499 999 999", agentId });
    const fresh = await suggest(db, dek, { userId, kind: "preferred_name", value: "Phil", agentId });
    // Saved by the person after the suggestion was made: the same address, written differently.
    await saveIdentityField(db, { userId, kind: "email", value: "  PHIL@Example.com " }, dek);
    await saveIdentityField(db, { userId, kind: "phone", value: "0412 000 000" }, dek);
    // A detail of another kind with the same text doesn't make the preferred name differ.
    await saveIdentityField(db, { userId, kind: "name", value: "Philip Levy" }, dek);

    const { suggestions } = await createIdentityActions({ db, keyWrapper }).load(sessionFor(userId));
    const ids = suggestions.map((s) => s.id);
    assert.ok(!ids.includes(stale), "the email About you already holds is not shown again");
    assert.equal(suggestions.find((s) => s.id === differs)?.differsFrom, true, "a different phone than the one saved");
    assert.ok(!suggestions.find((s) => s.id === fresh)?.differsFrom, "no preferred name is saved, so it differs from nothing");
    assert.deepEqual((await suggestionStates(db, userId)).map((s) => s.state), ["suggested", "suggested", "suggested"], "loading changes nothing");
  } finally {
    await db.close();
  }
});

test("Add saves the suggestion as an everyday detail and removes it", async () => {
  const db = await freshDb();
  const keyWrapper = localAesKeyWrapper(randomBytes(32));
  try {
    const { userId, dek } = await makeUser(db, keyWrapper, "sugg-accept");
    const agentId = await makeAgent(db, userId, "Claude");
    const postal = await suggest(db, dek, { userId, kind: "postal_address", value: "12 Example St, Bondi NSW 2026", movingOn: "2027-01-15", agentId });
    const phone = await suggest(db, dek, { userId, kind: "phone", value: "0412 345 678", agentId });
    const actions = createIdentityActions({ db, keyWrapper });

    assert.deepEqual(await actions.acceptSuggestion(sessionFor(userId), { id: postal }), { ok: true });

    const fields = await listIdentityFields(db, userId, dek);
    assert.deepEqual(fields.map((f) => [f.kind, f.value, f.movingOn]), [["postal_address", "12 Example St, Bondi NSW 2026", "2027-01-15"]]);
    assert.deepEqual((await suggestionStates(db, userId)).map((s) => s.id), [phone], "the accepted suggestion is gone; the other still waits");

    const data = await actions.load(sessionFor(userId));
    assert.deepEqual(data.suggestions.map((s) => s.id), [phone]);
    assert.ok(data.lowTierFields.some((f) => f.kind === "postal_address"), "it now lists as an everyday detail");

    assert.deepEqual(await actions.acceptSuggestion(sessionFor(userId), { id: postal }), { ok: false, reason: "not_found" }, "adding it twice saves nothing");
    assert.equal((await listIdentityFields(db, userId, dek)).length, 1);
  } finally {
    await db.close();
  }
});

test("Not mine declines the suggestion so it isn't suggested again", async () => {
  const db = await freshDb();
  const keyWrapper = localAesKeyWrapper(randomBytes(32));
  try {
    const { userId, dek } = await makeUser(db, keyWrapper, "sugg-decline");
    const agentId = await makeAgent(db, userId, "Claude");
    const id = await suggest(db, dek, { userId, kind: "email", value: "old@example.com", agentId });
    const actions = createIdentityActions({ db, keyWrapper });

    assert.deepEqual(await actions.declineSuggestion(sessionFor(userId), { id }), { ok: true });
    assert.deepEqual(await suggestionStates(db, userId), [{ id, state: "declined" }]);
    assert.deepEqual((await actions.load(sessionFor(userId))).suggestions, [], "a declined suggestion isn't shown");
    assert.equal((await listIdentityFields(db, userId, dek)).length, 0, "and nothing is saved");

    const again = await suggestIdentityDetail(db, { userId, kind: "email", value: "OLD@example.com", source: SOURCE, agentId }, dek);
    assert.equal(again.outcome, "declined_before", "the same detail is never suggested again");
    assert.deepEqual(await actions.declineSuggestion(sessionFor(userId), { id }), { ok: false, reason: "not_found" }, "declining twice changes nothing");
  } finally {
    await db.close();
  }
});

test("another person's suggestion id adds and declines nothing", async () => {
  const db = await freshDb();
  const keyWrapper = localAesKeyWrapper(randomBytes(32));
  try {
    const owner = await makeUser(db, keyWrapper, "sugg-owner");
    const intruder = await makeUser(db, keyWrapper, "sugg-intruder");
    const agentId = await makeAgent(db, owner.userId, "Claude");
    const id = await suggest(db, owner.dek, { userId: owner.userId, kind: "phone", value: "0412 345 678", agentId });
    const actions = createIdentityActions({ db, keyWrapper });

    // A userId smuggled in the input is ignored: the owner is always the session's.
    const smuggled = { id, userId: owner.userId } as unknown as { id: string };
    assert.deepEqual(await actions.acceptSuggestion(sessionFor(intruder.userId), smuggled), { ok: false, reason: "not_found" });
    assert.deepEqual(await actions.declineSuggestion(sessionFor(intruder.userId), smuggled), { ok: false, reason: "not_found" });
    assert.deepEqual(await actions.acceptSuggestion(sessionFor(intruder.userId), { id: randomUUID() }), { ok: false, reason: "not_found" });

    assert.deepEqual(await suggestionStates(db, owner.userId), [{ id, state: "suggested" }], "the owner's suggestion is untouched");
    assert.equal((await listIdentityFields(db, intruder.userId, intruder.dek)).length, 0, "nothing saved for the intruder");
    assert.equal((await listIdentityFields(db, owner.userId, owner.dek)).length, 0, "nor for the owner");
    assert.equal((await listIdentitySuggestions(db, owner.userId, owner.dek)).length, 1);
  } finally {
    await db.close();
  }
});

test("a malformed suggestion id is a 4xx before any query, and changes nothing", async () => {
  const db = await freshDb();
  const keyWrapper = localAesKeyWrapper(randomBytes(32));
  try {
    const { userId, dek } = await makeUser(db, keyWrapper, "sugg-bad-id");
    const agentId = await makeAgent(db, userId, "Claude");
    const id = await suggest(db, dek, { userId, kind: "phone", value: "0412 345 678", agentId });
    const actions = createIdentityActions({ db, keyWrapper });
    const session = sessionFor(userId);

    const probes: unknown[] = [{ id: "not-a-uuid" }, { id: "" }, { id: "1" }, { id: `${id}' OR '1'='1` }, { id: 42 }, {}, null];
    for (const probe of probes) {
      await assertRejects4xx(`accept ${JSON.stringify(probe)}`, () => actions.acceptSuggestion(session, probe as { id: string }));
      await assertRejects4xx(`decline ${JSON.stringify(probe)}`, () => actions.declineSuggestion(session, probe as { id: string }));
    }
    assert.deepEqual(await suggestionStates(db, userId), [{ id, state: "suggested" }]);
    assert.equal((await listIdentityFields(db, userId, dek)).length, 0);
  } finally {
    await db.close();
  }
});

// A suggestion the person answers by typing the same detail themselves no longer waits (so Home
// doesn't keep saying something waits to be checked).
test("saving a detail the agent also suggested clears that suggestion", async () => {
  const { freshDb } = await import("@/test/db");
  const { createUser } = await import("@/server/db/users");
  const { localAesKeyWrapper } = await import("@/server/crypto/key-wrapper");
  const { suggestIdentityDetail, countIdentitySuggestions } = await import("@/server/db/identity-suggestions");
  const { createIdentityActions } = await import("./actions");
  const { randomBytes, randomUUID } = await import("node:crypto");
  const db = await freshDb();
  try {
    const keyWrapper = localAesKeyWrapper(randomBytes(32));
    const dek = randomBytes(32);
    const user = await createUser(db, { email: `${randomUUID()}@warthog.com.au`, wrappedDek: await keyWrapper.wrap(dek) });
    await suggestIdentityDetail(db, { userId: user.id, kind: "phone", value: "0412 345 678", source: { service: "gmail", date: "2026-10-01" }, agentId: "a" }, dek);
    const actions = createIdentityActions({ db, keyWrapper });
    const session = { id: "s", userId: user.id, createdAt: new Date(), lastSeenAt: new Date(), steppedUpAt: null };
    await actions.saveLowTierField(session, { kind: "phone", value: "+61 412 345 678" });
    assert.equal(await countIdentitySuggestions(db, user.id), 0);
  } finally {
    await db.close();
  }
});
