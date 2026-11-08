// The held-request aggregate's data access (design §6.2, brief "Agents wait
// safely"). On an `ask` decision the pipeline HOLDS the exact agent call here and
// creates a linked approval; on approval Warthog executes the held call EXACTLY
// ONCE and returns the result via `check_approval`.
//
// The held call's `args` are PERSONAL CONTENT (recipient, amount, the field asked
// for), so they are stored only DEK-ENCRYPTED (`../crypto/envelope`, design §4.1):
// the id is generated up front so the envelope's associated data can bind the
// ciphertext to its exact (table, column, row) — the plaintext never lands in a
// column.
//
// Every statement is parameterized through the `Db` seam (INV-102): the ids and
// the args travel as BOUND values, never concatenated into the SQL text, so a
// value shaped like SQL is stored as data and cannot alter the query. Every read
// and write is member-scoped by the `user_id` the caller passes — the session's
// id, never a client value — so one person can never read or execute another's
// held request. Time enters through the injected Clock (never SQL now()); the DEK
// is injected (this module reads no `process.env` and holds no key, INV-103).

import { randomUUID } from "node:crypto";

import { decrypt, encrypt } from "../crypto/envelope";
import type { Clock } from "../seams/clock";
import type { Db, Row } from "./index";

// The envelope's associated data binds each `args` ciphertext to its exact
// location, so a row lifted into another row/column/table fails to decrypt.
const TABLE = "held_requests";
const ARGS_COLUMN = "args";
const OUTCOME_COLUMN = "outcome";

// The columns every read returns, kept in one place so create, the lookup and
// markExecuted hand back the same shape. `args` comes back as ciphertext here and
// is decrypted separately before it reaches a caller.
const COLUMNS =
  "id, user_id, agent_id, approval_id, status, args, created_at, executed_at, outcome";

// A held request is either waiting ('held') or has been run exactly once
// ('executed') — the two lifecycle values the store knows.
export type HeldStatus = "held" | "executed";

// What running the held call came to, kept so the agent can be handed it however
// many times it asks (check_approval): the tool ran and returned a result, or it was
// refused with a plain reason.
export type HeldOutcome =
  | { readonly status: "executed"; readonly result: unknown }
  | { readonly status: "refused"; readonly reason: string };

// Thrown when a held request has already been claimed to run — the single-shot
// compare-and-swap refused a second claim. A typed refusal, so callers can tell
// "already run" apart from an infrastructure failure (which propagates as-is).
export class HeldRequestAlreadyExecutedError extends Error {
  constructor(id: string) {
    super(`markExecuted: held request ${id} has already been executed`);
    this.name = "HeldRequestAlreadyExecutedError";
  }
}

// What createHeldRequest needs: the person (the session's id, never a client
// value), the requesting agent, the approval the call is parked behind, and the
// exact agent-call args to hold DEK-encrypted.
export interface NewHeldRequest {
  readonly userId: string;
  readonly agentId: string;
  readonly approvalId: string;
  readonly args: Record<string, unknown>;
}

// A held request as handed back to callers: the lifecycle status, the DECRYPTED
// args (the call Warthog will run), and the timestamps. `executedAt` is set the
// one time the held call executes.
export interface StoredHeldRequest {
  readonly id: string;
  readonly userId: string;
  readonly agentId: string;
  readonly approvalId: string;
  readonly status: HeldStatus;
  readonly args: Record<string, unknown>;
  readonly createdAt: Date;
  readonly executedAt?: Date;
  // The stored outcome of the run, once the claimed call has finished.
  readonly outcome?: HeldOutcome;
}

// What markExecuted needs: the person (member scope) and the held-request id.
export interface MarkExecutedInput {
  readonly userId: string;
  readonly id: string;
}

// A stored instant comes back as a Date or an ISO/epoch representation depending
// on the driver; normalise to a Date.
function toDate(value: unknown): Date {
  return new Date(value as string | number | Date);
}

// Decrypt a row's `args` envelope under `dek`, bound to that row's id, and parse
// it back to the object that was stored. Throws if the DEK is wrong or the
// ciphertext was tampered (the GCM tag fails to verify).
async function decryptArgs(
  dek: Uint8Array,
  id: string,
  envelope: string,
): Promise<Record<string, unknown>> {
  const plaintext = await decrypt(dek, TABLE, ARGS_COLUMN, id, envelope);
  return JSON.parse(plaintext) as Record<string, unknown>;
}

// Decrypt a row's stored outcome (bound to that row's id), or undefined while the
// run has not finished. Throws if the DEK is wrong or the ciphertext was tampered.
async function decryptOutcome(dek: Uint8Array, row: Row): Promise<HeldOutcome | undefined> {
  if (row.outcome == null) return undefined;
  const plaintext = await decrypt(dek, TABLE, OUTCOME_COLUMN, row.id as string, row.outcome as string);
  return JSON.parse(plaintext) as HeldOutcome;
}

