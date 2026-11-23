// Saving and changing life-admin records (docs/adr/life-admin-profile.md, life-admin-journal.md):
// the one place that decides, for the person and for agents alike, whether a save makes a new
// record, updates the one it matches, or waits for the person — and that keeps every item's
// journal and who is handling it.
//
//   • Kinds come from the person's catalogue (built-in plus their own categories); fields are
//     normalised to the kind's own, in the person's time zone (`domain/life-admin/normalise.ts`).
//   • A record whose identifying values match one already saved — any of its kind's identity
//     alternatives (insurer + policy number; a plate; a booking's provider + reference, or provider
//     + start date) — updates it instead of adding a copy, unless the person dismissed that one
//     ("not mine"), when an agent's save is skipped.
//   • An agent's record is a suggestion until the person confirms it. An agent never changes a
//     record the person confirmed: its change waits as a pending change. An agent may keep
//     refining its own suggestions.
//   • Links follow one rule from the catalogue: a record may belong to an anchor (a vehicle, home,
//     trip, pet, or a thing of a person's own category) its kind allows.
//   • Every item has a journal. Warthog writes a `change` entry for what it did (created, changed,
//     proposed, accepted, confirmed, handed over); agents and the person add one- or two-line
//     decisions, notes, next steps and hand-over notes. Recording a decision or next step on a live
//     item nobody is handling makes that agent its steward; `takeOver` hands it over explicitly.
//
// Identifiers that must never be stored are refused before this runs (the MCP schemas and the
// page actions). A SERVER module over its injected `db` and the owner's unwrapped DEK; every read
// and write is member-scoped by the caller's `userId`.

import type { Catalogue } from "../../domain/life-admin/catalogue";
import { cleanJournalText } from "../../domain/life-admin/journal-text";
import type { ChangeSummary, FieldChange, JournalKind } from "../../domain/life-admin/journal";
import { bookingDueDate, phaseOf, remindUntilOf, statusFor, RECORD_STATUSES } from "../../domain/life-admin/lifecycle";
import { calendarDate, identityAlternatives, normaliseFields, type NormalisedFields } from "../../domain/life-admin/normalise";
import type { RecordTypeDef } from "../../domain/life-admin/record-types";
import { listAgentsForUser } from "../db/agents";
import { appendJournalEntry, listJournal } from "../db/life-admin-journal";
import {
  confirmRecord,
  createRecord,
  dismissRecordRow,
  findRecordByMatchKeys,
  listRecordsForUser,
  getRecordForUser,
  recordMatchKey,
  setPendingChange,
  setSteward,
  updateRecord,
  type LifeAdminRecord,
  type PendingChange,
  type RecordFoundIn,
  type RecordSource,
} from "../db/life-admin-records";
import { declineCategory, keepCategory } from "../db/life-admin-categories";
import { withTransaction, type Db } from "../db/index";

export { RECORD_STATUSES };
export type Actor = RecordSource;

// Everything a save needs about the person and the moment, passed once.
export interface ServiceContext {
  readonly db: Db;
  readonly dek: Uint8Array;
  readonly userId: string;
  readonly catalogue: Catalogue;
  // The person's time zone (date-times without one are read in it; "today" is theirs).
  readonly zone: string;
  readonly now: Date;
  // The conversation an agent's call belongs to, and the product it came through (journal only).
  readonly run?: { readonly id: string; readonly label?: string | null } | null;
  readonly via?: string | null;
}

// What an agent (or the person) adds to an item's journal in the same call.
export interface JournalInput {
  readonly decision?: string;
  readonly replaces?: string;
  readonly note?: string;
  readonly next?: { readonly text: string; readonly due?: string };
  readonly doneNextIds?: readonly string[];
  readonly handover?: string;
}

