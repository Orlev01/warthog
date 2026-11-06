// E14-S01 — Life-admin records store (`src/server/db/life-admin-records.ts`,
// `db/migrations/0033_life_admin_records.sql`).
//
// RED-first: neither the data-access module nor the migration exists yet, so importing
// `./life-admin-records` throws and `freshDb()` has no `life_admin_records` table — every
// test here fails until the builder adds them. That absence IS the point of test-first; do
// NOT implement anything to make these pass — the builder writes the module and the migration
// afterwards.
//
// These tests pin BEHAVIOUR (what the data-access functions DO: the stored record, the
// list-all and by-kind reads, the DEK-encrypted fields that round-trip only under the owner's
// key, the plaintext metadata the reminders job filters on WITHOUT a key, who may read/write
// what, what a handler rejects, that every value is bound as a parameter), never the source
// text of the module or the SQL file — a later rename that preserves behaviour must not redden
// them.
//
// WHY this exists (task E14-S01; brief §"Life admin": records that agents and the person both
// maintain — subscriptions (service, cost, billing cycle, next renewal, how to cancel,
// status), receipts and warranties (merchant, item, date, amount, return-by, warranty end,
// receipt file), and renewals and appointments (what, due date, where); reminders by
// notification before due dates — "default 14 days and 1 day before, adjustable per record";
// agents add and update records through Warthog). Life-admin records are PERSONAL CONTENT, so
// each record's FIELDS are stored only DEK-ENCRYPTED (`../crypto/envelope`, design §4.1 —
// "every personal-content column … life-admin records"): the row id is generated up front so
// the envelope's associated data binds the ciphertext to its exact (table, column, row), and
// the plaintext fields never land in a column. The KIND, the due/next DATE, the STATUS, the
// per-record reminder OFFSETS + SENT-markers and the SOURCE (person|agent) stay PLAINTEXT
// metadata (design §4.1) so the reminders job and the Life-admin page can filter WITHOUT
// decrypting another person's data.
//
// ---------------------------------------------------------------------------
// THE PINNED CONTRACT (chosen by the tester; the implementation conforms to it).
//
//   type RecordKind =               // the three record kinds (task / brief)
//     | "subscription"              // service, cost, billing cycle, next renewal, how to cancel, status
//     | "receipt_warranty"          // merchant, item, date, amount, return-by, warranty end, receipt file
//     | "renewal_appointment";      // what, due date, where
//
//   type RecordSource =             // who maintains this record (plaintext metadata)
//     | { kind: "person" }          // the signed-in person created/edited it
//     | { kind: "agent"; agentId: string };  // a connected agent did (opaque id, like activity.agent_id)
//
//   interface NewRecord {           // what createRecord records
//     userId: string;               // the OWNER (the session's / connection's id, NEVER a client value)
//     kind: RecordKind;             // which kind — PLAINTEXT metadata
//     fields: Record<string, unknown>;   // the kind's content — stored DEK-ENCRYPTED as one blob
//     dueDate?: string | null;      // the due/next date (ISO "YYYY-MM-DD") — PLAINTEXT metadata; the
//                                   //   reminder anchor. Absent/null ⇒ no reminders for this record.
//     status: string;              // free-form status word — PLAINTEXT metadata
//     reminderOffsets?: number[];   // days-before-due to remind — PLAINTEXT metadata; DEFAULTS to [14, 1]
//     source: RecordSource;         // person | agent — PLAINTEXT metadata
//   }
//
//   interface LifeAdminRecord {     // a record as handed back to its owner (fields DECRYPTED)
//     id: string; userId: string; kind: RecordKind;
//     fields: Record<string, unknown>;        // decrypted on read
//     dueDate: string | Date | null;          // the due/next date (or null)
//     status: string;
//     reminderOffsets: number[];               // the per-record offsets
//     sentOffsets: number[];                   // offsets whose reminder has already been sent (the SENT-markers)
//     source: RecordSource;
//   }
//
//   interface DueReminder {         // one due, unsent reminder — METADATA ONLY (no decrypted field)
//     recordId: string; userId: string; kind: RecordKind;
//     dueDate: string | Date; offset: number;  // the owner + the exact offset that is now due
//   }
//
//   createRecord(db, input: NewRecord, dek): Promise<LifeAdminRecord>
//     • generates the id up front (so the fields envelope binds to the row), stores the fields
//       DEK-encrypted plus the plaintext metadata (kind, dueDate, status, reminderOffsets —
//       defaulting to [14, 1] — sentOffsets starting empty, source), and returns the record
//       assembled from its inputs (no dependency on a RETURNING read).
//   updateRecord(db, input: { userId, id, fields, dueDate?, status, reminderOffsets? }, dek):
//       Promise<LifeAdminRecord>
//     • MEMBER-SCOPED (WHERE id AND user_id bound): re-encrypts the fields and updates the
//       plaintext metadata for the owner's own record; THROWS when no such record belongs to
//       this user — so one person can never edit another's record.
//   listRecordsForUser(db, userId, dek): Promise<LifeAdminRecord[]>
//     • ALL of `userId`'s records (member-scoped), each fields-blob DECRYPTED under the owner's
//       `dek`; never another person's. Empty array when the person has none.
//   listRecordsByKind(db, userId, kind, dek): Promise<LifeAdminRecord[]>
//     • the same, filtered to one `kind` (the "filterable by kind" read).
//   listDueForReminder(db, clock): Promise<DueReminder[]>
//     • the REMINDERS JOB's read. Deliberately CROSS-USER (it takes NO userId and NO dek): it
//       returns, for EVERY person, each (record, offset) where the offset's reminder date
//       (dueDate − offset days) is at or before clock.now() AND the offset has NOT been marked
//       sent AND the record has a dueDate. METADATA ONLY — it never decrypts a field, which is
//       exactly design §4.1's "filter without decrypting another person's data".
//   markReminderSent(db, input: { recordId, offset }): Promise<void>
//     • records that the reminder for one (record, offset) has been sent — the SENT-marker the
//       job sets so listDueForReminder stops returning it. DEK-FREE (the job holds no key); keyed
//       on the record's unguessable id, so it is the system job's write, not a member read.
//
// Acceptance criteria → tests:
//   AC1 "Saving a record stores its fields DEK-encrypted with the kind, due/next date, status
//        and reminder offsets held as plaintext metadata, and listRecordsForUser returns the
//        owner's records decrypted, filterable by kind." — createRecord returns the id and the
//        recorded metadata; the plaintext fields never appear in a raw column (encrypted at
//        rest) yet round-trip under the owner's DEK; listRecordsForUser returns all of the
//        owner's records decrypted; listRecordsByKind filters to one kind.
//   AC2 "A record carries its reminder offsets (defaulting to 14 and 1 days before the due
//        date) and sent-markers, and listDueForReminder returns records with an offset now due
//        that has not yet been marked sent." — a record saved without offsets defaults to
//        [14, 1] with no sent-markers; listDueForReminder (no dek) returns each due, unsent
//        offset across people; markReminderSent removes a sent offset from the due set.
//   AC3 "A user cannot read or write another user's records (filtered by session user id)." —
//        B never sees A's records in a list or by-kind read; updateRecord refuses another
//        person's record; a handler takes the owner from the SESSION, so a userId smuggled in
//        the body never writes under another person.
//   AC4 [obligation:validate-and-parameterize-input] (INV-102) — a handler on the
//        `../http/validate` boundary rejects malformed / oversized / missing / mis-typed input
//        with a 4xx before any query runs; a SQL-injection probe routed through the repo
//        travels as a BOUND value (placeholders, never concatenation) and cannot drop the
//        table. The handler below is a test fixture (the intended usage), not an implementation
//        file.
//   AC5 [obligation:secrets-from-env] (INV-103) — enforced by construction: the repo takes
//        `db` and the `dek` as injected dependencies, holds no key and reads no `process.env`.
//        Shown behaviourally: the fields are encrypted under the INJECTED dek (a different dek
//        cannot read them back — not a baked-in secret), and a decoy secret planted in the
//        environment never lands in a stored or returned record.
//   Migration: the `life_admin_records` relation exists after the project migrations and a
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
  createRecord,
  updateRecord,
  listRecordsForUser,
  listRecordsByKind,
  listDueForReminder,
  markReminderSent,
} from "./life-admin-records";
import { createUser } from "./users";
import { freshDb } from "../../test/db";
import { loadMigrations, runMigrations, type Db } from "./index";
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

