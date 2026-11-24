// About you suggestions (docs/adr/profile-build.md; migration 0125).
//
// An agent may SUGGEST a low-tier detail for About you (a preferred name, an email address, a
// phone number, a postal address with its moving-on date, a language or a time zone); the person
// confirms each one. Until they accept it a suggestion is not an identity field, so no agent can
// read it (get_context lists identity fields only). It is personal content, so the value and its
// provenance are stored only DEK-encrypted, bound to their row; the same suggestion is recognised
// by an opaque keyed match key, never a plain hash; and a declined suggestion keeps only that
// match key, so it is never suggested again.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";

import {
  acceptIdentitySuggestion,
  countIdentitySuggestions,
  declineIdentitySuggestion,
  listIdentitySuggestions,
  normaliseDetail,
  suggestIdentityDetail,
  type NewIdentitySuggestion,
} from "./identity-suggestions";
import { listIdentityFields, saveIdentityField } from "./identity-fields";
import { createUser } from "./users";
import { freshDb } from "../../test/db";
import { loadMigrations, withTransaction, type Db } from "./index";

const dek = () => randomBytes(32);
const AGENT = randomUUID();
const SOURCE = { service: "google-gmail", messageId: "msg-1", date: "2026-11-20", sender: "Energy Co <bills@energy.example>" };

async function makeUser(db: Db, who: string): Promise<string> {
  const user = await createUser(db, { email: `${who}@warthog.com.au`, wrappedDek: Buffer.from(`w-${who}`).toString("base64") });
  return user.id;
}

function suggestion(userId: string, over: Partial<NewIdentitySuggestion> = {}): NewIdentitySuggestion {
  return { userId, kind: "email", value: "phil.new@example.com", source: SOURCE, agentId: AGENT, ...over };
}

async function rows(db: Db, userId: string) {
  return (await db.query("SELECT id, kind, value, meta, source_agent_id, match_key, state FROM identity_suggestions WHERE user_id = $1 ORDER BY created_at, id", [userId])).rows;
}

test("normaliseDetail folds the differences that don't make a different detail", () => {
  assert.equal(normaliseDetail("email", "  Phil.New@Example.COM "), "phil.new@example.com");
  assert.equal(normaliseDetail("phone", " +61 (412) 345-678 "), "0412345678", "an Australian number written internationally is the same as 04…");
  assert.equal(normaliseDetail("phone", "0412 345 678"), "0412345678", "no country is ever added to a local number");
  assert.equal(normaliseDetail("phone", "+44 20 7946 0958"), "+442079460958", "other countries keep their +");
  assert.equal(normaliseDetail("phone", "(+61) 412 345 678"), "0412345678");
  assert.equal(normaliseDetail("phone", "61+412"), "61412", "a + that isn't leading is dropped");
  assert.equal(normaliseDetail("postal_address", "  12  Example St,\n Bondi   NSW 2026 "), "12 example st, bondi nsw 2026");
  assert.equal(normaliseDetail("preferred_name", "  Phil   "), "phil");
  assert.equal(normaliseDetail("language", " English  (Australia) "), "english (australia)");
  assert.equal(normaliseDetail("time_zone", " Australia/Sydney "), "australia/sydney");
});

