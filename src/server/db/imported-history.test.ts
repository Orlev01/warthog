// E16-S04 — Imported-history archive store (`src/server/db/imported-history.ts`,
// `db/migrations/0042_imported_history.sql`).
//
// RED-first: neither the data-access module nor the migration exists yet, so importing
// `./imported-history` throws and `freshDb()` has no `imported_history` table — every test
// here fails until the builder adds them. That absence IS the point of test-first; do NOT
// implement anything to make these pass — the builder writes the module and the migration
// afterwards.
//
// These tests pin BEHAVIOUR (what the data-access functions DO: the stored archive entry,
// the list-all read, the DEK-encrypted content that round-trips only under the owner's key,
// the plaintext display metadata, who may read what, that an archive write touches neither
// activity_entries nor its hash chain, what a handler rejects, that every value is bound as a
// parameter), never the source text of the module or the SQL file — a later rename that
// preserves behaviour must not redden them.
//
// WHY this exists (task E16-S04; brief §"Export and portability": import "reads a Warthog
// export into a fresh account … the old activity history is kept as a separate read-only
// 'Imported history' archive, clearly labelled, OUTSIDE Warthog's own activity record").
// The imported history is PERSONAL CONTENT carried over from another Warthog export, so each
// archived entry's CONTENT is stored only DEK-ENCRYPTED (`../crypto/envelope`, design §4.1):
// the row id is generated up front so the envelope's associated data binds the ciphertext to
// its exact (table, column, row), and the plaintext content never lands in a column. A little
// plaintext metadata (when the original action occurred, its kind, its source label) stays
// readable so the archive can be LISTED and CLEARLY LABELLED without decrypting another
// person's data — exactly the activity feed's display metadata, but in a SEPARATE table that
// is NOT the append-only, hash-chained activity record, so an import never claims authorship
// of actions Warthog did not handle and never perturbs the live integrity chain (constitution
// principle 14).
//
// ---------------------------------------------------------------------------
// THE PINNED CONTRACT (chosen by the tester; the implementation conforms to it).
//
//   interface NewImportedEntry {        // what createImportedEntry archives
//     userId: string;                   // the OWNER (the session's id, NEVER a client value)
//     content: Record<string, unknown>; // the original exported activity entry — stored DEK-ENCRYPTED
//                                        //   as one JSON blob (seq, payload, prevHash, … all live here)
//     occurredAt: string | Date;        // when the ORIGINAL action happened — PLAINTEXT metadata (ordering)
//     kind: string;                     // the original entry's kind — PLAINTEXT metadata (label)
//     source: string;                   // "warthog" | "agent_reported" — PLAINTEXT metadata (label)
//   }
//
//   interface ImportedEntry {           // an archived entry handed back to its owner (content DECRYPTED)
//     id: string; userId: string;
//     content: Record<string, unknown>; // decrypted on read
//     occurredAt: string | Date;        // the original instant
//     kind: string;
//     source: string;
//   }
//
//   createImportedEntry(db, input: NewImportedEntry, dek): Promise<ImportedEntry>
//     • generates the id up front (so the content envelope binds to the row), stores the
//       content DEK-encrypted plus the plaintext metadata (occurredAt, kind, source), and
//       returns the entry assembled from its inputs (no dependency on a RETURNING read).
//       Writes ONLY to the archive table — never to activity_entries.
//   listImportedEntriesForUser(db, userId, dek): Promise<ImportedEntry[]>
//     • ALL of `userId`'s archived entries (member-scoped: the user id is BOUND), each
//       content blob DECRYPTED under the owner's `dek`; never another person's. Empty array
//       when the person has no imported history.
//
// Acceptance criteria → tests:
//   AC1 "An imported-history entry is stored DEK-encrypted and read back for its owner, in a
//        table SEPARATE from activity_entries." — createImportedEntry returns an id and the
//        recorded metadata; the plaintext content never appears in a raw column yet
//        round-trips under the owner's DEK; the row lands in `imported_history`, and an
//        archive write adds NO row to `activity_entries`.
//   AC2 "The list-all read returns only the session user's archive rows and never another
//        user's rows for an id supplied by the caller." — B never sees A's archive in a list;
//        a handler takes the owner from the SESSION, so a userId smuggled in the body never
//        reads/writes under another person.
//   AC3 "Writing to the archive adds nothing to activity_entries and does not change the
//        account's activity hash chain." — with a real, intact activity chain already
//        written (`createDbRecorder`), archiving imported history leaves the activity row
//        count, the full chain (seq/prev_hash/entry_hash), the chain head and `checkIntegrity`
//        all UNCHANGED, and the archived content never surfaces in `readActivity`.
//   AC4 [obligation:validate-and-parameterize-input] (INV-102) — a handler on the
//        `../http/validate` boundary rejects malformed / oversized / missing / mis-typed
//        input with a 4xx before any query runs; a SQL-injection probe routed through the
//        repo travels as a BOUND value (placeholders, never concatenation) and cannot drop
//        the table. The handler below is a TEST FIXTURE (the intended usage), not an
//        implementation file.
//   AC5 [obligation:secrets-from-env] (INV-103) — enforced by construction: the repo takes
//        `db` and the `dek` as injected dependencies, holds no key and reads no `process.env`.
//        Shown behaviourally: the content is encrypted under the INJECTED dek (a different dek
//        cannot read it back — not a baked-in secret), and a decoy secret planted in the
//        environment never lands in a stored or returned entry.
//   Migration: the `imported_history` relation exists after the project migrations and a
//        second run of every migration changes nothing.
//
// Every db handle is closed in a `finally` so node:test leaves no open handle; each real-db
// test uses its own `freshDb()` (an isolated in-memory PGlite with the real migrations), so
// tests share no state.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { z } from "zod";