// A fixed instant for the reminder tests. Dates below are chosen with ≥ 2-day margins from
// this instant so no driver/timezone date-boundary rounding can flip a due/not-due decision.
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

// Normalise a calendar date to a YYYY-MM-DD string regardless of whether the driver hands it
// back as a Date (pg `date` ⇒ local-midnight Date) or an ISO string — either is a reasonable
// representation and must not redden a test.
function dateOnly(value: Date | string | number): string {
  if (value instanceof Date) {
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, "0");
    const d = String(value.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  return String(value).slice(0, 10);
}

// A structural view of a returned record / due reminder, so the helpers below do not depend on
// the (absent) module's exported types at the point they run.
interface RecordLike {
  readonly id: string;
  readonly userId: string;
  readonly kind: string;
  readonly fields: Record<string, unknown>;
  readonly dueDate?: Date | string | null;
  readonly status: string;
  readonly reminderOffsets: number[];
  readonly sentOffsets: number[];
  readonly source: { readonly kind: string; readonly agentId?: string };
}
interface DueReminderLike {
  readonly recordId: string;
  readonly userId: string;
  readonly kind: string;
  readonly dueDate: Date | string;
  readonly offset: number;
}

// Find the one listed record carrying this exact decrypted field value (list order is not pinned).
function recordWithField(records: RecordLike[], key: string, value: string): RecordLike | undefined {
  return records.find((r) => r.fields?.[key] === value);
}

// Offsets sorted ascending, so an assertion compares the SET, not the storage order.
function sorted(ns: number[]): number[] {
  return [...ns].sort((a, b) => a - b);
}

// All due reminders for one record (there may be several — one per due, unsent offset).
function dueForRecord(items: DueReminderLike[], recordId: string): DueReminderLike[] {
  return items.filter((d) => d.recordId === recordId);
}

// Convenience builders for the three kinds' content (free-text values so they round-trip
// exactly through JSON). The content is DEK-encrypted; the metadata (dueDate/status/…) is not.
function subscriptionFields(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    service: "Netflix",
    cost: "15.99",
    billingCycle: "monthly",
    howToCancel: "Cancel in account settings",
    ...over,
  };
}

