// The approval aggregate's data access (design §6, brief "Approval inbox" /
// "Agents wait safely"). The pipeline creates an approval on every `ask` decision;
// the inbox and notifications read and decide them.
//
// This module is the STORAGE SKIN over the pure state machine
// (`../../domain/approvals/state-machine`): it persists and reloads approvals, and
// `decide()` delegates every transition to that pure machine, so an illegal move is
// refused exactly as the machine refuses it (the repo adds no lifecycle rules of its
// own). The `detail` the person sees (recipient, amount, field) is PERSONAL CONTENT,
// so it is stored only DEK-ENCRYPTED (`../crypto/envelope`, design §4.1): the id is
// generated up front so the envelope's associated data can bind the ciphertext to
// its exact (table, column, row) — the plaintext never lands in a column.
//
// Every statement is parameterized through the `Db` seam (INV-102): the id, user id
// and agent id travel as BOUND values, never concatenated into the SQL text, so a
// value shaped like SQL is stored as data and cannot alter the query. Every read and
// write is member-scoped by the `user_id` the caller passes — the session's id,
// never a client value — so one person can never read, list or decide another's
// approval. Time enters through the injected Clock (never SQL now()); the DEK is
// injected (this module reads no `process.env` and holds no key, INV-103).

import { randomUUID } from "node:crypto";

import { decrypt, encrypt } from "../crypto/envelope";
import type { Clock } from "../seams/clock";
import type { Db, Row } from "./index";
import {
  approve,
  askForMoreDetail,
  createApproval as holdPending,
  deny,
  expireIfDue,
  type Approval,
  type ApprovalStatus,
} from "../../domain/approvals/state-machine";

// The envelope's associated data binds each `detail` ciphertext to its exact
// location, so a row lifted into another row/column/table fails to decrypt.
const TABLE = "approvals";
const DETAIL_COLUMN = "detail";

// The columns every read returns, kept in one place so create, the lookups and
// decide hand back the same shape. `detail` comes back as ciphertext here and is
// decrypted separately before it reaches a caller.
const COLUMNS =
  "id, user_id, agent_id, status, detail, question, created_at, expires_at, decided_at";

// What createApproval needs: the person (the session's id), the requesting agent,
// the detail to hold DEK-encrypted, and an optional expiry (omitted → the state
// machine's default; clamped to its bounds).
export interface NewApproval {
  readonly userId: string;
  readonly agentId: string;
  readonly detail: Record<string, unknown>;
  readonly expiryMinutes?: number;
}

// An approval as handed back to callers: the lifecycle status, the DECRYPTED detail,
// and the timestamps. `decidedAt` is set on approve / deny / expire; `question` on a
// more_detail decision.
export interface StoredApproval {
  readonly id: string;
  readonly userId: string;
  readonly agentId: string;
  readonly status: ApprovalStatus;
  readonly detail: Record<string, unknown>;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly decidedAt?: Date;
  readonly question?: string;
}

// A decision targets one of the four non-pending statuses; the repo maps each to the
// pure state machine's transition and persists only if the machine allows it.
export type Decision =
  | { status: "approved" }
  | { status: "denied" }
  | { status: "expired" }
  | { status: "more_detail"; question: string };

// What decide() needs: the person (member scope), the approval id and the decision.
export interface DecideInput {
  readonly userId: string;
  readonly id: string;
  readonly decision: Decision;
}

// A stored instant comes back as a Date or an ISO/epoch representation depending on
// the driver; normalise to a Date. A NULL timestamp becomes undefined.
function toDate(value: unknown): Date {
  return new Date(value as string | number | Date);
}

// Map a raw row (plus its already-decrypted detail) to a StoredApproval, translating
// the snake_case columns to the module's camelCase fields.
function toStored(row: Row, detail: Record<string, unknown>): StoredApproval {
  return {
    id: row.id as string,
    userId: row.user_id as string,
    agentId: row.agent_id as string,
    status: row.status as ApprovalStatus,
    detail,
    createdAt: toDate(row.created_at),
    expiresAt: toDate(row.expires_at),
    decidedAt: row.decided_at != null ? toDate(row.decided_at) : undefined,
    question: (row.question as string | null) ?? undefined,
  };
}

// Decrypt a row's `detail` envelope under `dek`, bound to that row's id, and parse
// it back to the object that was stored. Throws if the DEK is wrong or the ciphertext
// was tampered (the GCM tag fails to verify).
async function decryptDetail(
  dek: Uint8Array,
  id: string,
  envelope: string,
): Promise<Record<string, unknown>> {
  const plaintext = await decrypt(dek, TABLE, DETAIL_COLUMN, id, envelope);
  return JSON.parse(plaintext) as Record<string, unknown>;
}

