// The imported-history archive aggregate's data access (brief "Export and
// portability"; design §4.1; constitution principle 14 "Warthog writes the
// record, not the agents").
//
// An import reads a Warthog export into a fresh account and keeps the old
// activity history as a separate, read-only "Imported history" archive, clearly
// labelled, OUTSIDE Warthog's own append-only, hash-chained activity record — so
// an import never claims authorship of actions Warthog did not handle and never
// perturbs the live integrity chain. This module therefore writes ONLY the
// `imported_history` table (never `activity_entries`, and never any seq /
// prev_hash / entry_hash), so archiving touches neither the activity record nor
// its hash chain.
//
// Each archived entry's CONTENT is PERSONAL CONTENT carried over from another
// Warthog export, so it is stored only DEK-ENCRYPTED (`../crypto/envelope`): the
// id is generated up front so the content envelope's associated data binds the
// ciphertext to its exact (table, column, row) — the plaintext content never
// lands in a column. A little plaintext metadata (`occurredAt`, `kind`, `source`)
// stays readable so the archive can be LISTED and CLEARLY LABELLED without
// decrypting another person's data.
//
// Every statement is parameterized through the `Db` seam (INV-102): the ids and
// every value travel as BOUND values, never concatenated into the SQL text, so a
// value shaped like SQL is stored as data and cannot alter the query. Every
// read/write is member-scoped by the `userId` the caller passes — the session's
// id, never a client value — so one person can never read another's imported
// history. The DEK is injected (this module reads no `process.env` and holds no
// key, INV-103).

import { randomUUID } from "node:crypto";

import { decrypt, encrypt } from "../crypto/envelope";
import type { Db, Row } from "./index";

// The envelope's associated data binds each content blob to its exact location,
// so a row's ciphertext lifted into another row/column/table fails to decrypt.
const TABLE = "imported_history";
const CONTENT_COLUMN = "content";

// What createImportedEntry archives. `userId` is the OWNER (the session's id,
// never a client value). `content` is the original exported activity entry,
// stored DEK-encrypted as one JSON blob. `occurredAt` is when the ORIGINAL action
// happened (plaintext metadata, ordering); `kind` and `source` are the original
// entry's labels (plaintext metadata).
export interface NewImportedEntry {
  readonly userId: string;
  readonly content: Record<string, unknown>;
  readonly occurredAt: string | Date;
  readonly kind: string;
  readonly source: string;
}

// An archived entry handed back to its owner, with its content DECRYPTED.
export interface ImportedEntry {
  readonly id: string;
  readonly userId: string;
  readonly content: Record<string, unknown>;
  readonly occurredAt: string | Date;
  readonly kind: string;
  readonly source: string;
}

// The metadata columns every read returns; `content` comes back as ciphertext and
// is decrypted separately. `occurred_at` is cast to a canonical ISO string on
// read via toEntry, so the original instant round-trips regardless of driver.
const SELECT_COLUMNS = "id, user_id, content, occurred_at, kind, source";

// Normalise an instant (Date or string) to a canonical ISO-8601 string.
function toIso(value: unknown): string {
  return new Date(value as string | number | Date).toISOString();
}

// Map a raw row (plus its already-decrypted content) to an ImportedEntry,
// translating the snake_case columns to the module's camelCase fields.
function toEntry(row: Row, content: Record<string, unknown>): ImportedEntry {
  return {
    id: row.id as string,
    userId: row.user_id as string,
    content,
    occurredAt: toIso(row.occurred_at),
    kind: row.kind as string,
    source: row.source as string,
  };
}

// Archive one imported-history entry for `input.userId`, storing its content
// DEK-encrypted as one JSON blob plus the plaintext metadata (occurredAt, kind,
// source). The id is generated up front so the content envelope binds to the row;
// the returned entry is assembled from the inputs (no dependency on a RETURNING
// read). Writes ONLY to `imported_history` — never to `activity_entries`.
export async function createImportedEntry(
  db: Db,
  input: NewImportedEntry,
  dek: Uint8Array,
): Promise<ImportedEntry> {
  const id = randomUUID();
  const envelope = await encrypt(dek, TABLE, CONTENT_COLUMN, id, JSON.stringify(input.content));

  await db.query(
    `INSERT INTO imported_history (id, user_id, content, occurred_at, kind, source)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, input.userId, envelope, input.occurredAt, input.kind, input.source],
  );

  return {
    id,
    userId: input.userId,
    content: input.content,
    occurredAt: input.occurredAt,
    kind: input.kind,
    source: input.source,
  };
}

// List ALL of `userId`'s archived entries (member-scoped: user_id is bound), each
// content blob DECRYPTED under the owner's `dek`. Never another person's entries;
// an empty array when the person has no imported history. A wrong DEK fails the
// GCM tag and rejects.
export async function listImportedEntriesForUser(
  db: Db,
  userId: string,
  dek: Uint8Array,
): Promise<ImportedEntry[]> {
  const result = await db.query(
    `SELECT ${SELECT_COLUMNS} FROM imported_history WHERE user_id = $1 ORDER BY occurred_at ASC`,
    [userId],
  );
  const entries: ImportedEntry[] = [];
  for (const row of result.rows) {
    const plaintext = await decrypt(dek, TABLE, CONTENT_COLUMN, row.id as string, row.content as string);
    entries.push(toEntry(row, JSON.parse(plaintext) as Record<string, unknown>));
  }
  return entries;
}