import {
  createImportedEntry,
  listImportedEntriesForUser,
} from "./imported-history";
import { createUser } from "./users";
import { freshDb } from "../../test/db";
import { loadMigrations, runMigrations, type Db } from "./index";
import { createDbRecorder, readActivity } from "../activity/writer";
import { checkIntegrity } from "../activity/integrity";
import { fixedClock } from "../seams/clock";
import { parseBody, HttpError } from "../http/validate";

// --- fixtures ---------------------------------------------------------------------

const DEK_BYTES = 32; // a 256-bit per-person data key

// A fresh random 256-bit DEK. The real DEK is unwrapped from the KeyWrapper seam a layer up;
// this repo only ever receives the already-unwrapped bytes.
function freshDek(): Uint8Array {
  return randomBytes(DEK_BYTES);
}

// A stand-in wrapped DEK for createUser (opaque base64; this module never reads it).
function wrappedDekFor(who: string): string {
  return Buffer.from(`wrapped-dek-${who}`).toString("base64");
}

// Create a person and return their id (every member-scoped row hangs off this id).
async function makeUser(db: Db, who: string): Promise<string> {
  const user = await createUser(db, {
    email: `${who}@warthog.com.au`,
    wrappedDek: wrappedDekFor(who),
  });
  return user.id;
}

// A fixed instant for the activity recorder in the hash-chain test. Imported entries carry
// their OWN original occurredAt (passed explicitly), unrelated to this.
const NOW = new Date("2026-11-10T12:00:00Z");

// A db seam stand-in that records every call instead of running it, so a test can prove WHAT
// reached the query layer and HOW (bound value vs. spliced text). It returns no rows and
// satisfies the `Db` shape structurally (query + close).
interface RecordingDb extends Db {
  readonly calls: { text: string; values: unknown[] }[];
}
function recordingDb(): RecordingDb {
  const calls: { text: string; values: unknown[] }[] = [];
  return {
    calls,
    query(text: string, values: unknown[] = []) {
      calls.push({ text, values });
      return Promise.resolve({ rows: [] as Record<string, unknown>[] });
    },
    close() {
      return Promise.resolve();
    },
  };
}

// Whether a relation of this exact name exists on this handle. `to_regclass` yields the
// relation name when it exists and NULL when it does not — a non-throwing probe scoped to the
// one table under test (behaviour, not source text).
async function tableExists(db: Db, name: string): Promise<boolean> {
  const result = await db.query("SELECT to_regclass($1) AS t", [name]);
  return result.rows[0]?.t != null;
}

// Count a person's rows in a table (member-scoped; the id is bound). Returns a number
// regardless of whether the driver hands `count(*)` back as a number or a numeric string.
async function countForUser(db: Db, table: string, userId: string): Promise<number> {
  const result = await db.query(
    `SELECT count(*) AS n FROM ${table} WHERE user_id = $1`,
    [userId],
  );
  return Number(result.rows[0]?.n ?? 0);
}