export interface SaveInput {
  readonly type: RecordTypeDef;
  // The raw fields, as an agent or form sent them, and any labelled extra details.
  readonly fields: Readonly<Record<string, unknown>>;
  readonly details?: readonly { readonly label: string; readonly value: string }[];
  // Undefined ⇒ not given (a due date may then be found among the fields).
  readonly dueDate?: string | null;
  // A status word ("active", "cancelled", "confirmed", "no show", "under review" …).
  readonly status?: string;
  readonly parentId?: string | null;
  readonly foundIn?: RecordFoundIn | null;
  readonly onMatch?: "update" | "skip" | "create";
  // Whether the actor may see a matching record (an agent limited to chosen records). A match
  // it can't see is never touched or revealed; a separate record is created instead.
  readonly canSee?: (record: LifeAdminRecord) => boolean;
  readonly journal?: JournalInput;
  readonly takeOver?: boolean;
}

export interface JournalResult {
  readonly added: readonly { readonly id: string; readonly kind: JournalKind }[];
  readonly steward?: string | null;
  readonly tookOverFrom?: string;
}

export type SaveOutcome =
  | { readonly action: "created" | "updated" | "unchanged" | "proposed"; readonly record: LifeAdminRecord; readonly problems: string[]; readonly hints?: string[]; readonly journal?: JournalResult }
  | { readonly action: "skipped"; readonly record: LifeAdminRecord | null; readonly reason: string; readonly problems: string[]; readonly hints?: string[] };

export interface ChangeInput {
  readonly set: Readonly<Record<string, unknown>>;
  readonly remove?: readonly string[];
  // Replace every field with `set` (the older update_record behaviour).
  readonly replace?: boolean;
  readonly details?: readonly { readonly label: string; readonly value: string }[];
  readonly dueDate?: string | null;
  readonly status?: string;
  readonly parentId?: string | null;
  readonly type?: RecordTypeDef;
  readonly foundIn?: RecordFoundIn | null;
  // Keep `set` exactly as given (an older record changed by an older caller keeps its own field
  // names and is not given a kind).
  readonly raw?: boolean;
  readonly journal?: JournalInput;
  readonly takeOver?: boolean;
}

export type ChangeOutcome =
  | { readonly action: "updated" | "unchanged" | "proposed"; readonly record: LifeAdminRecord; readonly problems: string[]; readonly journal?: JournalResult }
  | { readonly action: "refused"; readonly reason: string; readonly problems: string[] };

/** A record's kind in the person's catalogue. */
export function typeOf(catalogue: Catalogue, record: Pick<LifeAdminRecord, "kind" | "type">): RecordTypeDef {
  return catalogue.typeOfRecord(record.kind, record.type);
}

/** A status word as one of the record statuses (standing items), or null. */
export function recordStatusOf(value: string): (typeof RECORD_STATUSES)[number] | null {
  return statusFor({ lifecycle: "standing" }, value)?.status ?? null;
}

function sameValue(a: unknown, b: unknown): boolean {
  return (a ?? null) === (b ?? null) || String(a ?? "") === String(b ?? "");
}

function dateText(value: string | Date | null): string | null {
  if (value === null) return null;
  return typeof value === "string" ? value.slice(0, 10) : value.toISOString().slice(0, 10);
}

function tidyLabel(key: string): string {
  const words = key.replace(/[_-]+/g, " ").trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : key;
}

const cut = (value: string, max = 80) => (Array.from(value).length > max ? `${Array.from(value).slice(0, max - 1).join("")}…` : value);

// What changed, for the journal: labelled, values cut short; long notes and extra details by name only.
function fieldChanges(type: RecordTypeDef, before: Readonly<Record<string, unknown>>, setFields: Readonly<Record<string, string>>, removed: readonly string[]): FieldChange[] {
  const changes: FieldChange[] = [];
  for (const [key, to] of Object.entries(setFields)) {
    const def = type.fields.find((field) => field.key === key);
    const label = def?.label ?? tidyLabel(key);
    const from = before[key];
    if (!def || def.kind === "long_text") changes.push({ key, label });
    else changes.push({ key, label, ...(from !== undefined && from !== null && from !== "" ? { from: cut(String(from)) } : {}), to: cut(to) });
  }
  for (const key of removed) {
    const def = type.fields.find((field) => field.key === key);
    changes.push({ key, label: def?.label ?? tidyLabel(key), ...(def && def.kind !== "long_text" && before[key] !== undefined ? { from: cut(String(before[key])) } : {}) });
  }
  return changes;
}

