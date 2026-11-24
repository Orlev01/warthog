// The "what agents see" level store (`src/server/db/read-settings.ts`,
// `db/migrations/0124_read_settings.sql`, docs/adr/read-side-protection.md amendment 24 November
// 2026).
//
// Pinned contract:
//   getReadLevel(db, userId): Promise<ReadLevel>
//     • the person's stored level, or "standard" when they have set none (no row).
//   setReadLevel(db, { userId, level, clock }): Promise<
//     { ok: true; level: ReadLevel } | { ok: false; reason: "invalid_level" }>
//     • accepts only private, standard or open; anything else is refused BEFORE any query, so
//       nothing is written; a valid level upserts the person's one row.
//
// Behaviour only, against an isolated in-memory PGlite with the real migrations. Every db
// handle is closed in a `finally`.

import { test } from "node:test";
import assert from "node:assert/strict";

import { getReadLevel, setReadLevel } from "./read-settings";
import { createUser } from "./users";
import { loadMigrations, runMigrations, type Db } from "./index";
import { enqueueAccountPurge } from "./account-purge";
import { runAccountPurge } from "../account/purge-job";
import { createInMemoryBlobStore } from "../storage/blob";
import { fixedClock } from "../seams/clock";
import { freshDb } from "../../test/db";

const NOW = new Date("2026-11-24T09:00:00.000Z");
const clock = fixedClock(NOW);

async function makeUser(db: Db, who: string): Promise<string> {
  const user = await createUser(db, { email: `${who}@warthog.com.au`, wrappedDek: Buffer.from(`wrapped-dek-${who}`).toString("base64") });
  return user.id;
}

async function rowCount(db: Db, userId?: string): Promise<number> {
  const result = userId
    ? await db.query("SELECT count(*)::int AS n FROM read_settings WHERE user_id = $1", [userId])
    : await db.query("SELECT count(*)::int AS n FROM read_settings");
  return Number(result.rows[0]?.n ?? 0);
}

// A db stand-in that records every statement (to prove values are bound, not spliced).
function recordingDb(): Db & { calls: { text: string; values: unknown[] }[] } {
  const calls: { text: string; values: unknown[] }[] = [];
  return {
    calls,
    query(text: string, values: unknown[] = []) {
      calls.push({ text, values });
      return Promise.resolve({ rows: [] });
    },
    close() {
      return Promise.resolve();
    },
  };
}

test("a person who has set nothing reads standard", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "read-default");
    assert.equal(await getReadLevel(db, userId), "standard");
    assert.equal(await rowCount(db, userId), 0, "the default is assembled in code, not stored");
  } finally {
    await db.close();
  }
});

test("each level saves and reads back, and a second save overwrites the one row in place", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "read-setter");
    for (const level of ["open", "private", "standard"] as const) {
      assert.deepEqual(await setReadLevel(db, { userId, level, clock }), { ok: true, level });
      assert.equal(await getReadLevel(db, userId), level);
    }
    assert.equal(await rowCount(db, userId), 1, "one row per person");
    const later = fixedClock(new Date(NOW.getTime() + 60_000));
    await setReadLevel(db, { userId, level: "open", clock: later });
    const stored = await db.query("SELECT updated_at FROM read_settings WHERE user_id = $1", [userId]);
    assert.equal(new Date(stored.rows[0]!.updated_at as string).toISOString(), later.now().toISOString(), "updated_at is the injected clock's");
  } finally {
    await db.close();
  }
});

test("an unknown level is refused, nothing is written and a saved level is left as it was", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "read-refused");
    for (const level of ["Open", "everything", "", "none", null, undefined, 1]) {
      assert.deepEqual(await setReadLevel(db, { userId, level: level as never, clock }), { ok: false, reason: "invalid_level" }, String(level));
    }
    assert.equal(await rowCount(db), 0);
    await setReadLevel(db, { userId, level: "private", clock });
    assert.equal((await setReadLevel(db, { userId, level: "all" as never, clock })).ok, false);
    assert.equal(await getReadLevel(db, userId), "private");

    const recording = recordingDb();
    await setReadLevel(recording, { userId, level: "all" as never, clock });
    assert.equal(recording.calls.length, 0, "validation runs before any query");
  } finally {
    await db.close();
  }
});

test("the schema refuses an unknown level even if code is bypassed", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "read-schema");
    await assert.rejects(db.query("INSERT INTO read_settings (user_id, level, updated_at) VALUES ($1, $2, $3)", [userId, "everything", NOW.toISOString()]), /check|violates/i);
  } finally {
    await db.close();
  }
});

test("one person's level never changes another person's", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "alice-read");
    const bob = await makeUser(db, "bob-read");
    await setReadLevel(db, { userId: alice, level: "open", clock });
    assert.equal(await getReadLevel(db, alice), "open");
    assert.equal(await getReadLevel(db, bob), "standard", "Bob still reads the default");
    await setReadLevel(db, { userId: bob, level: "private", clock });
    assert.equal(await getReadLevel(db, alice), "open", "Bob's save never lands on Alice");
  } finally {
    await db.close();
  }
});

test("the user id and level travel as bound parameters, never spliced into the SQL", async () => {
  const probe = "u'); DROP TABLE read_settings; --";
  const db = recordingDb();
  await getReadLevel(db, probe);
  await setReadLevel(db, { userId: probe, level: "open", clock });
  assert.equal(db.calls.length, 2);
  for (const call of db.calls) {
    assert.ok(call.values.includes(probe), "the id is a bound value");
    assert.ok(!call.text.includes(probe));
  }
  assert.ok(db.calls[1]!.values.includes("open"), "the level is a bound value");
});

test("the level is removed with the account: a users-row delete cascades, and so does the purge job", async () => {
  const db = await freshDb();
  try {
    const gone = await makeUser(db, "read-deleted");
    const purged = await makeUser(db, "read-purged");
    const kept = await makeUser(db, "read-kept");
    for (const userId of [gone, purged, kept]) await setReadLevel(db, { userId, level: "open", clock });

    await db.query("DELETE FROM users WHERE id = $1", [gone]);
    assert.equal(await rowCount(db, gone), 0, "deleting the account removes its level");

    await enqueueAccountPurge(db, purged);
    await runAccountPurge(db, { blobStore: createInMemoryBlobStore() });
    assert.equal(await rowCount(db, purged), 0, "the purge job removes the level");

    assert.equal(await getReadLevel(db, kept), "open", "another account's level is untouched");
  } finally {
    await db.close();
  }
});

test("the migration is part of the project and the runtime role can read and write the table", async () => {
  const db = await freshDb();
  try {
    const migrations = await loadMigrations();
    assert.ok(migrations.some((m) => m.name === "0124_read_settings"), "0124_read_settings is a project migration");
    assert.deepEqual(await runMigrations(db, migrations), [], "re-running every migration changes nothing");
    for (const privilege of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
      const result = await db.query("SELECT has_table_privilege('warthog_app', 'read_settings', $1) AS p", [privilege]);
      assert.equal(result.rows[0]?.p, true, `warthog_app has ${privilege}`);
    }
  } finally {
    await db.close();
  }
});
