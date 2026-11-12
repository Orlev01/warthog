// Approval expiry setting store (`src/server/db/approval-settings.ts`,
// `db/migrations/0109_approval_settings.sql`).
//
// Brief "Rules and approvals": rules include "an approval expiry time", and "approvals
// expire after the configured time (default 15 minutes, adjustable from 2 minutes to 24
// hours) and an expired request is denied." This store holds the one per-person value:
// PLAINTEXT METADATA (a whole number of minutes), member-scoped by the session's user id,
// never a client value.
//
// Pinned contract:
//   getApprovalExpiryMinutes(db, userId): Promise<number>
//     • the person's stored minutes, or 15 when they have set none (no row).
//   setApprovalExpiryMinutes(db, { userId, minutes, now }): Promise<
//     { ok: true; minutes: number } | { ok: false; reason: "invalid_expiry" }>
//     • accepts only a whole number from 2 to 1440; anything else is refused BEFORE any
//       query, so nothing is written; a valid value upserts the person's one row.
//
// Behaviour only, against an isolated in-memory PGlite with the real migrations. Every db
// handle is closed in a `finally`.

import { test } from "node:test";
import assert from "node:assert/strict";

import { getApprovalExpiryMinutes, setApprovalExpiryMinutes } from "./approval-settings";
import { createUser } from "./users";
import { loadMigrations, runMigrations, type Db } from "./index";
import { enqueueAccountPurge } from "./account-purge";
import { runAccountPurge } from "../account/purge-job";
import { createInMemoryBlobStore } from "../storage/blob";
import { freshDb } from "../../test/db";

const NOW = new Date("2026-11-13T09:00:00.000Z");

async function makeUser(db: Db, who: string): Promise<string> {
  const user = await createUser(db, {
    email: `${who}@warthog.com.au`,
    wrappedDek: Buffer.from(`wrapped-dek-${who}`).toString("base64"),
  });
  return user.id;
}

async function rowCount(db: Db, userId?: string): Promise<number> {
  const result = userId
    ? await db.query("SELECT count(*)::int AS n FROM approval_settings WHERE user_id = $1", [userId])
    : await db.query("SELECT count(*)::int AS n FROM approval_settings");
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

test("a person who has set nothing reads the default of 15 minutes", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "default-reader");
    assert.equal(await getApprovalExpiryMinutes(db, userId), 15);
    assert.equal(await rowCount(db, userId), 0, "the default is assembled in code, not stored");
  } finally {
    await db.close();
  }
});

test("a set value reads back, and a second set overwrites the one row in place", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "setter");
    assert.deepEqual(await setApprovalExpiryMinutes(db, { userId, minutes: 120, now: NOW }), { ok: true, minutes: 120 });
    assert.equal(await getApprovalExpiryMinutes(db, userId), 120);

    const later = new Date(NOW.getTime() + 60_000);
    assert.deepEqual(await setApprovalExpiryMinutes(db, { userId, minutes: 2, now: later }), { ok: true, minutes: 2 });
    assert.equal(await getApprovalExpiryMinutes(db, userId), 2);
    assert.equal(await rowCount(db, userId), 1, "one row per person");

    const stored = await db.query("SELECT updated_at FROM approval_settings WHERE user_id = $1", [userId]);
    assert.equal(new Date(stored.rows[0]!.updated_at as string).toISOString(), later.toISOString(), "updated_at is the injected now");
  } finally {
    await db.close();
  }
});

test("both ends of the range are accepted: 2 minutes and 24 hours", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "bounds");
    assert.equal((await setApprovalExpiryMinutes(db, { userId, minutes: 2, now: NOW })).ok, true);
    assert.equal(await getApprovalExpiryMinutes(db, userId), 2);
    assert.equal((await setApprovalExpiryMinutes(db, { userId, minutes: 1440, now: NOW })).ok, true);
    assert.equal(await getApprovalExpiryMinutes(db, userId), 1440);
  } finally {
    await db.close();
  }
});

