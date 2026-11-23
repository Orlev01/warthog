// Saving and changing typed life-admin records (docs/adr/life-admin-profile.md): the one
// place that decides, for the person and for agents alike, whether a save makes a new record,
// updates the one it matches, or waits for the person to decide.
//
//   • Fields are normalised to the record type's own (`domain/life-admin/normalise.ts`).
//   • A record whose identifying values match one already saved (the same insurer and policy
//     number, the same plate) updates it instead of adding a copy — unless the person dismissed
//     that one ("not mine"), when an agent's save is skipped.
//   • An agent's record is a suggestion until the person confirms it. An agent never changes a
//     record the person confirmed: its change waits as a pending change the person accepts or
//     declines in Life admin. An agent may keep refining its own suggestions.
//   • Every write says who made it (`changed_by`), so a record an agent rewrote never reads as
//     the person's.
//
// Identifiers that must never be stored are refused before this runs (the MCP schemas and the
// page actions call `findForbidden`). A SERVER module over its injected `db` and the owner's
// unwrapped DEK; every read and write is member-scoped by the caller's `userId`.

import {
  identityParts,
  normaliseFields,
  type NormalisedFields,
} from "../../domain/life-admin/normalise";
import { recordType, typeOfRecord, type RecordTypeDef } from "../../domain/life-admin/record-types";
import {
  createRecord,
  findRecordByMatchKey,
  getRecordForUser,
  recordMatchKey,
  setPendingChange,
  updateRecord,
  type LifeAdminRecord,
  type PendingChange,
  type RecordFoundIn,
  type RecordSource,
} from "../db/life-admin-records";
import { withTransaction, type Db } from "../db/index";

// The statuses a typed record takes. Older records keep whatever status they were saved with.
export const RECORD_STATUSES = ["active", "paused", "cancelled", "expired", "done"] as const;
export type RecordStatus = (typeof RECORD_STATUSES)[number];
const STATUS_WORDS: Readonly<Record<string, RecordStatus>> = {
  active: "active", current: "active", ok: "active", renewed: "active",
  paused: "paused", on_hold: "paused",
  cancelled: "cancelled", canceled: "cancelled", ended: "cancelled", closed: "cancelled",
  expired: "expired", lapsed: "expired",
  done: "done", completed: "done", finished: "done",
};

/** A status word as one of the record statuses, or null. */
export function recordStatusOf(value: string): RecordStatus | null {
  return STATUS_WORDS[value.trim().toLowerCase().replace(/[\s-]+/g, "_")] ?? null;
}

export type Actor = RecordSource;

export interface SaveInput {
  readonly type: RecordTypeDef;
  // The raw fields, as an agent or form sent them.
  readonly fields: Readonly<Record<string, unknown>>;
  // Undefined ⇒ not given (a due date may then be found among the fields).
  readonly dueDate?: string | null;
  readonly status?: RecordStatus;
  readonly parentId?: string | null;
  readonly foundIn?: RecordFoundIn | null;
  // What to do when a matching record exists: update it (default), leave it, or add another.
  readonly onMatch?: "update" | "skip" | "create";
  // Whether the actor may see a matching record (an agent limited to chosen records). A match
  // it can't see is never touched or revealed; a separate record is created instead.
  readonly canSee?: (record: LifeAdminRecord) => boolean;
}

// `problems` say what was changed or left out of what was sent. `hints` are advice for an
// agent only (which details would let a later save find this record again); the person's own
// page never shows them.
export type SaveOutcome =
  | { readonly action: "created" | "updated" | "unchanged" | "proposed"; readonly record: LifeAdminRecord; readonly problems: string[]; readonly hints?: string[] }
  | { readonly action: "skipped"; readonly record: LifeAdminRecord | null; readonly reason: string; readonly problems: string[]; readonly hints?: string[] };