// The parent a record of `type` may belong to: the person's own live anchor its kind allows.
async function checkedParent(
  ctx: ServiceContext,
  tx: Db,
  type: RecordTypeDef,
  parentId: string | null | undefined,
  problems: string[],
): Promise<string | null | undefined> {
  if (parentId === undefined || parentId === null) return parentId;
  const parent = await getRecordForUser(tx, ctx.userId, parentId, ctx.dek);
  const parentType = parent ? typeOf(ctx.catalogue, parent) : null;
  if (!parent || !parentType || !ctx.catalogue.canBelongTo(type, parentType)) {
    problems.push(`Not linked to "${parentId}": a ${type.label.toLowerCase()} can't belong to that record.`);
    return null;
  }
  return parent.id;
}

function matchKeysOf(ctx: ServiceContext, type: RecordTypeDef, fields: Readonly<Record<string, unknown>>, parentId: string | null): string[] {
  return identityAlternatives(type, fields, parentId).map((alternative) => recordMatchKey(ctx.dek, type.id, alternative.keys, alternative.values));
}

// The status and (for bookings and cases) state a save lands at.
function statusChoice(type: RecordTypeDef, word: string | undefined, problems: string[], current?: { status: string; state: string | null }) {
  if (word === undefined) return current ?? (type.lifecycle === "booking" ? { status: "active", state: "confirmed" } : type.lifecycle === "case" ? { status: "active", state: "open" } : { status: "active", state: null });
  const choice = statusFor(type, word);
  if (!choice) {
    problems.push(type.lifecycle === "booking"
      ? "Status left as it was: use confirmed, pending, cancelled or no_show."
      : type.lifecycle === "case" ? "Status left as it was: use open, waiting or resolved." : `Status left as it was: use ${RECORD_STATUSES.join(", ")}.`);
    return current ?? { status: "active", state: type.lifecycle === "booking" ? "confirmed" : type.lifecycle === "case" ? "open" : null };
  }
  return { status: choice.status, state: choice.state ?? null };
}

// A booking's due date is the local date it starts; anything else keeps the date it was given.
function dueDateFor(ctx: ServiceContext, type: RecordTypeDef, fields: Readonly<Record<string, unknown>>, given: string | null | undefined, lifted: string | null, problems: string[]): string | null | undefined {
  if (type.lifecycle === "booking") {
    const start = bookingDueDate(fields, ctx.zone);
    if (start) return start;
    if (given) return given;
    return given === null ? null : undefined;
  }
  if (given !== undefined) return given;
  return lifted ?? undefined;
}

// ---- journal and steward -------------------------------------------------------------------

interface AgentNames {
  name(agentId: string | null | undefined): string;
  connected(agentId: string): boolean;
}

async function agentNames(db: Db, userId: string): Promise<AgentNames> {
  const agents = await listAgentsForUser(db, userId);
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  return {
    name: (agentId) => (agentId ? byId.get(agentId)?.displayName ?? "an agent that is no longer connected" : "you"),
    connected: (agentId) => byId.get(agentId)?.status === "connected",
  };
}

async function writeChange(ctx: ServiceContext, tx: Db, recordId: string, actor: Actor, change: ChangeSummary): Promise<string | null> {
  const outcome = await appendJournalEntry(tx, {
    userId: ctx.userId,
    recordId,
    kind: "change",
    actorKind: actor.kind,
    actorAgentId: actor.kind === "agent" ? actor.agentId : null,
    runId: ctx.run?.id ?? null,
    at: ctx.now,
    body: { change, ...(ctx.run ? { run: { id: ctx.run.id, ...(ctx.run.label ? { label: ctx.run.label } : {}) } } : {}), ...(ctx.via ? { via: ctx.via } : {}) },
  }, ctx.dek);
  return outcome.appended ? outcome.id : null;
}