test("a suggestion is stored only as envelopes bound to its row, and read back only with the owner's key", async () => {
  const db = await freshDb();
  try {
    const a = await makeUser(db, "suggest-enc");
    const key = dek();
    const first = await suggestIdentityDetail(db, suggestion(a), key);
    assert.equal(first.outcome, "suggested");
    await suggestIdentityDetail(db, suggestion(a, { kind: "postal_address", value: "12 Example St, Bondi NSW 2026", movingOn: "2027-01-15" }), key);

    for (const row of await rows(db, a)) {
      assert.match(String(row.value), /^v1:/, "the value is an envelope");
      assert.match(String(row.meta), /^v1:/, "the provenance is an envelope");
      for (const plain of ["phil.new", "Example St", "Energy Co", "bills@energy", "msg-1", "google-gmail", "2027-01-15"]) {
        for (const column of ["value", "meta", "match_key"] as const) {
          assert.doesNotMatch(String(row[column]), new RegExp(plain.replace(/[.]/g, "\\.")), `no plaintext "${plain}" in ${column}`);
        }
      }
      assert.equal(row.source_agent_id, AGENT, "the suggesting agent is kept as plain metadata");
      assert.equal(row.state, "suggested");
    }

    const listed = (await listIdentitySuggestions(db, a, key)).sort((x, y) => x.kind.localeCompare(y.kind));
    assert.deepEqual(listed.map((s) => [s.kind, s.value, s.movingOn]), [
      ["email", "phil.new@example.com", null],
      ["postal_address", "12 Example St, Bondi NSW 2026", "2027-01-15"],
    ]);
    assert.deepEqual(listed[0]!.source, SOURCE);
    assert.equal(listed[0]!.agentId, AGENT);
    assert.ok(!Number.isNaN(Date.parse(listed[0]!.createdAt)), "createdAt is a timestamp");

    await assert.rejects(listIdentitySuggestions(db, a, dek()), "the wrong data key can't decrypt them");
  } finally {
    await db.close();
  }
});

test("an envelope moved to another row fails to decrypt", async () => {
  const db = await freshDb();
  try {
    const a = await makeUser(db, "suggest-move");
    const key = dek();
    await suggestIdentityDetail(db, suggestion(a, { value: "one@example.com" }), key);
    await suggestIdentityDetail(db, suggestion(a, { value: "two@example.com" }), key);
    const [one, two] = await rows(db, a);
    await db.query("UPDATE identity_suggestions SET value = $1 WHERE id = $2", [one!.value, two!.id]);
    await assert.rejects(listIdentitySuggestions(db, a, key), "a value lifted into another row is refused");

    await db.query("UPDATE identity_suggestions SET value = $1, meta = $2 WHERE id = $3", [two!.value, one!.meta, two!.id]);
    await assert.rejects(listIdentitySuggestions(db, a, key), "provenance lifted into another row is refused");
    await assert.rejects(acceptIdentitySuggestion(db, a, String(two!.id), key), "accepting a tampered row fails");
    assert.equal((await listIdentityFields(db, a, key)).length, 0, "and saves nothing");
    assert.equal(await countIdentitySuggestions(db, a), 2, "the failed accept rolled back its delete");
  } finally {
    await db.close();
  }
});

test("the match key is keyed per person, never a plain hash of the detail", async () => {
  const db = await freshDb();
  try {
    const a = await makeUser(db, "suggest-key-a");
    const b = await makeUser(db, "suggest-key-b");
    await suggestIdentityDetail(db, suggestion(a, { value: "shared@example.com" }), dek());
    await suggestIdentityDetail(db, suggestion(b, { value: "shared@example.com" }), dek());
    const keyA = String((await rows(db, a))[0]!.match_key);
    const keyB = String((await rows(db, b))[0]!.match_key);
    assert.notEqual(keyA, keyB, "the same detail has a different key for each person");
    for (const plain of ["shared@example.com", "emailshared@example.com", "email\u001fshared@example.com", "email:shared@example.com"]) {
      assert.notEqual(keyA, createHash("sha256").update(plain).digest("hex"), "not an unkeyed SHA-256");
    }
  } finally {
    await db.close();
  }
});

test("suggestions are the person's own: another person's id reads, accepts and declines nothing", async () => {
  const db = await freshDb();
  try {
    const a = await makeUser(db, "suggest-own-a");
    const b = await makeUser(db, "suggest-own-b");
    const keyA = dek();
    const keyB = dek();
    const made = await suggestIdentityDetail(db, suggestion(a), keyA);
    assert.equal(made.outcome, "suggested");
    const id = made.id!;

    assert.deepEqual(await listIdentitySuggestions(db, b, keyB), [], "another person lists none");
    assert.equal(await countIdentitySuggestions(db, b), 0);
    assert.equal(await acceptIdentitySuggestion(db, b, id, keyB), undefined, "another person can't accept it");
    assert.equal(await declineIdentitySuggestion(db, b, id), false, "another person can't decline it");
    assert.equal((await listIdentityFields(db, b, keyB)).length, 0);

    assert.equal(await countIdentitySuggestions(db, a), 1, "the owner's suggestion is untouched");
    assert.equal((await rows(db, a))[0]!.state, "suggested");

    // The same detail suggested to another person is theirs alone.
    assert.equal((await suggestIdentityDetail(db, suggestion(b), keyB)).outcome, "suggested");
  } finally {
    await db.close();
  }
});

