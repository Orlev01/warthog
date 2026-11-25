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
import { withTransaction, type Db } from "../db/index";
import type { Clock } from "../seams/clock";
import { redact } from "../../domain/redaction/redact";

// A run as the pipeline and the activity record carry it: Warthog's id for it and, when the
// agent gave one, what it said it was working on.
export interface RunRef {
  readonly id: string;
  readonly label?: string;
}

// One run as the agent workspace and the Now view list it.
export interface RunSummary extends RunRef {
  readonly agentId: string;
  readonly via?: string;
  readonly startedAt: string;
  readonly lastSeenAt: string;
  // When the agent last changed what the run says it is working on.
  readonly labelChangedAt?: string;
  // Recorded entries, counted as Activity shows them: a change's "Started" intent record is
  // not counted separately from its result.
  readonly actions: number;
  // The latest action Warthog recorded in the run, from plaintext metadata only (nothing is
  // decrypted): not a change's intent record, a description change, or the conversation's own
  // check-in (get_context), which would otherwise hide the work after every status update.
  readonly latest?: RunLatest;
}

export interface RunLatest {
  readonly kind: string;
  readonly tool?: string;
  readonly outcome?: string;
  readonly connectorId?: string;
  readonly occurredAt: string;
}

// A description change: the run as it now reads, and what it said before (when it said
// anything).
export interface RunLabelChange {
  readonly run: RunRef;
  readonly previous?: string;
}

// The agent's description is a short phrase ("Fixing the website tests"), shown on one line.
export const RUN_LABEL_MAX = 100;

// The most runs one list read returns.
export const MAX_RUN_LIST = 50;

// An agent may change a run's description at most this often, so a run's record of what it was
// for stays readable. The first change after the run starts is always allowed.
export const RUN_LABEL_CHANGE_MS = 60_000;

const TABLE = "agent_runs";
const LABEL_COLUMN = "label_ct";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Who a run is for: the person and the agent the verified connection names.
export interface RunOwner {
  readonly userId: string;
  readonly agentId: string;
}

