// The "recently read" window per agent (db/migrations/0114_agent_read_exposures.sql,
// docs/adr/read-side-protection.md).
//
// A SERVER store over the injected `Db`: every query binds the person's user id and the
// agent id as parameters (member-scoped, INV-102); the senders are DEK-encrypted under the
// person's key and never include a subject or any text.

import { decrypt, encrypt } from "../crypto/envelope";
import type { Db } from "./index";

const TABLE = "agent_read_exposures";
const COLUMN = "detail_ct";

/** How long after a read the window stays open. */
export const READ_WINDOW_MS = 60 * 60 * 1000;

/** The most recent senders a window remembers. */
const MAX_SOURCES = 3;

/** One thing an agent read: which service, what kind, and who wrote it (when known). */
export interface ReadSource {
  readonly service: string;
  readonly kind: "email" | "event" | "file" | "message" | "content";
  readonly sender?: string;
  /** The person's account it was read in, by its label (docs/adr/several-accounts-per-agent.md). */
  readonly account?: string;
  /** When it was read (set when it is recorded). */
  readonly at?: string;
}

/** An open window: when the agent last read someone else's content, and from whom. */
export interface ReadExposure {
  readonly lastReadAt: Date;
  readonly untilAt: Date;
  readonly sources: readonly ReadSource[];
}

function rowId(agentId: string): string {
  return agentId;
}

async function sourcesOf(row: Record<string, unknown>, dek: Uint8Array, agentId: string): Promise<ReadSource[]> {
  if (typeof row.detail_ct !== "string") return [];
  try {
    const parsed = JSON.parse(await decrypt(dek, TABLE, COLUMN, rowId(agentId), row.detail_ct)) as unknown;
    return Array.isArray(parsed) ? (parsed as ReadSource[]).slice(0, MAX_SOURCES) : [];
  } catch {
    return [];
  }
}

/** Record that the agent just read `source`, opening (or extending) its window. */
export async function recordReadExposure(
  db: Db,
  input: { readonly userId: string; readonly agentId: string; readonly source: ReadSource; readonly at: Date },
  dek: Uint8Array,
): Promise<void> {
  const existing = await db.query(`SELECT detail_ct, until_at FROM ${TABLE} WHERE user_id = $1 AND agent_id = $2`, [input.userId, input.agentId]);
  const row = existing.rows[0] as Record<string, unknown> | undefined;
  const open = row && new Date(String(row.until_at)).getTime() > input.at.getTime();
  const previous = row && open ? await sourcesOf(row, dek, input.agentId) : [];
  const same = (a: ReadSource, b: ReadSource) => a.service === b.service && a.kind === b.kind && a.sender === b.sender && a.account === b.account;
  const sources = [{ ...input.source, at: input.at.toISOString() }, ...previous.filter((s) => !same(s, input.source))].slice(0, MAX_SOURCES);
  const detail = await encrypt(dek, TABLE, COLUMN, rowId(input.agentId), JSON.stringify(sources));
  const until = new Date(input.at.getTime() + READ_WINDOW_MS);
  await db.query(
    `INSERT INTO ${TABLE} (user_id, agent_id, last_read_at, until_at, detail_ct)
       VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (user_id, agent_id) DO UPDATE
       SET last_read_at = GREATEST(${TABLE}.last_read_at, EXCLUDED.last_read_at),
           until_at = GREATEST(${TABLE}.until_at, EXCLUDED.until_at),
           detail_ct = EXCLUDED.detail_ct`,
    [input.userId, input.agentId, input.at.toISOString(), until.toISOString(), detail],
  );
}

/** The agent's open window at `now`, or null (a passed window is cleared). */
export async function activeReadExposure(db: Db, userId: string, agentId: string, now: Date, dek: Uint8Array): Promise<ReadExposure | null> {
  const result = await db.query(`SELECT last_read_at, until_at, detail_ct FROM ${TABLE} WHERE user_id = $1 AND agent_id = $2`, [userId, agentId]);
  const row = result.rows[0] as Record<string, unknown> | undefined;
  if (!row) return null;
  const untilAt = new Date(String(row.until_at));
  if (untilAt.getTime() <= now.getTime()) {
    await db.query(`DELETE FROM ${TABLE} WHERE user_id = $1 AND agent_id = $2 AND until_at <= $3`, [userId, agentId, now.toISOString()]);
    return null;
  }
  return { lastReadAt: new Date(String(row.last_read_at)), untilAt, sources: await sourcesOf(row, dek, agentId) };
}

/** Whether the agent has an open window at `now`, from plain columns only (no data key needed). */
export async function hasOpenReadWindow(db: Db, userId: string, agentId: string, now: Date): Promise<boolean> {
  const result = await db.query(`SELECT 1 FROM ${TABLE} WHERE user_id = $1 AND agent_id = $2 AND until_at > $3`, [userId, agentId, now.toISOString()]);
  return result.rows.length > 0;
}
