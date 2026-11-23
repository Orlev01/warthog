// Every life-admin item's journal (docs/adr/life-admin-journal.md; db/migrations/0118): Warthog's
// own record of what changed, and the short decisions, notes, next steps and hand-over notes
// agents and the person write, so any agent — from any provider — can carry on a live item.
//
// One row per entry, append-only (the runtime role may only SELECT and INSERT). Plain columns
// carry no content: the kind, who wrote it, the conversation, the entry it refers to and when;
// the text, due date and change detail are in `body`, encrypted under the person's data key and
// bound to the row. An entry lives exactly as long as its record. Every read and write is
// member-scoped by the caller's `userId`; the DEK is injected.

import { randomUUID } from "node:crypto";

import type { ChangeSummary, JournalKind } from "../../domain/life-admin/journal";
import { decrypt, encrypt } from "../crypto/envelope";
import { assertCollectionCapacity } from "./collection-limits";
import type { Db, Row } from "./index";

const TABLE = "life_admin_journal";
const COLUMN = "body";

// At most this many entries per record; from REPORTED_CAP on, only Warthog's own change entries
// are added, so what happened is always recorded.
export const RECORD_JOURNAL_CAP = 400;
export const REPORTED_CAP = 300;

export type JournalActorKind = "person" | "agent" | "imported";

export interface JournalBody {
  readonly text?: string;
  readonly due?: string;
  readonly change?: ChangeSummary;
  readonly run?: { readonly id: string; readonly label?: string };
  readonly via?: string;
  // An imported entry's author, as text.
  readonly actorName?: string;
}

export interface NewJournalEntry {
  readonly userId: string;
  readonly recordId: string;
  readonly kind: JournalKind;
  readonly actorKind: JournalActorKind;
  readonly actorAgentId?: string | null;
  readonly runId?: string | null;
  readonly refId?: string | null;
  readonly at: Date;
  readonly body: JournalBody;
}

export interface JournalEntry {
  readonly id: string;
  readonly recordId: string;
  readonly seq: number;
  readonly kind: JournalKind;
  readonly actorKind: JournalActorKind;
  readonly actorAgentId: string | null;
  readonly runId: string | null;
  readonly refId: string | null;
  readonly at: string;
  readonly body: JournalBody;
}

export type AppendOutcome = { readonly appended: true; readonly id: string } | { readonly appended: false; readonly reason: "full" | "duplicate_ref" };

/**
 * Add one entry. Runs inside the caller's transaction, which must already hold the record (the
 * record service locks the owner row), so `seq` follows on without a race. Refused (not thrown)
 * when the record's journal is full for this kind of entry, or a step is closed / a decision
 * replaced twice.
 */
export async function appendJournalEntry(db: Db, input: NewJournalEntry, dek: Uint8Array): Promise<AppendOutcome> {
  if (!db.inTransaction) throw new Error("appendJournalEntry: run inside the record's transaction");
  const counts = (await db.query(
    `SELECT count(*) AS n, COALESCE(max(seq), 0) AS last FROM ${TABLE} WHERE user_id = $1 AND record_id = $2`,
    [input.userId, input.recordId],
  )).rows[0];
  const n = Number(counts?.n ?? 0);
  if (n >= RECORD_JOURNAL_CAP || (input.kind !== "change" && n >= REPORTED_CAP)) return { appended: false, reason: "full" };
  if (input.refId) {
    const taken = await db.query(`SELECT 1 FROM ${TABLE} WHERE user_id = $1 AND kind = $2 AND ref_id = $3`, [input.userId, input.kind, input.refId]);
    if (taken.rows.length > 0) return { appended: false, reason: "duplicate_ref" };
  }
  const id = randomUUID();
  const body = await encrypt(dek, TABLE, COLUMN, id, JSON.stringify(input.body));
  await assertCollectionCapacity(db, input.userId, "life_admin_journal", body.length);
  await db.query(
    `INSERT INTO ${TABLE} (user_id, id, record_id, seq, kind, actor_kind, actor_agent_id, run_id, ref_id, at, body)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::timestamptz, $11)`,
    [input.userId, id, input.recordId, Number(counts?.last ?? 0) + 1, input.kind, input.actorKind, input.actorAgentId ?? null, input.runId ?? null, input.refId ?? null, input.at.toISOString(), body],
  );
  return { appended: true, id };
}

