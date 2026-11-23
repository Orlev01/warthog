import { validTaskAssignee } from "../../../../server/db/task-handoffs";
// E14-S13 — Life-admin page loader + actions (the injectable, unit-testable seam the
// thin `page.tsx` composes — the convention's `createXActions(deps)` factory, as
// `skills/actions.ts`, `vault/actions.ts`, `connectors/actions.ts` and
// `settings/security/actions.ts` do). A Next entry file may export only its framework
// fields, so the Life Admin triad logic lives here and the entry stays thin (OBS-025).
//
// The Life Admin triad is the "Life admin" / "Tasks and hand-offs" / "Moving-house
// helper" surface (brief; design §4.1; CLAUDE.md). `load` reads the SESSION person's
// records, moving checklist and tasks server-side — content DECRYPTED under their own
// DEK, each task's assignee + note authors resolved to the agent's display name — and
// shapes them into the props the already-render-tested <LifeAdminView/> (E14-S11) and
// <TasksView/> (E14-S12) are mounted over. The actions save / edit records, attach a
// receipt file (encrypted on the server), set reminders, tick off / hand off / rebuild
// the moving checklist, and create / assign / annotate / complete tasks.
//
// Security (each a reviewer veto; CLAUDE.md + the safety invariants):
//   • Every read/write is member-scoped by `session.userId` — the session's verified
//     id, NEVER a userId smuggled in the input. `load` reads only the session person;
//     every mutation is scoped `WHERE … AND user_id = $N` (or refused up front when the
//     row/agent is not theirs), so another person's record / task / checklist is never
//     read, changed or removed by id (a safe refusal, never a silent write).
//   • Input is validated at the boundary (INV-102): a malformed / oversized / unknown
//     shape is refused with a 4xx `HttpError` BEFORE any query, so nothing is written. A
//     malformed id (not a well-formed uuid — a bare integer, a negative, a decimal, "",
//     whitespace, a SQL-shaped id) is rejected at the boundary (OBS-049) before it can
//     reach `WHERE id = $1` as a cast. Every value reaches storage bound as a query
//     parameter (and the content is additionally DEK-encrypted first), so a value shaped
//     like SQL is stored as data and cannot alter a query.
//   • attachReceiptFile DUCK-TYPES the upload (`typeof name === "string" && typeof size
//     === "number"`, NEVER `instanceof File` — OBS-052: instanceof fails across the
//     undici/global realm split) and stores ONLY DEK-encrypted ciphertext through the
//     receipt-file store (the plaintext bytes never land in the blob).
//   • handChecklistItemToAgent creates a task (assigned to the named OWN agent, or
//     'any') and LINKS it to the item; a foreign / nonexistent agent is refused and
//     nothing is created or linked.
//   • This module reads no `process.env` and holds no secret (INV-103): db, keyWrapper,
//     clock and blob are INJECTED seams, so no ambient env value can surface in the
//     loaded screen or a stored row.
//
// Typed records (docs/adr/life-admin-profile.md): the person adds a record of a catalogue
// type and edits one through the record service (`saveTypedRecord` / `changeRecord`, actor
// "person"), so their values are normalised the same way an agent's are. Before anything is
// saved, the person's input is checked for identifiers Warthog never keeps (tax file numbers,
// passwords and PINs, BSB and account numbers, passport, licence and Medicare numbers …) and
// refused with the field's name — never its value. An edit sends only what changed, removes
// what the person cleared, and never touches a value an older agent saved as a list or
// object (engineering finding M4). The person confirms an agent's suggestion, says it isn't
// theirs (a tombstone, so it isn't added again), or accepts or declines an agent's change.

import { z } from "zod";
import { recordDueDateSchema, reminderOffsetsSchema } from "@/domain/life-admin/record-metadata";
import { RECEIPT_MAX_BYTES } from "@/lib/receipt-upload";

import { HttpError, parseParams } from "@/server/http/validate";
import type { Db } from "@/server/db/index";
import type { Session } from "@/server/auth/session";
import type { KeyWrapper } from "@/server/crypto/key-wrapper";
import type { Clock } from "@/server/seams/clock";
import type { BlobStore } from "@/server/storage/blob";
import { getUserById } from "@/server/db/users";
import { getAgentById, listAgentsForUser } from "@/server/db/agents";
import {
  confirmRecord as confirmRecordRow,
  getRecordForUser,
  type LifeAdminRecord,
  type PendingChange,
  type RecordFoundIn,
  type RecordSource,
} from "@/server/db/life-admin-records";
import {
  RECORD_STATUSES,
  acceptPendingChange,
  changeRecord,
  declinePendingChange,
  saveTypedRecord,
  typeOf,
} from "@/server/life-admin/record-service";
import { findForbidden, type IdentifierRule } from "@/domain/life-admin/identifiers";
import { normaliseFields } from "@/domain/life-admin/normalise";
import { recordType, type RecordTypeDef } from "@/domain/life-admin/record-types";
import { cleanShortText } from "@/domain/content/untrusted";
import { fieldLabel, typedFieldLabel } from "@/components/life-admin/record-format";
import {
  createTask as createTaskRow,
  updateTask as updateTaskRow,
  addNote as addNoteRow,
  completeTask as completeTaskRow,
  type Task,
  type TaskActor,
} from "@/server/db/tasks";
import {
  listForUser as listChecklistForUser,
  toggleDone,
  linkTask,
  type ChecklistItem,
} from "@/server/db/moving-checklist";
import { saveReceiptFile, deleteRecordWithFiles, dismissRecordWithFiles } from "@/server/storage/receipt-files";
import { buildMovingChecklist } from "@/server/moving/checklist";
import { lifeAdminPageData } from "@/server/life-admin/page-data";
import { periodKeyFor } from "@/server/db/card-spend-ledger";
import { timeZoneFor } from "@/server/spending/time-zone";
import { formatAccountTime } from "@/domain/display-time";

