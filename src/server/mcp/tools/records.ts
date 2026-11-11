// E14-S08 — the `list_records` / `save_record` / `update_record` core tools
// (design §6.2 MCP core tools; brief "Life admin": records that agents and the
// person both maintain — subscriptions (service, cost, billing cycle, next
// renewal, how to cancel, status), receipts and warranties, and renewals and
// appointments; "agents add and update records through Warthog"; constitution
// principle 14 "Warthog … SHALL record every tool call itself at the moment it
// handles it").
//
// `save_record` creates ONE subscription / receipt / renewal record FOR the
// CONNECTION's person, with its `fields` (DEK-encrypted at rest), an optional
// `dueDate` + `status`, SOURCE = the connection's agent. `list_records` hands the
// agent back the person's records it may READ (the store's `listRecordsForUser`),
// each fields blob decrypted. `update_record` changes the fields (and optionally
// the status / due date) of a record the person OWNS. Every tool is refused with a
// plain reason for a connection without the records permission.
//
// A SERVER module built purely from its INJECTED seams (the parameterizing `db`,
// the `KeyWrapper` that unwraps the person's DEK to encrypt the fields and decrypt
// on read; the records store takes no clock, so `clock` is unused here): it reads
// no `process.env` and holds no secret (INV-103). Each handler VALIDATES its input
// at the boundary (zod → a 4xx `HttpError` BEFORE any db access or crypto work,
// INV-102); the records store binds `user_id` / the ids / the plaintext metadata as
// parameters and stores the fields DEK-encrypted as a bound value, so a SQL-shaped
// field is inert data that cannot alter a query. The OWNING person and the agent are
// ALWAYS taken from the session `connection` (`connection.userId` owns; the record's
// SOURCE is `connection.agentId`; `connection.connectionId` keys the permission),
// never a value in the input — so one agent can never save against, read, or change
// another person's records. The tool call itself is recorded by the pipeline that
// routes these core tools (Warthog writes the record, principle 14).

import { z } from "zod";
import { recordDueDateSchema } from "../../../domain/life-admin/record-metadata";

import { parseParams } from "../../http/validate";
import { getConnectionPermissions, type ConnectionPermissions } from "../../db/agent-permissions";
import {
  createRecord,
  updateRecord,
  listRecordsForUser,
  type LifeAdminRecord,
  type RecordKind,
  type RecordSource,
} from "../../db/life-admin-records";
import { getUserById } from "../../db/users";
import type { KeyWrapper } from "../../crypto/key-wrapper";
import type { Clock } from "../../seams/clock";
import type { AgentConnection } from "../context";
import type { Db } from "../../db/index";

// Field caps, so a grossly oversized value is refused at the boundary before any db
// access (INV-102). A status / due date is short; a record id is an opaque uuid; the
// `fields` blob holds a kind's content (a cap on its serialised size, well above a
// real record yet far below a payload meant to exhaust memory); `reason` matches the
// registry's envelope cap (design §6.2 "every tool takes an optional reason").
const MAX_STATUS = 200;
const MAX_ID = 200;
const MAX_FIELDS_CHARS = 100_000;
const MAX_REASON = 2000;

// The three record kinds (subscription / receipt&warranty / renewal&appointment).
const RECORD_KINDS = ["subscription", "receipt_warranty", "renewal_appointment"] as const;

// The status a `save_record` with no explicit status lands at (the brief's records
// are maintained items, so a new record is active until told otherwise).
const DEFAULT_STATUS = "active";

// The universal OPTIONAL `reason` every core tool carries (design §6.2).
const reason = z.string().max(MAX_REASON).optional();

// A record's `fields` blob: a REQUIRED object of arbitrary values, capped on its
// serialised size so a payload meant to exhaust memory is refused at the boundary.
const fields = z
  .record(z.string(), z.unknown())
  .refine((value) => JSON.stringify(value).length <= MAX_FIELDS_CHARS);

// list_records' input: nothing but the universal OPTIONAL `reason` (the owning
// person comes from the connection). A z.object, so its `.shape` exposes the field.
export const listRecordsSchema = z.object({ reason });

