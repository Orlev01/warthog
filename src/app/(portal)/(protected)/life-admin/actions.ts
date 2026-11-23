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
// Typed records (docs/adr/life-admin-profile.md, life-admin-journal.md): the person adds a
// record of a kind from THEIR catalogue (built-in, or a category of their own) and edits one
// through the record service (`saveTypedRecord` / `changeRecord`, actor "person", with the
// person's time zone and the injected clock), so their values are normalised the same way an
// agent's are. Before anything is
// saved, the person's input is checked for identifiers Warthog never keeps (tax file numbers,
// passwords and PINs, BSB and account numbers, passport, licence and Medicare numbers …) and
// refused with the field's name — never its value. An edit sends only what changed, removes
// what the person cleared, and never touches a value an older agent saved as a list or
// object (engineering finding M4). The person confirms an agent's suggestion, says it isn't
// theirs (a tombstone, so it isn't added again), or accepts (one by one or all at once) or
// declines an agent's change.
// They keep or decline a category an agent suggested, show or hide a built-in one, add a note,
// decision or next step to an item's journal (refused when it holds an identifier Warthog
// never keeps, naming the place, never the text), mark a next step done, and say which agent is
// handling an item. Every one of these is audited like memory and rules
// (`auditedOwnerChange`), recording FIELD NAMES and ids only, never a value.

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
import { listAgentsForUser, type Agent } from "@/server/db/agents";
import {
  getRecordForUser,
  type LifeAdminRecord,
  type PendingChange,
  type RecordFoundIn,
  type RecordSource,
} from "@/server/db/life-admin-records";
import {
  acceptPendingChange,
  addJournal,
  changeRecord,
  confirmRecordFor,
  declineCustomCategory,
  declinePendingChange,
  saveTypedRecord,
  setStewardFor,
  typeOf,
  type ServiceContext,
} from "@/server/life-admin/record-service";
import { catalogueFor, type PersonCatalogue } from "@/server/life-admin/catalogue";
import { entryView, journalSummaries, stateWords, stewardOf, type JournalSummary } from "@/server/life-admin/journal-views";
import { keepCategory as keepCategoryRow, setBuiltInSetting } from "@/server/db/life-admin-categories";
import { listJournal, type JournalEntry } from "@/server/db/life-admin-journal";
import { auditedOwnerChange } from "@/server/activity/owner-change";
import type { SavedBy, SavedByResolver } from "@/server/agents/saved-by";
import { visibilityOf, type CatalogueData } from "@/domain/life-admin/catalogue";
import { SLUG_PATTERN } from "@/domain/life-admin/custom-category";
import { findForbidden, type IdentifierRule } from "@/domain/life-admin/identifiers";
import { actorName, changeText, currentDecisions, handoverLine, openNextSteps, shortDate, type JournalActor, type JournalEntryView } from "@/domain/life-admin/journal";
import { findForbiddenText, JOURNAL_TEXT_MAX } from "@/domain/life-admin/journal-text";
import { localDate, type PhaseView } from "@/domain/life-admin/lifecycle";
import { normaliseFields } from "@/domain/life-admin/normalise";
import { BUILT_IN_CATEGORIES, type RecordTypeDef } from "@/domain/life-admin/record-types";
import { cleanShortText } from "@/domain/content/untrusted";
import { fieldLabel, recordName, statusChoices, typedFieldLabel } from "@/components/life-admin/record-format";
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
import { lifeAdminPageData, recordPhases } from "@/server/life-admin/page-data";
import { formatAccountTime } from "@/domain/display-time";