import type {
  LifeAdminRecordView,
  ChecklistItemView,
  PendingChangeView,
  RecordActorView,
  RecordFoundInView,
} from "@/components/life-admin/life-admin-view";
import type {
  AgentOption,
  TaskActorView,
  TaskAssigneeView,
  TaskItemView,
} from "@/components/life-admin/tasks-view";

// The injected seams — no process.env, no secret (INV-103). `db` is the parameterizing
// database seam; `keyWrapper` unwraps the session person's own DEK (users.wrapped_dek)
// so content round-trips decrypted/encrypted; `clock` supplies `now` to the
// moving-checklist builder (never SQL now()); `blob` is the private blob the
// receipt-file store puts ciphertext into.
export interface LifeAdminActionsDeps {
  readonly db: Db;
  readonly keyWrapper: KeyWrapper;
  readonly clock: Clock;
  readonly blob: BlobStore;
}

// What `load` returns — ALL of the session person's live records (fields decrypted; text
// values as strings, anything else summarised read-only; who added and changed each one
// resolved to an agent's name), moving checklist and tasks (titles/notes decrypted,
// assignee + note authors resolved to agent display names), plus the person's agents —
// shaped into the props <LifeAdminView/> + <TasksView/> are mounted over. `today` is the
// person's local date (YYYY-MM-DD in their account time zone, from the injected clock):
// what is overdue or coming up is worked out against it, so the view never reads the clock.
export interface LifeAdminPageData {
  readonly today: string;
  readonly records: LifeAdminRecordView[];
  readonly checklist: ChecklistItemView[];
  readonly tasks: TaskItemView[];
  readonly agents: AgentOption[];
}

// Every mutation reports its outcome — success, or a refusal naming its reason (the
// row/agent is not this person's). Never a silent success (conventions: a server action
// reports success, the refusal reason, or a 4xx). A record save also says what happened
// (created, or the person already had it and it was updated) and whether anything was left
// out; a refusal for an identifier Warthog never keeps names the rule and the field's label,
// never the value.
export type RecordRefusal = { readonly rule: IdentifierRule; readonly field: string };
export type ActionResult =
  | {
      readonly ok: true;
      readonly outcome?: "created" | "updated" | "unchanged" | "confirmed";
      readonly recordId?: string;
      readonly count?: number;
      readonly problems?: readonly string[];
    }
  | { readonly ok: false; readonly reason: string; readonly refusal?: RecordRefusal };

// ---- boundary validation (INV-102) -------------------------------------------------
//
// Field caps mirror the sibling MCP records/tasks tools so a grossly oversized value is
// refused at the boundary before any db access. Ids are uuids (life_admin_records /
// tasks / moving_checklist all gen_random_uuid()), shape-guarded so a non-uuid never
// reaches `WHERE id = $1` as a cast (OBS-049).
const MAX_STATUS = 200;
const MAX_FIELDS_CHARS = 100_000;
const MAX_TITLE = 2000;
const MAX_NOTE = 4000;
export const MAX_FILE_BYTES = RECEIPT_MAX_BYTES;

const uuid = z.uuid();
const MAX_IDS = 500;
// A record type from the catalogue ("vehicle.registration"); anything else is a 4xx.
const recordTypeId = z.string().max(80).refine((id) => recordType(id) !== undefined, "Unknown record type");
const taskStatus = z.enum(["open", "in_progress", "done"]);
// The assignee the view offers: 'any', or one of the person's own agents (a uuid).
const assignee = z.union([z.literal("any"), z.uuid()]);
// A record's fields blob: an object of arbitrary values, capped on its serialised size.
const fields = z
  .record(z.string(), z.unknown())
  .refine((value) => JSON.stringify(value).length <= MAX_FIELDS_CHARS);
const status = z.string().max(MAX_STATUS).optional();
const dueDate = recordDueDateSchema.optional().nullable();
const reminderOffsets = reminderOffsetsSchema;