test("a detail About you already holds is not suggested again, and nothing is written", async () => {
  const db = await freshDb();
  try {
    const a = await makeUser(db, "suggest-saved");
    const key = dek();
    await saveIdentityField(db, { userId: a, kind: "email", value: "Phil.New@Example.com" }, key);
    await saveIdentityField(db, { userId: a, kind: "phone", value: "+61 412 345 678" }, key);
    await saveIdentityField(db, { userId: a, kind: "postal_address", value: "12 Example St, Bondi NSW 2026" }, key);

    assert.deepEqual(await suggestIdentityDetail(db, suggestion(a, { value: " phil.new@example.COM " }), key), { outcome: "already_saved" });
    assert.deepEqual(await suggestIdentityDetail(db, suggestion(a, { kind: "phone", value: "+61412345678" }), key), { outcome: "already_saved" });
    assert.deepEqual(
      await suggestIdentityDetail(db, suggestion(a, { kind: "postal_address", value: "12 example st,  bondi nsw 2026", movingOn: "2027-02-01" }), key),
      { outcome: "already_saved" },
    );
    assert.equal((await rows(db, a)).length, 0, "no suggestion row was written");
  } finally {
    await db.close();
  }
});

test("a different value from a saved field of that kind is suggested, and the saved field is never changed", async () => {
  const db = await freshDb();
  try {
    const a = await makeUser(db, "suggest-different");
    const key = dek();
    const home = await saveIdentityField(db, { userId: a, kind: "postal_address", value: "1 Old Rd, Newtown NSW 2042" }, key);
    const name = await saveIdentityField(db, { userId: a, kind: "preferred_name", value: "Philip" }, key);

    assert.equal((await suggestIdentityDetail(db, suggestion(a, { kind: "postal_address", value: "12 Example St, Bondi NSW 2026", movingOn: "2027-01-15" }), key)).outcome, "suggested");
    assert.equal((await suggestIdentityDetail(db, suggestion(a, { kind: "preferred_name", value: "Phil" }), key)).outcome, "suggested");
    // The same text under another kind is a different detail.
    assert.equal((await suggestIdentityDetail(db, suggestion(a, { kind: "language", value: "Philip" }), key)).outcome, "suggested");

    const fields = await listIdentityFields(db, a, key);
    assert.deepEqual(
      fields.map((f) => [f.id, f.kind, f.value, f.movingOn]).sort(),
      [[home.id, "postal_address", "1 Old Rd, Newtown NSW 2042", null], [name.id, "preferred_name", "Philip", null]].sort(),
      "the saved fields are exactly as they were",
    );
    assert.equal(await countIdentitySuggestions(db, a), 3);
  } finally {
    await db.close();
  }
});

test("the same suggestion twice is kept once", async () => {
  const db = await freshDb();
  try {
    const a = await makeUser(db, "suggest-twice");
    const key = dek();
    assert.equal((await suggestIdentityDetail(db, suggestion(a), key)).outcome, "suggested");
    assert.deepEqual(await suggestIdentityDetail(db, suggestion(a, { value: "  PHIL.NEW@example.com" }), key), { outcome: "already_suggested" });
    assert.deepEqual(await suggestIdentityDetail(db, suggestion(a, { agentId: randomUUID() }), key), { outcome: "already_suggested" }, "even from another agent");
    assert.equal((await rows(db, a)).length, 1);

    // Two agents suggesting at the same moment still leave one row.
    const both = await Promise.all([
      suggestIdentityDetail(db, suggestion(a, { kind: "phone", value: "+61 400 000 001" }), key),
      suggestIdentityDetail(db, suggestion(a, { kind: "phone", value: "+61400000001" }), key),
    ]);
    assert.deepEqual(both.map((r) => r.outcome).sort(), ["already_suggested", "suggested"]);
    assert.equal(await countIdentitySuggestions(db, a), 2);
  } finally {
    await db.close();
  }
});

