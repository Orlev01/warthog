// The life-admin records aggregate's data access (brief "Life admin"; design
// §4.1). Life-admin records are the content a person and their agents both
// maintain, in three kinds: subscriptions, receipts and warranties, and renewals
// and appointments. Each record's FIELDS are PERSONAL CONTENT, so they are stored
// only DEK-ENCRYPTED (`../crypto/envelope`): the id is generated up front so the
// fields envelope's associated data binds the ciphertext to its exact (table,
// column, row) — the plaintext fields never land in a column.
//
// The KIND, the due/next DATE, the STATUS, the per-record reminder OFFSETS +
// SENT-markers and the SOURCE (person | agent) stay PLAINTEXT metadata (design
// §4.1), so the reminders job (`listDueForReminder`) and the Life-admin page can
// filter WITHOUT decrypting another person's data. A record carries its reminder
// offsets (defaulting to 14 and 1 days before the due date, per the brief) and
// the offsets whose reminder has already been sent.
//
// Every statement is parameterized through the `Db` seam (INV-102): the ids and
// every value travel as BOUND values, never concatenated into the SQL text, so a
// value shaped like SQL is stored as data and cannot alter the query. Every
// member-scoped read/write is scoped by the `userId` the caller passes — the
// session's / connection's id, never a client value — so one person can never
// read or write another's records. The DEK is injected (this module reads no
// `process.env` and holds no key, INV-103); `listDueForReminder` and
// `markReminderSent` are the system job's reads/writes and take no DEK at all —
// they only ever touch plaintext metadata.

import { randomUUID } from "node:crypto";

import { decrypt, encrypt } from "../crypto/envelope";
import type { Clock } from "../seams/clock";
import type { Db, Row } from "./index";

// The envelope's associated data binds each fields blob to its exact location, so
// a row's ciphertext lifted into another row/column/table fails to decrypt.
const TABLE = "life_admin_records";
const FIELDS_COLUMN = "fields";

// The brief's default reminder schedule: 14 days and 1 day before the due date.
const DEFAULT_REMINDER_OFFSETS = [14, 1];

// The three record kinds (task / brief).
export type RecordKind = "subscription" | "receipt_warranty" | "renewal_appointment";

// Who maintains this record (plaintext metadata): the signed-in person, or a
// connected agent (an opaque id, like activity.agent_id).
export type RecordSource = { kind: "person" } | { kind: "agent"; agentId: string };

// What createRecord records. `userId` is the OWNER (the session's / connection's
// id, never a client value). `fields` is the kind's content, stored DEK-encrypted
// as one blob. `dueDate` is the reminder anchor (ISO "YYYY-MM-DD"); absent/null ⇒
// no reminders. `reminderOffsets` default to [14, 1] when omitted.
export interface NewRecord {
  readonly userId: string;
  readonly kind: RecordKind;
  readonly fields: Record<string, unknown>;
  readonly dueDate?: string | null;
  readonly status: string;
  readonly reminderOffsets?: number[];
  readonly source: RecordSource;
}

// What updateRecord changes for the owner's own record. Member-scoped by
// `userId` + `id`. `reminderOffsets` are left unchanged when omitted.
export interface UpdateRecordInput {
  readonly userId: string;
  readonly id: string;
  readonly fields: Record<string, unknown>;
  readonly dueDate?: string | null;
  readonly status: string;
  readonly reminderOffsets?: number[];
}

// A record as handed back to its owner, with its fields DECRYPTED. `sentOffsets`
// are the offsets whose reminder has already been sent.
export interface LifeAdminRecord {
  readonly id: string;
  readonly userId: string;
  readonly kind: RecordKind;
  readonly fields: Record<string, unknown>;
  readonly dueDate: string | Date | null;
  readonly status: string;
  readonly reminderOffsets: number[];
  readonly sentOffsets: number[];
  readonly source: RecordSource;
}

// One due, unsent reminder — METADATA ONLY (no decrypted field): the owner + the
// exact offset that is now due, so the reminders job can route it.
export interface DueReminder {
  readonly recordId: string;
  readonly userId: string;
  readonly kind: RecordKind;
  readonly dueDate: string | Date;
  readonly offset: number;
}

