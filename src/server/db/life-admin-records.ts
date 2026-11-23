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
//
// Typed records (migration 0117, docs/adr/life-admin-profile.md): a record's TYPE and where
// an agent says it found it live in the encrypted `meta` envelope; its review state (suggested
// by an agent, confirmed by the person, or dismissed), the asset it belongs to, its match key
// (an opaque HMAC under a key derived from the DEK) and who last changed it are plaintext
// metadata. An agent's proposed change to a confirmed record waits, encrypted, in `pending`.
// A dismissed record is a tombstone: its fields are emptied and it is left out of every list,
// so only its match key remains to stop the same suggestion being added again.

import { createHmac, hkdfSync, randomUUID } from "node:crypto";
import { MAX_REMINDER_OFFSET_DAYS, recordDueDateSchema, reminderOffsetsSchema } from "../../domain/life-admin/record-metadata";
import { remindUntilOf, WINDOWS } from "../../domain/life-admin/lifecycle";

import { decrypt, encrypt } from "../crypto/envelope";
import type { Clock } from "../seams/clock";
import { assertCollectionCapacity } from "./collection-limits";
import { withTransaction, type Db, type Row } from "./index";

// The envelope's associated data binds each fields blob to its exact location, so
// a row's ciphertext lifted into another row/column/table fails to decrypt.
const TABLE = "life_admin_records";
const FIELDS_COLUMN = "fields";
const META_COLUMN = "meta";
const PENDING_COLUMN = "pending";

// The brief's default reminder schedule: 14 days and 1 day before the due date.
const DEFAULT_REMINDER_OFFSETS = [14, 1];

// How long after its due date a record's unsent reminders may still go out.
export const REMINDER_GRACE_DAYS = WINDOWS.reminderGraceDays;

// The stored kinds: the three original ones, and `item` for every other type (whose type
// lives encrypted in `meta`, so the plaintext kind never names a category).
export type RecordKind = "subscription" | "receipt_warranty" | "renewal_appointment" | "item";

// Who maintains this record (plaintext metadata): the signed-in person, or a
// connected agent (an opaque id, like activity.agent_id).
export type RecordSource = { kind: "person" } | { kind: "agent"; agentId: string };

// Suggested by an agent and not yet checked; added or checked by the person; or dismissed.
export type ReviewState = "suggested" | "confirmed" | "dismissed";

// Where an agent says it found a record (encrypted in `meta`). `seenByWarthog` is set by
// Warthog, not the agent: true only when this agent had just read mail from that sender
// through Warthog (the read-exposure window), so the claim is not the agent's alone.
export interface RecordFoundIn {
  readonly service: string;
  readonly messageId?: string;
  readonly date?: string;
  readonly sender?: string;
  readonly seenByWarthog: boolean;
}

// An agent's proposed change to a record the person confirmed, kept until they decide.
export interface PendingChange {
  readonly set: Readonly<Record<string, string>>;
  readonly remove: readonly string[];
  readonly dueDate?: string | null;
  readonly status?: string;
  readonly byAgentId: string;
  readonly at: string;
  readonly foundIn?: RecordFoundIn;
}

// The encrypted `meta` envelope's content.
interface RecordMeta {
  readonly type?: string;
  readonly foundIn?: RecordFoundIn;
  // A booking's or case's detailed state (pending, confirmed, cancelled, no_show; open, waiting,
  // resolved). Kept here, encrypted, so the plaintext status never says a record is a booking.
  readonly state?: string;
}

