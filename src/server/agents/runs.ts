// Agent runs — telling one agent's conversations apart (docs/adr/agent-runs.md).
//
// Every conversation a person has with one agent shares that agent's credential, and
// neither the MCP protocol nor the clients send anything that identifies a conversation.
// So Warthog hands one out: `get_context` starts a run and returns its id, the agent passes
// it back as `run` on later calls, and each activity entry recorded for such a call is
// linked to the run (`activity_entry_runs`, written by the activity writer).
//
// A run is bookkeeping, not identity: the agent chooses whether to pass it back, and the
// label is the agent's own description of its work. Nothing about access depends on it.
// What Warthog does guarantee is ownership: a run is only ever resolved for the agent it
// was issued to, so an agent cannot attach its calls to another agent's (or another
// person's) run. The label is personal content, so it is redacted like every other
// agent-supplied text and stored encrypted under the person's data key.
//
// A server module built from injected seams (db, clock, data key, released-value matcher):
// it reads no `process.env` and holds no key. Every query is member-scoped by the
// connection's user id and parameter-bound.

import { randomUUID } from "node:crypto";

import { decrypt, encrypt } from "../crypto/envelope";
import type { Db } from "../db/index";
import type { Clock } from "../seams/clock";
import { redact } from "../../domain/redaction/redact";

// A run as the pipeline and the activity record carry it: Warthog's id for it and, when the
// agent gave one, what it said it was working on.
export interface RunRef {
  readonly id: string;
  readonly label?: string;
}

// One run as the agent workspace lists it.
export interface RunSummary extends RunRef {
  readonly agentId: string;
  readonly via?: string;
  readonly startedAt: string;
  readonly lastSeenAt: string;
  readonly actions: number;
}

// The agent's description is a short phrase ("Fixing the website tests"), shown on one line.
export const RUN_LABEL_MAX = 100;

// The most runs one list read returns.
export const MAX_RUN_LIST = 50;

const TABLE = "agent_runs";
const LABEL_COLUMN = "label_ct";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Who a run is for: the person and the agent the verified connection names.
export interface RunOwner {
  readonly userId: string;
  readonly agentId: string;
}

// The label as stored and shown: control characters removed, whitespace collapsed, cut to
// RUN_LABEL_MAX characters, then redacted with the person's released-value matcher. Empty
// after cleaning ⇒ no label.
export function cleanRunLabel(label: string | undefined, matchesReleased: (token: string) => boolean = () => false): string | undefined {
  if (label === undefined) return undefined;
  const cleaned = Array.from(label.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim()).slice(0, RUN_LABEL_MAX).join("");
  if (cleaned === "") return undefined;
  return String(redact(cleaned, matchesReleased));
}

// Whether a value could be a run id at all. Checked before any query, so an agent's typo
// never reaches the uuid cast.
export function isRunId(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

/** Start a run for this person's agent. The label is cleaned and encrypted; `via` is plain. */
export async function startRun(
  db: Db,
  owner: RunOwner,
  input: { label?: string; via?: string },
  dek: Uint8Array,
  clock: Clock,
  matchesReleased: (token: string) => boolean = () => false,
): Promise<RunRef> {
  const id = randomUUID();
  const label = cleanRunLabel(input.label, matchesReleased);
  const now = clock.now().toISOString();
  const labelCt = label === undefined ? null : await encrypt(dek, TABLE, LABEL_COLUMN, id, label);
  await db.query(
    `INSERT INTO agent_runs (user_id, id, agent_id, started_at, last_seen_at, via, label_ct)
     VALUES ($1, $2, $3, $4, $4, $5, $6)`,
    [owner.userId, id, owner.agentId, now, input.via ?? null, labelCt],
  );
  return label === undefined ? { id } : { id, label };
}

/**
 * The run `runId` names, when it was issued to this person's agent; null for anything else
 * (malformed, unknown, another agent's or another person's). A run that resolves is marked
 * seen now.
 */
export async function resolveRun(
  db: Db,
  owner: RunOwner,
  runId: unknown,
  dek: Uint8Array,
  clock: Clock,
): Promise<RunRef | null> {
  if (!isRunId(runId)) return null;
  const found = await db.query(
    `UPDATE agent_runs SET last_seen_at = GREATEST(last_seen_at, $4::timestamptz)
      WHERE user_id = $1 AND id = $2 AND agent_id = $3
      RETURNING id, label_ct`,
    [owner.userId, runId.toLowerCase(), owner.agentId, clock.now().toISOString()],
  );
  const row = found.rows[0];
  if (!row) return null;
  return toRef(row, dek);
}

// One person's runs, newest activity first: one agent's when `agentId` is given, or the
// runs named in `runIds`. Each carries how many recorded entries it has.
export async function listRuns(
  db: Db,
  userId: string,
  dek: Uint8Array,
  options: { agentId?: string; runIds?: readonly string[]; limit?: number },
): Promise<RunSummary[]> {
  const values: unknown[] = [userId];
  const conditions = ["r.user_id = $1"];
  if (options.agentId !== undefined) {
    values.push(options.agentId);
    conditions.push(`r.agent_id = $${values.length}`);
  }
  if (options.runIds !== undefined) {
    const ids = options.runIds.filter(isRunId).map((id) => id.toLowerCase());
    if (ids.length === 0) return [];
    values.push(ids);
    conditions.push(`r.id = ANY($${values.length}::uuid[])`);
  }
  const limit = Math.min(MAX_RUN_LIST, Math.max(1, Math.floor(options.limit ?? MAX_RUN_LIST)));
  values.push(limit);
  const result = await db.query(
    `SELECT r.id, r.agent_id, r.started_at, r.last_seen_at, r.via, r.label_ct,
            (SELECT count(*)::int FROM activity_entry_runs e
              WHERE e.user_id = r.user_id AND e.run_id = r.id) AS actions
       FROM agent_runs r
      WHERE ${conditions.join(" AND ")}
      ORDER BY r.last_seen_at DESC, r.started_at DESC
      LIMIT $${values.length}`,
    values,
  );
  return Promise.all(result.rows.map(async (row) => ({
    ...(await toRef(row, dek)),
    agentId: String(row.agent_id),
    ...(row.via == null ? {} : { via: String(row.via) }),
    startedAt: new Date(row.started_at as string).toISOString(),
    lastSeenAt: new Date(row.last_seen_at as string).toISOString(),
    actions: Number(row.actions),
  })));
}

async function toRef(row: Record<string, unknown>, dek: Uint8Array): Promise<RunRef> {
  const id = String(row.id);
  if (row.label_ct == null) return { id };
  return { id, label: await decrypt(dek, TABLE, LABEL_COLUMN, id, String(row.label_ct)) };
}