// ===========================================================================
// AC1 — saving records a record (fields DEK-encrypted, metadata plaintext);
// listRecordsForUser returns all of the owner's records decrypted; by-kind filters.
// ===========================================================================

test("createRecord returns a record with an id and the recorded kind, fields and metadata", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac1");
    const dek = freshDek();

    const saved = (await createRecord(
      db,
      {
        userId,
        kind: "subscription",
        fields: subscriptionFields(),
        dueDate: "2026-12-01",
        status: "active",
        source: { kind: "person" },
      },
      dek,
    )) as RecordLike;

    assert.equal(typeof saved.id, "string", "createRecord returns an id string");
    assert.ok(saved.id.length > 0, "the returned id is non-empty");
    assert.equal(saved.userId, userId, "the record belongs to the saving person");
    assert.equal(saved.kind, "subscription", "the kind is recorded");
    assert.deepEqual(saved.fields, subscriptionFields(), "the fields are recorded");
    assert.equal(dateOnly(saved.dueDate as Date | string), "2026-12-01", "the due date is recorded");
    assert.equal(saved.status, "active", "the status is recorded");
    assert.equal(saved.source.kind, "person", "the source is recorded");
  } finally {
    await db.close();
  }
});

test("createRecord gives each record a distinct id", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac1-ids");
    const dek = freshDek();
    const one = (await createRecord(
      db,
      { userId, kind: "subscription", fields: subscriptionFields({ service: "A" }), dueDate: "2026-12-01", status: "active", source: { kind: "person" } },
      dek,
    )) as RecordLike;
    const two = (await createRecord(
      db,
      { userId, kind: "subscription", fields: subscriptionFields({ service: "B" }), dueDate: "2026-12-02", status: "active", source: { kind: "person" } },
      dek,
    )) as RecordLike;
    assert.notEqual(one.id, two.id, "two saved records have different ids");
  } finally {
    await db.close();
  }
});

test("the fields are stored DEK-encrypted: the plaintext never appears in a raw column", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac1-atrest");
    const dek = freshDek();
    // A unique marker placed INSIDE the encrypted fields blob (the metadata columns — status,
    // kind, etc. — are deliberately plaintext, so the marker must live only in a field).
    const secret = "LEAKCHECK_lifeadmin_9x7Q cancel via secret.example/portal";

    await createRecord(
      db,
      {
        userId,
        kind: "subscription",
        fields: subscriptionFields({ howToCancel: secret }),
        dueDate: "2026-12-01",
        status: "active",
        source: { kind: "person" },
      },
      dek,
    );

    // Scan every cell of the one table under test. This value is unique and lives only in an
    // encrypted field, so any raw occurrence is a genuine plaintext leak. Scoped to
    // `life_admin_records` alone — the same value may legitimately live (encrypted) elsewhere.
    const all = await db.query("SELECT * FROM life_admin_records");
    assert.ok(all.rows.length >= 1, "the record row was stored");
    for (const row of all.rows) {
      for (const cell of Object.values(row)) {
        if (typeof cell === "string") {
          assert.ok(!cell.includes(secret), "the plaintext field value must never be written to a column");
        }
      }
    }
  } finally {
    await db.close();
  }
});

test("listRecordsForUser round-trips the stored fields decrypted under the owner's DEK", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac1-roundtrip");
    const dek = freshDek();
    const fields = subscriptionFields({ service: "Spotify", cost: "11.99" });

    await createRecord(
      db,
      { userId, kind: "subscription", fields, dueDate: "2026-12-01", status: "active", source: { kind: "person" } },
      dek,
    );

    const records = (await listRecordsForUser(db, userId, dek)) as RecordLike[];
    assert.equal(records.length, 1, "the owner's one record is listed");
    assert.equal(records[0]!.kind, "subscription", "the kind round-trips");
    assert.deepEqual(records[0]!.fields, fields, "the fields decrypt back to exactly what was stored");
    assert.equal(records[0]!.status, "active", "the status round-trips");
  } finally {
    await db.close();
  }
});