const recordStatus = z.enum(RECORD_STATUSES).optional();
const parentId = uuid.nullable().optional();
const saveRecordSchema = z.object({ type: recordTypeId, fields, dueDate, status: recordStatus, parentId });
const updateRecordSchema = z.object({ id: uuid, fields, dueDate, status, parentId });
const idsSchema = z.object({ ids: z.array(uuid).min(1).max(MAX_IDS) });
const setRemindersSchema = z.object({ id: uuid, reminderOffsets });
const attachRecordSchema = z.object({ recordId: uuid });
const idOnlySchema = z.object({ id: uuid });
const handSchema = z.object({ id: uuid, agentId: uuid.optional() });
// A title or note is trimmed before it is checked, so one made only of spaces is refused at
// the boundary (a 4xx) instead of being saved as a blank task or note.
const createTaskSchema = z.object({ title: z.string().trim().min(1).max(MAX_TITLE), assignee: assignee.optional() });
const updateTaskSchema = z.object({
  id: uuid,
  title: z.string().trim().min(1).max(MAX_TITLE),
  assignee,
  status: taskStatus,
});
const assignTaskSchema = z.object({ id: uuid, assignee });
const addNoteSchema = z.object({ id: uuid, text: z.string().trim().min(1).max(MAX_NOTE) });

// ---- the method input types (so the factory's shape is precise) --------------------

// A new record of a catalogue type, from the Add form: the type's fields (empty ones are
// ignored), its due date, status and the vehicle, home or pet it belongs to.
export interface SaveRecordInput {
  readonly type: string;
  readonly fields: Record<string, unknown>;
  readonly dueDate?: string | null;
  readonly status?: string;
  readonly parentId?: string | null;
}
// An edit from the Edit form: every field the form showed, as submitted. A changed value is
// set, an emptied one removed and an unchanged one left alone. An omitted due date, status
// or parent keeps the stored one; `null` clears the date or the link.
export interface UpdateRecordInput {
  readonly id: string;
  readonly fields: Record<string, unknown>;
  readonly dueDate?: string | null;
  readonly status?: string;
  readonly parentId?: string | null;
}
export interface IdsInput {
  readonly ids: readonly string[];
}
export interface AttachReceiptFileInput {
  readonly recordId: string;
  readonly file: unknown;
}
export interface SetRemindersInput {
  readonly id: string;
  readonly reminderOffsets: number[];
}
export interface IdInput {
  readonly id: string;
}
export interface HandToAgentInput {
  readonly id: string;
  readonly agentId?: string;
}
export interface CreateTaskInput {
  readonly title: string;
  readonly assignee?: string;
}
export interface UpdateTaskInput {
  readonly id: string;
  readonly title: string;
  readonly assignee: string;
  readonly status: z.infer<typeof taskStatus>;
}
export interface AssignTaskInput {
  readonly id: string;
  readonly assignee: string;
}
export interface AddTaskNoteInput {
  readonly id: string;
  readonly text: string;
}

export interface LifeAdminActions {
  load(session: Session): Promise<LifeAdminPageData>;
  saveRecord(session: Session, input: SaveRecordInput): Promise<ActionResult>;
  updateRecord(session: Session, input: UpdateRecordInput): Promise<ActionResult>;
  attachReceiptFile(session: Session, input: AttachReceiptFileInput): Promise<ActionResult>;
  deleteRecord(session: Session, input: IdInput): Promise<ActionResult>;
  confirmRecord(session: Session, input: IdInput): Promise<ActionResult>;
  confirmAll(session: Session, input: IdsInput): Promise<ActionResult>;
  dismissRecord(session: Session, input: IdInput): Promise<ActionResult>;
  acceptPending(session: Session, input: IdInput): Promise<ActionResult>;
  declinePending(session: Session, input: IdInput): Promise<ActionResult>;
  setRecordReminders(session: Session, input: SetRemindersInput): Promise<ActionResult>;
  toggleChecklistItem(session: Session, input: IdInput): Promise<ActionResult>;
  handChecklistItemToAgent(session: Session, input: HandToAgentInput): Promise<ActionResult>;
  refreshMovingChecklist(session: Session): Promise<ActionResult>;
  createTask(session: Session, input: CreateTaskInput): Promise<ActionResult>;
  updateTask(session: Session, input: UpdateTaskInput): Promise<ActionResult>;
  completeTask(session: Session, input: IdInput): Promise<ActionResult>;
  assignTask(session: Session, input: AssignTaskInput): Promise<ActionResult>;
  addTaskNote(session: Session, input: AddTaskNoteInput): Promise<ActionResult>;
}

// An upload is accepted by DUCK-TYPING, never `instanceof File` (OBS-052): it carries a
// string `name`, a numeric `size` and an `arrayBuffer()` to read its bytes.
interface UploadLike {
  readonly name: string;
  readonly size: number;
  readonly type?: string;
  arrayBuffer(): Promise<ArrayBuffer>;
}
function isUploadLike(file: unknown): file is UploadLike {
  if (typeof file !== "object" || file === null) return false;
  const f = file as { name?: unknown; size?: unknown; arrayBuffer?: unknown };
  return typeof f.name === "string" && typeof f.size === "number" && typeof f.arrayBuffer === "function";
}

// ---- typed records: shaping for the view, and the person's input --------------------

const PERSON: RecordSource = { kind: "person" };

const FORMER_AGENT = "an agent that is no longer connected";
const MAX_HELD_SUMMARY = 300;