/** Add the actor's journal entries to a record, then apply the steward rules. Inside the caller's transaction. */
async function writeJournal(
  ctx: ServiceContext,
  tx: Db,
  record: LifeAdminRecord,
  actor: Actor,
  journal: JournalInput | undefined,
  takeOver: boolean,
  problems: string[],
): Promise<JournalResult> {
  const added: { id: string; kind: JournalKind }[] = [];
  const base = {
    userId: ctx.userId,
    recordId: record.id,
    actorKind: actor.kind,
    actorAgentId: actor.kind === "agent" ? actor.agentId : null,
    runId: ctx.run?.id ?? null,
    at: ctx.now,
  } as const;
  const extra = { ...(ctx.run ? { run: { id: ctx.run.id, ...(ctx.run.label ? { label: ctx.run.label } : {}) } } : {}), ...(ctx.via ? { via: ctx.via } : {}) };
  const add = async (kind: JournalKind, text: string | undefined, more: { due?: string; refId?: string | null } = {}) => {
    const cleaned = text === undefined ? null : cleanJournalText(text);
    if (text !== undefined && !cleaned) return;
    if (cleaned?.cut) problems.push(`Your ${kind} was cut to 280 characters.`);
    const outcome = await appendJournalEntry(tx, { ...base, kind, refId: more.refId ?? null, body: { ...(cleaned ? { text: cleaned.text } : {}), ...(more.due ? { due: more.due } : {}), ...extra } }, ctx.dek);
    if (outcome.appended) added.push({ id: outcome.id, kind });
    else problems.push(outcome.reason === "full" ? "This item's log is full, so your entry wasn't added." : `That ${kind === "next_done" ? "step was already marked done" : "decision was already replaced"}.`);
  };

  if (journal) {
    let replaces: string | null = null;
    if (journal.replaces) {
      const earlier = (await listJournal(tx, ctx.userId, record.id, ctx.dek, { limit: 200 })).find((entry) => entry.id === journal.replaces && entry.kind === "decision");
      if (earlier) replaces = earlier.id;
      else problems.push("replaces doesn't name a decision on this record, so the new decision stands on its own.");
    }
    if (journal.decision !== undefined) await add("decision", journal.decision, { refId: replaces });
    if (journal.note !== undefined) await add("note", journal.note);
    if (journal.next) {
      const due = journal.next.due ? calendarDate(journal.next.due) : null;
      if (journal.next.due && !due) problems.push("The next step's due date was left out: use YYYY-MM-DD.");
      await add("next", journal.next.text, { ...(due ? { due } : {}) });
    }
    if (journal.handover !== undefined) await add("handover", journal.handover);
    if (journal.doneNextIds && journal.doneNextIds.length > 0) {
      const steps = new Set((await listJournal(tx, ctx.userId, record.id, ctx.dek, { limit: 200 })).filter((entry) => entry.kind === "next").map((entry) => entry.id));
      for (const id of journal.doneNextIds) {
        if (!steps.has(id)) problems.push(`"${id}" isn't a next step on this record.`);
        else await add("next_done", undefined, { refId: id });
      }
    }
  }

  // Steward: an agent that records work on a live item nobody is handling takes it on; takeOver
  // hands it over explicitly. The person assigns through setStewardFor.
  if (actor.kind !== "agent") return { added };
  const wroteWork = added.some((entry) => entry.kind === "decision" || entry.kind === "next" || entry.kind === "handover");
  const live = phaseOf(record, typeOf(ctx.catalogue, record), ctx.now, ctx.zone).live;
  const current = record.steward;
  const names = await agentNames(tx, ctx.userId);
  const vacant = !current || !names.connected(current.agentId);
  if ((takeOver && current?.agentId !== actor.agentId) || (wroteWork && live && vacant && current?.agentId !== actor.agentId)) {
    await setSteward(tx, ctx.userId, record.id, { agentId: actor.agentId, setBy: "agent", since: ctx.now });
    const from = current && current.agentId !== actor.agentId ? names.name(current.agentId) : undefined;
    const to = names.name(actor.agentId);
    await writeChange(ctx, tx, record.id, actor, { event: "steward", ...(from && takeOver ? { from } : {}), to });
    return { added, steward: to, ...(from && takeOver ? { tookOverFrom: from } : {}) };
  }
  return { added, ...(current ? { steward: names.name(current.agentId) } : { steward: null }) };
}

// ---- applying a change ---------------------------------------------------------------------