test("listRecordsForUser returns every one of the owner's records, across kinds, decrypted", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac1-list");
    const dek = freshDek();

    await createRecord(db, { userId, kind: "subscription", fields: subscriptionFields(), dueDate: "2026-12-01", status: "active", source: { kind: "person" } }, dek);
    await createRecord(db, { userId, kind: "receipt_warranty", fields: { merchant: "Bunnings", item: "Drill", amount: "129.00", returnBy: "2026-12-20", warrantyEnd: "2028-11-01" }, dueDate: "2026-12-20", status: "under_warranty", source: { kind: "agent", agentId: "agent-claude-1" } }, dek);
    await createRecord(db, { userId, kind: "renewal_appointment", fields: { what: "Car service", where: "City Auto" }, dueDate: "2027-01-15", status: "upcoming", source: { kind: "person" } }, dek);

    const records = (await listRecordsForUser(db, userId, dek)) as RecordLike[];
    assert.equal(records.length, 3, "all three of the owner's records are listed");
    for (const r of records) {
      assert.equal(r.userId, userId, "every listed record belongs to the owner");
    }
    const kinds = new Set(records.map((r) => r.kind));
    assert.ok(kinds.has("subscription") && kinds.has("receipt_warranty") && kinds.has("renewal_appointment"), "all three kinds are listed");

    // The agent-sourced record carries its source metadata back.
    const receipt = records.find((r) => r.kind === "receipt_warranty")!;
    assert.equal(receipt.source.kind, "agent", "the agent-sourced record reports source agent");
    assert.equal(receipt.source.agentId, "agent-claude-1", "with the exact agent id");
    assert.deepEqual(receipt.fields, { merchant: "Bunnings", item: "Drill", amount: "129.00", returnBy: "2026-12-20", warrantyEnd: "2028-11-01" }, "its fields decrypt exactly");
  } finally {
    await db.close();
  }
});

test("listRecordsForUser returns an empty array for a person with no records", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac1-empty");
    const records = await listRecordsForUser(db, userId, freshDek());
    assert.deepEqual(records, [], "a person with no records gets an empty list");
  } finally {
    await db.close();
  }
});

test("listRecordsByKind returns only the owner's records of that kind, decrypted", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac1-bykind");
    const dek = freshDek();

    await createRecord(db, { userId, kind: "subscription", fields: subscriptionFields({ service: "Netflix" }), dueDate: "2026-12-01", status: "active", source: { kind: "person" } }, dek);
    await createRecord(db, { userId, kind: "subscription", fields: subscriptionFields({ service: "Spotify" }), dueDate: "2026-12-05", status: "active", source: { kind: "person" } }, dek);
    await createRecord(db, { userId, kind: "renewal_appointment", fields: { what: "Dentist", where: "Smile Co" }, dueDate: "2027-02-01", status: "upcoming", source: { kind: "person" } }, dek);

    const subs = (await listRecordsByKind(db, userId, "subscription", dek)) as RecordLike[];
    assert.equal(subs.length, 2, "both subscriptions are listed");
    assert.ok(subs.every((r) => r.kind === "subscription"), "only subscriptions are returned");
    const services = new Set(subs.map((r) => r.fields.service));
    assert.ok(services.has("Netflix") && services.has("Spotify"), "each subscription decrypts");

    const receipts = await listRecordsByKind(db, userId, "receipt_warranty", dek);
    assert.deepEqual(receipts, [], "a kind the person has none of returns an empty list");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// Update — the owner edits a record's fields and metadata; member-scoped.
// ===========================================================================

test("updateRecord changes the fields and metadata and round-trips decrypted", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "update-ok");
    const dek = freshDek();

    const saved = (await createRecord(
      db,
      { userId, kind: "subscription", fields: subscriptionFields({ cost: "15.99" }), dueDate: "2026-12-01", status: "active", source: { kind: "person" } },
      dek,
    )) as RecordLike;

    const updated = (await updateRecord(
      db,
      { userId, id: saved.id, fields: subscriptionFields({ cost: "17.99" }), dueDate: "2027-01-01", status: "price_changed" },
      dek,
    )) as RecordLike;
    assert.equal(updated.id, saved.id, "the same record is updated");
    assert.equal(updated.fields.cost, "17.99", "the returned record carries the new field value");
    assert.equal(updated.status, "price_changed", "the returned record carries the new status");

    const records = (await listRecordsForUser(db, userId, dek)) as RecordLike[];
    assert.equal(records.length, 1, "still one record (an update, not an insert)");
    assert.equal(records[0]!.fields.cost, "17.99", "the new field value is persisted and decrypts");
    assert.equal(records[0]!.status, "price_changed", "the new status is persisted");
    assert.equal(dateOnly(records[0]!.dueDate as Date | string), "2027-01-01", "the new due date is persisted");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC2 — reminder offsets (default 14 & 1), sent-markers, and the due-for-reminder read.
// ===========================================================================

test("a record saved without reminder offsets defaults to 14 and 1 days, with no sent-markers", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac2-default");
    const dek = freshDek();

    const saved = (await createRecord(
      db,
      { userId, kind: "subscription", fields: subscriptionFields(), dueDate: "2026-12-01", status: "active", source: { kind: "person" } },
      dek,
    )) as RecordLike;

    assert.deepEqual(sorted(saved.reminderOffsets), [1, 14], "the default reminder offsets are 14 and 1 days before");
    assert.deepEqual(saved.sentOffsets, [], "no reminder has been sent yet");
  } finally {
    await db.close();
  }
});