test("a declined suggestion keeps only its match key and is never suggested again", async () => {
  const db = await freshDb();
  try {
    const a = await makeUser(db, "suggest-decline");
    const key = dek();
    const made = await suggestIdentityDetail(db, suggestion(a), key);
    const keep = await suggestIdentityDetail(db, suggestion(a, { kind: "time_zone", value: "Australia/Sydney" }), key);

    assert.equal(await declineIdentitySuggestion(db, a, made.id!), true);
    assert.equal(await declineIdentitySuggestion(db, a, made.id!), false, "declining twice changes nothing");

    const row = (await rows(db, a)).find((r) => r.id === made.id)!;
    assert.equal(row.state, "declined");
    assert.equal(row.value, null, "the value is gone");
    assert.equal(row.meta, null, "the provenance is gone");
    assert.equal(row.source_agent_id, null, "the agent is gone");
    assert.match(String(row.match_key), /^[0-9a-f]{64}$/, "only the opaque match key remains");

    assert.deepEqual((await listIdentitySuggestions(db, a, key)).map((s) => s.id), [keep.id], "a declined suggestion is not listed");
    assert.equal(await countIdentitySuggestions(db, a), 1, "nor counted");
    assert.deepEqual(await suggestIdentityDetail(db, suggestion(a, { value: "Phil.New@example.com", agentId: randomUUID() }), key), { outcome: "declined_before" });
    assert.equal(await acceptIdentitySuggestion(db, a, made.id!, key), undefined, "a declined suggestion can't be accepted");
    assert.equal((await listIdentityFields(db, a, key)).length, 0);
  } finally {
    await db.close();
  }
});

test("accepting a suggestion saves it About you (with an address's moving-on date) and removes the suggestion", async () => {
  const db = await freshDb();
  try {
    const a = await makeUser(db, "suggest-accept");
    const key = dek();
    const address = await suggestIdentityDetail(db, suggestion(a, { kind: "postal_address", value: "12 Example St, Bondi NSW 2026", movingOn: "2027-01-15" }), key);
    const email = await suggestIdentityDetail(db, suggestion(a), key);

    const saved = await withTransaction(db, (tx) => acceptIdentitySuggestion(tx, a, address.id!, key));
    assert.ok(saved);
    assert.equal(saved.kind, "postal_address");
    assert.equal(saved.value, "12 Example St, Bondi NSW 2026");
    assert.equal(saved.movingOn, "2027-01-15");

    const fields = await listIdentityFields(db, a, key);
    assert.deepEqual(fields.map((f) => [f.id, f.kind, f.value, f.movingOn]), [[saved.id, "postal_address", "12 Example St, Bondi NSW 2026", "2027-01-15"]]);
    assert.deepEqual((await listIdentitySuggestions(db, a, key)).map((s) => s.id), [email.id], "the accepted suggestion is gone");
    assert.equal((await db.query("SELECT 1 FROM identity_suggestions WHERE id = $1", [address.id])).rows.length, 0, "deleted, not kept");
    assert.equal(await acceptIdentitySuggestion(db, a, address.id!, key), undefined, "accepting twice saves nothing more");

    // Accepting without an open transaction runs in one of its own.
    const accepted = await acceptIdentitySuggestion(db, a, email.id!, key);
    assert.equal(accepted?.value, "phil.new@example.com");
    assert.equal(accepted?.movingOn, null);
    assert.equal(await countIdentitySuggestions(db, a), 0);

    // Now saved, the same detail is not suggested again.
    assert.deepEqual(await suggestIdentityDetail(db, suggestion(a), key), { outcome: "already_saved" });
  } finally {
    await db.close();
  }
});