// save_record's input: a REQUIRED `kind` (one of the three), a REQUIRED `fields`
// object, an OPTIONAL `status` + `dueDate`, plus the universal OPTIONAL `reason`.
export const saveRecordSchema = z.object({
  kind: z.enum(RECORD_KINDS),
  fields,
  status: z.string().max(MAX_STATUS).optional(),
  dueDate: recordDueDateSchema.nullable().optional(),
  reason,
});

// update_record's input: a REQUIRED non-empty `id`, a REQUIRED `fields` object (the
// agent resupplies the content), an OPTIONAL `status` + `dueDate`, plus the
// universal OPTIONAL `reason`.
export const updateRecordSchema = z.object({
  id: z.string().min(1).max(MAX_ID),
  fields,
  status: z.string().max(MAX_STATUS).optional(),
  dueDate: recordDueDateSchema.nullable().optional(),
  reason,
});

// The injected seams — no process.env (INV-103). `db` is the parameterizing seam the
// permission lookup and the records store read through; `keyWrapper` unwraps the
// person's DEK so fields are encrypted on write / decrypted on read; `clock` is
// harmless if unused (the records store takes no clock).
export interface RecordsToolDeps {
  readonly db: Db;
  readonly keyWrapper: KeyWrapper;
  readonly clock?: Clock;
}

// One record as handed to the agent (fields DECRYPTED under the owner's DEK; the
// owning userId and the reminder bookkeeping stay out of the result).
export interface RecordView {
  readonly id: string;
  readonly kind: RecordKind;
  readonly fields: Record<string, unknown>;
  readonly dueDate: string | Date | null;
  readonly status: string;
  readonly source: RecordSource;
}

export type ListRecordsResult =
  | { status: "ok"; records: ReadonlyArray<RecordView> }
  | { status: "refused"; reason: string };

export type SaveRecordResult =
  | { status: "saved"; id: string }
  | { status: "refused"; reason: string };

export type UpdateRecordResult =
  | { status: "updated"; id: string }
  | { status: "refused"; reason: string };

export interface ListRecordsTool {
  readonly name: string;
  readonly inputSchema: z.ZodType;
  handle(input: unknown, connection: AgentConnection): Promise<ListRecordsResult>;
}

export interface SaveRecordTool {
  readonly name: string;
  readonly inputSchema: z.ZodType;
  handle(input: unknown, connection: AgentConnection): Promise<SaveRecordResult>;
}

export interface UpdateRecordTool {
  readonly name: string;
  readonly inputSchema: z.ZodType;
  handle(input: unknown, connection: AgentConnection): Promise<UpdateRecordResult>;
}

// The plain refusals. A connection with neither the read nor the change class for
// this tool has no records permission; a change tool against a record that is not
// the person's own refuses rather than throwing.
const NO_PERMISSION_REASON = "This agent does not have permission to use records.";
const NO_SUCH_RECORD_REASON = "No such record for this person.";

// Map a decrypted store record to the view handed to the agent (the owning userId
// and the reminder offsets stay out of the result).
function toView(record: LifeAdminRecord): RecordView {
  return {
    id: record.id,
    kind: record.kind,
    fields: record.fields,
    dueDate: record.dueDate,
    status: record.status,
    source: record.source,
  };
}

// Resolve the person's unwrapped 256-bit DEK: read their wrapped DEK member-scoped
// by `userId` (the session's, never a client value) and unwrap it through the
// KeyWrapper seam. Throws when the person has no row — never fails silently.
async function dataKeyFor(db: Db, keyWrapper: KeyWrapper, userId: string): Promise<Uint8Array> {
  const user = await getUserById(db, userId);
  if (!user) {
    throw new Error("records tool: no data key for this user");
  }
  return keyWrapper.unwrap(user.wrappedDek);
}

// The connection's records permission, or null when it has none: its own `recordsAccess`
// grant (review fix A2 — the life-admin records grant the person set on the consent screen or
// permissions page, no longer the connector tool classes `readTools` / `changeTools`).
// It covers reads and changes alike; `kind` is kept for the callers. Keyed by
// `connection.connectionId` member-scoped by `connection.userId`, exactly the grant
// the person set.
async function recordsPermission(
  db: Db,
  connection: AgentConnection,
  _kind: "read" | "change",
): Promise<ConnectionPermissions | null> {
  const permissions = await getConnectionPermissions(db, connection.userId, connection.connectionId);
  if (!permissions || !permissions.recordsAccess) return null;
  return permissions;
}