import type {
  LifeAdminRecordView,
  ChecklistItemView,
  PendingChangeView,
  RecordActorView,
  RecordFoundInView,
} from "@/components/life-admin/life-admin-view";
import type {
  CategoryStateView,
  DoneStepView,
  HistoryDayView,
  JournalItemView,
  LifeAdminItemData,
  NextStepView,
  RecordHandlingView,
  RecordPhaseView,
  RelatedItemView,
  ReplacedDecisionView,
  SuggestedCategoryView,
} from "@/components/life-admin/record-view-types";
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
// resolved to an agent's name; where each stands, and who is handling it with its next step),
// their catalogue (built-in and their own categories, as plain data), each category's place on
// the page, the categories agents suggested, the open next steps with a due date, the moving
// checklist and tasks, plus the person's agents. `today` is the person's local date
// (YYYY-MM-DD in their account time zone, from the injected clock), so the view never reads
// the clock.
export interface LifeAdminPageData {
  readonly today: string;
  readonly zone: string;
  readonly catalogue: CatalogueData;
  readonly categories: CategoryStateView[];
  readonly suggestedCategories: SuggestedCategoryView[];
  readonly records: LifeAdminRecordView[];
  readonly nextSteps: NextStepView[];
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
export type ActionOutcome =
  | "created" | "updated" | "unchanged" | "confirmed"
  | "kept" | "declined" | "shown" | "hidden" | "cleared"
  | "added" | "cut" | "done" | "assigned" | "unassigned";
export type ActionResult =
  | {
      readonly ok: true;
      readonly outcome?: ActionOutcome;
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
// A kind from the person's catalogue ("vehicles.registration", "x_7kq2mz.mooring"); the
// action checks it against their catalogue, so an unknown kind is a 4xx before any write.
const recordTypeId = z.string().min(1).max(80);
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

const parentId = uuid.nullable().optional();
const saveRecordSchema = z.object({ type: recordTypeId, fields, dueDate, status, parentId });
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
// Categories: one of the person's own by its random slug, or a built-in by its id.
const BUILT_IN_IDS = BUILT_IN_CATEGORIES.map((category) => category.id) as [string, ...string[]];
const slugSchema = z.object({ slug: z.string().regex(SLUG_PATTERN) });
const visibilitySchema = z.object({ category: z.enum(BUILT_IN_IDS), setting: z.enum(["show", "not_for_me", "clear"]) });
// A journal entry the person writes: one or two lines, at most 280 characters.
const JOURNAL_KINDS = ["note", "decision", "next"] as const;
const journalSchema = z.object({
  id: uuid,
  kind: z.enum(JOURNAL_KINDS),
  text: z.string().trim().min(1).max(JOURNAL_TEXT_MAX),
  due: recordDueDateSchema.optional().nullable(),
});
const nextDoneSchema = z.object({ id: uuid, stepId: uuid });
const stewardSchema = z.object({ id: uuid, agentId: z.union([z.literal("none"), uuid]) });

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
export interface CategorySlugInput {
  readonly slug: string;
}
export interface CategoryVisibilityInput {
  readonly category: string;
  readonly setting: string;
}
export interface JournalEntryInput {
  readonly id: string;
  readonly kind: string;
  readonly text: string;
  readonly due?: string | null;
}
export interface NextDoneInput {
  readonly id: string;
  readonly stepId: string;
}
export interface StewardInput {
  readonly id: string;
  readonly agentId: string;
}

export interface LifeAdminActions {
  load(session: Session): Promise<LifeAdminPageData>;
  // One item with its whole journal, or null when the id isn't one of this person's records.
  loadItem(session: Session, id: string): Promise<LifeAdminItemData | null>;
  saveRecord(session: Session, input: SaveRecordInput): Promise<ActionResult>;
  updateRecord(session: Session, input: UpdateRecordInput): Promise<ActionResult>;
  attachReceiptFile(session: Session, input: AttachReceiptFileInput): Promise<ActionResult>;
  deleteRecord(session: Session, input: IdInput): Promise<ActionResult>;
  confirmRecord(session: Session, input: IdInput): Promise<ActionResult>;
  confirmAll(session: Session, input: IdsInput): Promise<ActionResult>;
  dismissRecord(session: Session, input: IdInput): Promise<ActionResult>;
  acceptPending(session: Session, input: IdInput): Promise<ActionResult>;
  acceptAllPending(session: Session, input: IdsInput): Promise<ActionResult>;
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
  keepCategory(session: Session, input: CategorySlugInput): Promise<ActionResult>;
  declineCategory(session: Session, input: CategorySlugInput): Promise<ActionResult>;
  setCategoryVisibility(session: Session, input: CategoryVisibilityInput): Promise<ActionResult>;
  addJournalEntry(session: Session, input: JournalEntryInput): Promise<ActionResult>;
  markNextDone(session: Session, input: NextDoneInput): Promise<ActionResult>;
  setSteward(session: Session, input: StewardInput): Promise<ActionResult>;
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

// A waiting change's new kind ("vehicles.vehicle"), when it carries one: a kind's id only.
const KIND_ID = /^[a-z0-9_]{1,40}\.[a-z0-9_]{1,40}$/;

function pendingView(pending: PendingChange | null, names: ReadonlyMap<string, string>): PendingChangeView | null {
  if (!pending) return null;
  const set: Record<string, string> = {};
  for (const [key, value] of Object.entries(pending.set ?? {})) set[key] = value == null ? "" : String(value);
  const { type } = pending;
  return {
    byName: agentName(names, pending.byAgentId),
    ...(typeof type === "string" && KIND_ID.test(type) ? { type } : {}),
    set,
    remove: [...(pending.remove ?? [])],
    ...(pending.dueDate !== undefined ? { dueDate: pending.dueDate } : {}),
    ...(pending.status !== undefined ? { status: pending.status } : {}),
    ...(pending.parentId !== undefined ? { parentId: pending.parentId } : {}),
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

// A record's text values, for naming it (lists and objects an older agent saved are skipped).
function stringFields(fields: Readonly<Record<string, unknown>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(fields)) {
    const text = scalarText(value);
    if (text !== null) out[key] = text;
  }
  return out;
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

// How the person's page reads journal authors: an agent by its name (quoted when it would
// read as the person), the person themselves as "you".
function personSavedBy(names: ReadonlyMap<string, string>): SavedByResolver {
  return (agentId): SavedBy => (agentId ? { kind: "agent", name: agentName(names, agentId) } : { kind: "you" });
}

// An author in words for the person's page: "You", an agent's name, or imported history.
function actorText(actor: JournalActor): string {
  if (actor.kind === "you" || actor.kind === "person") return "You";
  if (actor.kind === "agent") return actor.name;
  return actor.name ? `${actor.name} (imported)` : "Imported history";
}

// The person's own entries read as "you" in Warthog's change lines ("You confirmed this").
const asReader = (actor: JournalActor): JournalActor => (actor.kind === "person" ? { kind: "you" } : actor);

function phaseView(phase: PhaseView | undefined): RecordPhaseView | undefined {
  if (!phase) return undefined;
  return {
    phase: phase.phase,
    bucket: phase.bucket,
    live: phase.live,
    label: phase.label,
    comingUp: phase.comingUp,
    ...(phase.inDays !== undefined ? { inDays: phase.inDays } : {}),
    ...(phase.starts ? { starts: phase.starts.toISOString() } : {}),
    ...(phase.ends ? { ends: phase.ends.toISOString() } : {}),
  };
}

// Who is handling a record, and its next open step (the soonest due, else the oldest).
function handlingView(record: LifeAdminRecord, summary: JournalSummary | undefined, savedBy: SavedByResolver, connected: ReadonlySet<string>): RecordHandlingView | undefined {
  const steward = stewardOf(record, savedBy, connected);
  const next = summary?.openNext.length
    ? [...summary.openNext].sort((a, b) => (a.due ?? "9999").localeCompare(b.due ?? "9999"))[0]!
    : null;
  if (!steward && !next) return undefined;
  return {
    steward: steward ? actorText(steward) : null,
    next: next ? { id: next.id, text: next.text, ...(next.due ? { due: next.due } : {}) } : null,
  };
}

// The field names (never values) an audit entry records for a change.
const fieldNames = (keys: Iterable<string>) => [...new Set(keys)].sort();

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
  // resolved for display; an agent's waiting change with its agent's name; where it stands,
  // and who is handling it with its next step.
  function toRecordView(
    record: LifeAdminRecord,
    hasAttachedFile: boolean,
    names: ReadonlyMap<string, string>,
    files: { id: string; size: number }[] = [],
    phase?: PhaseView,
    handling?: RecordHandlingView,
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
    const shownPhase = phaseView(phase);
    return {
      id: record.id,
      kind: record.kind,
      type: record.type,
      fields: display,
      ...(Object.keys(held).length ? { heldFields: held } : {}),
      dueDate: record.dueDate == null ? null : String(record.dueDate instanceof Date ? record.dueDate.toISOString() : record.dueDate).slice(0, 10),
      status: record.status,
      ...(record.state ? { state: record.state } : {}),
      reminderOffsets: record.reminderOffsets,
      hasAttachedFile,
      ...(files.length ? { files } : {}),
      reviewState: record.reviewState === "suggested" ? "suggested" : "confirmed",
      parentId: record.parentId,
      addedBy: actorView(record.source, names) ?? { kind: "person" },
      ...(changedBy ? { changedBy } : {}),
      ...(foundIn ? { foundIn } : {}),
      ...(pending ? { pending } : {}),
      ...(shownPhase ? { phase: shownPhase } : {}),
      ...(handling ? { handling } : {}),
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

  // The person's catalogue, time zone and a service context for the record service, under
  // their own DEK and the injected clock.
  async function personFor(userId: string): Promise<{ dek: Uint8Array; person: PersonCatalogue; ctx: ServiceContext }> {
    const dek = await dataKeyFor(userId);
    const person = await catalogueFor(db, userId, dek);
    return { dek, person, ctx: { db, dek, userId, catalogue: person.catalogue, zone: person.zone, now: clock.now() } };
  }

  // A change and its audit entry in one transaction (the memory and rules pattern): `change`
  // gets the transaction's context and a recorder that takes field names and ids only.
  function audited<T>(
    base: ServiceContext,
    change: (ctx: ServiceContext, record: (kind: string, changes: Record<string, unknown>, recordIds?: readonly string[]) => Promise<void>) => Promise<T>,
  ): Promise<T> {
    return auditedOwnerChange(deps, base.userId, (tx, record) =>
      change({ ...base, db: tx }, (kind, changes, recordIds) => record(kind, changes, undefined, recordIds)));
  }

  // The agents' names as the page shows them (cleaned; quoted when they'd read as the person).
  function agentNames(agents: readonly Agent[]): Map<string, string> {
    return new Map(agents.map((agent) => [agent.id, cleanShortText(agent.displayName, 80)] as const));
  }

  // Read ONLY the session person's records / checklist / tasks (member-scoped by
  // `session.userId`), decrypted under their own DEK, shaped into the two views' props. The
  // owner-scoped list-all read is `lifeAdminPageData`; the person's catalogue says what kind
  // each record is and which categories show; the one lifecycle module says where each record
  // stands (`recordPhases`); the journal says who is handling each item and what's next.
  async function load(session: Session): Promise<LifeAdminPageData> {
    const userId = session.userId;
    const { dek, person } = await personFor(userId);
    const { catalogue, zone, settings } = person;
    const now = clock.now();
    const page = await lifeAdminPageData(db, userId, dek);
    const fileRows = await db.query("SELECT id, record_id, size FROM receipt_files WHERE user_id=$1 ORDER BY id", [userId]);
    const filesFor = (id: string) => fileRows.rows.filter((r) => r.record_id === id).map((r) => ({ id: r.id as string, size: Number(r.size) }));
    const agents = await listAgentsForUser(db, userId);
    const names = agentNames(agents);
    const connected = new Set(agents.filter((agent) => agent.status === "connected").map((agent) => agent.id));
    const savedBy = personSavedBy(names);
    const phases = recordPhases(page.records, catalogue, now, zone);
    const summaries = await journalSummaries(db, userId, page.records, dek, savedBy);
    const today = localDate(now, zone);

    const counts = new Map<string, number>();
    for (const record of page.records) {
      const category = catalogue.typeOfRecord(record.kind, record.type).category;
      counts.set(category, (counts.get(category) ?? 0) + 1);
    }
    const categories: CategoryStateView[] = catalogue.categories.map((category) => ({
      id: category.id,
      visibility: visibilityOf((counts.get(category.id) ?? 0) > 0, category.origin === "builtin" ? settings[category.id] : undefined, category.origin),
      records: counts.get(category.id) ?? 0,
    }));

    const suggestedCategories: SuggestedCategoryView[] = person.custom
      .filter((row) => row.state === "suggested")
      .map((row) => {
        const inCategory = page.records.filter((record) => record.type?.startsWith(`${row.slug}.`));
        const suggestedRecords = inCategory.filter((record) => record.reviewState === "suggested").length;
        return {
          slug: row.slug,
          label: cleanShortText(row.definition.label, 60),
          description: cleanShortText(row.definition.description, 200),
          suggestedBy: row.suggestedByAgentId ? agentName(names, row.suggestedByAgentId) : "You",
          ...(row.definition.why ? { why: cleanShortText(row.definition.why, 280) } : {}),
          kinds: row.definition.kinds.map((kind) => cleanShortText(kind.label, 60)),
          records: inCategory.length,
          suggestedRecords,
          confirmedRecords: inCategory.length - suggestedRecords,
        };
      });

    const nextSteps: NextStepView[] = [];
    for (const record of page.records) {
      const summary = summaries.get(record.id);
      if (!summary) continue;
      const type = catalogue.typeOfRecord(record.kind, record.type);
      for (const step of summary.openNext) {
        if (!step.due) continue;
        nextSteps.push({ id: step.id, recordId: record.id, recordName: recordName(type, stringFields(record.fields), Boolean(record.type)).name, text: step.text, due: step.due });
      }
    }
    nextSteps.sort((a, b) => a.due.localeCompare(b.due) || a.recordName.localeCompare(b.recordName));

    return {
      today,
      zone,
      catalogue: catalogue.data,
      categories,
      suggestedCategories,
      records: page.records.map((r) =>
        toRecordView(r, r.hasAttachedFile, names, filesFor(r.id), phases.get(r.id), handlingView(r, summaries.get(r.id), savedBy, connected))),
      nextSteps,
      checklist: page.checklist.map(toChecklistView),
      tasks: page.tasks.map((t) => toTaskView(t, agents, zone)),
      agents: agents.map((a) => ({ id: a.id, name: a.displayName })),
    };
  }

  // One of the person's items with its WHOLE journal (finished items included): where it
  // stands in the same one line agents get, its open and done next steps, the decisions in
  // force and those replaced, notes and hand-over notes, and Warthog's own change entries grouped
  // by day and by who made them. Member-scoped; a malformed id, or one that isn't this person's
  // record, is null (the page says it isn't there), never another person's item.
  async function loadItem(session: Session, id: string): Promise<LifeAdminItemData | null> {
    if (!uuid.safeParse(id).success) return null;
    const userId = session.userId;
    const { dek, person } = await personFor(userId);
    const { catalogue, zone } = person;
    const record = await getRecordForUser(db, userId, id, dek);
    if (!record) return null;
    const now = clock.now();
    const agents = await listAgentsForUser(db, userId);
    const names = agentNames(agents);
    const connected = new Set(agents.filter((agent) => agent.status === "connected").map((agent) => agent.id));
    const savedBy = personSavedBy(names);
    const type = typeOf(catalogue, record);
    const category = catalogue.category(type.category);

    // Its parent and the records that belong to it, for the phases (a trip's span) and the page.
    const all = (await lifeAdminPageData(db, userId, dek)).records;
    const related = all.filter((other) => other.id === record.id || other.id === record.parentId || other.parentId === record.id);
    const phases = recordPhases(related, catalogue, now, zone);
    const relatedView = (other: LifeAdminRecord): RelatedItemView => {
      const otherType = typeOf(catalogue, other);
      return { id: other.id, name: recordName(otherType, stringFields(other.fields), Boolean(other.type)).name, kindLabel: otherType.label, ...(phases.get(other.id) ? { phaseLabel: phases.get(other.id)!.label } : {}) };
    };
    const parent = record.parentId ? related.find((other) => other.id === record.parentId) ?? null : null;
    const children = related.filter((other) => other.parentId === record.id && other.id !== record.id);

    // The whole journal, oldest first (pages of 200; a record holds at most 400 entries).
    const raw: JournalEntry[] = [];
    for (let before: number | undefined; ;) {
      const page = await listJournal(db, userId, record.id, dek, { limit: 200, ...(before !== undefined ? { beforeSeq: before } : {}) });
      raw.push(...page);
      if (page.length < 200) break;
      before = page[page.length - 1]!.seq;
    }
    raw.sort((a, b) => a.seq - b.seq);
    const views = raw.map((entry) => entryView(entry, savedBy));
    const when = (iso: string) => shortDate(iso, zone);
    const item = (view: JournalEntryView): JournalItemView => ({
      id: view.id,
      at: view.at,
      when: when(view.at),
      by: actorText(view.by),
      text: view.text ?? "",
      ...(view.due ? { due: view.due } : {}),
    });
    const newestFirst = <T extends { at: string }>(list: T[]) => [...list].reverse();

    const open = openNextSteps(views);
    const closings = new Map(views.filter((view) => view.kind === "next_done" && view.refId).map((view) => [view.refId!, view] as const));
    const doneSteps: DoneStepView[] = views
      .filter((view) => view.kind === "next" && closings.has(view.id))
      .map((view) => ({ ...item(view), doneWhen: when(closings.get(view.id)!.at), doneBy: actorText(closings.get(view.id)!.by) }));
    const decisions = currentDecisions(views);
    const replacedBy = new Map(views.filter((view) => view.kind === "decision" && view.refId).map((view) => [view.refId!, view] as const));
    const replaced: ReplacedDecisionView[] = views
      .filter((view) => view.kind === "decision" && replacedBy.has(view.id))
      .map((view) => ({ ...item(view), replacedBy: replacedBy.get(view.id)!.text ?? "" }));

    // Warthog's change entries, newest first, by day in the person's zone, then by who.
    const dayParts = new Intl.DateTimeFormat("en-AU", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: zone });
    const dayLabel = { format: (at: Date) => { const p = Object.fromEntries(dayParts.formatToParts(at).map((part) => [part.type, part.value])); return `${p.weekday} ${p.day} ${p.month} ${p.year}`; } };
    const history: HistoryDayView[] = [];
    for (const view of newestFirst(views.filter((entry) => entry.kind === "change" && entry.change))) {
      const day = dayLabel.format(new Date(view.at));
      const by = actorText(view.by);
      let slot = history[history.length - 1];
      if (!slot || slot.day !== day) history.push((slot = { day, groups: [] }));
      let group = slot.groups[slot.groups.length - 1];
      if (!group || group.by !== by) slot.groups.push((group = { by, lines: [] }));
      group.lines.push(changeText(view.change!, asReader(view.by)));
    }

    const steward = stewardOf(record, savedBy, connected);
    const name = recordName(type, stringFields(record.fields), Boolean(record.type)).name;
    const latest = views[views.length - 1];
    const whereItStands = handoverLine({
      name,
      state: stateWords(record, catalogue, now, zone),
      decision: decisions[0] ? { ...decisions[0], by: asReader(decisions[0].by) } : null,
      next: open[0] ?? null,
      steward: steward && record.steward ? actorText(steward) : null,
      lastTouched: latest ? { at: latest.at, by: actorName(asReader(latest.by)) } : null,
      now,
      zone,
    });

    return {
      today: localDate(now, zone),
      zone,
      record: toRecordView(record, false, names, [], phases.get(record.id), undefined),
      type,
      name,
      kindLabel: type.label,
      categoryLabel: category?.label ?? "Other",
      lifecycle: type.lifecycle,
      whereItStands,
      parent: parent ? relatedView(parent) : null,
      children: children.map(relatedView),
      steward: steward && record.steward ? { agentId: record.steward.agentId, name: actorText(steward) } : null,
      agents: agents.filter((agent) => agent.status === "connected").map((agent) => ({ id: agent.id, name: agentName(names, agent.id) })),
      openSteps: open.map(item),
      doneSteps: newestFirst(doneSteps),
      decisions: decisions.map(item),
      replaced: newestFirst(replaced),
      notes: newestFirst(views.filter((view) => view.kind === "note").map(item)),
      handovers: newestFirst(views.filter((view) => view.kind === "handover").map(item)),
      history,
      entries: views.length,
    };
  }

  // A kind from the person's catalogue, or a 4xx (an unknown kind never reaches a write).
  function kindOf(ctx: ServiceContext, id: string): RecordTypeDef {
    const type = ctx.catalogue.type(id);
    if (!type) throw new HttpError(400, "Unknown record type");
    return type;
  }

  // A status the kind's form offers (a booking's, a case's or a standing item's), or a 4xx.
  function checkedStatus(type: RecordTypeDef, value: string | undefined): string | undefined {
    if (value === undefined || value === "") return undefined;
    if (!statusChoices(type.lifecycle).some((choice) => choice.value === value)) throw new HttpError(400, "Unknown status");
    return value;
  }

  // Add a record of a kind from the person's catalogue, through the record service (actor
  // "person", so it is confirmed and its values normalised like an agent's, in the person's
  // time zone). Validate at the boundary first (an unknown kind or status is a 4xx before any
  // write); refuse an identifier Warthog never keeps, naming the field; refuse a form with
  // nothing filled in. The owner is the session's id, so a userId smuggled in the input is
  // ignored. A record matching one the person already has (the same plate, the same insurer
  // and policy) updates it. Audited with the field names only.
  async function saveRecord(session: Session, input: SaveRecordInput): Promise<ActionResult> {
    const valid = parseParams(saveRecordSchema, input);
    const { ctx } = await personFor(session.userId);
    const type = kindOf(ctx, valid.type);
    const statusWord = checkedStatus(type, valid.status);
    const filled = filledFields(valid.fields);
    const refusal = refusalFor(type, filled);
    if (refusal) return { ok: false, reason: "forbidden", refusal };
    if (Object.keys(filled).length === 0 && !valid.dueDate) return { ok: false, reason: "empty" };
    return audited(ctx, async (tx, record) => {
      const saved = await saveTypedRecord(tx, PERSON, {
        type,
        fields: filled,
        dueDate: valid.dueDate ?? null,
        ...(statusWord ? { status: statusWord } : {}),
        parentId: valid.parentId,
      });
      const problems = saved.problems;
      if (saved.action === "skipped") {
        return { ok: true as const, outcome: "unchanged" as const, ...(saved.record ? { recordId: saved.record.id } : {}), problems };
      }
      await record("life_admin_record_saved", { recordId: saved.record.id, kind: type.origin === "builtin" ? type.id : "own_category", outcome: saved.action, fields: fieldNames(Object.keys(filled)) }, [saved.record.id]);
      return { ok: true as const, outcome: saved.action === "proposed" ? "updated" as const : saved.action, recordId: saved.record.id, problems };
    });
  }

  // Edit an OWNED record from the Edit form, through the record service (actor "person").
  // Validate at the boundary first (a malformed id is a 4xx before any query), read the
  // record member-scoped (id AND user_id bound — another person's record is refused and left
  // unchanged), then change only what the person changed (editChanges), refusing an
  // identifier Warthog never keeps. An omitted due date, status or parent keeps the stored
  // one. The person's edit confirms an agent's suggestion — even one that changed nothing.
  async function updateRecord(session: Session, input: UpdateRecordInput): Promise<ActionResult> {
    const valid = parseParams(updateRecordSchema, input);
    const { ctx } = await personFor(session.userId);
    const existing = await getRecordForUser(db, session.userId, valid.id, ctx.dek);
    if (!existing) return { ok: false, reason: "not_found" };
    const type = typeOf(ctx.catalogue, existing);
    const { set, remove } = editChanges(type, existing.fields, valid.fields);
    const refusal = refusalFor(type, set);
    if (refusal) return { ok: false, reason: "forbidden", refusal };
    return audited(ctx, async (tx, record) => {
      const changed = await changeRecord(tx, existing, PERSON, { set, remove, dueDate: valid.dueDate, status: valid.status, parentId: valid.parentId });
      if (changed.action === "refused") return { ok: false as const, reason: "not_found" };
      const touched = { recordId: existing.id, fields: fieldNames([...Object.keys(set), ...remove]), dueDate: valid.dueDate !== undefined, status: valid.status !== undefined, parent: valid.parentId !== undefined };
      if (changed.action === "unchanged" && existing.reviewState === "suggested") {
        await confirmRecordFor(tx, existing.id);
        await record("life_admin_record_confirmed", { recordId: existing.id }, [existing.id]);
        return { ok: true as const, outcome: "confirmed" as const, recordId: existing.id, problems: changed.problems };
      }
      if (changed.action !== "unchanged") await record("life_admin_record_changed", touched, [existing.id]);
      return { ok: true as const, outcome: changed.action === "proposed" ? "updated" as const : changed.action, recordId: existing.id, problems: changed.problems };
    });
  }

  // The person checked an agent's suggestion: it becomes theirs (and so does its suggested
  // category), and agents can no longer change it without asking. Member-scoped; a record that
  // is not this person's suggestion (another person's, or one already confirmed) is refused.
  async function confirmRecord(session: Session, input: IdInput): Promise<ActionResult> {
    const { id } = parseParams(idOnlySchema, input);
    const { ctx } = await personFor(session.userId);
    const confirmed = await audited(ctx, async (tx, record) => {
      if (!(await confirmRecordFor(tx, id))) return false;
      await record("life_admin_record_confirmed", { recordId: id }, [id]);
      return true;
    });
    return confirmed ? { ok: true, outcome: "confirmed", recordId: id, count: 1 } : { ok: false, reason: "not_found" };
  }

  // Confirm several suggestions at once ("Confirm all"). Every id must be well formed (a 4xx
  // otherwise, before any write); each is confirmed member-scoped, so another person's id
  // changes nothing. Refused when none of them was one of this person's suggestions.
  async function confirmAll(session: Session, input: IdsInput): Promise<ActionResult> {
    const { ids } = parseParams(idsSchema, input);
    const { ctx } = await personFor(session.userId);
    const count = await audited(ctx, async (tx, record) => {
      const done: string[] = [];
      for (const id of new Set(ids)) if (await confirmRecordFor(tx, id)) done.push(id);
      if (done.length > 0) await record("life_admin_record_confirmed", { count: done.length }, done);
      return done.length;
    });
    return count > 0 ? { ok: true, outcome: "confirmed", count } : { ok: false, reason: "not_found" };
  }

  // "Not mine": remove the record's files and its journal, leaving a tombstone that keeps only
  // its type and match keys, so an agent finding the same thing again doesn't add it back.
  // Member-scoped. The files' store runs its own transaction, so the audit entry follows it.
  async function dismissRecord(session: Session, input: IdInput): Promise<ActionResult> {
    const { id } = parseParams(idOnlySchema, input);
    const { ctx } = await personFor(session.userId);
    if (!(await dismissRecordWithFiles(db, blob, { userId: session.userId, recordId: id }, ctx.dek))) return { ok: false, reason: "not_found" };
    await audited(ctx, (_tx, record) => record("life_admin_record_dismissed", { recordId: id }, [id]));
    return { ok: true };
  }

  // Accept an agent's waiting change to one of the person's records: it is applied and the
  // record stays the person's. Refused when there is no such change on their record.
  async function acceptPending(session: Session, input: IdInput): Promise<ActionResult> {
    const { id } = parseParams(idOnlySchema, input);
    const { ctx } = await personFor(session.userId);
    const accepted = await audited(ctx, async (tx, record) => {
      const before = await getRecordForUser(tx.db, session.userId, id, ctx.dek);
      const updated = await acceptPendingChange(tx, id);
      if (!updated) return false;
      await record("life_admin_change_accepted", { recordId: id, fields: fieldNames([...Object.keys(before?.pending?.set ?? {}), ...(before?.pending?.remove ?? [])]) }, [id]);
      return true;
    });
    return accepted ? { ok: true, outcome: "updated", recordId: id } : { ok: false, reason: "not_found" };
  }

  // Accept several waiting changes at once ("Accept all n changes"). Every id must be well formed
  // (a 4xx otherwise, before any write); each is accepted member-scoped, so another person's id,
  // or a record with no waiting change, changes nothing. Refused when none of them was accepted.
  async function acceptAllPending(session: Session, input: IdsInput): Promise<ActionResult> {
    const { ids } = parseParams(idsSchema, input);
    const { ctx } = await personFor(session.userId);
    const count = await audited(ctx, async (tx, record) => {
      const done: string[] = [];
      const fields: string[] = [];
      for (const id of new Set(ids)) {
        const before = await getRecordForUser(tx.db, session.userId, id, ctx.dek);
        if (!before?.pending || !(await acceptPendingChange(tx, id))) continue;
        done.push(id);
        fields.push(...Object.keys(before.pending.set ?? {}), ...(before.pending.remove ?? []));
      }
      if (done.length > 0) await record("life_admin_change_accepted", { count: done.length, fields: fieldNames(fields) }, done);
      return done.length;
    });
    return count > 0 ? { ok: true, outcome: "updated", count } : { ok: false, reason: "not_found" };
  }

  // Keep the person's own values: the agent's waiting change is dropped. Member-scoped.
  async function declinePending(session: Session, input: IdInput): Promise<ActionResult> {
    const { id } = parseParams(idOnlySchema, input);
    const { ctx } = await personFor(session.userId);
    const declined = await audited(ctx, async (tx, record) => {
      if (!(await declinePendingChange(tx, id))) return false;
      await record("life_admin_change_declined", { recordId: id }, [id]);
      return true;
    });
    return declined ? { ok: true, recordId: id } : { ok: false, reason: "not_found" };
  }

  // Keep a category an agent suggested: it becomes the person's own. Member-scoped by slug.
  async function keepCategory(session: Session, input: CategorySlugInput): Promise<ActionResult> {
    const { slug } = parseParams(slugSchema, input);
    const { ctx } = await personFor(session.userId);
    const kept = await audited(ctx, async (tx, record) => {
      if (!(await keepCategoryRow(tx.db, session.userId, slug, clock))) return false;
      await record("life_admin_category_kept", { category: slug });
      return true;
    });
    return kept ? { ok: true, outcome: "kept" } : { ok: false, reason: "not_found" };
  }

  // Decline one of the person's own categories: its suggested records are removed (and not
  // added again), anything they confirmed moves to "Something else" with its details kept, and
  // the same suggestion isn't accepted again. Member-scoped by slug.
  async function declineCategory(session: Session, input: CategorySlugInput): Promise<ActionResult> {
    const { slug } = parseParams(slugSchema, input);
    const { ctx } = await personFor(session.userId);
    const result = await audited(ctx, async (tx, record) => {
      const outcome = await declineCustomCategory(tx, slug);
      if (outcome.declined) await record("life_admin_category_declined", { category: slug, removed: outcome.removed, moved: outcome.moved });
      return outcome;
    });
    return result.declined ? { ok: true, outcome: "declined", count: result.removed + result.moved } : { ok: false, reason: "not_found" };
  }

  // Show an empty built-in category, say it's not for the person, or clear that setting.
  async function setCategoryVisibility(session: Session, input: CategoryVisibilityInput): Promise<ActionResult> {
    const valid = parseParams(visibilitySchema, input);
    const { ctx } = await personFor(session.userId);
    const setting = valid.setting === "clear" ? null : valid.setting;
    await audited(ctx, async (tx, record) => {
      await setBuiltInSetting(tx.db, session.userId, valid.category, setting, ctx.dek, clock);
      await record("life_admin_category_setting", { category: valid.category, setting: valid.setting });
    });
    return { ok: true, outcome: setting === "show" ? "shown" : setting === "not_for_me" ? "hidden" : "cleared" };
  }

  // The person adds a note, a decision or a next step (with an optional due date) to one of
  // their items. The text is checked like a record's fields: an identifier Warthog never keeps
  // (a tax file number, a password, bank or ID numbers, payment details) refuses the entry,
  // naming the place, never the text. Member-scoped; audited with the entry's kind only.
  async function addJournalEntry(session: Session, input: JournalEntryInput): Promise<ActionResult> {
    const valid = parseParams(journalSchema, input);
    const { ctx } = await personFor(session.userId);
    const existing = await getRecordForUser(db, session.userId, valid.id, ctx.dek);
    if (!existing) return { ok: false, reason: "not_found" };
    const type = typeOf(ctx.catalogue, existing);
    const place = valid.kind === "decision" ? "Decision" : valid.kind === "next" ? "Next step" : "Note";
    const rule = findForbiddenText(valid.text, type.id);
    if (rule) return { ok: false, reason: "forbidden", refusal: { rule, field: place } };
    const entry = valid.kind === "decision"
      ? { decision: valid.text }
      : valid.kind === "next"
        ? { next: { text: valid.text, ...(valid.due ? { due: valid.due } : {}) } }
        : { note: valid.text };
    return audited(ctx, async (tx, record) => {
      const added = await addJournal(tx, existing, PERSON, entry);
      if (added.journal.added.length === 0) return { ok: false as const, reason: added.problems.some((p) => /full/.test(p)) ? "full" : "not_added" };
      await record("life_admin_journal_added", { recordId: existing.id, entry: valid.kind }, [existing.id]);
      return { ok: true as const, outcome: added.problems.length ? "cut" as const : "added" as const, recordId: existing.id, problems: added.problems };
    });
  }

  // Mark one of an item's open next steps done. Member-scoped; a step that isn't on this
  // record (or is already done) is refused.
  async function markNextDone(session: Session, input: NextDoneInput): Promise<ActionResult> {
    const valid = parseParams(nextDoneSchema, input);
    const { ctx } = await personFor(session.userId);
    const existing = await getRecordForUser(db, session.userId, valid.id, ctx.dek);
    if (!existing) return { ok: false, reason: "not_found" };
    return audited(ctx, async (tx, record) => {
      const added = await addJournal(tx, existing, PERSON, { doneNextIds: [valid.stepId] });
      if (added.journal.added.length === 0) return { ok: false as const, reason: "not_found" };
      await record("life_admin_next_done", { recordId: existing.id }, [existing.id]);
      return { ok: true as const, outcome: "done" as const, recordId: existing.id };
    });
  }

  // Say which of the person's connected agents is handling an item, or that no one is. A
  // label, never a lock or a permission. Member-scoped; an agent that isn't this person's
  // connected agent is refused.
  async function setSteward(session: Session, input: StewardInput): Promise<ActionResult> {
    const valid = parseParams(stewardSchema, input);
    const { ctx } = await personFor(session.userId);
    const existing = await getRecordForUser(db, session.userId, valid.id, ctx.dek);
    if (!existing) return { ok: false, reason: "not_found" };
    const agentId = valid.agentId === "none" ? null : valid.agentId;
    return audited(ctx, async (tx, record) => {
      if (!(await setStewardFor(tx, existing, agentId))) return { ok: false as const, reason: agentId ? "unknown_agent" : "not_found" };
      await record("life_admin_steward_set", { recordId: existing.id, steward: agentId ?? "none" }, [existing.id]);
      return { ok: true as const, outcome: agentId ? "assigned" as const : "unassigned" as const, recordId: existing.id };
    });
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
    // The file store runs its own transaction (blob first), so the audit entry follows it.
    await auditedOwnerChange(deps, session.userId, (_tx, record) => record("life_admin_file_attached", { recordId }, undefined, [recordId]));
    return { ok: true };
  }

  // Change ONLY the OWNED record's reminder offsets (member-scoped: id AND user_id
  // bound), leaving the encrypted fields untouched. A record that is not this person's
  // matches nothing and is refused.
  async function setRecordReminders(session: Session, input: SetRemindersInput): Promise<ActionResult> {
    const valid = parseParams(setRemindersSchema, input);
    const changed = await auditedOwnerChange(deps, session.userId, async (tx, record) => {
      const result = await tx.query(
        "UPDATE life_admin_records SET reminder_offsets = $3::int[] WHERE id = $1 AND user_id = $2 AND review_state <> 'dismissed' RETURNING id",
        [valid.id, session.userId, valid.reminderOffsets],
      );
      if (result.rows.length === 0) return false;
      await record("life_admin_reminders_changed", { recordId: valid.id, reminders: valid.reminderOffsets.length }, undefined, [valid.id]);
      return true;
    });
    return changed ? { ok: true } : { ok: false, reason: "not_found" };
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
    if (!(await deleteRecordWithFiles(db, blob, { userId: session.userId, recordId: id }))) return { ok: false, reason: "not_found" };
    // The file store runs its own transaction (blobs first), so the audit entry follows it.
    await auditedOwnerChange(deps, session.userId, (_tx, record) => record("life_admin_record_deleted", { recordId: id }, undefined, [id]));
    return { ok: true };
  }

  return {
    load,
    loadItem,
    keepCategory,
    declineCategory,
    setCategoryVisibility,
    addJournalEntry,
    markNextDone,
    setSteward,
    deleteRecord,
    confirmRecord,
    confirmAll,
    dismissRecord,
    acceptPending,
    acceptAllPending,
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