test("accepting a detail the person has since saved themselves doesn't save it twice", async () => {
  const db = await freshDb();
  try {
    const a = await makeUser(db, "suggest-accept-dup");
    const key = dek();
    const made = await suggestIdentityDetail(db, suggestion(a), key);
    const own = await saveIdentityField(db, { userId: a, kind: "email", value: "Phil.New@Example.com" }, key);
    const accepted = await acceptIdentitySuggestion(db, a, made.id!, key);
    assert.equal(accepted?.id, own.id, "the field they already have is returned");
    assert.equal((await listIdentityFields(db, a, key)).length, 1);
    assert.equal(await countIdentitySuggestions(db, a), 0, "the suggestion is gone");
  } finally {
    await db.close();
  }
});

test("a suggestion never appears among the person's identity fields", async () => {
  const db = await freshDb();
  try {
    const a = await makeUser(db, "suggest-hidden");
    const key = dek();
    await saveIdentityField(db, { userId: a, kind: "name", value: "Phil Example" }, key);
    for (const [kind, value] of [["preferred_name", "Phil"], ["email", "phil@example.com"], ["phone", "+61 400 000 000"], ["postal_address", "12 Example St"], ["language", "English"], ["time_zone", "Australia/Sydney"]] as const) {
      assert.equal((await suggestIdentityDetail(db, suggestion(a, { kind, value }), key)).outcome, "suggested", kind);
    }
    assert.deepEqual((await listIdentityFields(db, a, key)).map((f) => f.value), ["Phil Example"], "only what the person saved");
    assert.equal(await countIdentitySuggestions(db, a), 6);
  } finally {
    await db.close();
  }
});

test("what a suggestion may hold is checked before anything is written", async () => {
  const db = await freshDb();
  try {
    const a = await makeUser(db, "suggest-input");
    const key = dek();
    await assert.rejects(suggestIdentityDetail(db, suggestion(a, { value: "   " }), key), /empty/i);
    await assert.rejects(suggestIdentityDetail(db, suggestion(a, { kind: "name" as never, value: "Phil" }), key), /kind/i, "a name is never suggested");
    await assert.rejects(suggestIdentityDetail(db, suggestion(a, { kind: "passport" as never, value: "X1" }), key), /kind/i);
    await assert.rejects(suggestIdentityDetail(db, suggestion(a, { kind: "postal_address", value: "1 St", movingOn: "next March" }), key), /date/i);
    await assert.rejects(suggestIdentityDetail(db, suggestion(a, { kind: "postal_address", value: "1 St", movingOn: "2027-02-30" }), key), /date/i);
    assert.equal((await rows(db, a)).length, 0);

    // A moving-on date belongs to an address only.
    await suggestIdentityDetail(db, suggestion(a, { kind: "phone", value: "+61 400 000 000", movingOn: "2027-01-01" }), key);
    // The value is kept as given, apart from surrounding whitespace.
    await suggestIdentityDetail(db, suggestion(a, { value: "  Phil.New@Example.com " }), key);
    const byKind = new Map((await listIdentitySuggestions(db, a, key)).map((s) => [s.kind, s]));
    assert.equal(byKind.get("phone")!.movingOn, null);
    assert.equal(byKind.get("email")!.value, "Phil.New@Example.com");
  } finally {
    await db.close();
  }
});

test("a malformed or guessed id is simply not found, and never reaches SQL text", async () => {
  const db = await freshDb();
  try {
    const a = await makeUser(db, "suggest-ids");
    const key = dek();
    await suggestIdentityDetail(db, suggestion(a), key);
    for (const id of ["not-a-uuid", "x'); DROP TABLE identity_suggestions; --", "", randomUUID()]) {
      assert.equal(await acceptIdentitySuggestion(db, a, id, key), undefined, `accept ${id}`);
      assert.equal(await declineIdentitySuggestion(db, a, id), false, `decline ${id}`);
    }
    assert.equal(await countIdentitySuggestions(db, a), 1, "the table and the suggestion survive");
  } finally {
    await db.close();
  }
});