// The label as stored and shown: control characters removed and whitespace collapsed, then
// redacted with the person's released-value matcher over the WHOLE text (so cutting it can't
// split a secret past the matcher), then cut to RUN_LABEL_MAX characters at a word boundary
// so no partial token is left at the end. Empty after cleaning ⇒ no label.
export function cleanRunLabel(label: string | undefined, matchesReleased: (token: string) => boolean = () => false): string | undefined {
  if (label === undefined) return undefined;
  const cleaned = label.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (cleaned === "") return undefined;
  const redacted = Array.from(String(redact(cleaned, matchesReleased)));
  if (redacted.length <= RUN_LABEL_MAX) return redacted.join("");
  const cut = redacted.slice(0, RUN_LABEL_MAX).join("");
  // A redaction marker ("[card ••••1111]") cut part-way is dropped whole; otherwise the cut
  // goes back to the last word boundary.
  const open = cut.lastIndexOf("[");
  if (open > cut.lastIndexOf("]")) return cut.slice(0, open).trimEnd();
  const boundary = cut.lastIndexOf(" ");
  return (boundary > 0 ? cut.slice(0, boundary) : cut).trimEnd();
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

/**
 * Replace what this person's agent says its run is working on. The new description is cleaned
 * like a new run's. `record` writes the change's activity entry in the same transaction, so the
 * description never changes without its record. Null, with nothing written, for anything that
 * changes nothing: a malformed or unknown run, another agent's or person's run, an empty or
 * unchanged description, or a change within RUN_LABEL_CHANGE_MS of the last one.
 */
export async function updateRunLabel(
  db: Db,
  owner: RunOwner,
  runId: unknown,
  label: string | undefined,
  dek: Uint8Array,
  clock: Clock,
  matchesReleased: (token: string) => boolean,
  record: (tx: Db, change: RunLabelChange) => Promise<void>,
): Promise<RunLabelChange | null> {
  if (!isRunId(runId)) return null;
  const next = cleanRunLabel(label, matchesReleased);
  if (next === undefined) return null;
  const id = runId.toLowerCase();
  const now = clock.now();
  return withTransaction(db, async (tx) => {
    const found = await tx.query(
      `SELECT label_ct, label_changed_at FROM agent_runs
        WHERE user_id = $1 AND id = $2 AND agent_id = $3
        FOR UPDATE`,
      [owner.userId, id, owner.agentId],
    );
    const row = found.rows[0];
    if (!row) return null;
    const previous = row.label_ct == null ? undefined : await decrypt(dek, TABLE, LABEL_COLUMN, id, String(row.label_ct));
    if (previous === next) return null;
    if (row.label_changed_at != null && now.getTime() - new Date(row.label_changed_at as string).getTime() < RUN_LABEL_CHANGE_MS) return null;
    await tx.query(
      `UPDATE agent_runs SET label_ct = $4, label_changed_at = $5
        WHERE user_id = $1 AND id = $2 AND agent_id = $3`,
      [owner.userId, id, owner.agentId, await encrypt(dek, TABLE, LABEL_COLUMN, id, next), now.toISOString()],
    );
    const change: RunLabelChange = previous === undefined ? { run: { id, label: next } } : { run: { id, label: next }, previous };
    await record(tx, change);
    return change;
  });
}

// One person's runs, newest activity first: one agent's when `agentId` is given, the runs
// named in `runIds`, or every agent's seen since `since` (the Now view). Each carries how many
// recorded entries it has and its latest action.
export async function listRuns(
  db: Db,
  userId: string,
  dek: Uint8Array,
  options: { agentId?: string; runIds?: readonly string[]; since?: string; limit?: number },
): Promise<RunSummary[]> {
  const values: unknown[] = [userId];
  const conditions = ["r.user_id = $1"];
  if (options.agentId !== undefined) {
    values.push(options.agentId);
    conditions.push(`r.agent_id = $${values.length}`);
  }
  if (options.since !== undefined) {
    values.push(options.since);
    conditions.push(`r.last_seen_at >= $${values.length}::timestamptz`);
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
    `SELECT r.id, r.agent_id, r.started_at, r.last_seen_at, r.label_changed_at, r.via, r.label_ct,
            (SELECT count(*)::int FROM activity_entry_runs e
               JOIN activity_entries a ON a.user_id = e.user_id AND a.seq = e.entry_seq
              WHERE e.user_id = r.user_id AND e.run_id = r.id AND a.kind <> 'tool_attempt') AS actions,
            latest.kind AS latest_kind, latest.tool AS latest_tool, latest.outcome AS latest_outcome,
            latest.connector_id AS latest_connector, latest.occurred_at AS latest_at
       FROM agent_runs r
       LEFT JOIN LATERAL (
         SELECT a.kind, a.tool, a.outcome, a.connector_id, a.occurred_at
           FROM activity_entry_runs e
           JOIN activity_entries a ON a.user_id = e.user_id AND a.seq = e.entry_seq
          WHERE e.user_id = r.user_id AND e.run_id = r.id AND a.kind NOT IN ('tool_attempt', 'run_status')
            AND a.tool IS DISTINCT FROM 'get_context'
          ORDER BY e.entry_seq DESC
          LIMIT 1
       ) AS latest ON TRUE
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
    ...(row.label_changed_at == null ? {} : { labelChangedAt: new Date(row.label_changed_at as string).toISOString() }),
    actions: Number(row.actions),
    ...(row.latest_kind == null ? {} : {
      latest: {
        kind: String(row.latest_kind),
        ...(row.latest_tool == null ? {} : { tool: String(row.latest_tool) }),
        ...(row.latest_outcome == null ? {} : { outcome: String(row.latest_outcome) }),
        ...(row.latest_connector == null ? {} : { connectorId: String(row.latest_connector) }),
        occurredAt: new Date(row.latest_at as string).toISOString(),
      },
    }),
  })));
}

async function toRef(row: Record<string, unknown>, dek: Uint8Array): Promise<RunRef> {
  const id = String(row.id);
  if (row.label_ct == null) return { id };
  return { id, label: await decrypt(dek, TABLE, LABEL_COLUMN, id, String(row.label_ct)) };
}