test("a record's custom reminder offsets are stored and round-trip", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac2-custom");
    const dek = freshDek();

    await createRecord(
      db,
      { userId, kind: "renewal_appointment", fields: { what: "Passport renewal", where: "Post office" }, dueDate: "2027-03-01", status: "upcoming", reminderOffsets: [30, 7], source: { kind: "person" } },
      dek,
    );

    const records = (await listRecordsForUser(db, userId, dek)) as RecordLike[];
    assert.deepEqual(sorted(records[0]!.reminderOffsets), [7, 30], "the custom offsets round-trip");
  } finally {
    await db.close();
  }
});

test("listDueForReminder returns a record whose offset is now due — metadata only, no DEK needed", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac2-due");
    const dek = freshDek();

    // dueDate 2026-11-20, default offsets [14, 1]. now = 2026-11-10.
    //   offset 14 → reminder date 2026-11-06 (4 days before now → DUE)
    //   offset 1  → reminder date 2026-11-19 (9 days after now  → NOT due)
    const saved = (await createRecord(
      db,
      { userId, kind: "subscription", fields: subscriptionFields({ howToCancel: "DUE_SECRET_never_leaks" }), dueDate: "2026-11-20", status: "active", source: { kind: "person" } },
      dek,
    )) as RecordLike;

    const due = (await listDueForReminder(db, fixedClock(NOW))) as DueReminderLike[];
    const mine = dueForRecord(due, saved.id);
    assert.equal(mine.length, 1, "exactly the one due offset is returned for this record");
    assert.equal(mine[0]!.offset, 14, "the 14-day reminder is the one that is due");
    assert.equal(mine[0]!.userId, userId, "the due reminder carries the owner so the job can route it");
    assert.equal(mine[0]!.kind, "subscription", "and the kind, which is plaintext metadata");
    assert.equal(dateOnly(mine[0]!.dueDate), "2026-11-20", "and the due date");

    // The job read decrypts nothing: the encrypted field value must not appear anywhere in it.
    assert.ok(
      !JSON.stringify(due).includes("DUE_SECRET_never_leaks"),
      "listDueForReminder returns metadata only — no decrypted field content",
    );
  } finally {
    await db.close();
  }
});

test("listDueForReminder returns one entry per due, unsent offset (a record with two due offsets yields two)", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac2-both");
    const dek = freshDek();

    // dueDate 2026-11-09 (just past), default offsets [14, 1]. now = 2026-11-10.
    //   offset 14 → 2026-10-26 (DUE)   offset 1 → 2026-11-08 (2 days before now → DUE)
    const saved = (await createRecord(
      db,
      { userId, kind: "renewal_appointment", fields: { what: "Rego", where: "Service NSW" }, dueDate: "2026-11-09", status: "overdue", source: { kind: "person" } },
      dek,
    )) as RecordLike;

    const due = (await listDueForReminder(db, fixedClock(NOW))) as DueReminderLike[];
    const offsets = sorted(dueForRecord(due, saved.id).map((d) => d.offset));
    assert.deepEqual(offsets, [1, 14], "both the 14-day and the 1-day reminders are due");
  } finally {
    await db.close();
  }
});

test("listDueForReminder excludes offsets that are not yet due and records with no due date", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac2-notdue");
    const dek = freshDek();

    // Entirely in the future: dueDate 2026-12-15, offsets [14,1] → earliest reminder 2026-12-01 (> now).
    const future = (await createRecord(
      db,
      { userId, kind: "subscription", fields: subscriptionFields({ service: "Future" }), dueDate: "2026-12-15", status: "active", source: { kind: "person" } },
      dek,
    )) as RecordLike;
    // No due date at all → never reminded.
    const noDate = (await createRecord(
      db,
      { userId, kind: "subscription", fields: subscriptionFields({ service: "NoDate" }), dueDate: null, status: "active", source: { kind: "person" } },
      dek,
    )) as RecordLike;

    const due = (await listDueForReminder(db, fixedClock(NOW))) as DueReminderLike[];
    assert.equal(dueForRecord(due, future.id).length, 0, "a record whose reminders are all in the future is not due");
    assert.equal(dueForRecord(due, noDate.id).length, 0, "a record with no due date is never due");
  } finally {
    await db.close();
  }
});

test("markReminderSent removes a sent offset from the due set and records the sent-marker", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac2-sent");
    const dek = freshDek();

    // The 14-day offset is due (see the due test above); the 1-day offset is not yet.
    const saved = (await createRecord(
      db,
      { userId, kind: "subscription", fields: subscriptionFields(), dueDate: "2026-11-20", status: "active", source: { kind: "person" } },
      dek,
    )) as RecordLike;

    const before = dueForRecord((await listDueForReminder(db, fixedClock(NOW))) as DueReminderLike[], saved.id);
    assert.deepEqual(before.map((d) => d.offset), [14], "the 14-day reminder is due before it is sent");

    await markReminderSent(db, { recordId: saved.id, offset: 14 });

    const after = dueForRecord((await listDueForReminder(db, fixedClock(NOW))) as DueReminderLike[], saved.id);
    assert.equal(after.length, 0, "once marked sent, the offset is no longer returned as due");

    // The sent-marker is recorded as plaintext metadata the owner can read back.
    const records = (await listRecordsForUser(db, userId, dek)) as RecordLike[];
    assert.ok(records[0]!.sentOffsets.includes(14), "the sent offset is recorded on the record");

    // Marking the same offset again is harmless (idempotent) and still not due.
    await markReminderSent(db, { recordId: saved.id, offset: 14 });
    const again = dueForRecord((await listDueForReminder(db, fixedClock(NOW))) as DueReminderLike[], saved.id);
    assert.equal(again.length, 0, "re-marking a sent offset keeps it out of the due set");
  } finally {
    await db.close();
  }
});