test("suggestions are listed oldest first", async () => {
  const db = await freshDb();
  try {
    const a = await makeUser(db, "suggest-order");
    const key = dek();
    const made: string[] = [];
    for (const value of ["c@example.com", "a@example.com", "b@example.com"]) {
      made.push((await suggestIdentityDetail(db, suggestion(a, { value }), key)).id!);
    }
    // (PGlite's clock ticks in milliseconds, so the test sets the times rather than relying on them.)
    for (const [id, daysAgo] of [[made[0], 2], [made[1], 1], [made[2], 3]] as const) {
      await db.query("UPDATE identity_suggestions SET created_at = now() - make_interval(days => $2) WHERE id = $1", [id, daysAgo]);
    }
    assert.deepEqual((await listIdentitySuggestions(db, a, key)).map((s) => s.id), [made[2], made[0], made[1]]);
  } finally {
    await db.close();
  }
});

test("the table refuses plaintext, unknown kinds and a declined row that still holds its detail", async () => {
  const db = await freshDb();
  try {
    const a = await makeUser(db, "suggest-checks");
    const insert = (over: { kind?: string; value?: string | null; meta?: string | null; agent?: string | null; key?: string; state?: string }) =>
      db.query(
        `INSERT INTO identity_suggestions (id, user_id, kind, value, meta, source_agent_id, match_key, state)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [randomUUID(), a, over.kind ?? "email", over.value === undefined ? "v1:x" : over.value, over.meta === undefined ? "v1:y" : over.meta,
          over.agent === undefined ? AGENT : over.agent, over.key ?? randomUUID(), over.state ?? "suggested"],
      );

    await insert({});
    await assert.rejects(insert({ kind: "passport" }), "an unknown kind is refused");
    await assert.rejects(insert({ kind: "name" }), "a name is not a suggestible kind");
    await assert.rejects(insert({ value: "phil@example.com" }), "a plaintext value is refused");
    await assert.rejects(insert({ meta: '{"source":{}}' }), "plaintext provenance is refused");
    await assert.rejects(insert({ value: null }), "a suggestion without a value is refused");
    await assert.rejects(insert({ meta: null }), "a suggestion without provenance is refused");
    await assert.rejects(insert({ state: "accepted" }), "an unknown state is refused");
    await insert({ state: "declined", value: null, meta: null, agent: null });
    await assert.rejects(insert({ state: "declined" }), "a declined suggestion can't keep its value or provenance");
    await assert.rejects(insert({ state: "declined", value: null }), "nor its provenance");
    await assert.rejects(insert({ state: "declined", value: null, meta: null }), "nor its agent");
    await insert({ key: "same" });
    await assert.rejects(insert({ key: "same" }), "one row per match key per person");
    const b = await makeUser(db, "suggest-checks-b");
    await db.query(
      `INSERT INTO identity_suggestions (id, user_id, kind, value, meta, source_agent_id, match_key, state) VALUES ($1, $2, 'email', 'v1:x', 'v1:y', NULL, 'same', 'suggested')`,
      [randomUUID(), b],
    );
  } finally {
    await db.close();
  }
});

test("the app role can use the table, and an account purge removes every suggestion", async () => {
  const db = await freshDb();
  try {
    const role = await db.query("SELECT 1 FROM pg_roles WHERE rolname = 'warthog_app'");
    if (role.rows.length) {
      for (const privilege of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
        const has = await db.query("SELECT has_table_privilege('warthog_app', 'identity_suggestions', $1) AS ok", [privilege]);
        assert.equal(has.rows[0]!.ok, true, `warthog_app has ${privilege}`);
      }
    }

    const a = await makeUser(db, "suggest-purge");
    const b = await makeUser(db, "suggest-purge-b");
    const key = dek();
    const made = await suggestIdentityDetail(db, suggestion(a), key);
    await suggestIdentityDetail(db, suggestion(a, { kind: "phone", value: "+61 400 000 000" }), key);
    await declineIdentitySuggestion(db, a, made.id!);
    await suggestIdentityDetail(db, suggestion(b), dek());

    const purgeRole = await db.query("SELECT 1 FROM pg_roles WHERE rolname = 'warthog_purge'");
    if (purgeRole.rows.length) await db.query("SET ROLE warthog_purge");
    try {
      await db.query("DELETE FROM users WHERE id = $1", [a]);
    } finally {
      if (purgeRole.rows.length) await db.query("RESET ROLE");
    }
    assert.equal((await db.query("SELECT 1 FROM identity_suggestions WHERE user_id = $1", [a])).rows.length, 0, "suggested and declined rows go with the account");
    assert.equal(await countIdentitySuggestions(db, b), 1, "another person's are kept");
  } finally {
    await db.close();
  }
});

test("migration 0125 is part of the project", async () => {
  const all = await loadMigrations();
  assert.ok(all.some((m) => m.name === "0125_identity_suggestions"), "0125_identity_suggestions is a project migration");
});

test("a waiting suggestion the person has since saved themselves is removed, not left waiting", async () => {
  const db = await freshDb();
  try {
    const { createUser } = await import("./users");
    const { saveIdentityField } = await import("./identity-fields");
    const { pruneSavedSuggestions, suggestIdentityDetail, listIdentitySuggestions, countIdentitySuggestions } = await import("./identity-suggestions");
    const { randomBytes, randomUUID } = await import("node:crypto");
    const dek = randomBytes(32);
    const user = await createUser(db, { email: `${randomUUID()}@warthog.com.au`, wrappedDek: "w" });
    const source = { service: "gmail", date: "2026-10-01" };
    await suggestIdentityDetail(db, { userId: user.id, kind: "phone", value: "0412 345 678", source, agentId: "a" }, dek);
    await suggestIdentityDetail(db, { userId: user.id, kind: "email", value: "me@work.example", source, agentId: "a" }, dek);
    await saveIdentityField(db, { userId: user.id, kind: "phone", value: "+0412345678".replace("+", "") }, dek);
    assert.equal(await pruneSavedSuggestions(db, user.id, dek), 1);
    assert.deepEqual((await listIdentitySuggestions(db, user.id, dek)).map((item) => item.kind), ["email"]);
    assert.equal(await countIdentitySuggestions(db, user.id), 1);
    assert.equal(await pruneSavedSuggestions(db, user.id, dek), 0, "nothing else to remove");
  } finally {
    await db.close();
  }
});

test("adding a different preferred name, time zone or language replaces the person's one, never leaving two", async () => {
  const db = await freshDb();
  try {
    const { createUser } = await import("./users");
    const { saveIdentityField, listIdentityFields } = await import("./identity-fields");
    const { acceptIdentitySuggestion, suggestIdentityDetail } = await import("./identity-suggestions");
    const { randomBytes, randomUUID } = await import("node:crypto");
    const dek = randomBytes(32);
    const user = await createUser(db, { email: `${randomUUID()}@warthog.com.au`, wrappedDek: "w" });
    await saveIdentityField(db, { userId: user.id, kind: "preferred_name", value: "Al" }, dek);
    await saveIdentityField(db, { userId: user.id, kind: "phone", value: "0400 000 000" }, dek);
    const source = { service: "gmail", date: "2026-10-01" };
    const name = await suggestIdentityDetail(db, { userId: user.id, kind: "preferred_name", value: "Alex", source, agentId: "a" }, dek);
    const phone = await suggestIdentityDetail(db, { userId: user.id, kind: "phone", value: "0412 345 678", source, agentId: "a" }, dek);
    await acceptIdentitySuggestion(db, user.id, (name as { id: string }).id, dek);
    await acceptIdentitySuggestion(db, user.id, (phone as { id: string }).id, dek);
    const fields = await listIdentityFields(db, user.id, dek);
    assert.deepEqual(fields.filter((field) => field.kind === "preferred_name").map((field) => field.value), ["Alex"], "replaced");
    assert.deepEqual(fields.filter((field) => field.kind === "phone").map((field) => field.value).sort(), ["0400 000 000", "0412 345 678"], "a second phone is a second phone");
  } finally {
    await db.close();
  }
});