// The agent handling a live item (a label, never a lock or a permission).
export interface RecordSteward {
  readonly agentId: string;
  readonly setBy: "person" | "agent";
  readonly since: string;
}

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
  // Typed records (0117). An agent's record defaults to `suggested`, the person's to `confirmed`.
  readonly type?: string | null;
  readonly foundIn?: RecordFoundIn | null;
  readonly reviewState?: ReviewState;
  readonly parentId?: string | null;
  readonly matchKeys?: readonly string[];
  readonly state?: string | null;
  // The last day reminders may go out; omitted ⇒ worked out as for a standing item.
  readonly remindUntil?: string | null;
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
  // Each left unchanged when omitted. `changedBy` defaults to the person.
  readonly type?: string | null;
  readonly foundIn?: RecordFoundIn | null;
  readonly reviewState?: Exclude<ReviewState, "dismissed">;
  readonly parentId?: string | null;
  readonly matchKeys?: readonly string[];
  readonly state?: string | null;
  readonly remindUntil?: string | null;
  readonly changedBy?: RecordSource;
  // Drop a pending agent change (the person accepted it into `fields`, or kept their own).
  readonly clearPending?: boolean;
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
  // Typed records (0117): null type ⇒ the record reads as its kind's type.
  readonly type: string | null;
  readonly foundIn: RecordFoundIn | null;
  readonly reviewState: ReviewState;
  readonly parentId: string | null;
  readonly matchKeys: readonly string[];
  readonly state: string | null;
  readonly remindUntil: string | null;
  readonly steward: RecordSteward | null;
  readonly pending: PendingChange | null;
  readonly changedBy: RecordSource | null;
  readonly createdAt: string;
  readonly updatedAt: string;
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
  "reminder_offsets, sent_offsets, source_kind, source_agent_id, meta, review_state, parent_id, " +
  "match_keys, pending, changed_by_kind, changed_by_agent_id, created_at, updated_at, " +
  "remind_until::text AS remind_until, steward_agent_id, steward_set_by, steward_since";

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

function toChangedBy(row: Row): RecordSource | null {
  if (row.changed_by_kind === "agent") return { kind: "agent", agentId: row.changed_by_agent_id as string };
  return row.changed_by_kind === "person" ? { kind: "person" } : null;
}

function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : new Date(String(value ?? 0)).toISOString();
}

// Map a raw row (plus its already-decrypted content) to a LifeAdminRecord,
// translating the snake_case columns to the module's camelCase fields.
function toRecord(row: Row, fields: Record<string, unknown>, meta: RecordMeta = {}, pending: PendingChange | null = null): LifeAdminRecord {
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
    type: meta.type ?? null,
    foundIn: meta.foundIn ?? null,
    reviewState: (row.review_state as ReviewState | undefined) ?? "confirmed",
    parentId: (row.parent_id as string | null) ?? null,
    matchKeys: ((row.match_keys as string[] | null) ?? []).map(String),
    state: meta.state ?? null,
    remindUntil: (row.remind_until as string | null) ?? null,
    steward: row.steward_agent_id
      ? { agentId: row.steward_agent_id as string, setBy: (row.steward_set_by as "person" | "agent") ?? "agent", since: iso(row.steward_since) }
      : null,
    pending,
    changedBy: toChangedBy(row),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at ?? row.created_at),
  };
}

// The key a record's match key is an HMAC under: derived from the person's DEK with its own
// context label, so it differs per person and from every other derived key.
const MATCH_INFO = "warthog/life-admin-match/v1";

/** The opaque match key for a kind, the fields that identify it and their values (see identityAlternatives). */
export function recordMatchKey(dek: Uint8Array, typeId: string, keys: readonly string[], values: readonly string[]): string {
  const key = Buffer.from(hkdfSync("sha256", dek, new Uint8Array(0), MATCH_INFO, 32));
  return createHmac("sha256", key).update([typeId, keys.join(","), ...values].join("\u001f"), "utf8").digest("hex");
}

// The default last reminder day: as for a standing item (live, due + grace).
function defaultRemindUntil(status: string, dueDate: string | null): string | null {
  return remindUntilOf({ lifecycle: "standing" }, status, null, dueDate);
}

async function encryptMeta(dek: Uint8Array, id: string, meta: RecordMeta): Promise<string | null> {
  return meta.type || meta.foundIn || meta.state ? encrypt(dek, TABLE, META_COLUMN, id, JSON.stringify(meta)) : null;
}