// Create a PENDING approval for `userId` with its DEK-encrypted detail and an expiry
// window (createdAt = clock.now(); expiresAt = createdAt + the clamped expiry). The
// id is generated up front so the detail's envelope can bind to it. Returns the
// StoredApproval carrying the generated id (with the plaintext detail).
export async function createApproval(
  db: Db,
  input: NewApproval,
  dek: Uint8Array,
  clock: Clock,
): Promise<StoredApproval> {
  const id = randomUUID();
  // The pure state machine sets status/createdAt/expiresAt (and clamps the window);
  // `request` is this module's `detail`.
  const held: Approval = holdPending(
    { id, agentId: input.agentId, request: input.detail, expiryMinutes: input.expiryMinutes },
    clock.now(),
  );
  const envelope = await encrypt(dek, TABLE, DETAIL_COLUMN, id, JSON.stringify(input.detail));

  await db.query(
    `INSERT INTO approvals (id, user_id, agent_id, status, detail, created_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $7::timestamptz)`,
    [
      id,
      input.userId,
      input.agentId,
      held.status,
      envelope,
      held.createdAt.toISOString(),
      held.expiresAt.toISOString(),
    ],
  );

  return {
    id,
    userId: input.userId,
    agentId: input.agentId,
    status: held.status,
    detail: input.detail,
    createdAt: held.createdAt,
    expiresAt: held.expiresAt,
  };
}

// The one approval with this id OWNED BY `userId` (member-scoped: id AND user_id
// both bound), its detail decrypted under `dek`; null when none for this user — so
// another user's id returns null (they cannot read it).
export async function getApproval(
  db: Db,
  userId: string,
  id: string,
  dek: Uint8Array,
): Promise<StoredApproval | null> {
  const result = await db.query(
    `SELECT ${COLUMNS} FROM approvals WHERE id = $1 AND user_id = $2`,
    [id, userId],
  );
  const row = result.rows[0];
  if (!row) return null;
  const detail = await decryptDetail(dek, row.id as string, row.detail as string);
  return toStored(row, detail);
}

// This user's `pending` approvals, details decrypted — never another user's, never
// already-decided ones (the user id is bound as a parameter; member-scoped).
export async function listPendingForUser(
  db: Db,
  userId: string,
  dek: Uint8Array,
): Promise<StoredApproval[]> {
  const result = await db.query(
    `SELECT ${COLUMNS} FROM approvals
      WHERE user_id = $1 AND status = 'pending'
      ORDER BY created_at`,
    [userId],
  );
  const approvals: StoredApproval[] = [];
  for (const row of result.rows) {
    const detail = await decryptDetail(dek, row.id as string, row.detail as string);
    approvals.push(toStored(row, detail));
  }
  return approvals;
}

// Apply the decision's target status to `current` via the pure state machine — which
// throws exactly when the move is illegal (e.g. deciding a non-pending approval) and
// only expires when the window is due.
function applyDecision(current: Approval, decision: Decision, now: Date): Approval {
  switch (decision.status) {
    case "approved":
      return approve(current, now);
    case "denied":
      return deny(current, now);
    case "more_detail":
      return askForMoreDetail(current, decision.question, now);
    case "expired":
      return expireIfDue(current, now);
  }
}

// Decide an approval, member-scoped. Loads the one approval OWNED BY `userId`
// (throws when none for this user, so one person can never decide another's),
// applies the pure transition (throwing exactly when the machine throws — an
// already-decided approval is refused and left unchanged), persists and returns the
// updated StoredApproval. `{status:"expired"}` delegates to expireIfDue — a no-op
// unless the window has passed.
export async function decide(
  db: Db,
  { userId, id, decision }: DecideInput,
  dek: Uint8Array,
  clock: Clock,
): Promise<StoredApproval> {
  const loaded = await db.query(
    `SELECT ${COLUMNS} FROM approvals WHERE id = $1 AND user_id = $2`,
    [id, userId],
  );
  const row = loaded.rows[0];
  if (!row) {
    throw new Error(`decide: no approval ${id} for this user`);
  }

  const detail = await decryptDetail(dek, row.id as string, row.detail as string);
  const current: Approval = {
    id: row.id as string,
    agentId: row.agent_id as string,
    status: row.status as ApprovalStatus,
    request: detail,
    createdAt: toDate(row.created_at),
    expiresAt: toDate(row.expires_at),
    decidedAt: row.decided_at != null ? toDate(row.decided_at) : undefined,
    question: (row.question as string | null) ?? undefined,
  };

  const next = applyDecision(current, decision, clock.now());

  const updated = await db.query(
    `UPDATE approvals
        SET status = $1, decided_at = $2::timestamptz, question = $3
      WHERE id = $4 AND user_id = $5
      RETURNING ${COLUMNS}`,
    [next.status, next.decidedAt?.toISOString() ?? null, next.question ?? null, id, userId],
  );
  const updatedRow = updated.rows[0];
  if (!updatedRow) {
    throw new Error(`decide: approval ${id} vanished during the decision`);
  }
  return toStored(updatedRow, detail);
}