// Assert a probe reached the query layer as a BOUND value and never as spliced SQL text,
// scoped to each recorded call (the parameterize half of INV-102).
function assertBoundNotSpliced(db: RecordingDb, probe: string): void {
  assert.ok(db.calls.length >= 1, "at least one query was issued");
  assert.ok(db.calls.some((c) => c.values.includes(probe)), "the probe travels as a bound value");
  for (const call of db.calls) {
    assert.ok(!call.text.includes(probe), "the input is bound, never concatenated into the SQL");
    assert.ok(!call.text.includes("DROP TABLE"), "no injected statement appears in the SQL text");
  }
}

// Normalise an instant (Date or string) to a canonical ISO string, so a `timestamptz` that
// comes back as a Date, an ISO string, or a "YYYY-MM-DD HH:MM:SS+00" string all compare equal
// — either representation is reasonable and must not redden a test.
function toInstant(value: Date | string | number): string {
  return new Date(value).toISOString();
}

// A structural view of a returned archive entry, so the helpers below do not depend on the
// (absent) module's exported types at the point they run.
interface ImportedEntryLike {
  readonly id: string;
  readonly userId: string;
  readonly content: Record<string, unknown>;
  readonly occurredAt: Date | string;
  readonly kind: string;
  readonly source: string;
}

// A convenience builder for the content of an imported entry: the shape of an exported
// activity entry (brief: the import brings in the full activity history). The free-text values
// round-trip exactly through JSON. The whole object is DEK-encrypted; only occurredAt/kind/
// source are mirrored as plaintext metadata.
function exportedActivityEntry(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    seq: 7,
    occurredAt: "2026-03-01T10:00:00.000Z",
    kind: "tool_call",
    source: "warthog",
    tool: "calendar.create_event",
    outcome: "ok",
    payload: { summary: "Dentist", when: "2026-03-05" },
    prevHash: "deadbeef".repeat(8),
    entryHash: "feedface".repeat(8),
    ...over,
  };
}

// ===========================================================================
// AC1 — an entry is stored DEK-encrypted and read back for its owner, in a table
// SEPARATE from activity_entries.
// ===========================================================================

test("createImportedEntry returns an entry with an id and the recorded content and metadata", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac1");
    const dek = freshDek();

    const saved = (await createImportedEntry(
      db,
      {
        userId,
        content: exportedActivityEntry(),
        occurredAt: "2026-03-01T10:00:00.000Z",
        kind: "tool_call",
        source: "warthog",
      },
      dek,
    )) as ImportedEntryLike;

    assert.equal(typeof saved.id, "string", "createImportedEntry returns an id string");
    assert.ok(saved.id.length > 0, "the returned id is non-empty");
    assert.equal(saved.userId, userId, "the entry belongs to the archiving person");
    assert.deepEqual(saved.content, exportedActivityEntry(), "the content is recorded");
    assert.equal(toInstant(saved.occurredAt), "2026-03-01T10:00:00.000Z", "the original instant is recorded");
    assert.equal(saved.kind, "tool_call", "the kind label is recorded");
    assert.equal(saved.source, "warthog", "the source label is recorded");
  } finally {
    await db.close();
  }
});

test("createImportedEntry gives each entry a distinct id", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac1-ids");
    const dek = freshDek();
    const one = (await createImportedEntry(
      db,
      { userId, content: exportedActivityEntry({ seq: 1 }), occurredAt: "2026-03-01T10:00:00.000Z", kind: "tool_call", source: "warthog" },
      dek,
    )) as ImportedEntryLike;
    const two = (await createImportedEntry(
      db,
      { userId, content: exportedActivityEntry({ seq: 2 }), occurredAt: "2026-03-02T10:00:00.000Z", kind: "tool_call", source: "warthog" },
      dek,
    )) as ImportedEntryLike;
    assert.notEqual(one.id, two.id, "two archived entries have different ids");
  } finally {
    await db.close();
  }
});