export interface ChangeInput {
  // Fields to set (raw, normalised here) and field keys to remove.
  readonly set: Readonly<Record<string, unknown>>;
  readonly remove?: readonly string[];
  // Replace every field with `set` (the older update_record behaviour).
  readonly replace?: boolean;
  readonly dueDate?: string | null;
  readonly status?: string;
  readonly parentId?: string | null;
  readonly type?: RecordTypeDef;
  readonly foundIn?: RecordFoundIn | null;
  // Keep `set` exactly as given (an older record changed by an older caller keeps its own
  // field names and is not given a type).
  readonly raw?: boolean;
}

export type ChangeOutcome =
  | { readonly action: "updated" | "unchanged" | "proposed"; readonly record: LifeAdminRecord; readonly problems: string[] }
  | { readonly action: "refused"; readonly reason: string; readonly problems: string[] };

// A record's type: its own, else the one its stored kind reads as.
export function typeOf(record: Pick<LifeAdminRecord, "kind" | "type">): RecordTypeDef {
  return typeOfRecord(record.kind, record.type);
}

function sameValue(a: unknown, b: unknown): boolean {
  return (a ?? null) === (b ?? null) || String(a ?? "") === String(b ?? "");
}

function dateText(value: string | Date | null): string | null {
  if (value === null) return null;
  return typeof value === "string" ? value.slice(0, 10) : value.toISOString().slice(0, 10);
}

// The parent a record of `type` may belong to: the person's own live asset of an allowed type.
async function checkedParent(
  db: Db,
  userId: string,
  type: RecordTypeDef,
  parentId: string | null | undefined,
  dek: Uint8Array,
  problems: string[],
): Promise<string | null | undefined> {
  if (parentId === undefined || parentId === null) return parentId;
  const parent = await getRecordForUser(db, userId, parentId, dek);
  const parentType = parent ? typeOf(parent) : null;
  if (!parent || !parentType?.asset || !(type.parents ?? []).includes(parentType.id)) {
    problems.push(`Not linked to "${parentId}": a ${type.label.toLowerCase()} can belong only to one of the person's ${(type.parents ?? []).map((id) => recordType(id)!.label.toLowerCase()).join(" or ") || "records"}.`);
    return null;
  }
  return parent.id;
}

function matchKeyOf(dek: Uint8Array, type: RecordTypeDef, fields: Readonly<Record<string, unknown>>, parentId: string | null): string | null {
  const parts = identityParts(type, fields, parentId);
  return parts ? recordMatchKey(dek, type.id, parts) : null;
}

// The scalar fields of a stored record (older records may hold objects an agent saved; those are
// kept as they are, never flattened to "[object Object]").
function storedFields(record: LifeAdminRecord): Record<string, unknown> {
  return { ...record.fields };
}

/**
 * Apply a change from `actor` to `existing`. The person's change, or an agent's change to a
 * record that is still a suggestion, is written; an agent's change to a confirmed record waits
 * as a pending change. Runs inside the caller's transaction.
 */