test("out-of-range and non-integer values are refused and nothing is written", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "refused");
    for (const minutes of [1, 0, -15, 1441, 100_000, 15.5, 2.0001, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.deepEqual(
        await setApprovalExpiryMinutes(db, { userId, minutes, now: NOW }),
        { ok: false, reason: "invalid_expiry" },
        `${minutes} is refused`,
      );
    }
    assert.equal(await rowCount(db), 0, "no refused value wrote a row");
    assert.equal(await getApprovalExpiryMinutes(db, userId), 15, "the default still applies");

    // A refusal leaves a previously saved value untouched.
    await setApprovalExpiryMinutes(db, { userId, minutes: 30, now: NOW });
    assert.equal((await setApprovalExpiryMinutes(db, { userId, minutes: 1441, now: NOW })).ok, false);
    assert.equal(await getApprovalExpiryMinutes(db, userId), 30);
  } finally {
    await db.close();
  }
});

test("a refused value never reaches the database at all", async () => {
  const db = recordingDb();
  for (const minutes of [1, 1441, 15.5, Number.NaN]) {
    await setApprovalExpiryMinutes(db, { userId: "00000000-0000-4000-8000-000000000001", minutes, now: NOW });
  }
  assert.equal(db.calls.length, 0, "validation runs before any query");
});

test("one person's setting never changes another person's", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "alice-expiry");
    const bob = await makeUser(db, "bob-expiry");
    await setApprovalExpiryMinutes(db, { userId: alice, minutes: 240, now: NOW });
    assert.equal(await getApprovalExpiryMinutes(db, alice), 240);
    assert.equal(await getApprovalExpiryMinutes(db, bob), 15, "Bob still reads the default");

    await setApprovalExpiryMinutes(db, { userId: bob, minutes: 5, now: NOW });
    assert.equal(await getApprovalExpiryMinutes(db, alice), 240, "Bob's set never lands on Alice");
    assert.equal(await getApprovalExpiryMinutes(db, bob), 5);
  } finally {
    await db.close();
  }
});

test("the user id and minutes travel as bound parameters, never spliced into the SQL", async () => {
  const probe = "u'); DROP TABLE approval_settings; --";
  const db = recordingDb();
  await getApprovalExpiryMinutes(db, probe);
  await setApprovalExpiryMinutes(db, { userId: probe, minutes: 30, now: NOW });
  assert.equal(db.calls.length, 2);
  for (const call of db.calls) {
    assert.ok(call.values.includes(probe), "the id is a bound value");
    assert.ok(!call.text.includes(probe), "the id never appears in the SQL text");
    assert.ok(!/DROP\s+TABLE/i.test(call.text));
  }
  assert.ok(db.calls[1]!.values.includes(30), "the minutes are a bound value");
});

test("the schema refuses an out-of-range value even if code is bypassed", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "schema-guard");
    for (const minutes of [1, 1441]) {
      await assert.rejects(
        db.query("INSERT INTO approval_settings (user_id, expiry_minutes, updated_at) VALUES ($1, $2, $3)", [
          userId,
          minutes,
          NOW.toISOString(),
        ]),
        /check|violates/i,
      );
    }
  } finally {
    await db.close();
  }
});

test("the setting is removed with the account: a users-row delete cascades, and so does the purge job", async () => {
  const db = await freshDb();
  try {
    const gone = await makeUser(db, "deleted-account");
    const purged = await makeUser(db, "purged-account");
    const kept = await makeUser(db, "kept-account");
    for (const userId of [gone, purged, kept]) await setApprovalExpiryMinutes(db, { userId, minutes: 60, now: NOW });

    await db.query("DELETE FROM users WHERE id = $1", [gone]);
    assert.equal(await rowCount(db, gone), 0, "deleting the account removes its setting");

    await enqueueAccountPurge(db, purged);
    await runAccountPurge(db, { blobStore: createInMemoryBlobStore() });
    assert.equal(await rowCount(db, purged), 0, "the purge job removes the setting");

    assert.equal(await getApprovalExpiryMinutes(db, kept), 60, "another account's setting is untouched");
  } finally {
    await db.close();
  }
});

test("the migration is part of the project and the runtime role can read and write the table", async () => {
  const db = await freshDb();
  try {
    const migrations = await loadMigrations();
    assert.ok(migrations.some((m) => m.name === "0109_approval_settings"), "0109_approval_settings is a project migration");
    assert.deepEqual(await runMigrations(db, migrations), [], "re-running every migration changes nothing");

    for (const privilege of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
      const result = await db.query("SELECT has_table_privilege('warthog_app', 'approval_settings', $1) AS p", [privilege]);
      assert.equal(result.rows[0]?.p, true, `warthog_app has ${privilege}`);
    }
  } finally {
    await db.close();
  }
});