test("the content is stored DEK-encrypted: the plaintext never appears in a raw column", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac1-atrest");
    const dek = freshDek();
    // A unique marker placed INSIDE the encrypted content blob (occurredAt/kind/source are
    // deliberately plaintext metadata, so the marker must live only in the content).
    const secret = "LEAKCHECK_imported_9x7Q agent whispered a secret in the old history";

    await createImportedEntry(
      db,
      {
        userId,
        content: exportedActivityEntry({ payload: { note: secret } }),
        occurredAt: "2026-03-01T10:00:00.000Z",
        kind: "note",
        source: "agent_reported",
      },
      dek,
    );

    // Scan every cell of the one table under test. This value is unique and lives only in the
    // encrypted content, so any raw occurrence is a genuine plaintext leak. Scoped to
    // `imported_history` alone — the same value may legitimately live (encrypted) elsewhere.
    const all = await db.query("SELECT * FROM imported_history");
    assert.ok(all.rows.length >= 1, "the archive row was stored");
    for (const row of all.rows) {
      for (const cell of Object.values(row)) {
        if (typeof cell === "string") {
          assert.ok(!cell.includes(secret), "the plaintext content must never be written to a column");
        }
      }
    }
  } finally {
    await db.close();
  }
});

test("listImportedEntriesForUser round-trips the stored content decrypted under the owner's DEK", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac1-roundtrip");
    const dek = freshDek();
    const content = exportedActivityEntry({ tool: "mail.send", payload: { to: "a@b.com", subject: "Hi" } });

    await createImportedEntry(
      db,
      { userId, content, occurredAt: "2026-04-10T08:30:00.000Z", kind: "tool_call", source: "warthog" },
      dek,
    );

    const entries = (await listImportedEntriesForUser(db, userId, dek)) as ImportedEntryLike[];
    assert.equal(entries.length, 1, "the owner's one archived entry is listed");
    assert.deepEqual(entries[0]!.content, content, "the content decrypts back to exactly what was stored");
    assert.equal(entries[0]!.kind, "tool_call", "the kind round-trips");
    assert.equal(entries[0]!.source, "warthog", "the source round-trips");
    assert.equal(toInstant(entries[0]!.occurredAt), "2026-04-10T08:30:00.000Z", "the original instant round-trips");
  } finally {
    await db.close();
  }
});

test("listImportedEntriesForUser returns every one of the owner's archived entries, decrypted", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac1-list");
    const dek = freshDek();

    await createImportedEntry(db, { userId, content: exportedActivityEntry({ payload: { x: "one" } }), occurredAt: "2026-01-01T00:00:00.000Z", kind: "tool_call", source: "warthog" }, dek);
    await createImportedEntry(db, { userId, content: exportedActivityEntry({ payload: { x: "two" } }), occurredAt: "2026-01-02T00:00:00.000Z", kind: "approval", source: "warthog" }, dek);
    await createImportedEntry(db, { userId, content: exportedActivityEntry({ payload: { x: "three" } }), occurredAt: "2026-01-03T00:00:00.000Z", kind: "memory_write", source: "agent_reported" }, dek);

    const entries = (await listImportedEntriesForUser(db, userId, dek)) as ImportedEntryLike[];
    assert.equal(entries.length, 3, "all three of the owner's archived entries are listed");
    for (const e of entries) {
      assert.equal(e.userId, userId, "every listed entry belongs to the owner");
    }
    const payloads = new Set(entries.map((e) => (e.content.payload as { x: string }).x));
    assert.ok(payloads.has("one") && payloads.has("two") && payloads.has("three"), "each entry's content decrypts");
    const kinds = new Set(entries.map((e) => e.kind));
    assert.ok(kinds.has("tool_call") && kinds.has("approval") && kinds.has("memory_write"), "the plaintext kind labels round-trip");
  } finally {
    await db.close();
  }
});

test("listImportedEntriesForUser returns an empty array for a person with no imported history", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac1-empty");
    const entries = await listImportedEntriesForUser(db, userId, freshDek());
    assert.deepEqual(entries, [], "a person with no imported history gets an empty list");
  } finally {
    await db.close();
  }
});