// A parent must be another of the SAME person's records, and not a dismissed one.
async function assertParent(db: Db, userId: string, id: string, parentId: string | null | undefined): Promise<void> {
  if (!parentId) return;
  if (parentId === id) throw new Error("life-admin record: a record cannot belong to itself");
  const owner = await db.query(
    "SELECT id FROM life_admin_records WHERE id = $1 AND user_id = $2 AND review_state <> 'dismissed'",
    [parentId, userId],
  );
  if (owner.rows.length === 0) throw new Error("life-admin record: no such parent record for this user");
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
  // Validate before any query, then do the work in one transaction.
  const dueDate = recordDueDateSchema.nullable().parse(input.dueDate ?? null);
  const reminderOffsets = reminderOffsetsSchema.parse(input.reminderOffsets ?? [...DEFAULT_REMINDER_OFFSETS]);
  if (!db.inTransaction) return withTransaction(db, (tx) => createRecord(tx, input, dek));
  const id = randomUUID();
  const source = input.source;
  const sourceAgentId = source.kind === "agent" ? source.agentId : null;
  const reviewState: ReviewState = input.reviewState ?? (source.kind === "agent" ? "suggested" : "confirmed");
  const parentId = input.parentId ?? null;
  const meta: RecordMeta = { ...(input.type ? { type: input.type } : {}), ...(input.foundIn ? { foundIn: input.foundIn } : {}), ...(input.state ? { state: input.state } : {}) };
  const remindUntil = input.remindUntil !== undefined ? input.remindUntil : defaultRemindUntil(input.status, dueDate);
  const envelope = await encrypt(dek, TABLE, FIELDS_COLUMN, id, JSON.stringify(input.fields));
  const metaEnvelope = await encryptMeta(dek, id, meta);
  // Lock the owner row and check the person's record allowance (collection-bounds ADR); the
  // lock also serialises a caller's match look-up with this insert.
  await assertCollectionCapacity(db, input.userId, "life_admin_records", envelope.length);
  await assertParent(db, input.userId, id, parentId);

  const result = await db.query(
    `INSERT INTO life_admin_records
       (id, user_id, kind, fields, due_date, status, reminder_offsets, source_kind, source_agent_id,
        meta, review_state, parent_id, match_keys, changed_by_kind, changed_by_agent_id, remind_until)
     VALUES ($1, $2, $3, $4, $5::date, $6, $7::int[], $8, $9, $10, $11, $12, $13::text[], $8, $9, $14::date)
     RETURNING created_at, updated_at`,
    [id, input.userId, input.kind, envelope, dueDate, input.status, reminderOffsets, source.kind, sourceAgentId,
      metaEnvelope, reviewState, parentId, [...(input.matchKeys ?? [])], remindUntil],
  );
  const stamps = result.rows[0] ?? {};

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
    type: meta.type ?? null,
    foundIn: meta.foundIn ?? null,
    reviewState,
    parentId,
    matchKeys: [...(input.matchKeys ?? [])],
    state: meta.state ?? null,
    remindUntil,
    steward: null,
    pending: null,
    changedBy: source,
    createdAt: iso(stamps.created_at ?? new Date()),
    updatedAt: iso(stamps.updated_at ?? stamps.created_at ?? new Date()),
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
  // Validate before any query, then do the work in one transaction.
  const dueDate = recordDueDateSchema.nullable().parse(input.dueDate ?? null);
  const reminderOffsets = input.reminderOffsets === undefined ? null : reminderOffsetsSchema.parse(input.reminderOffsets);
  if (!db.inTransaction) return withTransaction(db, (tx) => updateRecord(tx, input, dek));
  const envelope = await encrypt(dek, TABLE, FIELDS_COLUMN, input.id, JSON.stringify(input.fields));
  await assertCollectionCapacity(db, input.userId, "life_admin_records", envelope.length, input.id);

  // Lock the row (member-scoped) so its meta merges with what is there now.
  const current = (await db.query(
    "SELECT meta, review_state, due_date::text AS due_date FROM life_admin_records WHERE id = $1 AND user_id = $2 FOR UPDATE",
    [input.id, input.userId],
  )).rows[0];
  if (!current || current.review_state === "dismissed") {
    throw new Error("updateRecord: no such record for this user");
  }
  let meta: RecordMeta = current.meta ? JSON.parse(await decrypt(dek, TABLE, META_COLUMN, input.id, current.meta as string)) : {};
  let metaEnvelope = (current.meta as string | null) ?? null;
  if (input.type !== undefined || input.foundIn !== undefined || input.state !== undefined) {
    const next: { type?: string; foundIn?: RecordFoundIn; state?: string } = { ...meta };
    if (input.state !== undefined) {
      if (input.state) next.state = input.state;
      else delete next.state;
    }
    if (input.type !== undefined) {
      if (input.type) next.type = input.type;
      else delete next.type;
    }
    if (input.foundIn !== undefined) {
      if (input.foundIn) next.foundIn = input.foundIn;
      else delete next.foundIn;
    }
    meta = next;
    metaEnvelope = await encryptMeta(dek, input.id, meta);
  }
  if (input.parentId !== undefined) await assertParent(db, input.userId, input.id, input.parentId);
  const changedBy = input.changedBy ?? { kind: "person" as const };
  const effectiveDue = input.dueDate !== undefined ? dueDate : ((current.due_date as string | null) ?? null);
  const remindUntil = input.remindUntil !== undefined ? input.remindUntil : defaultRemindUntil(input.status, effectiveDue);

  const result = await db.query(
    `UPDATE life_admin_records
     SET fields = $3,
         due_date = CASE WHEN $7::boolean THEN $4::date ELSE due_date END,
         status = $5,
         reminder_offsets = COALESCE($6::int[], reminder_offsets),
         sent_offsets = CASE WHEN $7::boolean AND due_date IS DISTINCT FROM $4::date
                             THEN '{}'::int[] ELSE sent_offsets END,
         meta = $8,
         review_state = COALESCE($9, review_state),
         parent_id = CASE WHEN $10::boolean THEN $11::uuid ELSE parent_id END,
         match_keys = CASE WHEN $12::boolean THEN $13::text[] ELSE match_keys END,
         pending = CASE WHEN $14::boolean THEN NULL ELSE pending END,
         changed_by_kind = $15,
         changed_by_agent_id = $16,
         remind_until = $17::date,
         updated_at = now()
     WHERE id = $1 AND user_id = $2
     RETURNING ${SELECT_COLUMNS}`,
    [input.id, input.userId, envelope, dueDate, input.status, reminderOffsets, input.dueDate !== undefined,
      metaEnvelope, input.reviewState ?? null, input.parentId !== undefined, input.parentId ?? null,
      input.matchKeys !== undefined, [...(input.matchKeys ?? [])], input.clearPending === true,
      changedBy.kind, changedBy.kind === "agent" ? changedBy.agentId : null, remindUntil],
  );

  const row = result.rows[0];
  if (!row) {
    throw new Error("updateRecord: no such record for this user");
  }
  return toRecord(row, input.fields, meta, await decryptPending(dek, row));
}