/**
 * Apply a change from `actor` to `existing`. The person's change, or an agent's change to a record
 * that is still a suggestion, is written; an agent's change to a confirmed record waits as a
 * pending change. Runs inside the caller's transaction.
 */
async function applyChange(
  ctx: ServiceContext,
  tx: Db,
  existing: LifeAdminRecord,
  actor: Actor,
  type: RecordTypeDef,
  normalised: NormalisedFields,
  change: {
    remove: readonly string[]; replace: boolean; dueDate?: string | null; statusWord?: string; rawStatus?: string;
    parentId?: string | null; foundIn?: RecordFoundIn | null; retype: boolean; keepUntyped?: boolean;
  },
  problems: string[],
): Promise<{ action: "updated" | "unchanged" | "proposed"; record: LifeAdminRecord }> {
  const current = { ...existing.fields };
  const next: Record<string, unknown> = change.replace ? { ...normalised.fields } : { ...current, ...normalised.fields };
  for (const key of change.remove) delete next[key];
  const given = change.dueDate !== undefined ? change.dueDate : normalised.dueDate !== null ? normalised.dueDate : undefined;
  const dueDate = change.keepUntyped ? given : dueDateFor(ctx, type, next, given, null, problems);

  const choice = change.rawStatus !== undefined
    ? { status: change.rawStatus, state: existing.state }
    : statusChoice(type, change.statusWord, problems, { status: existing.status, state: existing.state });

  const setFields: Record<string, string> = {};
  for (const [key, value] of Object.entries(next)) if (!sameValue(current[key], value)) setFields[key] = String(value);
  const removed = Object.keys(current).filter((key) => !(key in next));
  const dueChanged = dueDate !== undefined && dateText(existing.dueDate) !== dueDate;
  const statusChanged = choice.status !== existing.status || (choice.state ?? null) !== (existing.state ?? null);
  const parentChanged = change.parentId !== undefined && change.parentId !== existing.parentId;
  const changed = Object.keys(setFields).length > 0 || removed.length > 0 || dueChanged || statusChanged || parentChanged || change.retype;
  if (!changed) return { action: "unchanged", record: existing };

  const fieldsChanged = fieldChanges(type, current, setFields, removed);
  if (statusChanged) fieldsChanged.push({ key: "status", label: "Status", from: existing.state ?? existing.status, to: choice.state ?? choice.status });
  if (dueChanged) fieldsChanged.push({ key: "due_date", label: type.due?.label ?? "Due", ...(existing.dueDate ? { from: dateText(existing.dueDate)! } : {}), ...(dueDate ? { to: dueDate } : {}) });

  const retyped = change.retype || (!existing.type && !change.keepUntyped);
  if (actor.kind === "agent" && existing.reviewState === "confirmed") {
    const pending: PendingChange = {
      set: setFields,
      remove: removed,
      ...(dueChanged ? { dueDate } : {}),
      ...(statusChanged ? { status: choice.status, state: choice.state ?? null } : {}),
      ...(retyped ? { type: type.id } : {}),
      ...(parentChanged ? { parentId: change.parentId } : {}),
      byAgentId: actor.agentId,
      at: ctx.now.toISOString(),
      ...(change.foundIn ? { foundIn: change.foundIn } : {}),
    };
    await setPendingChange(tx, existing.userId, existing.id, pending, ctx.dek);
    await writeChange(ctx, tx, existing.id, actor, { event: "proposed", fields: fieldsChanged });
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
      status: choice.status,
      state: choice.state,
      remindUntil: change.keepUntyped ? undefined : remindUntilOf(type, choice.status, choice.state, dueDate !== undefined ? dueDate : existing.dueDate),
      ...(retyped ? { type: type.id } : {}),
      ...(change.foundIn !== undefined ? { foundIn: change.foundIn } : {}),
      ...(change.parentId !== undefined ? { parentId: change.parentId } : {}),
      matchKeys: matchKeysOf(ctx, type, next, parentId),
      // The person's own change makes the record theirs; an agent's keeps it a suggestion.
      reviewState: actor.kind === "person" ? "confirmed" : existing.reviewState === "confirmed" ? "confirmed" : "suggested",
      changedBy: actor,
    },
    ctx.dek,
  );
  await writeChange(ctx, tx, existing.id, actor, { event: "updated", fields: fieldsChanged });
  if (actor.kind === "person") await keepIfSuggested(ctx, tx, type);
  return { action: "updated", record: { ...record, steward: existing.steward } };
}