// The metadata columns every owner read returns. `due_date` is cast to text so it
// round-trips as a stable "YYYY-MM-DD" string regardless of the driver's date
// handling (a bare `date` comes back as a UTC-midnight Date that would shift a day
// in a timezone behind UTC); `fields` comes back as ciphertext and is decrypted
// separately.
const SELECT_COLUMNS =
  "id, user_id, kind, fields, due_date::text AS due_date, status, " +
  "reminder_offsets, sent_offsets, source_kind, source_agent_id";

// Reconstruct the plaintext source metadata from its two columns.
function toSource(row: Row): RecordSource {
  if (row.source_kind === "agent") {
    return { kind: "agent", agentId: row.source_agent_id as string };
  }
  return { kind: "person" };
}

// Coerce a stored int[] column to a number[] regardless of whether the driver
// hands back numbers or numeric strings.
function toOffsets(value: unknown): number[] {
  return ((value as unknown[]) ?? []).map(Number);
}

// Map a raw row (plus its already-decrypted fields) to a LifeAdminRecord,
// translating the snake_case columns to the module's camelCase fields.
function toRecord(row: Row, fields: Record<string, unknown>): LifeAdminRecord {
  return {
    id: row.id as string,
    userId: row.user_id as string,
    kind: row.kind as RecordKind,
    fields,
    dueDate: (row.due_date as string | null) ?? null,
    status: row.status as string,
    reminderOffsets: toOffsets(row.reminder_offsets),
    sentOffsets: toOffsets(row.sent_offsets),
    source: toSource(row),
  };
}

// Save a life-admin record for `input.userId`, storing its fields DEK-encrypted
// as one JSON blob plus the plaintext metadata (kind, due date, status, reminder
// offsets — defaulting to [14, 1] — source). `sent_offsets` starts empty (the DB
// default). The id is generated up front so the fields envelope binds to the row;
// the returned record is assembled from the inputs (no dependency on a RETURNING
// read).
export async function createRecord(
  db: Db,
  input: NewRecord,
  dek: Uint8Array,
): Promise<LifeAdminRecord> {
  const id = randomUUID();
  const dueDate = input.dueDate ?? null;
  const reminderOffsets = input.reminderOffsets ?? [...DEFAULT_REMINDER_OFFSETS];
  const source = input.source;
  const sourceAgentId = source.kind === "agent" ? source.agentId : null;
  const envelope = await encrypt(dek, TABLE, FIELDS_COLUMN, id, JSON.stringify(input.fields));

  await db.query(
    `INSERT INTO life_admin_records
       (id, user_id, kind, fields, due_date, status, reminder_offsets, source_kind, source_agent_id)
     VALUES ($1, $2, $3, $4, $5::date, $6, $7::int[], $8, $9)`,
    [id, input.userId, input.kind, envelope, dueDate, input.status, reminderOffsets, source.kind, sourceAgentId],
  );

  return {
    id,
    userId: input.userId,
    kind: input.kind,
    fields: input.fields,
    dueDate,
    status: input.status,
    reminderOffsets,
    sentOffsets: [],
    source,
  };
}

// Update the owner's own record (member-scoped: both id AND user_id are bound),
// re-encrypting the fields and updating the plaintext metadata. `reminderOffsets`
// are left unchanged when omitted. Moving the due date (to another date, or clearing
// it) starts a FRESH reminder cycle: the sent-markers belonged to the old date, so they
// are cleared and the new date's reminders fire — a renewal rolled on a year reminds
// again. An edit that keeps the same date keeps them, so nothing is sent twice. (In the
// SET list `due_date` still names the row's OLD value, so the comparison is old vs new.)
// THROWS when no such record belongs to this user — so one person can never edit
// another's record.
export async function updateRecord(
  db: Db,
  input: UpdateRecordInput,
  dek: Uint8Array,
): Promise<LifeAdminRecord> {
  const dueDate = input.dueDate ?? null;
  const reminderOffsets = input.reminderOffsets ?? null;
  const envelope = await encrypt(dek, TABLE, FIELDS_COLUMN, input.id, JSON.stringify(input.fields));

  const result = await db.query(
    `UPDATE life_admin_records
     SET fields = $3,
         due_date = $4::date,
         status = $5,
         reminder_offsets = COALESCE($6::int[], reminder_offsets),
         sent_offsets = CASE WHEN due_date IS DISTINCT FROM $4::date
                             THEN '{}'::int[] ELSE sent_offsets END
     WHERE id = $1 AND user_id = $2
     RETURNING ${SELECT_COLUMNS}`,
    [input.id, input.userId, envelope, dueDate, input.status, reminderOffsets],
  );

  const row = result.rows[0];
  if (!row) {
    throw new Error("updateRecord: no such record for this user");
  }
  return toRecord(row, input.fields);
}