// Map a raw row (plus its already-decrypted args and outcome) to a
// StoredHeldRequest, translating the snake_case columns to the module's camelCase
// fields.
function toStored(row: Row, args: Record<string, unknown>, outcome?: HeldOutcome): StoredHeldRequest {
  return {
    id: row.id as string,
    userId: row.user_id as string,
    agentId: row.agent_id as string,
    approvalId: row.approval_id as string,
    status: row.status as HeldStatus,
    args,
    createdAt: toDate(row.created_at),
    executedAt: row.executed_at != null ? toDate(row.executed_at) : undefined,
    ...(outcome !== undefined ? { outcome } : {}),
  };
}

// Create a 'held' request for `userId` with its DEK-encrypted args, linked to
// `approvalId` (createdAt = clock.now()). The id is generated up front so the
// args' envelope can bind to it. Returns the StoredHeldRequest carrying the
// generated id (with the plaintext args).
export async function createHeldRequest(
  db: Db,
  input: NewHeldRequest,
  dek: Uint8Array,
  clock: Clock,
): Promise<StoredHeldRequest> {
  const id = randomUUID();
  const createdAt = clock.now();
  const envelope = await encrypt(dek, TABLE, ARGS_COLUMN, id, JSON.stringify(input.args));

  await db.query(
    `INSERT INTO held_requests (id, user_id, agent_id, approval_id, status, args, created_at)
     VALUES ($1, $2, $3, $4, 'held', $5, $6::timestamptz)`,
    [id, input.userId, input.agentId, input.approvalId, envelope, createdAt.toISOString()],
  );

  return {
    id,
    userId: input.userId,
    agentId: input.agentId,
    approvalId: input.approvalId,
    status: "held",
    args: input.args,
    createdAt,
  };
}

// The held request parked behind this approval OWNED BY `userId` (member-scoped:
// approval_id AND user_id both bound), args decrypted under `dek`; null when none
// for this user — so another user's approval id returns null (they cannot read it).
export async function getByApproval(
  db: Db,
  userId: string,
  approvalId: string,
  dek: Uint8Array,
): Promise<StoredHeldRequest | null> {
  const result = await db.query(
    `SELECT ${COLUMNS} FROM held_requests WHERE approval_id = $1 AND user_id = $2`,
    [approvalId, userId],
  );
  const row = result.rows[0];
  if (!row) return null;
  const args = await decryptArgs(dek, row.id as string, row.args as string);
  return toStored(row, args, await decryptOutcome(dek, row));
}

// Execute a held request, member-scoped and SINGLE-SHOT. Loads the one held
// request OWNED BY `userId` (throws when none for this user, so one person can
// never execute another's). While it is still 'held' it transitions to 'executed'
// and stamps executedAt = clock.now(); the UPDATE's own `status = 'held'` guard
// makes the transition a compare-and-swap, so a concurrent second run changes no
// row and is refused. An already-executed held request is REFUSED (throws) and
// left unchanged — so Warthog can never run the same held call twice. Returns the
// StoredHeldRequest with DECRYPTED args (the executor receives the call to run). A
// refused claim throws HeldRequestAlreadyExecutedError.
export async function markExecuted(
  db: Db,
  { userId, id }: MarkExecutedInput,
  dek: Uint8Array,
  clock: Clock,
): Promise<StoredHeldRequest> {
  const loaded = await db.query(
    `SELECT ${COLUMNS} FROM held_requests WHERE id = $1 AND user_id = $2`,
    [id, userId],
  );
  const row = loaded.rows[0];
  if (!row) {
    throw new Error(`markExecuted: no held request ${id} for this user`);
  }
  if ((row.status as HeldStatus) !== "held") {
    throw new HeldRequestAlreadyExecutedError(id);
  }

  const args = await decryptArgs(dek, row.id as string, row.args as string);
  const executedAt = clock.now();

  const updated = await db.query(
    `UPDATE held_requests
        SET status = 'executed', executed_at = $1::timestamptz
      WHERE id = $2 AND user_id = $3 AND status = 'held'
      RETURNING ${COLUMNS}`,
    [executedAt.toISOString(), id, userId],
  );
  const updatedRow = updated.rows[0];
  if (!updatedRow) {
    // The compare-and-swap matched no row: another run executed it first.
    throw new HeldRequestAlreadyExecutedError(id);
  }
  return toStored(updatedRow, args);
}

// What recordOutcome needs: the person (member scope), the held-request id and the
// outcome of running it.
export interface RecordOutcomeInput {
  readonly userId: string;
  readonly id: string;
  readonly outcome: HeldOutcome;
}

// Keep the outcome of a held call that has run, DEK-encrypted and bound to its row,
// so the agent can be handed it later (check_approval). Member-scoped (id AND user_id
// bound) and only on an EXECUTED held request — throws when no such row is this
// person's, so an outcome never lands on a call that has not run or on another
// person's held request.
export async function recordOutcome(
  db: Db,
  { userId, id, outcome }: RecordOutcomeInput,
  dek: Uint8Array,
): Promise<void> {
  const envelope = await encrypt(dek, TABLE, OUTCOME_COLUMN, id, JSON.stringify(outcome));
  const updated = await db.query(
    `UPDATE held_requests SET outcome = $1
      WHERE id = $2 AND user_id = $3 AND status = 'executed'
      RETURNING id`,
    [envelope, id, userId],
  );
  if (!updated.rows[0]) {
    throw new Error(`recordOutcome: no executed held request ${id} for this user`);
  }
}
