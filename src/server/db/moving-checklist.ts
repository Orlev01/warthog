// The moving checklist's data access (brief "Moving-house helper"; design §4.1).
// When the person adds a new address with a moving date, Warthog builds a
// checklist of places that hold the OLD address — their connected services, the
// subscriptions and renewal records on file, and the person's own additions — so
// each can be ticked off or handed to an agent as a task. A checklist item's
// LABEL is PERSONAL CONTENT, so it is stored only DEK-ENCRYPTED
// (`../crypto/envelope`): the id is generated up front so each envelope's
// associated data binds the ciphertext to its exact (table, column, row) — the
// plaintext label never lands in a column.
//
// The SOURCE KIND (connection | subscription | renewal | own), the SOURCE
// REFERENCE, the DONE flag and the optional LINKED TASK id stay PLAINTEXT metadata
// (design §4.1), so the owner list and the idempotent seed can filter / dedupe
// WITHOUT decrypting another person's data.
//
// Every statement is parameterized through the `Db` seam (INV-102): the ids and
// every value travel as BOUND values, never concatenated into the SQL text, so a
// value shaped like SQL is stored as data and cannot alter the query. Every
// member-scoped read/write is scoped by the `userId` the caller passes — the
// session's / connection's id, never a client value — so one person can never
// read or write another's checklist. The DEK is injected (this module reads no
// `process.env` and holds no key, INV-103); `toggleDone` and `linkTask` take no
// DEK at all — they only ever touch the plaintext metadata.

import { randomUUID } from "node:crypto";

import { decrypt, encrypt } from "../crypto/envelope";
import type { Db, Row } from "./index";

// The envelope's associated data binds each blob to its exact location, so a row's
// ciphertext lifted into another row/column/table fails to decrypt.
const TABLE = "moving_checklist";
const LABEL_COLUMN = "label";

// Where a checklist item came from (plaintext metadata).
export type ChecklistSourceKind = "connection" | "subscription" | "renewal" | "own";

// One place that holds the old address, to seed. `label` is stored DEK-encrypted;
// `sourceKind` and `sourceReference` are plaintext metadata (the idempotency key).
export interface SeedItem {
  readonly label: string;
  readonly sourceKind: ChecklistSourceKind;
  readonly sourceReference: string;
}

// What seedItems records. `userId` is the OWNER (the session's / connection's id,
// never a client value); `items` are the sources to seed (deduped on kind +
// reference per user).
export interface SeedItemsInput {
  readonly userId: string;
  readonly items: SeedItem[];
}

// A checklist item as handed back to its owner, with its label DECRYPTED.
export interface ChecklistItem {
  readonly id: string;
  readonly userId: string;
  readonly label: string;
  readonly sourceKind: ChecklistSourceKind;
  readonly sourceReference: string;
  readonly done: boolean;
  readonly linkedTaskId: string | null;
}

// The metadata columns every read returns; `label` comes back as ciphertext and
// is decrypted separately.
const SELECT_COLUMNS = "id, user_id, label, source_kind, source_reference, done, linked_task_id";

// Map a raw row (plus its already-decrypted label) to a ChecklistItem, translating
// the snake_case columns to the module's camelCase fields.
function toItem(row: Row, label: string): ChecklistItem {
  return {
    id: row.id as string,
    userId: row.user_id as string,
    label,
    sourceKind: row.source_kind as ChecklistSourceKind,
    sourceReference: row.source_reference as string,
    done: row.done as boolean,
    linkedTaskId: (row.linked_task_id as string | null) ?? null,
  };
}

// Store the item's label DEK-encrypted plus its plaintext metadata (source kind /
// reference; done defaults to false). The id is generated up front so the label
// envelope binds to the row. A conflict on (user, source kind, source reference) is
// a no-op — re-running the helper never duplicates an item, nor resets a ticked-off
// one, nor overwrites its label — so seeding is IDEMPOTENT.
async function insertItem(
  db: Db,
  userId: string,
  item: SeedItem,
  dek: Uint8Array,
): Promise<string> {
  const id = randomUUID();
  const labelEnvelope = await encrypt(dek, TABLE, LABEL_COLUMN, id, item.label);
  await db.query(
    `INSERT INTO moving_checklist (id, user_id, label, source_kind, source_reference)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (user_id, source_kind, source_reference) DO NOTHING`,
    [id, userId, labelEnvelope, item.sourceKind, item.sourceReference],
  );
  return id;
}

// Seed the person's checklist from `input.items`, each label DEK-encrypted with its
// plaintext metadata. IDEMPOTENT on (user, source kind, source reference): a second
// seed over the same sources adds nothing and changes nothing.
export async function seedItems(db: Db, input: SeedItemsInput, dek: Uint8Array): Promise<void> {
  for (const item of input.items) {
    await insertItem(db, input.userId, item, dek);
  }
}

// List ALL of `userId`'s checklist items (member-scoped: user_id is bound), each
// label DECRYPTED under the owner's `dek`. Never another person's items; an empty
// array when the person has none. A wrong DEK fails the GCM tag and rejects.
export async function listForUser(db: Db, userId: string, dek: Uint8Array): Promise<ChecklistItem[]> {
  const result = await db.query(
    `SELECT ${SELECT_COLUMNS} FROM moving_checklist WHERE user_id = $1`,
    [userId],
  );
  const items: ChecklistItem[] = [];
  for (const row of result.rows) {
    const label = await decrypt(dek, TABLE, LABEL_COLUMN, row.id as string, row.label as string);
    items.push(toItem(row, label));
  }
  return items;
}

// FLIP the owner's own item's done flag (member-scoped: both id AND user_id are
// bound). DEK-FREE (done is plaintext metadata, so the label is never touched).
// Returns true when it toggled one, false when none matched — so one person can
// never tick off another's item.
export async function toggleDone(
  db: Db,
  input: { readonly userId: string; readonly id: string },
): Promise<boolean> {
  const result = await db.query(
    `UPDATE moving_checklist SET done = NOT done WHERE id = $1 AND user_id = $2 RETURNING id`,
    [input.id, input.userId],
  );
  return result.rows.length > 0;
}

// Record the task id the owner's item was handed off as (member-scoped: both id AND
// user_id are bound). DEK-FREE (the linked task id is plaintext metadata). Returns
// true when it linked one, false when none matched — so one person can never alter
// another's item.
export async function linkTask(
  db: Db,
  input: { readonly userId: string; readonly id: string; readonly taskId: string },
): Promise<boolean> {
  const result = await db.query(
    `UPDATE moving_checklist SET linked_task_id = $3 WHERE id = $1 AND user_id = $2 RETURNING id`,
    [input.id, input.userId, input.taskId],
  );
  return result.rows.length > 0;
}

// Add the person's OWN addition: the label DEK-encrypted with source kind 'own' and
// a FRESH source reference (so two own additions never collide under the seed's
// idempotency key), done false, no linked task. Returns the created item assembled
// from its inputs (no dependency on a RETURNING read).
export async function addOwnItem(
  db: Db,
  input: { readonly userId: string; readonly label: string },
  dek: Uint8Array,
): Promise<ChecklistItem> {
  const sourceReference = randomUUID();
  const item: SeedItem = { label: input.label, sourceKind: "own", sourceReference };
  const id = await insertItem(db, input.userId, item, dek);
  return {
    id,
    userId: input.userId,
    label: input.label,
    sourceKind: "own",
    sourceReference,
    done: false,
    linkedTaskId: null,
  };
}