// Confirming or editing a record in a suggested category of the person's own keeps that category.
async function keepIfSuggested(ctx: ServiceContext, tx: Db, type: RecordTypeDef): Promise<void> {
  if (type.origin === "custom" && ctx.catalogue.customStates[type.category] === "suggested") {
    await keepCategory(tx, ctx.userId, type.category, { now: () => ctx.now });
  }
}

const inTx = <T>(db: Db, run: (tx: Db) => Promise<T>) => (db.inTransaction ? run(db) : withTransaction(db, run));

/** Save a record for the person from `actor`: create it, update its match, or propose a change. */
export async function saveTypedRecord(ctx: ServiceContext, actor: Actor, input: SaveInput): Promise<SaveOutcome> {
  return inTx(ctx.db, async (tx) => {
    // Lock the owner row first, so the match look-up and the insert can't race another save.
    await tx.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [ctx.userId]);
    const type = input.type;
    const normalised = normaliseFields(type, input.fields, input.dueDate != null, { fromAgent: actor.kind === "agent", zone: ctx.zone }, input.details ?? []);
    const problems = [...normalised.problems];
    const parentId = await checkedParent(ctx, tx, type, input.parentId, problems);
    let matchKeys = matchKeysOf(ctx, type, normalised.fields, parentId ?? null);

    if (matchKeys.length > 0 && input.onMatch !== "create") {
      const match = await findRecordByMatchKeys(tx, ctx.userId, matchKeys, ctx.dek);
      if (match && match.reviewState === "dismissed") {
        if (actor.kind === "agent") {
          return { action: "skipped", record: null, reason: "The person removed this record from Life admin before, so it wasn't added again.", problems };
        }
      } else if (match && (input.canSee?.(match) ?? true)) {
        if (input.onMatch === "skip") return { action: "skipped", record: match, reason: "A matching record is already saved.", problems };
        const changed = await applyChange(ctx, tx, match, actor, type, normalised, {
          remove: [],
          replace: false,
          dueDate: input.dueDate !== undefined && input.dueDate !== null ? input.dueDate : normalised.dueDate ?? undefined,
          statusWord: input.status,
          parentId: parentId === undefined ? undefined : parentId,
          foundIn: input.foundIn,
          retype: false,
        }, problems);
        const journal = await writeJournal(ctx, tx, changed.record, actor, input.journal, input.takeOver === true, problems);
        return { ...changed, problems, journal };
      } else if (match) {
        // A match this actor can't see stays untouched and unrevealed.
        matchKeys = [];
      }
    }
    const hints: string[] = [];
    if (matchKeys.length === 0 && type.identity.length > 0 && !type.singleton) {
      const first = type.identity[0]!.map((key) => (key === "parent" ? "parentId" : key === "title" ? "name" : key));
      hints.push(`Add ${first.join(" and ")} so a later save updates this record instead of adding another.`);
    }

    const choice = statusChoice(type, input.status, problems);
    const dueDate = dueDateFor(ctx, type, normalised.fields, input.dueDate, normalised.dueDate, problems) ?? null;
    const record = await createRecord(
      tx,
      {
        userId: ctx.userId,
        kind: type.storedKind,
        type: type.id,
        fields: normalised.fields,
        dueDate,
        status: choice.status,
        state: choice.state,
        remindUntil: remindUntilOf(type, choice.status, choice.state, dueDate),
        ...(type.reminders ? { reminderOffsets: [...type.reminders] } : {}),
        source: actor,
        foundIn: input.foundIn ?? null,
        parentId: parentId ?? null,
        matchKeys,
      },
      ctx.dek,
    );
    await writeChange(ctx, tx, record.id, actor, { event: "created" });
    if (actor.kind === "person") await keepIfSuggested(ctx, tx, type);
    const journal = await writeJournal(ctx, tx, record, actor, input.journal, input.takeOver === true, problems);
    return { action: "created", record, problems, ...(hints.length > 0 ? { hints } : {}), journal };
  });
}