test("an archive write lands in imported_history and adds NO row to activity_entries", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac1-separate");
    const dek = freshDek();

    // Both tables must exist, and they are distinct.
    assert.equal(await tableExists(db, "imported_history"), true, "the archive lives in its own table");
    assert.equal(await tableExists(db, "activity_entries"), true, "the live activity record is a different table");

    await createImportedEntry(
      db,
      { userId, content: exportedActivityEntry(), occurredAt: "2026-03-01T10:00:00.000Z", kind: "tool_call", source: "warthog" },
      dek,
    );

    assert.equal(await countForUser(db, "imported_history", userId), 1, "the entry is stored in the archive table");
    assert.equal(
      await countForUser(db, "activity_entries", userId),
      0,
      "archiving imported history must add NO row to the append-only activity record",
    );
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC2 — ownership: the list-all read is scoped to the session user; a second
// person can never read another's archive.
// ===========================================================================

test("listImportedEntriesForUser never returns another person's archived entries", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "owner-alice");
    const bob = await makeUser(db, "owner-bob");
    const dek = freshDek();

    await createImportedEntry(db, { userId: alice, content: exportedActivityEntry({ payload: { who: "Alice A" } }), occurredAt: "2026-02-01T00:00:00.000Z", kind: "tool_call", source: "warthog" }, dek);
    await createImportedEntry(db, { userId: alice, content: exportedActivityEntry({ payload: { who: "Alice B" } }), occurredAt: "2026-02-02T00:00:00.000Z", kind: "tool_call", source: "warthog" }, dek);
    await createImportedEntry(db, { userId: bob, content: exportedActivityEntry({ payload: { who: "Bob B" } }), occurredAt: "2026-02-03T00:00:00.000Z", kind: "tool_call", source: "warthog" }, dek);

    const aliceAll = (await listImportedEntriesForUser(db, alice, dek)) as ImportedEntryLike[];
    assert.equal(aliceAll.length, 2, "Alice sees exactly her own two archived entries");
    assert.ok(aliceAll.every((e) => e.userId === alice), "every entry in Alice's list is hers");
    assert.ok(!aliceAll.some((e) => (e.content.payload as { who: string }).who === "Bob B"), "Bob's archive never appears in Alice's list");

    const bobAll = (await listImportedEntriesForUser(db, bob, dek)) as ImportedEntryLike[];
    assert.equal(bobAll.length, 1, "Bob sees exactly his own archived entry");
    assert.equal((bobAll[0]!.content.payload as { who: string }).who, "Bob B", "Bob sees his own entry");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC3 — writing to the archive adds nothing to activity_entries and does not
// change the account's activity hash chain.
//
// We first write a REAL, intact activity chain through the production writer
// (`createDbRecorder`), snapshot it, then archive several imported entries and prove the
// live activity record — count, chain (seq/prev_hash/entry_hash), head, and the integrity
// check — is UNCHANGED, and the archived content never surfaces in the activity read.
// ===========================================================================

// Snapshot the whole per-user activity chain as the integrity-relevant columns, so a
// before/after deepEqual catches any added/removed/reordered/mutated entry.
async function chainSnapshot(db: Db, userId: string): Promise<unknown[]> {
  const result = await db.query(
    "SELECT seq, prev_hash, entry_hash FROM activity_entries WHERE user_id = $1 ORDER BY seq ASC",
    [userId],
  );
  return result.rows.map((row) => ({
    seq: Number(row.seq),
    prevHash: String(row.prev_hash),
    entryHash: String(row.entry_hash),
  }));
}

test("archiving imported history leaves activity_entries, the hash chain and the integrity check unchanged", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac3-chain");
    const dek = freshDek();

    // A real activity chain written through the production recorder (Warthog writes the record).
    const recorder = createDbRecorder({
      db,
      clock: fixedClock(NOW),
      dekFor: async () => dek,
    });
    await recorder.record({ userId, kind: "tool_call", source: "warthog", tool: "a", payload: { step: 1 } });
    await recorder.record({ userId, kind: "approval", source: "warthog", payload: { step: 2 } });
    await recorder.record({ userId, kind: "tool_call", source: "warthog", tool: "b", payload: { step: 3 } });

    // Snapshot the live activity record before any archive write.
    const countBefore = await countForUser(db, "activity_entries", userId);
    const chainBefore = await chainSnapshot(db, userId);
    const activityBefore = await readActivity(db, userId, dek);
    const integrityBefore = await checkIntegrity(db, userId);
    assert.equal(countBefore, 3, "three activity entries were written");
    assert.deepEqual(integrityBefore, { intact: true, checked: 3, brokenSeq: null }, "the chain starts intact");

    // Now archive several imported-history entries — a distinct marker so we can prove it never
    // leaks into the activity read.
    const archiveMarker = "ARCHIVE_ONLY_never_in_activity_7731";
    await createImportedEntry(db, { userId, content: exportedActivityEntry({ payload: { note: archiveMarker, n: 1 } }), occurredAt: "2025-12-01T00:00:00.000Z", kind: "tool_call", source: "warthog" }, dek);
    await createImportedEntry(db, { userId, content: exportedActivityEntry({ payload: { note: archiveMarker, n: 2 } }), occurredAt: "2025-12-02T00:00:00.000Z", kind: "approval", source: "agent_reported" }, dek);

    // The archive actually received the writes (so the assertions below are not vacuous).
    assert.equal(await countForUser(db, "imported_history", userId), 2, "both imported entries were archived");

    // The live activity record is entirely unchanged.
    assert.equal(await countForUser(db, "activity_entries", userId), countBefore, "no activity row was added or removed");
    assert.deepEqual(await chainSnapshot(db, userId), chainBefore, "the per-user hash chain (seq/prev_hash/entry_hash) is unchanged");
    assert.deepEqual(await checkIntegrity(db, userId), integrityBefore, "the integrity check still reports the same intact chain");

    // The chain HEAD (last entry's hash) is byte-for-byte the same — the archive never extended it.
    const headBefore = chainBefore[chainBefore.length - 1];
    const chainAfter = await chainSnapshot(db, userId);
    assert.deepEqual(chainAfter[chainAfter.length - 1], headBefore, "the chain head is unchanged");

    // The activity read returns exactly the same entries, and never the archived content.
    const activityAfter = await readActivity(db, userId, dek);
    assert.equal(activityAfter.length, activityBefore.length, "the activity feed still has the same entries");
    assert.ok(
      !JSON.stringify(activityAfter).includes(archiveMarker),
      "archived content never surfaces in the live activity record",
    );
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC4 — every statement binds its input as a parameter (no spliced SQL).
// ===========================================================================

test("createImportedEntry binds its inputs as parameters, never woven into the SQL text", async () => {
  const db = recordingDb();
  const probe = "u'); DROP TABLE imported_history; --";

  // The recording db returns no rows; createImportedEntry assembles its result from the inputs,
  // so the INSERT it issued must have BOUND the probe (here the owner id), checked below.
  try {
    await createImportedEntry(
      db,
      { userId: probe, content: exportedActivityEntry(), occurredAt: "2026-03-01T10:00:00.000Z", kind: "tool_call", source: "warthog" },
      freshDek(),
    );
  } catch {
    /* tolerate a no-row read: the binding is asserted below regardless */
  }

  assertBoundNotSpliced(db, probe);
});

test("listImportedEntriesForUser binds the user id as a parameter, never woven into the SQL text", async () => {
  const db = recordingDb();
  const probe = "l'); DROP TABLE imported_history; --";

  const result = await listImportedEntriesForUser(db, probe, freshDek());
  assert.deepEqual(result, [], "the recording db returns no rows, so the list is empty");

  assertBoundNotSpliced(db, probe);
});

test("a SQL-injection probe in the content is stored as data: the table survives and it round-trips", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "inject");
    const dek = freshDek();
    const probe = "Grace'); DROP TABLE imported_history; --";

    await createImportedEntry(
      db,
      { userId, content: exportedActivityEntry({ payload: { note: probe } }), occurredAt: "2026-03-01T10:00:00.000Z", kind: "tool_call", source: "warthog" },
      dek,
    );

    assert.equal(
      await tableExists(db, "imported_history"),
      true,
      "the imported_history table must still exist (the probe was stored as data, not run as SQL)",
    );

    const entries = (await listImportedEntriesForUser(db, userId, dek)) as ImportedEntryLike[];
    assert.ok(entries.length === 1, "the entry was stored");
    assert.equal((entries[0]!.content.payload as { note: string }).note, probe, "the probe round-trips verbatim as data");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC4 — a handler on the validation boundary rejects bad input and binds probes.
//
// A route handler validates external input HERE (`parseBody`), then calls this task's
// parameterized data-access with the SESSION's user id (NEVER a body value) and the injected
// dek. A rejected input maps to a 4xx Response and never reaches a query. This handler is a
// test fixture that EXERCISES the modules — it is not an implementation file.
// ===========================================================================

function importHandler(
  db: Db,
  dek: Uint8Array,
  sessionUserId: string,
): (req: Request) => Promise<Response> {
  // The body carries the archived entry's content and its display metadata; the user id comes
  // from the SESSION, never the body. Lengths are capped so an absurd value is rejected, but
  // generous enough that a probe can still REACH the query to prove it is bound.
  const schema = z.object({
    content: z.record(z.string(), z.unknown()),
    occurredAt: z.string().min(1).max(64),
    kind: z.string().min(1).max(128),
    source: z.string().min(1).max(64),
  });
  return async (req: Request): Promise<Response> => {
    try {
      const body = await parseBody(schema, req, { maxBytes: 8 * 1024 });
      const saved = await createImportedEntry(
        db,
        {
          userId: sessionUserId,
          content: body.content,
          occurredAt: body.occurredAt,
          kind: body.kind,
          source: body.source,
        },
        dek,
      );
      return new Response(JSON.stringify({ id: saved.id }), { status: 201 });
    } catch (err) {
      if (err instanceof HttpError) {
        return new Response(JSON.stringify({ error: "invalid input" }), { status: err.status });
      }
      // A non-HttpError escaping the boundary is an uncontrolled 500; surface it so a test sees
      // the raw-500 failure rather than a masked success.
      return new Response("internal error", { status: 500 });
    }
  };
}

function jsonRequest(body: string): Request {
  return new Request("https://warthog.com.au/api/imported-history", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

function validBody(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    content: exportedActivityEntry(),
    occurredAt: "2026-03-01T10:00:00.000Z",
    kind: "tool_call",
    source: "warthog",
    ...over,
  });
}

test("the handler rejects malformed JSON with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = importHandler(db, freshDek(), "session-user");

  const res = await handler(jsonRequest("{ not valid json"));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "malformed input must never reach a query");
});