async function toEntry(dek: Uint8Array, row: Row): Promise<JournalEntry> {
  return {
    id: row.id as string,
    recordId: row.record_id as string,
    seq: Number(row.seq),
    kind: row.kind as JournalKind,
    actorKind: row.actor_kind as JournalActorKind,
    actorAgentId: (row.actor_agent_id as string | null) ?? null,
    runId: (row.run_id as string | null) ?? null,
    refId: (row.ref_id as string | null) ?? null,
    at: new Date(String(row.at)).toISOString(),
    body: JSON.parse(await decrypt(dek, TABLE, COLUMN, row.id as string, row.body as string)) as JournalBody,
  };
}

const COLUMNS = "id, record_id, seq, kind, actor_kind, actor_agent_id, run_id, ref_id, at, body";

/** One record's journal, newest first, a page at a time (`beforeSeq` continues). */
export async function listJournal(
  db: Db,
  userId: string,
  recordId: string,
  dek: Uint8Array,
  options: { readonly limit?: number; readonly beforeSeq?: number } = {},
): Promise<JournalEntry[]> {
  const result = await db.query(
    `SELECT ${COLUMNS} FROM ${TABLE} WHERE user_id = $1 AND record_id = $2 AND ($3::int IS NULL OR seq < $3::int)
     ORDER BY seq DESC LIMIT $4`,
    [userId, recordId, options.beforeSeq ?? null, Math.min(Math.max(options.limit ?? 50, 1), 200)],
  );
  const entries: JournalEntry[] = [];
  for (const row of result.rows) entries.push(await toEntry(dek, row));
  return entries;
}

/**
 * What matters for each of these records at a glance — its decisions, next steps and their
 * closings, hand-over notes, and its latest entry (when and by whom) — without decrypting every
 * change entry. Keyed by record id.
 */
export async function journalHighlights(
  db: Db,
  userId: string,
  recordIds: readonly string[],
  dek: Uint8Array,
): Promise<Map<string, { entries: JournalEntry[]; count: number; latest: JournalEntry | null }>> {
  const out = new Map<string, { entries: JournalEntry[]; count: number; latest: JournalEntry | null }>();
  if (recordIds.length === 0) return out;
  const ids = [...new Set(recordIds)];
  const rows = (await db.query(
    `SELECT ${COLUMNS} FROM ${TABLE} WHERE user_id = $1 AND record_id = ANY($2::uuid[]) AND kind <> 'change'
     ORDER BY record_id, seq ASC`,
    [userId, ids],
  )).rows;
  const latestRows = (await db.query(
    `SELECT DISTINCT ON (record_id) ${COLUMNS}, count(*) OVER (PARTITION BY record_id) AS total
     FROM ${TABLE} WHERE user_id = $1 AND record_id = ANY($2::uuid[]) ORDER BY record_id, seq DESC`,
    [userId, ids],
  )).rows;
  for (const row of rows) {
    const entry = await toEntry(dek, row);
    const slot = out.get(entry.recordId) ?? { entries: [], count: 0, latest: null };
    slot.entries.push(entry);
    out.set(entry.recordId, slot);
  }
  for (const row of latestRows) {
    const entry = await toEntry(dek, row);
    const slot = out.get(entry.recordId) ?? { entries: [], count: 0, latest: null };
    slot.count = Number(row.total);
    slot.latest = entry;
    out.set(entry.recordId, slot);
  }
  return out;
}

/** Which of these records have an open next step (plain columns only, no decrypting). */
export async function recordsWithOpenSteps(db: Db, userId: string, recordIds: readonly string[]): Promise<Set<string>> {
  if (recordIds.length === 0) return new Set();
  const rows = (await db.query(
    `SELECT DISTINCT n.record_id FROM ${TABLE} n
     WHERE n.user_id = $1 AND n.record_id = ANY($2::uuid[]) AND n.kind = 'next'
       AND NOT EXISTS (SELECT 1 FROM ${TABLE} d WHERE d.user_id = n.user_id AND d.kind = 'next_done' AND d.ref_id = n.id)`,
    [userId, [...new Set(recordIds)]],
  )).rows;
  return new Set(rows.map((row) => row.record_id as string));
}