// List ALL of `userId`'s records (member-scoped: user_id is bound), each fields
// blob DECRYPTED under the owner's `dek`. Never another person's records; an empty
// array when the person has none. A wrong DEK fails the GCM tag and rejects.
export async function listRecordsForUser(
  db: Db,
  userId: string,
  dek: Uint8Array,
): Promise<LifeAdminRecord[]> {
  const result = await db.query(
    `SELECT ${SELECT_COLUMNS} FROM life_admin_records WHERE user_id = $1`,
    [userId],
  );
  return decryptRows(result.rows, dek);
}

// The same, filtered to one `kind` (the "filterable by kind" read).
export async function listRecordsByKind(
  db: Db,
  userId: string,
  kind: RecordKind,
  dek: Uint8Array,
): Promise<LifeAdminRecord[]> {
  const result = await db.query(
    `SELECT ${SELECT_COLUMNS} FROM life_admin_records WHERE user_id = $1 AND kind = $2`,
    [userId, kind],
  );
  return decryptRows(result.rows, dek);
}

// Decrypt each row's fields blob under the owner's DEK and assemble the records.
async function decryptRows(rows: Row[], dek: Uint8Array): Promise<LifeAdminRecord[]> {
  const records: LifeAdminRecord[] = [];
  for (const row of rows) {
    const plaintext = await decrypt(dek, TABLE, FIELDS_COLUMN, row.id as string, row.fields as string);
    records.push(toRecord(row, JSON.parse(plaintext) as Record<string, unknown>));
  }
  return records;
}

// The REMINDERS JOB's read. Deliberately CROSS-USER (no userId, no dek): for EVERY
// person, return each (record, offset) where the offset's reminder date
// (due_date − offset days) is at or before `clock.now()`, the offset has NOT been
// marked sent, and the record has a due date. METADATA ONLY — it never decrypts a
// field (the fields blob is not even selected), which is exactly design §4.1's
// "filter without decrypting another person's data".
export async function listDueForReminder(db: Db, clock: Clock): Promise<DueReminder[]> {
  const result = await db.query(
    `SELECT r.id AS record_id, r.user_id, r.kind, r.due_date::text AS due_date, o AS "offset"
     FROM life_admin_records r, unnest(r.reminder_offsets) AS o
     WHERE r.due_date IS NOT NULL
       AND NOT (o = ANY(r.sent_offsets))
       AND (r.due_date - o) <= $1`,
    [clock.now()],
  );
  return result.rows.map((row) => ({
    recordId: row.record_id as string,
    userId: row.user_id as string,
    kind: row.kind as RecordKind,
    dueDate: row.due_date as string,
    offset: Number(row.offset),
  }));
}

// Record that the reminder for one (record, offset) has been sent — the SENT-marker
// the job sets so `listDueForReminder` stops returning it. DEK-FREE (the job holds
// no key); keyed on the record's unguessable id, so it is the system job's write,
// not a member read. Appending only when absent makes a repeat call idempotent.
export async function markReminderSent(
  db: Db,
  input: { recordId: string; offset: number },
): Promise<void> {
  await db.query(
    `UPDATE life_admin_records
     SET sent_offsets = array_append(sent_offsets, $2::int)
     WHERE id = $1 AND NOT ($2::int = ANY(sent_offsets))`,
    [input.recordId, input.offset],
  );
}