export function createListRecordsTool(deps: RecordsToolDeps): ListRecordsTool {
  const { db, keyWrapper } = deps;

  return {
    name: "list_records",
    inputSchema: listRecordsSchema,

    async handle(input: unknown, connection: AgentConnection): Promise<ListRecordsResult> {
      // VALIDATE at the boundary: a bad / oversized / mis-shaped input throws a 4xx
      // `HttpError` BEFORE any db access or crypto work (INV-102).
      parseParams(listRecordsSchema, input);

      // Refuse a connection without the records READ permission.
      const permissions = await recordsPermission(db, connection, "read");
      if (!permissions) {
        return { status: "refused", reason: NO_PERMISSION_REASON };
      }

      // Read ONLY the CONNECTION's person's records (member-scoped by the session's
      // userId, never the input), each fields blob decrypted under the owner's DEK.
      const dek = await dataKeyFor(db, keyWrapper, connection.userId);
      const records = await listRecordsForUser(db, connection.userId, dek);

      return { status: "ok", records: records.map(toView) };
    },
  };
}

export function createSaveRecordTool(deps: RecordsToolDeps): SaveRecordTool {
  const { db, keyWrapper } = deps;

  return {
    name: "save_record",
    inputSchema: saveRecordSchema,

    async handle(input: unknown, connection: AgentConnection): Promise<SaveRecordResult> {
      // VALIDATE at the boundary (INV-102) BEFORE any db access or crypto work.
      const parsed = parseParams(saveRecordSchema, input);

      // Refuse a connection without the records CHANGE permission — nothing is saved.
      const permissions = await recordsPermission(db, connection, "change");
      if (!permissions) {
        return { status: "refused", reason: NO_PERMISSION_REASON };
      }

      // Create FOR the CONNECTION's person, SOURCE = the CONNECTION's agent (never a
      // value in the input). The fields are stored DEK-encrypted through the
      // parameterized store; the kind / status / due date travel as bound values, so
      // a SQL-shaped field is inert data.
      const dek = await dataKeyFor(db, keyWrapper, connection.userId);
      const record = await createRecord(
        db,
        {
          userId: connection.userId,
          kind: parsed.kind,
          fields: parsed.fields,
          dueDate: parsed.dueDate ?? null,
          status: parsed.status ?? DEFAULT_STATUS,
          source: { kind: "agent", agentId: connection.agentId },
        },
        dek,
      );

      return { status: "saved", id: record.id };
    },
  };
}

export function createUpdateRecordTool(deps: RecordsToolDeps): UpdateRecordTool {
  const { db, keyWrapper } = deps;

  return {
    name: "update_record",
    inputSchema: updateRecordSchema,

    async handle(input: unknown, connection: AgentConnection): Promise<UpdateRecordResult> {
      // VALIDATE at the boundary (INV-102) BEFORE any db access or crypto work.
      const parsed = parseParams(updateRecordSchema, input);

      // Refuse a connection without the records CHANGE permission — nothing changes.
      const permissions = await recordsPermission(db, connection, "change");
      if (!permissions) {
        return { status: "refused", reason: NO_PERMISSION_REASON };
      }

      // Find the record THIS PERSON owns (member-scoped by the connection's userId) —
      // so one person can never change another's record. A missing one refuses (not
      // throws).
      const dek = await dataKeyFor(db, keyWrapper, connection.userId);
      const owned = await listRecordsForUser(db, connection.userId, dek);
      const existing = owned.find((r) => r.id === parsed.id);
      if (!existing) {
        return { status: "refused", reason: NO_SUCH_RECORD_REASON };
      }

      // Replace the fields (re-encrypted) and the status / due date; an omitted
      // status or due date preserves the record's current value. The kind is left
      // untouched (the store never changes it).
      await updateRecord(
        db,
        {
          userId: connection.userId,
          id: existing.id,
          fields: parsed.fields,
          status: parsed.status ?? existing.status,
          dueDate: parsed.dueDate,
        },
        dek,
      );

      return { status: "updated", id: existing.id };
    },
  };
}