/** Change one of the person's records by id, from `actor`. */
export async function changeRecord(ctx: ServiceContext, existing: LifeAdminRecord, actor: Actor, input: ChangeInput): Promise<ChangeOutcome> {
  return inTx(ctx.db, async (tx) => {
    await tx.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [ctx.userId]);
    const fresh = await getRecordForUser(tx, ctx.userId, existing.id, ctx.dek);
    if (!fresh) return { action: "refused", reason: "No such record for this person.", problems: [] };
    const type = input.type ?? typeOf(ctx.catalogue, fresh);
    const normalised: NormalisedFields = input.raw
      ? { fields: { ...input.set } as Record<string, string>, dueDate: null, problems: [] }
      : normaliseFields(type, input.set, input.dueDate != null, { fromAgent: actor.kind === "agent", zone: ctx.zone }, input.details ?? []);
    const problems = [...normalised.problems];
    const parentId = await checkedParent(ctx, tx, type, input.parentId, problems);
    // A record saved before kinds existed keeps taking the free-form status it always did.
    const rawStatus = input.status !== undefined && !statusFor(type, input.status) && !fresh.type && input.type === undefined ? input.status : undefined;
    const onlyJournal = Object.keys(input.set).length === 0 && !input.remove?.length && input.dueDate === undefined && input.status === undefined && input.parentId === undefined && !input.type && !input.details?.length && !input.replace;
    const changed = onlyJournal
      ? { action: "unchanged" as const, record: fresh }
      : await applyChange(ctx, tx, fresh, actor, type, normalised, {
        remove: input.remove ?? [],
        replace: input.replace === true,
        dueDate: input.dueDate,
        ...(rawStatus !== undefined ? { rawStatus } : { statusWord: input.status }),
        parentId: parentId === undefined ? undefined : parentId,
        foundIn: input.foundIn,
        retype: input.type !== undefined && input.type.id !== fresh.type,
        keepUntyped: input.raw === true,
      }, problems);
    const journal = await writeJournal(ctx, tx, changed.record, actor, input.journal, input.takeOver === true, problems);
    return { ...changed, problems, journal };
  });
}

/** The person accepts an agent's pending change: it is applied and the record stays theirs. */
export async function acceptPendingChange(ctx: ServiceContext, id: string): Promise<LifeAdminRecord | null> {
  return inTx(ctx.db, async (tx) => {
    const record = await getRecordForUser(tx, ctx.userId, id, ctx.dek);
    if (!record?.pending) return null;
    const { pending } = record;
    // A change that moves an older record into its kind (or a record into another kind) is
    // applied as that kind, provided the person's catalogue still has it.
    const movedTo = pending.type !== undefined ? ctx.catalogue.type(pending.type) : undefined;
    const type = movedTo ?? typeOf(ctx.catalogue, record);
    const fields: Record<string, unknown> = { ...record.fields, ...pending.set };
    for (const key of pending.remove) delete fields[key];
    const dueDate = pending.dueDate !== undefined ? pending.dueDate : record.dueDate;
    const status = pending.status ?? record.status;
    const state = pending.state !== undefined ? pending.state : record.state;
    const parentId = pending.parentId !== undefined ? pending.parentId : record.parentId;
    const updated = await updateRecord(
      tx,
      {
        userId: ctx.userId,
        id,
        fields,
        ...(pending.dueDate !== undefined ? { dueDate: pending.dueDate } : {}),
        status,
        ...(pending.state !== undefined ? { state: pending.state } : {}),
        ...(movedTo ? { type: movedTo.id } : {}),
        ...(pending.parentId !== undefined ? { parentId: pending.parentId } : {}),
        remindUntil: remindUntilOf(type, status, state, dueDate),
        ...(pending.foundIn ? { foundIn: pending.foundIn } : {}),
        matchKeys: matchKeysOf(ctx, type, fields, parentId),
        reviewState: "confirmed",
        changedBy: { kind: "person" },
        clearPending: true,
      },
      ctx.dek,
    );
    await writeChange(ctx, tx, id, { kind: "person" }, { event: "accepted", fields: fieldChanges(type, record.fields, pending.set, pending.remove) });
    return updated;
  });
}