test("the handler rejects an oversized body with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = importHandler(db, freshDek(), "session-user");

  // ~20 KiB content value, well over the handler's 8 KiB cap: rejected by size before parse.
  const res = await handler(jsonRequest(validBody({ content: { note: "a".repeat(20 * 1024) } })));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "an oversized body must never reach a query");
});

test("the handler rejects a body missing a required field with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = importHandler(db, freshDek(), "session-user");

  // No kind — an archived entry must carry its plaintext kind label.
  const res = await handler(jsonRequest(JSON.stringify({ content: exportedActivityEntry(), occurredAt: "2026-03-01T10:00:00.000Z", source: "warthog" })));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "a schema violation must never reach a query");
});

test("the handler rejects a mis-typed content with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = importHandler(db, freshDek(), "session-user");

  // content must be an object — a string is a schema violation.
  const res = await handler(jsonRequest(validBody({ content: "not-an-object" })));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "a mis-typed content must never reach a query");
});

test("the handler accepts a well-formed body and archives the entry for the SESSION user", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "handler-ok");
    const dek = freshDek();
    const handler = importHandler(db, dek, userId);

    const res = await handler(jsonRequest(validBody()));

    assert.ok(res.status >= 200 && res.status < 300, `expected a 2xx, got ${res.status}`);
    const { id } = (await res.json()) as { id: string };
    assert.ok(typeof id === "string" && id.length > 0, "the handler returns the stored entry id");

    const entries = (await listImportedEntriesForUser(db, userId, dek)) as ImportedEntryLike[];
    assert.equal(entries.length, 1, "a valid body is archived for the session user");
    assert.equal(entries[0]!.id, id, "the stored entry matches the returned id");
    assert.deepEqual(entries[0]!.content, exportedActivityEntry(), "and the submitted content, decrypted");

    // And it did NOT touch the live activity record.
    assert.equal(await countForUser(db, "activity_entries", userId), 0, "the handler never writes to activity_entries");
  } finally {
    await db.close();
  }
});