test("listDueForReminder is cross-user: it returns every person's due reminders with their owner", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "ac2-alice");
    const bob = await makeUser(db, "ac2-bob");
    const dek = freshDek();

    const a = (await createRecord(db, { userId: alice, kind: "subscription", fields: subscriptionFields({ service: "Alice sub" }), dueDate: "2026-11-20", status: "active", source: { kind: "person" } }, dek)) as RecordLike;
    const b = (await createRecord(db, { userId: bob, kind: "renewal_appointment", fields: { what: "Bob rego", where: "x" }, dueDate: "2026-11-20", status: "active", source: { kind: "person" } }, dek)) as RecordLike;

    const due = (await listDueForReminder(db, fixedClock(NOW))) as DueReminderLike[];
    const aDue = dueForRecord(due, a.id);
    const bDue = dueForRecord(due, b.id);
    assert.equal(aDue.length, 1, "Alice's due reminder is returned");
    assert.equal(aDue[0]!.userId, alice, "tagged with Alice as owner");
    assert.equal(bDue.length, 1, "Bob's due reminder is returned (the job reads across people)");
    assert.equal(bDue[0]!.userId, bob, "tagged with Bob as owner");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC3 — ownership: a second person can never read or write another's records.
// ===========================================================================

test("listRecordsForUser and listRecordsByKind never return another person's records", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "owner-alice");
    const bob = await makeUser(db, "owner-bob");
    const dek = freshDek();

    await createRecord(db, { userId: alice, kind: "subscription", fields: subscriptionFields({ service: "Alice A" }), dueDate: "2026-12-01", status: "active", source: { kind: "person" } }, dek);
    await createRecord(db, { userId: alice, kind: "renewal_appointment", fields: { what: "Alice appt", where: "x" }, dueDate: "2027-01-01", status: "upcoming", source: { kind: "person" } }, dek);
    await createRecord(db, { userId: bob, kind: "subscription", fields: subscriptionFields({ service: "Bob B" }), dueDate: "2026-12-01", status: "active", source: { kind: "person" } }, dek);

    const aliceAll = (await listRecordsForUser(db, alice, dek)) as RecordLike[];
    assert.equal(aliceAll.length, 2, "Alice sees exactly her own two records");
    assert.ok(aliceAll.every((r) => r.userId === alice), "every record in Alice's list is hers");
    assert.ok(!recordWithField(aliceAll, "service", "Bob B"), "Bob's record never appears in Alice's list");

    const aliceSubs = (await listRecordsByKind(db, alice, "subscription", dek)) as RecordLike[];
    assert.equal(aliceSubs.length, 1, "Alice's by-kind read is scoped to her own records");
    assert.ok(!recordWithField(aliceSubs, "service", "Bob B"), "and never includes Bob's subscription");

    const bobAll = (await listRecordsForUser(db, bob, dek)) as RecordLike[];
    assert.equal(bobAll.length, 1, "Bob sees exactly his own record");
    assert.equal(bobAll[0]!.fields.service, "Bob B", "Bob sees his own record");
  } finally {
    await db.close();
  }
});

test("updateRecord refuses to edit another person's record (and leaves it unchanged)", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "update-alice");
    const bob = await makeUser(db, "update-bob");
    const dek = freshDek();

    const aliceRecord = (await createRecord(
      db,
      { userId: alice, kind: "subscription", fields: subscriptionFields({ cost: "15.99" }), dueDate: "2026-12-01", status: "active", source: { kind: "person" } },
      dek,
    )) as RecordLike;

    // Bob tries to update Alice's record id under his own user id — member scope must refuse.
    await assert.rejects(
      async () => {
        await updateRecord(
          db,
          { userId: bob, id: aliceRecord.id, fields: subscriptionFields({ cost: "0.00" }), dueDate: "2026-12-01", status: "hijacked" },
          dek,
        );
      },
      "one person cannot update another's record",
    );

    // Alice's record is untouched.
    const aliceRecords = (await listRecordsForUser(db, alice, dek)) as RecordLike[];
    assert.equal(aliceRecords.length, 1, "Alice still has her record");
    assert.equal(aliceRecords[0]!.fields.cost, "15.99", "its field value is unchanged");
    assert.equal(aliceRecords[0]!.status, "active", "its status is unchanged");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC4 — every statement binds its input as a parameter (no spliced SQL).