async function applyChange(
  tx: Db,
  dek: Uint8Array,
  existing: LifeAdminRecord,
  actor: Actor,
  type: RecordTypeDef,
  normalised: NormalisedFields,
  change: { remove: readonly string[]; replace: boolean; dueDate?: string | null; status?: string; parentId?: string | null; foundIn?: RecordFoundIn | null; retype: boolean; keepUntyped?: boolean },
  clockIso: string,
): Promise<{ action: "updated" | "unchanged" | "proposed"; record: LifeAdminRecord }> {
  const current = storedFields(existing);
  const next: Record<string, unknown> = change.replace ? { ...normalised.fields } : { ...current, ...normalised.fields };
  for (const key of change.remove) delete next[key];
  const dueDate = change.dueDate !== undefined ? change.dueDate : normalised.dueDate !== null ? normalised.dueDate : undefined;

  const setFields: Record<string, string> = {};
  for (const [key, value] of Object.entries(next)) if (!sameValue(current[key], value)) setFields[key] = String(value);
  const removed = Object.keys(current).filter((key) => !(key in next));
  const dueChanged = dueDate !== undefined && dateText(existing.dueDate) !== dueDate;
  const statusChanged = change.status !== undefined && change.status !== existing.status;
  const parentChanged = change.parentId !== undefined && change.parentId !== existing.parentId;
  const changed = Object.keys(setFields).length > 0 || removed.length > 0 || dueChanged || statusChanged || parentChanged || change.retype;

  if (!changed) return { action: "unchanged", record: existing };

  if (actor.kind === "agent" && existing.reviewState === "confirmed") {
    const pending: PendingChange = {
      set: setFields,
      remove: removed,
      ...(dueChanged ? { dueDate } : {}),
      ...(statusChanged ? { status: change.status } : {}),
      byAgentId: actor.agentId,
      at: clockIso,
      ...(change.foundIn ? { foundIn: change.foundIn } : {}),
    };
    await setPendingChange(tx, existing.userId, existing.id, pending, dek);
    return { action: "proposed", record: { ...existing, pending } };
  }

  const parentId = change.parentId !== undefined ? change.parentId : existing.parentId;
  const record = await updateRecord(
    tx,
    {
      userId: existing.userId,
      id: existing.id,
      fields: next,
      dueDate,
      status: change.status ?? existing.status,
      ...(change.retype || (!existing.type && !change.keepUntyped) ? { type: type.id } : {}),
      ...(change.foundIn !== undefined ? { foundIn: change.foundIn } : {}),
      ...(change.parentId !== undefined ? { parentId: change.parentId } : {}),
      matchKey: matchKeyOf(dek, type, next, parentId),
      // The person's own change makes the record theirs; an agent's keeps it a suggestion.
      reviewState: actor.kind === "person" ? "confirmed" : existing.reviewState === "confirmed" ? "confirmed" : "suggested",
      changedBy: actor,
    },
    dek,
  );
  return { action: "updated", record };
}

/** Save a typed record for `userId` from `actor`: create it, update its match, or propose a change. */
export async function saveTypedRecord(
  db: Db,
  dek: Uint8Array,
  userId: string,
  actor: Actor,
  input: SaveInput,
  now: Date,
): Promise<SaveOutcome> {
  const run = async (tx: Db): Promise<SaveOutcome> => {
    // Lock the owner row first, so the match look-up and the insert can't race another save.
    await tx.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [userId]);
    const type = input.type;
    const normalised = normaliseFields(type, input.fields, input.dueDate != null, { fromAgent: actor.kind === "agent" });
    const problems = [...normalised.problems];
    const parentId = await checkedParent(tx, userId, type, input.parentId, dek, problems);
    const dueDate = input.dueDate !== undefined && input.dueDate !== null ? input.dueDate : normalised.dueDate ?? input.dueDate ?? null;
    let matchKey = matchKeyOf(dek, type, normalised.fields, parentId ?? null);

    if (matchKey && input.onMatch !== "create") {
      const match = await findRecordByMatchKey(tx, userId, matchKey, dek);
      if (match && match.reviewState === "dismissed") {
        if (actor.kind === "agent") {
          return { action: "skipped", record: null, reason: "The person removed this record from Life admin before, so it wasn't added again.", problems };
        }
      } else if (match && (input.canSee?.(match) ?? true)) {
        if (input.onMatch === "skip") return { action: "skipped", record: match, reason: "A matching record is already saved.", problems };
        const changed = await applyChange(tx, dek, match, actor, type, normalised, {
          remove: [],
          replace: false,
          dueDate: input.dueDate !== undefined && input.dueDate !== null ? input.dueDate : normalised.dueDate ?? undefined,
          status: input.status,
          parentId: parentId === undefined ? undefined : parentId,
          foundIn: input.foundIn,
          retype: false,
        }, now.toISOString());
        return { ...changed, problems };
      } else if (match) {
        // A match this actor can't see stays untouched and unrevealed.
        matchKey = null;
      }
    }
    const hints: string[] = [];
    if (!matchKey && type.identity.length > 0 && !type.singleton) {
      hints.push(`Add ${type.identity.map((key) => (key === "parent" ? "parentId" : key === "title" ? "name" : key)).join(" and ")} so a later save updates this record instead of adding another.`);
    }

    const record = await createRecord(
      tx,
      {
        userId,
        kind: type.storedKind,
        type: type.id,
        fields: normalised.fields,
        dueDate,
        status: input.status ?? "active",
        ...(type.reminders ? { reminderOffsets: [...type.reminders] } : {}),
        source: actor,
        foundIn: input.foundIn ?? null,
        parentId: parentId ?? null,
        matchKey,
      },
      dek,
    );
    return { action: "created", record, problems, ...(hints.length > 0 ? { hints } : {}) };
  };
  return db.inTransaction ? run(db) : withTransaction(db, run);
}