test("the handler takes the user id from the session, not the body (no cross-user write)", async () => {
  const db = await freshDb();
  try {
    const sessionUser = await makeUser(db, "handler-session");
    const attacker = await makeUser(db, "handler-attacker");
    const dek = freshDek();
    const handler = importHandler(db, dek, sessionUser);

    // The body smuggles a userId; the handler must ignore it and use the session's.
    const res = await handler(jsonRequest(validBody({ userId: attacker })));
    assert.ok(res.status >= 200 && res.status < 300, `expected a 2xx, got ${res.status}`);

    assert.equal(
      (await listImportedEntriesForUser(db, sessionUser, dek)).length,
      1,
      "the entry is archived under the SESSION user",
    );
    assert.deepEqual(
      await listImportedEntriesForUser(db, attacker, dek),
      [],
      "and never under the user id smuggled in the body",
    );
  } finally {
    await db.close();
  }
});

test("the handler cannot be SQL-injected: a probe value is stored as data and the table survives", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "handler-probe");
    const dek = freshDek();
    const handler = importHandler(db, dek, userId);
    const probe = "oren'); DROP TABLE imported_history; --";

    const res = await handler(jsonRequest(validBody({ content: { note: probe } })));

    assert.ok(res.status >= 200 && res.status < 300, "a valid-shaped (if nasty) value is accepted");
    assert.equal(await tableExists(db, "imported_history"), true, "the imported_history table must still exist");

    const entries = (await listImportedEntriesForUser(db, userId, dek)) as ImportedEntryLike[];
    assert.equal((entries[0]!.content.note as string), probe, "the probe is stored verbatim, not interpreted as SQL");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC5 — the content is encrypted under the INJECTED dek, not a baked-in secret (a different
// dek cannot read it back); the repo reads no process.env and holds no key (INV-103), shown
// behaviourally with a decoy secret in the environment.
// ===========================================================================

test("listImportedEntriesForUser cannot decrypt the content with a different DEK", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac5-wrongdek");
    const dek = freshDek();
    await createImportedEntry(
      db,
      { userId, content: exportedActivityEntry(), occurredAt: "2026-03-01T10:00:00.000Z", kind: "tool_call", source: "warthog" },
      dek,
    );

    // A different DEK is the wrong key; the GCM tag must fail rather than return other bytes —
    // so reading the archive under it rejects.
    const wrongDek = freshDek();
    await assert.rejects(
      async () => {
        await listImportedEntriesForUser(db, userId, wrongDek);
      },
      "the content is bound to the person's own DEK, not any ambient/hardcoded key",
    );
  } finally {
    await db.close();
  }
});