// ===========================================================================

test("createRecord binds its inputs as parameters, never woven into the SQL text", async () => {
  const db = recordingDb();
  const probe = "u'); DROP TABLE life_admin_records; --";

  // The recording db returns no rows; createRecord assembles its result from the inputs, so the
  // INSERT it issued must have BOUND the probe (here the owner id), which is checked below.
  try {
    await createRecord(
      db,
      { userId: probe, kind: "subscription", fields: subscriptionFields(), dueDate: "2026-12-01", status: "active", source: { kind: "person" } },
      freshDek(),
    );
  } catch {
    /* tolerate a no-row read: the binding is asserted below regardless */
  }

  assertBoundNotSpliced(db, probe);
});

test("updateRecord binds its inputs as parameters, never woven into the SQL text", async () => {
  const db = recordingDb();
  const probe = "p'); DROP TABLE life_admin_records; --";

  try {
    await updateRecord(
      db,
      { userId: probe, id: "some-id", fields: subscriptionFields(), dueDate: "2026-12-01", status: "active" },
      freshDek(),
    );
  } catch {
    /* an empty RETURNING may throw "not found" — the binding is asserted regardless */
  }

  assertBoundNotSpliced(db, probe);
});

test("listRecordsForUser binds the user id as a parameter, never woven into the SQL text", async () => {
  const db = recordingDb();
  const probe = "l'); DROP TABLE life_admin_records; --";

  const result = await listRecordsForUser(db, probe, freshDek());
  assert.deepEqual(result, [], "the recording db returns no rows, so the list is empty");

  assertBoundNotSpliced(db, probe);
});

test("a SQL-injection probe in a field is stored as data: the table survives and it round-trips", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "inject");
    const dek = freshDek();
    const probe = "Grace'); DROP TABLE life_admin_records; --";

    await createRecord(
      db,
      { userId, kind: "subscription", fields: subscriptionFields({ service: probe }), dueDate: "2026-12-01", status: "active", source: { kind: "person" } },
      dek,
    );

    assert.equal(
      await tableExists(db, "life_admin_records"),
      true,
      "the life_admin_records table must still exist (the probe was stored as data, not run as SQL)",
    );

    const records = (await listRecordsForUser(db, userId, dek)) as RecordLike[];
    assert.ok(recordWithField(records, "service", probe), "the probe round-trips verbatim as data");
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

const KINDS = ["subscription", "receipt_warranty", "renewal_appointment"] as const;

function createRecordHandler(
  db: Db,
  dek: Uint8Array,
  sessionUserId: string,
): (req: Request) => Promise<Response> {
  // The body carries the kind, the fields, the metadata and an optional offsets list; the user
  // id comes from the session, never the body. Lengths are capped so an absurd value is
  // rejected, but generous enough that a probe can still REACH the query to prove it is bound.
  const schema = z.object({
    kind: z.enum(KINDS),
    fields: z.record(z.string(), z.string()),
    dueDate: z.string().min(1).max(32).optional(),
    status: z.string().min(1).max(64),
    reminderOffsets: z.array(z.number().int().min(0).max(3650)).max(20).optional(),
    source: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("person") }),
      z.object({ kind: z.literal("agent"), agentId: z.string().min(1).max(128) }),
    ]),
  });
  return async (req: Request): Promise<Response> => {
    try {
      const body = await parseBody(schema, req, { maxBytes: 8 * 1024 });
      const saved = await createRecord(
        db,
        {
          userId: sessionUserId,
          kind: body.kind,
          fields: body.fields,
          dueDate: body.dueDate,
          status: body.status,
          reminderOffsets: body.reminderOffsets,
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
  return new Request("https://warthog.com.au/api/life-admin", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

function validBody(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    kind: "subscription",
    fields: { service: "Netflix", cost: "15.99" },
    dueDate: "2026-12-01",
    status: "active",
    source: { kind: "person" },
    ...over,
  });
}

test("the handler rejects malformed JSON with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = createRecordHandler(db, freshDek(), "session-user");

  const res = await handler(jsonRequest("{ not valid json"));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "malformed input must never reach a query");
});

test("the handler rejects an oversized body with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = createRecordHandler(db, freshDek(), "session-user");

  // ~20 KiB field value, well over the handler's 8 KiB cap: rejected by size before parse.
  const res = await handler(jsonRequest(validBody({ fields: { service: "a".repeat(20 * 1024) } })));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "an oversized body must never reach a query");
});

test("the handler rejects a body missing a required field with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = createRecordHandler(db, freshDek(), "session-user");

  // No status — a record must carry its plaintext status metadata.
  const res = await handler(jsonRequest(JSON.stringify({ kind: "subscription", fields: { service: "x" }, source: { kind: "person" } })));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "a schema violation must never reach a query");
});

test("the handler rejects an unknown kind with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = createRecordHandler(db, freshDek(), "session-user");

  const res = await handler(jsonRequest(validBody({ kind: "budget" })));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "an out-of-enum kind must never reach a query");
});