// An agent's display name as the provenance line uses it. A name that would read as the
// person or as Warthog itself ("you", "Warthog") is quoted, so an agent can never pass its
// own record off as the person's.
function agentName(names: ReadonlyMap<string, string>, agentId: string): string {
  const name = names.get(agentId);
  if (!name) return FORMER_AGENT;
  return /^(you|yourself|me|the person|warthog)$/i.test(name.replace(/[^\p{L}\p{N} ]/gu, "").trim())
    ? `an agent called \u201c${name}\u201d`
    : name;
}

function actorView(source: RecordSource | null, names: ReadonlyMap<string, string>): RecordActorView | null {
  if (!source) return null;
  return source.kind === "agent" ? { kind: "agent", agentId: source.agentId, name: agentName(names, source.agentId) } : { kind: "person" };
}

// Where an agent says it found something, cleaned for display (it is the agent's text).
function foundInView(foundIn: RecordFoundIn | null | undefined): RecordFoundInView | null {
  if (!foundIn) return null;
  return {
    service: cleanShortText(String(foundIn.service ?? ""), 80),
    ...(foundIn.sender ? { sender: cleanShortText(String(foundIn.sender), 120) } : {}),
    ...(foundIn.date ? { date: cleanShortText(String(foundIn.date), 40) } : {}),
    seenByWarthog: foundIn.seenByWarthog === true,
  };
}

function pendingView(pending: PendingChange | null, names: ReadonlyMap<string, string>): PendingChangeView | null {
  if (!pending) return null;
  const set: Record<string, string> = {};
  for (const [key, value] of Object.entries(pending.set ?? {})) set[key] = value == null ? "" : String(value);
  return {
    byName: agentName(names, pending.byAgentId),
    set,
    remove: [...(pending.remove ?? [])],
    ...(pending.dueDate !== undefined ? { dueDate: pending.dueDate } : {}),
    ...(pending.status !== undefined ? { status: pending.status } : {}),
    foundIn: foundInView(pending.foundIn),
  };
}

function scalarText(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "yes" : "no";
  return null;
}

// A value an older agent saved as a list or an object, summarised for reading only.
function heldSummary(value: object): string {
  const text = Array.isArray(value)
    ? value.map((item) => scalarText(item) ?? "…").join(", ")
    : Object.entries(value).map(([key, item]) => `${fieldLabel(key)}: ${scalarText(item) ?? "…"}`).join("; ");
  return text.length > MAX_HELD_SUMMARY ? `${text.slice(0, MAX_HELD_SUMMARY - 1)}…` : text || "…";
}

// The fields the person filled in on the Add form: empty ones dropped, text trimmed.
function filledFields(raw: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const filled: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    const text = typeof value === "string" ? value.trim() : value;
    if (text === "" || text === null || text === undefined) continue;
    filled[key] = text;
  }
  return filled;
}

// The first identifier Warthog never keeps among `fields`, named by the type's label for
// the field — never its value.
function refusalFor(type: RecordTypeDef, fields: Readonly<Record<string, unknown>>): RecordRefusal | null {
  const [finding] = findForbidden(fields, type.id);
  return finding ? { rule: finding.rule, field: typedFieldLabel(type, finding.field) } : null;
}

/**
 * What an Edit form submission changes on `current`: each value the person changed (set),
 * each one they emptied (remove). An unchanged value is left out, so normalising never
 * rewrites what the person didn't touch, and a stored list or object is never replaced from
 * a form (M4). A changed detail saved under another name that now lands on one of the
 * type's own fields ("service" → "provider") moves there instead of being kept twice.
 */
export function editChanges(
  type: RecordTypeDef,
  current: Readonly<Record<string, unknown>>,
  submitted: Readonly<Record<string, unknown>>,
): { set: Record<string, unknown>; remove: string[] } {
  const set: Record<string, unknown> = {};
  const remove: string[] = [];
  for (const [key, raw] of Object.entries(submitted)) {
    const stored = Object.hasOwn(current, key) ? current[key] : undefined;
    if (stored !== null && typeof stored === "object") continue;
    const value = typeof raw === "string" ? raw.trim() : raw;
    const storedText = stored === undefined || stored === null ? "" : String(stored).trim();
    if (value === "" || value === null || value === undefined) {
      if (storedText !== "") remove.push(key);
      continue;
    }
    if (storedText === String(value)) continue;
    set[key] = value;
    const landed = Object.keys(normaliseFields(type, { [key]: value }, true, { fromAgent: false }).fields);
    if (stored !== undefined && landed.length === 1 && landed[0] !== key) remove.push(key);
  }
  return { set, remove };
}