// One of the person's live (not dismissed) records by id, decrypted; null when there is none.
export async function getRecordForUser(
  db: Db,
  userId: string,
  id: string,
  dek: Uint8Array,
): Promise<LifeAdminRecord | null> {
  const result = await db.query(
    `SELECT ${SELECT_COLUMNS} FROM life_admin_records WHERE id = $1 AND user_id = $2 AND review_state <> 'dismissed'`,
    [id, userId],
  );
  return (await decryptRows(result.rows, dek))[0] ?? null;
}

// The person's record sharing any of these match keys: a live one first, else a dismissed
// tombstone (so a caller can tell "already saved" from "the person said not mine"). Null when none.
export async function findRecordByMatchKeys(
  db: Db,
  userId: string,
  matchKeys: readonly string[],
  dek: Uint8Array,
): Promise<LifeAdminRecord | null> {
  if (matchKeys.length === 0) return null;
  const result = await db.query(
    `SELECT ${SELECT_COLUMNS} FROM life_admin_records WHERE user_id = $1 AND match_keys && $2::text[]
     ORDER BY (review_state = 'dismissed') ASC, updated_at DESC, id ASC LIMIT 1`,
    [userId, [...matchKeys]],
  );
  return (await decryptRows(result.rows, dek))[0] ?? null;
}

// The agent handling a live item, or nobody (null). Member-scoped; true when the record exists.
export async function setSteward(
  db: Db,
  userId: string,
  id: string,
  steward: { readonly agentId: string; readonly setBy: "person" | "agent"; readonly since: Date } | null,
): Promise<boolean> {
  const result = await db.query(
    `UPDATE life_admin_records SET steward_agent_id = $3, steward_set_by = $4, steward_since = $5::timestamptz
     WHERE id = $1 AND user_id = $2 AND review_state <> 'dismissed' RETURNING id`,
    [id, userId, steward?.agentId ?? null, steward?.setBy ?? null, steward ? steward.since.toISOString() : null],
  );
  return result.rows.length > 0;
}