test("the handler rejects a mis-typed field with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = createRecordHandler(db, freshDek(), "session-user");

  // fields must be an object of string values — a string is a schema violation.
  const res = await handler(jsonRequest(validBody({ fields: "not-an-object" })));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "a mis-typed field must never reach a query");
});

test("the handler accepts a well-formed body and records the record for the SESSION user", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "handler-ok");
    const dek = freshDek();
    const handler = createRecordHandler(db, dek, userId);

    const res = await handler(jsonRequest(validBody()));

    assert.ok(res.status >= 200 && res.status < 300, `expected a 2xx, got ${res.status}`);
    const { id } = (await res.json()) as { id: string };
    assert.ok(typeof id === "string" && id.length > 0, "the handler returns the stored record id");

    const records = (await listRecordsForUser(db, userId, dek)) as RecordLike[];
    assert.equal(records.length, 1, "a valid body is persisted for the session user");
    assert.equal(records[0]!.id, id, "the stored record matches the returned id");
    assert.equal(records[0]!.kind, "subscription", "with the submitted kind");
    assert.deepEqual(records[0]!.fields, { service: "Netflix", cost: "15.99" }, "and the submitted fields, decrypted");
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
    const handler = createRecordHandler(db, dek, sessionUser);

    // The body smuggles a userId; the handler must ignore it and use the session's.
    const res = await handler(jsonRequest(validBody({ userId: attacker })));
    assert.ok(res.status >= 200 && res.status < 300, `expected a 2xx, got ${res.status}`);

    assert.equal(
      (await listRecordsForUser(db, sessionUser, dek)).length,
      1,
      "the record is recorded under the SESSION user",
    );
    assert.deepEqual(
      await listRecordsForUser(db, attacker, dek),
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
    const handler = createRecordHandler(db, dek, userId);
    const probe = "oren'); DROP TABLE life_admin_records; --";

    const res = await handler(jsonRequest(validBody({ fields: { service: probe } })));

    assert.ok(res.status >= 200 && res.status < 300, "a valid-shaped (if nasty) value is accepted");
    assert.equal(await tableExists(db, "life_admin_records"), true, "the life_admin_records table must still exist");

    const records = (await listRecordsForUser(db, userId, dek)) as RecordLike[];
    assert.ok(recordWithField(records, "service", probe), "the probe is stored verbatim, not interpreted as SQL");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC5 — the fields are encrypted under the INJECTED dek, not a baked-in secret (a different
// dek cannot read them back); the repo reads no process.env and holds no key (INV-103), shown
// behaviourally with a decoy secret in the environment.
// ===========================================================================

test("listRecordsForUser cannot decrypt the fields with a different DEK", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac5-wrongdek");
    const dek = freshDek();
    await createRecord(
      db,
      { userId, kind: "subscription", fields: subscriptionFields(), dueDate: "2026-12-01", status: "active", source: { kind: "person" } },
      dek,
    );

    // A different DEK is the wrong key; the GCM tag must fail rather than return other bytes —
    // so reading the records under it rejects.
    const wrongDek = freshDek();
    await assert.rejects(
      async () => {
        await listRecordsForUser(db, userId, wrongDek);
      },
      "the fields are bound to the person's own DEK, not any ambient/hardcoded key",
    );
  } finally {
    await db.close();
  }
});

test("the repo reads no process.env: a decoy secret in the environment never lands in a record", async () => {
  const DECOY = "sk_live_DECOY_must_never_appear_in_warthog";
  const prev = process.env.WARTHOG_DECOY_SECRET;
  process.env.WARTHOG_DECOY_SECRET = DECOY;
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac5");
    const dek = freshDek();
    await createRecord(
      db,
      { userId, kind: "subscription", fields: subscriptionFields(), dueDate: "2026-12-01", status: "active", source: { kind: "person" } },
      dek,
    );

    const records = (await listRecordsForUser(db, userId, dek)) as RecordLike[];
    assert.equal(records.length, 1, "the record reads and writes purely from the injected db — no app env needed");
    assert.ok(
      !JSON.stringify(records).includes(DECOY),
      "no ambient env value is folded into the returned records",
    );

    // Scan every cell of the one table under test for the decoy (scoped narrowly — the same
    // value could legitimately live elsewhere if it were a real datum, which it is not).
    const all = await db.query("SELECT * FROM life_admin_records");
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

test("the life_admin_records migration applies and re-running every migration changes nothing", async () => {
  const db = await freshDb();
  try {
    assert.equal(
      await tableExists(db, "life_admin_records"),
      true,
      "the life_admin_records table must exist after the project migrations",
    );

    const migrations = await loadMigrations();
    assert.ok(
      migrations.some((m) => m.name === "0033_life_admin_records"),
      "db/migrations/0033_life_admin_records.sql must be part of the project migrations",
    );

    // A second run over the same database applies nothing new and does not throw — re-executing
    // 0033's CREATE would throw "already exists", so an empty result AND no throw together prove
    // the migration's second run changes nothing.
    const again = await runMigrations(db, migrations);
    assert.deepEqual(again, [], "a second migration run must change nothing");
  } finally {
    await db.close();
  }
});