test("the repo reads no process.env: a decoy secret in the environment never lands in an archived entry", async () => {
  const DECOY = "sk_live_DECOY_must_never_appear_in_warthog";
  const prev = process.env.WARTHOG_DECOY_SECRET;
  process.env.WARTHOG_DECOY_SECRET = DECOY;
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac5");
    const dek = freshDek();
    await createImportedEntry(
      db,
      { userId, content: exportedActivityEntry(), occurredAt: "2026-03-01T10:00:00.000Z", kind: "tool_call", source: "warthog" },
      dek,
    );

    const entries = (await listImportedEntriesForUser(db, userId, dek)) as ImportedEntryLike[];
    assert.equal(entries.length, 1, "the entry reads and writes purely from the injected db — no app env needed");
    assert.ok(
      !JSON.stringify(entries).includes(DECOY),
      "no ambient env value is folded into the returned entries",
    );

    // Scan every cell of the one table under test for the decoy (scoped narrowly — the same
    // value could legitimately live elsewhere if it were a real datum, which it is not).
    const all = await db.query("SELECT * FROM imported_history");
    for (const row of all.rows) {
      for (const cell of Object.values(row)) {
        if (typeof cell === "string") {
          assert.ok(!cell.includes(DECOY), "no ambient env value is written to a column");
        }
      }
    }
  } finally {
    await db.close();
    if (prev === undefined) delete process.env.WARTHOG_DECOY_SECRET;
    else process.env.WARTHOG_DECOY_SECRET = prev;
  }
});

// ===========================================================================
// Migration — the table applies and a second run changes nothing.
// ===========================================================================

test("the imported_history migration applies and re-running every migration changes nothing", async () => {
  const db = await freshDb();
  try {
    assert.equal(
      await tableExists(db, "imported_history"),
      true,
      "the imported_history table must exist after the project migrations",
    );

    const migrations = await loadMigrations();
    assert.ok(
      migrations.some((m) => m.name === "0042_imported_history"),
      "db/migrations/0042_imported_history.sql must be part of the project migrations",
    );

    // A second run over the same database applies nothing new and does not throw — re-executing
    // 0042's CREATE would throw "already exists", so an empty result AND no throw together prove
    // the migration's second run changes nothing.
    const again = await runMigrations(db, migrations);
    assert.deepEqual(again, [], "a second migration run must change nothing");
  } finally {
    await db.close();
  }
});