// The person checked an agent's suggestion: it becomes theirs. True when one was confirmed.
export async function confirmRecord(db: Db, userId: string, id: string): Promise<boolean> {
  const result = await db.query(
    `UPDATE life_admin_records SET review_state = 'confirmed', changed_by_kind = 'person', changed_by_agent_id = NULL, updated_at = now()
     WHERE id = $1 AND user_id = $2 AND review_state = 'suggested' RETURNING id`,
    [id, userId],
  );
  return result.rows.length > 0;
}

// Hold an agent's change to a confirmed record for the person to decide (replacing any change
// already waiting). True when the record exists.
export async function setPendingChange(
  db: Db,
  userId: string,
  id: string,
  change: PendingChange,
  dek: Uint8Array,
): Promise<boolean> {
  const envelope = await encrypt(dek, TABLE, PENDING_COLUMN, id, JSON.stringify(change));
  const result = await db.query(
    `UPDATE life_admin_records SET pending = $3 WHERE id = $1 AND user_id = $2 AND review_state <> 'dismissed' RETURNING id`,
    [id, userId, envelope],
  );
  return result.rows.length > 0;
}

// Make one of the person's records a tombstone ("not mine"): the record (and, through the
// cascade, its journal and task links) is removed, and a new row keeps only its kind and match
// keys, so the same suggestion is not added again. Records that belonged to it are unlinked by
// the parent link's ON DELETE SET NULL. Runs inside the caller's transaction (receipt files are
// removed alongside, in storage/receipt-files.ts). True when there was such a record.
export async function dismissRecordRow(db: Db, userId: string, id: string, dek: Uint8Array): Promise<boolean> {
  const current = (await db.query(
    "SELECT kind, meta, match_keys, source_kind, source_agent_id, status FROM life_admin_records WHERE id = $1 AND user_id = $2 AND review_state <> 'dismissed' FOR UPDATE",
    [id, userId],
  )).rows[0];
  if (!current) return false;
  const meta: RecordMeta = current.meta ? JSON.parse(await decrypt(dek, TABLE, META_COLUMN, id, current.meta as string)) : {};
  await db.query("DELETE FROM life_admin_records WHERE id = $1 AND user_id = $2", [id, userId]);
  const tombstone = randomUUID();
  const empty = await encrypt(dek, TABLE, FIELDS_COLUMN, tombstone, "{}");
  const metaEnvelope = await encryptMeta(dek, tombstone, meta.type ? { type: meta.type } : {});
  await db.query(
    `INSERT INTO life_admin_records
       (id, user_id, kind, fields, status, source_kind, source_agent_id, meta, review_state, match_keys,
        changed_by_kind, changed_by_agent_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'dismissed', $9::text[], 'person', NULL)`,
    [tombstone, userId, current.kind, empty, current.status, current.source_kind, current.source_agent_id, metaEnvelope, (current.match_keys as string[]) ?? []],
  );
  return true;
}

// The owner reads' order: soonest due first, undated records last, then creation
// order and id so records sharing a due date (or both undated) always come back the
// same way. The columns are table-qualified because the output list re-labels
// `due_date::text AS due_date`; ordering by the real `date` column, not its text.
const OWNER_ORDER =
  "ORDER BY life_admin_records.due_date ASC NULLS LAST, life_admin_records.created_at ASC, life_admin_records.id ASC";

// List ALL of `userId`'s live records (member-scoped: user_id is bound; dismissed
// tombstones are left out), each fields blob DECRYPTED under the owner's `dek`, in
// OWNER_ORDER. Never another person's records; an empty array when the person has none.
// A wrong DEK fails the GCM tag and rejects.
export async function listRecordsForUser(
  db: Db,
  userId: string,
  dek: Uint8Array,
): Promise<LifeAdminRecord[]> {
  const result = await db.query(
    `SELECT ${SELECT_COLUMNS} FROM life_admin_records WHERE user_id = $1 AND review_state <> 'dismissed' ${OWNER_ORDER}`,
    [userId],
  );
  return decryptRows(result.rows, dek);
}