/** Change one of the person's records by id, from `actor`. */
export async function changeRecord(
  db: Db,
  dek: Uint8Array,
  existing: LifeAdminRecord,
  actor: Actor,
  input: ChangeInput,
  now: Date,
): Promise<ChangeOutcome> {
  const run = async (tx: Db): Promise<ChangeOutcome> => {
    await tx.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [existing.userId]);
    const fresh = await getRecordForUser(tx, existing.userId, existing.id, dek);
    if (!fresh) return { action: "refused", reason: "No such record for this person.", problems: [] };
    const type = input.type ?? typeOf(fresh);
    const normalised: NormalisedFields = input.raw
      ? { fields: { ...input.set } as Record<string, string>, dueDate: null, problems: [] }
      : normaliseFields(type, input.set, input.dueDate != null, { fromAgent: actor.kind === "agent" });
    const problems = [...normalised.problems];
    const parentId = await checkedParent(tx, existing.userId, type, input.parentId, dek, problems);
    // A typed record takes one of the record statuses; a record saved before types existed
    // keeps taking the free-form status it always did.
    let status: string | undefined;
    if (input.status !== undefined) {
      const known = recordStatusOf(input.status);
      if (known) status = known;
      else if (!fresh.type && input.type === undefined) status = input.status;
      else problems.push(`Status left unchanged: use ${RECORD_STATUSES.join(", ")}.`);
    }
    const changed = await applyChange(tx, dek, fresh, actor, type, normalised, {
      remove: input.remove ?? [],
      replace: input.replace === true,
      dueDate: input.dueDate,
      status,
      parentId: parentId === undefined ? undefined : parentId,
      foundIn: input.foundIn,
      retype: input.type !== undefined && input.type.id !== fresh.type,
      keepUntyped: input.raw === true,
    }, now.toISOString());
    return { ...changed, problems };
  };
  return db.inTransaction ? run(db) : withTransaction(db, run);
}

/** The person accepts an agent's pending change: it is applied and the record stays theirs. */
export async function acceptPendingChange(db: Db, dek: Uint8Array, userId: string, id: string): Promise<LifeAdminRecord | null> {
  return withTransaction(db, async (tx) => {
    const record = await getRecordForUser(tx, userId, id, dek);
    if (!record?.pending) return null;
    const { pending } = record;
    const type = typeOf(record);
    const fields: Record<string, unknown> = { ...record.fields, ...pending.set };
    for (const key of pending.remove) delete fields[key];
    return updateRecord(
      tx,
      {
        userId,
        id,
        fields,
        ...(pending.dueDate !== undefined ? { dueDate: pending.dueDate } : {}),
        status: pending.status ?? record.status,
        ...(pending.foundIn ? { foundIn: pending.foundIn } : {}),
        matchKey: matchKeyOf(dek, type, fields, record.parentId),
        reviewState: "confirmed",
        changedBy: { kind: "person" },
        clearPending: true,
      },
      dek,
    );
  });
}

/** The person keeps their own values: the pending change is dropped. */
export async function declinePendingChange(db: Db, userId: string, id: string): Promise<boolean> {
  const result = await db.query(
    "UPDATE life_admin_records SET pending = NULL WHERE id = $1 AND user_id = $2 AND pending IS NOT NULL RETURNING id",
    [id, userId],
  );
  return result.rows.length > 0;
}
