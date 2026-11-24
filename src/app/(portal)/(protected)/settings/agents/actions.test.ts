// Settings › Agent defaults — saving the person's "what agents see" level (`./actions`,
// docs/adr/read-side-protection.md amendment 24 November 2026).
//
// Pins BEHAVIOUR: the save takes the level from the form, refuses anything but the three
// levels (nothing written), saves under the SESSION user only, and records the change in the
// person's activity as their own account change, by field name only. The outcome maps to a
// plain-words notice.
//
// Behaviour only: the real stores over an isolated PGlite with the real migrations. Every db
// handle is closed in a `finally`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";

import { createReadLevelActions, readLevelInputFromForm, readLevelNotice } from "./actions";
import { createUser } from "@/server/db/users";
import { getReadLevel } from "@/server/db/read-settings";
import { createSession, type Session } from "@/server/auth/session";
import { localAesKeyWrapper, type KeyWrapper } from "@/server/crypto/key-wrapper";
import { fixedClock } from "@/server/seams/clock";
import { systemRandom } from "@/server/seams/random";
import { readActivity } from "@/server/activity/writer";
import { activityCategory } from "@/domain/activity/category";
import { kindLabel } from "@/domain/activity/describe";
import { activityEvidence } from "@/domain/activity/evidence";
import { freshDb } from "@/test/db";
import type { Db } from "@/server/db/index";

const NOW = new Date("2026-11-24T12:00:00.000Z");

type Person = { userId: string; dek: Uint8Array; session: Session };

async function makePerson(db: Db, keyWrapper: KeyWrapper, who: string): Promise<Person> {
  const dek = randomBytes(32);
  const user = await createUser(db, { email: `${who}-${randomUUID()}@warthog.com.au`, wrappedDek: await keyWrapper.wrap(dek) });
  const { session } = await createSession(db, user.id, { clock: fixedClock(NOW), random: systemRandom });
  return { userId: user.id, dek, session };
}

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

test("saving a level stores it for the session person and records which way it moved", async () => {
  const db = await freshDb();
  try {
    const keyWrapper = localAesKeyWrapper(randomBytes(32));
    const person = await makePerson(db, keyWrapper, "reads-open");
    const actions = createReadLevelActions({ db, clock: fixedClock(NOW), keyWrapper });

    assert.deepEqual(await actions.setReadLevel(person.session, readLevelInputFromForm(form({ readLevel: "open" }))), { ok: true, level: "open" });
    assert.equal(await getReadLevel(db, person.userId), "open");

    const entries = await readActivity(db, person.userId, person.dek);
    const entry = entries.find((e) => e.kind === "read_level_change");
    assert.ok(entry, "the change is in the person's activity");
    assert.equal(entry.source, "warthog");
    assert.deepEqual(entry.payload, { actor: "account_owner", changes: { fields: ["readLevel"], from: "standard", to: "open" } });
    // Filed with the other changes to what agents can use and see.
    assert.equal(activityCategory({ kind: entry.kind, source: entry.source }, () => false), "access");
    assert.equal(kindLabel("read_level_change"), "What agents see changed");
    const evidence = activityEvidence(entry);
    assert.equal(evidence.changedBy, "you");
    assert.match(evidence.detail, /What changed: What agents see in your email and files: Standard → Everything/);

    // Saving the level they already have writes no second entry.
    await actions.setReadLevel(person.session, { level: "open" });
    assert.equal((await readActivity(db, person.userId, person.dek)).filter((e) => e.kind === "read_level_change").length, 1);
  } finally {
    await db.close();
  }
});

test("anything but the three levels is refused and nothing is saved or recorded", async () => {
  const db = await freshDb();
  try {
    const keyWrapper = localAesKeyWrapper(randomBytes(32));
    const person = await makePerson(db, keyWrapper, "reads-refused");
    const actions = createReadLevelActions({ db, clock: fixedClock(NOW), keyWrapper });
    for (const input of [readLevelInputFromForm(form({})), readLevelInputFromForm(form({ readLevel: "everything" })), { level: "Open" }, null, "open"]) {
      assert.deepEqual(await actions.setReadLevel(person.session, input), { ok: false, reason: "invalid_level" }, JSON.stringify(input));
    }
    assert.equal(await getReadLevel(db, person.userId), "standard");
    assert.equal((await readActivity(db, person.userId, person.dek)).filter((e) => e.kind === "read_level_change").length, 0);
  } finally {
    await db.close();
  }
});

test("a save lands only on the session person, whatever the form names", async () => {
  const db = await freshDb();
  try {
    const keyWrapper = localAesKeyWrapper(randomBytes(32));
    const alice = await makePerson(db, keyWrapper, "reads-alice");
    const bob = await makePerson(db, keyWrapper, "reads-bob");
    const actions = createReadLevelActions({ db, clock: fixedClock(NOW), keyWrapper });
    await actions.setReadLevel(alice.session, readLevelInputFromForm(form({ readLevel: "private", userId: bob.userId })));
    assert.equal(await getReadLevel(db, alice.userId), "private");
    assert.equal(await getReadLevel(db, bob.userId), "standard", "Bob's level is untouched");
    assert.equal((await readActivity(db, bob.userId, bob.dek)).filter((e) => e.kind === "read_level_change").length, 0);
  } finally {
    await db.close();
  }
});

test("each outcome reads as a plain notice", () => {
  assert.deepEqual(readLevelNotice("read-open"), { tone: "success", text: "Saved. What agents see is now Everything, from each agent's next request." });
  assert.deepEqual(readLevelNotice("read-private"), { tone: "success", text: "Saved. What agents see is now Private, from each agent's next request." });
  assert.equal(readLevelNotice("read-invalid")?.tone, "error");
  assert.match(readLevelNotice("read-invalid")!.text, /Nothing was saved/);
  for (const other of [undefined, "saved", "read-everything", "invalid"]) assert.equal(readLevelNotice(other), null, String(other));
});