/** The person keeps their own values: the pending change is dropped. */
export async function declinePendingChange(ctx: ServiceContext, id: string): Promise<boolean> {
  return inTx(ctx.db, async (tx) => {
    const result = await tx.query(
      "UPDATE life_admin_records SET pending = NULL WHERE id = $1 AND user_id = $2 AND pending IS NOT NULL RETURNING id",
      [id, ctx.userId],
    );
    if (result.rows.length === 0) return false;
    await writeChange(ctx, tx, id, { kind: "person" }, { event: "declined" });
    return true;
  });
}

/** The person confirms an agent's suggestion (and so keeps its suggested category). */
export async function confirmRecordFor(ctx: ServiceContext, id: string): Promise<boolean> {
  return inTx(ctx.db, async (tx) => {
    const record = await getRecordForUser(tx, ctx.userId, id, ctx.dek);
    if (!record || !(await confirmRecord(tx, ctx.userId, id))) return false;
    await writeChange(ctx, tx, id, { kind: "person" }, { event: "confirmed" });
    await keepIfSuggested(ctx, tx, typeOf(ctx.catalogue, record));
    return true;
  });
}

/** The person (or an agent, through its tools) adds journal entries without changing fields. */
export async function addJournal(ctx: ServiceContext, record: LifeAdminRecord, actor: Actor, journal: JournalInput): Promise<{ journal: JournalResult; problems: string[] }> {
  return inTx(ctx.db, async (tx) => {
    const problems: string[] = [];
    const result = await writeJournal(ctx, tx, record, actor, journal, false, problems);
    return { journal: result, problems };
  });
}

/** The person asks an agent to handle a live item, or clears who is handling it. */
export async function setStewardFor(ctx: ServiceContext, record: LifeAdminRecord, agentId: string | null): Promise<boolean> {
  return inTx(ctx.db, async (tx) => {
    const names = await agentNames(tx, ctx.userId);
    if (agentId && !names.connected(agentId)) return false;
    if (!(await setSteward(tx, ctx.userId, record.id, agentId ? { agentId, setBy: "person", since: ctx.now } : null))) return false;
    await writeChange(ctx, tx, record.id, { kind: "person" }, {
      event: "steward",
      ...(record.steward ? { from: names.name(record.steward.agentId) } : {}),
      ...(agentId ? { to: names.name(agentId) } : {}),
    });
    return true;
  });
}

/**
 * The person declines one of their own (suggested or kept) categories: its suggested records
 * become tombstones (so a later scan doesn't bring them back), anything they had confirmed moves to
 * "Something else" with its fields kept, and the category leaves a tombstone of its label so the
 * same suggestion isn't accepted again.
 */
export async function declineCustomCategory(ctx: ServiceContext, slug: string): Promise<{ declined: boolean; removed: number; moved: number }> {
  return inTx(ctx.db, async (tx) => {
    await tx.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [ctx.userId]);
    if (!ctx.catalogue.category(slug) || ctx.catalogue.category(slug)!.origin !== "custom") return { declined: false, removed: 0, moved: 0 };
    let removed = 0;
    let moved = 0;
    const other = ctx.catalogue.type("other.item")!;
    for (const record of await listRecordsForUser(tx, ctx.userId, ctx.dek)) {
      if (!record.type?.startsWith(`${slug}.`)) continue;
      if (record.reviewState === "suggested") {
        if (await dismissRecordRow(tx, ctx.userId, record.id, ctx.dek)) removed += 1;
      } else {
        await updateRecord(tx, {
          userId: ctx.userId, id: record.id, fields: record.fields, status: record.status, type: other.id,
          matchKeys: [], parentId: null, changedBy: { kind: "person" },
        }, ctx.dek);
        await writeChange(ctx, tx, record.id, { kind: "person" }, { event: "updated", fields: [{ key: "type", label: "Kind", to: other.label }] });
        moved += 1;
      }
    }
    const declined = await declineCategory(tx, ctx.userId, slug, ctx.dek, { now: () => ctx.now });
    return { declined, removed, moved };
  });
}