// The same, filtered to one `kind` (the "filterable by kind" read), in the same order.
export async function listRecordsByKind(
  db: Db,
  userId: string,
  kind: RecordKind,
  dek: Uint8Array,
): Promise<LifeAdminRecord[]> {
  const result = await db.query(
    `SELECT ${SELECT_COLUMNS} FROM life_admin_records WHERE user_id = $1 AND kind = $2 AND review_state <> 'dismissed' ${OWNER_ORDER}`,
    [userId, kind],
  );
  return decryptRows(result.rows, dek);
}

async function decryptPending(dek: Uint8Array, row: Row): Promise<PendingChange | null> {
  return row.pending ? (JSON.parse(await decrypt(dek, TABLE, PENDING_COLUMN, row.id as string, row.pending as string)) as PendingChange) : null;
}

// Decrypt each row's fields, meta and pending change under the owner's DEK and assemble the records.
async function decryptRows(rows: Row[], dek: Uint8Array): Promise<LifeAdminRecord[]> {
  const records: LifeAdminRecord[] = [];
  for (const row of rows) {
    const plaintext = await decrypt(dek, TABLE, FIELDS_COLUMN, row.id as string, row.fields as string);
    const meta = row.meta ? (JSON.parse(await decrypt(dek, TABLE, META_COLUMN, row.id as string, row.meta as string)) as RecordMeta) : {};
    records.push(toRecord(row, JSON.parse(plaintext) as Record<string, unknown>, meta, await decryptPending(dek, row)));
  }
  return records;
}

// The REMINDERS JOB's read. Deliberately CROSS-USER (no userId, no dek): for EVERY
// person, return each (record, offset) where the offset's reminder date
// (due_date − offset days) is at or before `clock.now()`, the offset has NOT been
// marked sent, and the record has a due date — the earliest reminder date first. METADATA
// ONLY — it never decrypts a field (the fields blob is not even selected), which is
// exactly design §4.1's "filter without decrypting another person's data".
// A record reminds only up to its `remind_until` day, worked out from its kind, status and due
// date when it was written (none for anything dismissed, cancelled, done, paused or expired;
// REMINDER_GRACE_DAYS past the due date for a live item; the start date for a booking) — so a
// batch of old records an agent saves from email, or an imported export, never sets off a burst
// of pushes, a reminder missed during a short outage still catches up, and this keyless sweep
// needs no status list and never learns which records are bookings.
export async function listDueForReminder(db: Db, clock: Clock): Promise<DueReminder[]> {
  const result = await db.query(
    `SELECT r.id AS record_id, r.user_id, r.kind, r.due_date::text AS due_date, o AS "offset"
     FROM life_admin_records r
     CROSS JOIN LATERAL (
       SELECT DISTINCT CASE WHEN value BETWEEN 0 AND $2::int THEN value END AS o
       FROM unnest(r.reminder_offsets) AS value
     ) offsets
     WHERE r.due_date IS NOT NULL
       AND r.review_state <> 'dismissed'
       AND r.remind_until IS NOT NULL
       AND r.remind_until >= $1::date
       AND o IS NOT NULL
       AND NOT (o = ANY(r.sent_offsets))
       AND (r.due_date - o) <= $1
     ORDER BY (r.due_date - o), r.id, o`,
    [clock.now(), MAX_REMINDER_OFFSET_DAYS],
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
// no key). Bind the owner and captured due date so an in-flight delivery cannot mark a
// rescheduled cycle sent. A removed offset must not be reintroduced by that delivery.
// Appending only when absent makes repeated completion writes idempotent; this does
// not guarantee exactly-once external push delivery across crashes/overlapping sweeps.
export async function markReminderSent(
  db: Db,
  input: Pick<DueReminder, "recordId" | "userId" | "dueDate" | "offset">,
): Promise<void> {
  await db.query(
    `UPDATE life_admin_records
     SET sent_offsets = array_append(sent_offsets, $2::int)
     WHERE id = $1 AND user_id = $3 AND due_date = $4::date
       AND $2::int = ANY(reminder_offsets)
       AND NOT ($2::int = ANY(sent_offsets))`,
    [input.recordId, input.offset, input.userId, input.dueDate],
  );
}