export function createLifeAdminActions(deps: LifeAdminActionsDeps): LifeAdminActions {
  const { db, keyWrapper, clock, blob } = deps;

  // Resolve the session person's unwrapped 256-bit DEK: read their wrapped DEK (bound by
  // userId) and unwrap it through the injected KeyWrapper. Throws when the person has no
  // row (never fails silently) — the page-data idiom shared with the siblings.
  async function dataKeyFor(userId: string): Promise<Uint8Array> {
    const user = await getUserById(db, userId);
    if (!user) {
      throw new Error("createLifeAdminActions: no data key for this user");
    }
    return keyWrapper.unwrap(user.wrappedDek);
  }

  // Whether this person owns the record / task with this id (member-scoped: id AND
  // user_id bound). Used to refuse a cross-user mutation up front — a reported
  // { ok: false }, never letting the store throw a raw 500.
  async function ownsRow(table: "life_admin_records" | "tasks", userId: string, id: string): Promise<boolean> {
    const result = await db.query(`SELECT id FROM ${table} WHERE id = $1 AND user_id = $2`, [id, userId]);
    return result.rows.length > 0;
  }

  // Resolve the display name of one of the person's own agents (from the already-read
  // list), falling back to a neutral label so the view never renders a raw id.
  function nameOf(agents: ReadonlyArray<{ id: string; displayName: string }>, id: string): string {
    return agents.find((a) => a.id === id)?.displayName ?? "an agent";
  }

  // One record as the view renders it: text values as strings; a list or object an older
  // agent saved summarised read-only in `heldFields` (never "[object Object]", never put back
  // into a form); who added and last changed it, and where an agent says it found it,
  // resolved for display; an agent's waiting change with its agent's name.
  function toRecordView(
    record: LifeAdminRecord,
    hasAttachedFile: boolean,
    names: ReadonlyMap<string, string>,
    files: { id: string; size: number }[] = [],
  ): LifeAdminRecordView {
    const display: Record<string, string> = {};
    const held: Record<string, string> = {};
    for (const [key, value] of Object.entries(record.fields)) {
      if (value !== null && typeof value === "object") held[key] = heldSummary(value);
      else display[key] = value == null ? "" : String(value);
    }
    const pending = pendingView(record.pending, names);
    const foundIn = foundInView(record.foundIn);
    const changedBy = actorView(record.changedBy, names);
    return {
      id: record.id,
      kind: record.kind,
      type: record.type,
      fields: display,
      ...(Object.keys(held).length ? { heldFields: held } : {}),
      dueDate: record.dueDate == null ? null : String(record.dueDate).slice(0, 10),
      status: record.status,
      reminderOffsets: record.reminderOffsets,
      hasAttachedFile,
      ...(files.length ? { files } : {}),
      reviewState: record.reviewState === "suggested" ? "suggested" : "confirmed",
      parentId: record.parentId,
      addedBy: actorView(record.source, names) ?? { kind: "person" },
      ...(changedBy ? { changedBy } : {}),
      ...(foundIn ? { foundIn } : {}),
      ...(pending ? { pending } : {}),
    };
  }

  function toChecklistView(item: ChecklistItem): ChecklistItemView {
    return { id: item.id, label: item.label, done: item.done, linkedTaskId: item.linkedTaskId };
  }

  function toActorView(actor: TaskActor, agents: ReadonlyArray<{ id: string; displayName: string }>): TaskActorView {
    return actor.kind === "agent"
      ? { kind: "agent", agentId: actor.agentId, agentName: nameOf(agents, actor.agentId) }
      : { kind: "person" };
  }

  function toAssigneeView(
    assigneeId: string,
    agents: ReadonlyArray<{ id: string; displayName: string }>,
  ): TaskAssigneeView {
    return assigneeId === "any"
      ? { kind: "any" }
      : { kind: "agent", agentId: assigneeId, agentName: nameOf(agents, assigneeId) };
  }

  // A claim's expiry is worded in the person's own time zone ("12 Nov 2026, 6:17 pm"), never
  // as a raw UTC timestamp; the ISO instant is kept for the <time> element.
  function toTaskView(task: Task, agents: ReadonlyArray<{ id: string; displayName: string }>, timeZone?: string): TaskItemView {
    return {
      id: task.id,
      title: task.title,
      notes: task.notes.map((note) => ({ author: toActorView(note.author, agents), text: note.text })),
      assignee: toAssigneeView(task.assignee, agents),
      status: task.status,
      ...(task.claimedBy
        ? { claim: { agentName: nameOf(agents, task.claimedBy), expiresAt: task.claimExpiresAt!, until: formatAccountTime(task.claimExpiresAt!, timeZone) } }
        : {}),
    };
  }

  // Read ONLY the session person's records / checklist / tasks (member-scoped by
  // `session.userId`), decrypted under their own DEK, shaped into the two views' props.
  // The owner-scoped list-all read is the dedicated E14-S10 `lifeAdminPageData` — it
  // composes the stores, groups the records by kind and flags each receipt that carries
  // a saved file (metadata only, never the file bytes). We reuse it as the ONE source of
  // truth for the page read and only map its output onto the views' props here (fields
  // stringified for display, assignee + note authors resolved to agent names); another
  // person's content never appears.
  async function load(session: Session): Promise<LifeAdminPageData> {
    const userId = session.userId;
    const dek = await dataKeyFor(userId);
    const page = await lifeAdminPageData(db, userId, dek);
    const fileRows = await db.query("SELECT id, record_id, size FROM receipt_files WHERE user_id=$1 ORDER BY id", [userId]);
    const filesFor = (id: string) => fileRows.rows.filter((r) => r.record_id === id).map((r) => ({ id: r.id as string, size: Number(r.size) }));
    const agents = await listAgentsForUser(db, userId);
    const names = new Map(agents.map((agent) => [agent.id, cleanShortText(agent.displayName, 80)] as const));
    // "Today" is the person's own local day (the same derivation Home uses), not UTC.
    const timeZone = await timeZoneFor(db, userId, dek);
    const today = periodKeyFor("day", clock.now(), timeZone);

    return {
      today,
      records: page.records.map((r) => toRecordView(r, r.hasAttachedFile, names, filesFor(r.id))),
      checklist: page.checklist.map(toChecklistView),
      tasks: page.tasks.map((t) => toTaskView(t, agents, timeZone)),
      agents: agents.map((a) => ({ id: a.id, name: a.displayName })),
    };
  }

  // Add a record of a catalogue type for the session person, through the record service
  // (actor "person", so it is confirmed and its values normalised like an agent's). Validate
  // at the boundary first (an unknown type is a 4xx before any write); refuse an identifier
  // Warthog never keeps, naming the field; refuse a form with nothing filled in. The owner
  // is the session's id, so a userId smuggled in the input is ignored. A record matching one
  // the person already has (the same plate, the same insurer and policy) updates it.
  async function saveRecord(session: Session, input: SaveRecordInput): Promise<ActionResult> {
    const valid = parseParams(saveRecordSchema, input);
    const type = recordType(valid.type)!;
    const filled = filledFields(valid.fields);
    const refusal = refusalFor(type, filled);
    if (refusal) return { ok: false, reason: "forbidden", refusal };
    if (Object.keys(filled).length === 0 && !valid.dueDate) return { ok: false, reason: "empty" };
    const dek = await dataKeyFor(session.userId);
    const saved = await saveTypedRecord(
      db,
      dek,
      session.userId,
      PERSON,
      { type, fields: filled, dueDate: valid.dueDate ?? null, status: valid.status, parentId: valid.parentId },
      clock.now(),
    );
    const problems = saved.problems;
    if (saved.action === "skipped") {
      return { ok: true, outcome: "unchanged", ...(saved.record ? { recordId: saved.record.id } : {}), problems };
    }
    return { ok: true, outcome: saved.action === "proposed" ? "updated" : saved.action, recordId: saved.record.id, problems };
  }

  // Edit an OWNED record from the Edit form, through the record service (actor "person").
  // Validate at the boundary first (a malformed id is a 4xx before any query), read the
  // record member-scoped (id AND user_id bound — another person's record is refused and left
  // unchanged), then change only what the person changed (editChanges), refusing an
  // identifier Warthog never keeps. An omitted due date, status or parent keeps the stored
  // one. The person's edit confirms an agent's suggestion — even one that changed nothing.
  async function updateRecord(session: Session, input: UpdateRecordInput): Promise<ActionResult> {
    const valid = parseParams(updateRecordSchema, input);
    const dek = await dataKeyFor(session.userId);
    const existing = await getRecordForUser(db, session.userId, valid.id, dek);
    if (!existing) return { ok: false, reason: "not_found" };
    const type = typeOf(existing);
    const { set, remove } = editChanges(type, existing.fields, valid.fields);
    const refusal = refusalFor(type, set);
    if (refusal) return { ok: false, reason: "forbidden", refusal };
    const changed = await changeRecord(
      db,
      dek,
      existing,
      PERSON,
      { set, remove, dueDate: valid.dueDate, status: valid.status, parentId: valid.parentId },
      clock.now(),
    );
    if (changed.action === "refused") return { ok: false, reason: "not_found" };
    if (changed.action === "unchanged" && existing.reviewState === "suggested") {
      await confirmRecordRow(db, session.userId, existing.id);
      return { ok: true, outcome: "confirmed", recordId: existing.id, problems: changed.problems };
    }
    return { ok: true, outcome: changed.action === "proposed" ? "updated" : changed.action, recordId: existing.id, problems: changed.problems };
  }

  // The person checked an agent's suggestion: it becomes theirs, and agents can no longer
  // change it without asking. Member-scoped; a record that is not this person's suggestion
  // (another person's, or one already confirmed) is refused.
  async function confirmRecord(session: Session, input: IdInput): Promise<ActionResult> {
    const { id } = parseParams(idOnlySchema, input);
    return (await confirmRecordRow(db, session.userId, id))
      ? { ok: true, outcome: "confirmed", recordId: id, count: 1 }
      : { ok: false, reason: "not_found" };
  }

  // Confirm several suggestions at once ("Confirm all"). Every id must be well formed (a 4xx
  // otherwise, before any write); each is confirmed member-scoped, so another person's id
  // changes nothing. Refused when none of them was one of this person's suggestions.
  async function confirmAll(session: Session, input: IdsInput): Promise<ActionResult> {
    const { ids } = parseParams(idsSchema, input);
    let count = 0;
    for (const id of new Set(ids)) if (await confirmRecordRow(db, session.userId, id)) count += 1;
    return count > 0 ? { ok: true, outcome: "confirmed", count } : { ok: false, reason: "not_found" };
  }

  // "Not mine": remove the record's files and leave a tombstone that keeps only its type and
  // match key, so an agent finding the same thing again doesn't add it back. Member-scoped.
  async function dismissRecord(session: Session, input: IdInput): Promise<ActionResult> {
    const { id } = parseParams(idOnlySchema, input);
    const dek = await dataKeyFor(session.userId);
    return (await dismissRecordWithFiles(db, blob, { userId: session.userId, recordId: id }, dek))
      ? { ok: true }
      : { ok: false, reason: "not_found" };
  }

  // Accept an agent's waiting change to one of the person's records: it is applied and the
  // record stays the person's. Refused when there is no such change on their record.
  async function acceptPending(session: Session, input: IdInput): Promise<ActionResult> {
    const { id } = parseParams(idOnlySchema, input);
    const dek = await dataKeyFor(session.userId);
    const record = await acceptPendingChange(db, dek, session.userId, id);
    return record ? { ok: true, outcome: "updated", recordId: id } : { ok: false, reason: "not_found" };
  }

  // Keep the person's own values: the agent's waiting change is dropped. Member-scoped.
  async function declinePending(session: Session, input: IdInput): Promise<ActionResult> {
    const { id } = parseParams(idOnlySchema, input);
    return (await declinePendingChange(db, session.userId, id)) ? { ok: true, recordId: id } : { ok: false, reason: "not_found" };
  }

  // Attach a receipt file to an OWNED record. Validate the id at the boundary (a 4xx
  // before any query), DUCK-TYPE the upload (a 4xx if it is not file-shaped — never
  // instanceof File), refuse up front when the record is not this person's (so nothing
  // is stored), then store ONLY DEK-encrypted ciphertext through the receipt-file store.
  async function attachReceiptFile(session: Session, input: AttachReceiptFileInput): Promise<ActionResult> {
    const { recordId } = parseParams(attachRecordSchema, input);
    const file = (input as { file?: unknown }).file;
    if (!isUploadLike(file)) {
      throw new HttpError(400, "A file upload is required");
    }
    if (file.size > MAX_FILE_BYTES) {
      throw new HttpError(413, "File too large");
    }
    if (file.size <= 0) throw new HttpError(400, "Choose a non-empty file");
    if (!(await ownsRow("life_admin_records", session.userId, recordId))) {
      return { ok: false, reason: "not_found" };
    }
    const dek = await dataKeyFor(session.userId);
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes.byteLength > MAX_FILE_BYTES) throw new HttpError(413, "File too large");
    await saveReceiptFile(
      db,
      blob,
      {
        userId: session.userId,
        recordId,
        contentType: typeof file.type === "string" && file.type ? file.type : "application/octet-stream",
        bytes,
      },
      dek,
    );
    return { ok: true };
  }

  // Change ONLY the OWNED record's reminder offsets (member-scoped: id AND user_id
  // bound), leaving the encrypted fields untouched. A record that is not this person's
  // matches nothing and is refused.
  async function setRecordReminders(session: Session, input: SetRemindersInput): Promise<ActionResult> {
    const valid = parseParams(setRemindersSchema, input);
    const result = await db.query(
      "UPDATE life_admin_records SET reminder_offsets = $3::int[] WHERE id = $1 AND user_id = $2 RETURNING id",
      [valid.id, session.userId, valid.reminderOffsets],
    );
    return result.rows.length > 0 ? { ok: true } : { ok: false, reason: "not_found" };
  }

  // Flip an OWNED checklist item's done flag (member-scoped). A malformed id is a 4xx
  // before any query; an item that is not this person's matches nothing and is refused.
  async function toggleChecklistItem(session: Session, input: IdInput): Promise<ActionResult> {
    const valid = parseParams(idOnlySchema, input);
    const toggled = await toggleDone(db, { userId: session.userId, id: valid.id });
    return toggled ? { ok: true } : { ok: false, reason: "not_found" };
  }

  // Hand an OWNED checklist item to an agent: create a task (assigned to the named own
  // agent, or 'any') and LINK it to the item. Validate at the boundary first; refuse —
  // creating and linking nothing — when the item is not this person's, or when a named
  // agent is not one of this person's own.
  async function handChecklistItemToAgent(session: Session, input: HandToAgentInput): Promise<ActionResult> {
    const valid = parseParams(handSchema, input);
    const dek = await dataKeyFor(session.userId);
    const item = (await listChecklistForUser(db, session.userId, dek)).find((i) => i.id === valid.id);
    if (!item) {
      return { ok: false, reason: "not_found" };
    }
    let assignTo = "any";
    if (valid.agentId !== undefined) {
      if (!(await validTaskAssignee(db, session.userId, valid.agentId))) {
        return { ok: false, reason: "unknown_agent" };
      }
      assignTo = valid.agentId;
    }
    const task = await createTaskRow(
      db,
      { userId: session.userId, title: item.label, assignee: assignTo, createdBy: { kind: "person" } },
      dek,
    );
    const linked = await linkTask(db, { userId: session.userId, id: item.id, taskId: task.id });
    return linked ? { ok: true } : { ok: false, reason: "not_found" };
  }

  // (Re)build the session person's moving checklist from a move on file (the builder
  // reads the postal addresses + places that hold the old address and seeds idempotently
  // through the store). With no move, nothing is seeded. Member-scoped by the session.
  async function refreshMovingChecklist(session: Session): Promise<ActionResult> {
    const dek = await dataKeyFor(session.userId);
    await buildMovingChecklist({ db, clock, dek }, session);
    return { ok: true };
  }

  // Open a new task for the session person (title DEK-encrypted by the store). Validate
  // at the boundary first; a specific assignee must be one of the person's own agents
  // (refused otherwise); the owner is the session's id, so a smuggled userId is ignored.
  async function createTask(session: Session, input: CreateTaskInput): Promise<ActionResult> {
    const valid = parseParams(createTaskSchema, input);
    let assignTo = "any";
    if (valid.assignee !== undefined && valid.assignee !== "any") {
      if (!(await validTaskAssignee(db, session.userId, valid.assignee))) {
        return { ok: false, reason: "unknown_agent" };
      }
      assignTo = valid.assignee;
    }
    const dek = await dataKeyFor(session.userId);
    await createTaskRow(
      db,
      { userId: session.userId, title: valid.title, assignee: assignTo, createdBy: { kind: "person" } },
      dek,
    );
    return { ok: true };
  }

  // Change an OWNED task's title, assignee and status together. Validate at the boundary
  // first (a malformed id is a 4xx before any query); a specific assignee must be the
  // person's own agent; a task that is not this person's is refused and left unchanged.
  async function updateTask(session: Session, input: UpdateTaskInput): Promise<ActionResult> {
    const valid = parseParams(updateTaskSchema, input);
    if (valid.assignee !== "any" && !(await validTaskAssignee(db, session.userId, valid.assignee))) {
      return { ok: false, reason: "unknown_agent" };
    }
    if (!(await ownsRow("tasks", session.userId, valid.id))) {
      return { ok: false, reason: "not_found" };
    }
    const dek = await dataKeyFor(session.userId);
    await updateTaskRow(
      db,
      { userId: session.userId, id: valid.id, title: valid.title, assignee: valid.assignee, status: valid.status },
      dek,
    );
    return { ok: true };
  }

  // Mark an OWNED task done (member-scoped). A malformed id is a 4xx before any query; a
  // task that is not this person's matches nothing and is refused.
  async function completeTask(session: Session, input: IdInput): Promise<ActionResult> {
    const valid = parseParams(idOnlySchema, input);
    const done = await completeTaskRow(db, { userId: session.userId, id: valid.id });
    return done ? { ok: true } : { ok: false, reason: "not_found" };
  }

  // Reassign an OWNED task (assignee is plaintext metadata, so no DEK is needed).
  // Validate at the boundary first; a specific assignee must be the person's own agent;
  // a task that is not this person's matches nothing and is refused.
  async function assignTask(session: Session, input: AssignTaskInput): Promise<ActionResult> {
    const valid = parseParams(assignTaskSchema, input);
    if (valid.assignee !== "any" && !(await validTaskAssignee(db, session.userId, valid.assignee))) {
      return { ok: false, reason: "unknown_agent" };
    }
    const result = await db.query(
      "UPDATE tasks SET assignee = $3, claimed_by = NULL, claim_expires_at = NULL WHERE id = $1 AND user_id = $2 RETURNING id",
      [valid.id, session.userId, valid.assignee],
    );
    return result.rows.length > 0 ? { ok: true } : { ok: false, reason: "not_found" };
  }

  // Append a person-authored note to an OWNED task (note DEK-encrypted by the store).
  // Validate at the boundary first; a task that is not this person's is refused and left
  // unchanged.
  async function addTaskNote(session: Session, input: AddTaskNoteInput): Promise<ActionResult> {
    const valid = parseParams(addNoteSchema, input);
    if (!(await ownsRow("tasks", session.userId, valid.id))) {
      return { ok: false, reason: "not_found" };
    }
    const dek = await dataKeyFor(session.userId);
    await addNoteRow(db, { userId: session.userId, id: valid.id, author: { kind: "person" }, text: valid.text }, dek);
    return { ok: true };
  }

  async function deleteRecord(session: Session, input: IdInput): Promise<ActionResult> {
    const { id } = parseParams(idOnlySchema, input);
    return await deleteRecordWithFiles(db, blob, { userId: session.userId, recordId: id })
      ? { ok: true } : { ok: false, reason: "not_found" };
  }

  return {
    load,
    deleteRecord,
    confirmRecord,
    confirmAll,
    dismissRecord,
    acceptPending,
    declinePending,
    saveRecord,
    updateRecord,
    attachReceiptFile,
    setRecordReminders,
    toggleChecklistItem,
    handChecklistItemToAgent,
    refreshMovingChecklist,
    createTask,
    updateTask,
    completeTask,
    assignTask,
    addTaskNote,
  };
}
