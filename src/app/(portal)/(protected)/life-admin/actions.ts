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

import { z } from "zod";

import { HttpError, parseParams } from "@/server/http/validate";
import type { Db } from "@/server/db/index";
import type { Session } from "@/server/auth/session";
import type { KeyWrapper } from "@/server/crypto/key-wrapper";
import type { Clock } from "@/server/seams/clock";
import type { BlobStore } from "@/server/storage/blob";
import { getUserById } from "@/server/db/users";
import { getAgentById, listAgentsForUser } from "@/server/db/agents";
import {
  createRecord,
  updateRecord as updateRecordRow,
  type LifeAdminRecord,
} from "@/server/db/life-admin-records";
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
import { saveReceiptFile } from "@/server/storage/receipt-files";
import { buildMovingChecklist } from "@/server/moving/checklist";
import { lifeAdminPageData } from "@/server/life-admin/page-data";

import type {
  LifeAdminRecordView,
  ChecklistItemView,
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

// What `load` returns — ALL of the session person's records (grouped by kind, fields
// decrypted and stringified for display), moving checklist and tasks (titles/notes
// decrypted, assignee + note authors resolved to agent display names), plus the
// person's agents — shaped into the props <LifeAdminView/> + <TasksView/> are mounted
// over.
export interface LifeAdminPageData {
  readonly subscriptions: LifeAdminRecordView[];
  readonly receipts: LifeAdminRecordView[];
  readonly renewals: LifeAdminRecordView[];
  readonly checklist: ChecklistItemView[];
  readonly tasks: TaskItemView[];
  readonly agents: AgentOption[];
}

// Every mutation reports its outcome — success, or a refusal naming its reason (the
// row/agent is not this person's). Never a silent success (conventions: a server action
// reports success, the refusal reason, or a 4xx).
export type ActionResult = { readonly ok: true } | { readonly ok: false; readonly reason: string };

// ---- boundary validation (INV-102) -------------------------------------------------
//
// Field caps mirror the sibling MCP records/tasks tools so a grossly oversized value is
// refused at the boundary before any db access. Ids are uuids (life_admin_records /
// tasks / moving_checklist all gen_random_uuid()), shape-guarded so a non-uuid never
// reaches `WHERE id = $1` as a cast (OBS-049).
const MAX_STATUS = 200;
const MAX_DUE_DATE = 40;
const MAX_FIELDS_CHARS = 100_000;
const MAX_TITLE = 2000;
const MAX_NOTE = 4000;
const MAX_OFFSETS = 50;
const MAX_FILE_BYTES = 25 * 1024 * 1024; // a receipt is small; a payload meant to exhaust memory is refused
const DEFAULT_STATUS = "active";

const uuid = z.uuid();
const recordKind = z.enum(["subscription", "receipt_warranty", "renewal_appointment"]);
const taskStatus = z.enum(["open", "in_progress", "done"]);
// The assignee the view offers: 'any', or one of the person's own agents (a uuid).
const assignee = z.union([z.literal("any"), z.uuid()]);
// A record's fields blob: an object of arbitrary values, capped on its serialised size.
const fields = z
  .record(z.string(), z.unknown())
  .refine((value) => JSON.stringify(value).length <= MAX_FIELDS_CHARS);
const status = z.string().max(MAX_STATUS).optional();
const dueDate = z.string().max(MAX_DUE_DATE).optional().nullable();
const reminderOffsets = z.array(z.number().int().min(0)).max(MAX_OFFSETS);

const saveRecordSchema = z.object({
  kind: recordKind,
  fields,
  dueDate,
  status,
  reminderOffsets: reminderOffsets.optional(),
});
const updateRecordSchema = z.object({
  id: uuid,
  fields,
  dueDate,
  status,
  reminderOffsets: reminderOffsets.optional(),
});
const setRemindersSchema = z.object({ id: uuid, reminderOffsets });
const attachRecordSchema = z.object({ recordId: uuid });
const idOnlySchema = z.object({ id: uuid });
const handSchema = z.object({ id: uuid, agentId: uuid.optional() });
const createTaskSchema = z.object({ title: z.string().min(1).max(MAX_TITLE), assignee: assignee.optional() });
const updateTaskSchema = z.object({
  id: uuid,
  title: z.string().min(1).max(MAX_TITLE),
  assignee,
  status: taskStatus,
});
const assignTaskSchema = z.object({ id: uuid, assignee });
const addNoteSchema = z.object({ id: uuid, text: z.string().min(1).max(MAX_NOTE) });

// ---- the method input types (so the factory's shape is precise) --------------------

export interface SaveRecordInput {
  readonly kind: z.infer<typeof recordKind>;
  readonly fields: Record<string, unknown>;
  readonly dueDate?: string | null;
  readonly status?: string;
  readonly reminderOffsets?: number[];
}
export interface UpdateRecordInput {
  readonly id: string;
  readonly fields: Record<string, unknown>;
  readonly dueDate?: string | null;
  readonly status?: string;
  readonly reminderOffsets?: number[];
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

  function toRecordView(record: LifeAdminRecord, hasAttachedFile: boolean): LifeAdminRecordView {
    const display: Record<string, string> = {};
    for (const [key, value] of Object.entries(record.fields)) {
      display[key] = value == null ? "" : String(value);
    }
    return {
      id: record.id,
      kind: record.kind,
      fields: display,
      dueDate: record.dueDate == null ? null : String(record.dueDate),
      status: record.status,
      reminderOffsets: record.reminderOffsets,
      hasAttachedFile,
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

  function toTaskView(task: Task, agents: ReadonlyArray<{ id: string; displayName: string }>): TaskItemView {
    return {
      id: task.id,
      title: task.title,
      notes: task.notes.map((note) => ({ author: toActorView(note.author, agents), text: note.text })),
      assignee: toAssigneeView(task.assignee, agents),
      status: task.status,
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
    const agents = await listAgentsForUser(db, userId);

    return {
      subscriptions: page.subscriptions.map((r) => toRecordView(r, r.hasAttachedFile)),
      receipts: page.receipts.map((r) => toRecordView(r, r.hasAttachedFile)),
      renewals: page.renewals.map((r) => toRecordView(r, r.hasAttachedFile)),
      checklist: page.checklist.map(toChecklistView),
      tasks: page.tasks.map((t) => toTaskView(t, agents)),
      agents: agents.map((a) => ({ id: a.id, name: a.displayName })),
    };
  }

  // Save a new record for the session person (fields DEK-encrypted by the store).
  // Validate at the boundary first (a 4xx before any write); the owner is the session's
  // id, so a userId smuggled in the input is ignored.
  async function saveRecord(session: Session, input: SaveRecordInput): Promise<ActionResult> {
    const valid = parseParams(saveRecordSchema, input);
    const dek = await dataKeyFor(session.userId);
    await createRecord(
      db,
      {
        userId: session.userId,
        kind: valid.kind,
        fields: valid.fields,
        dueDate: valid.dueDate ?? null,
        status: valid.status ?? DEFAULT_STATUS,
        reminderOffsets: valid.reminderOffsets,
        source: { kind: "person" },
      },
      dek,
    );
    return { ok: true };
  }

  // Edit an OWNED record's fields, PRESERVING the metadata the caller did not resubmit.
  // Validate at the boundary first (a malformed id is a 4xx before any query), then read
  // the current due date + status member-scoped (id AND user_id bound) — this both
  // refuses a record that is not this person's (left unchanged) and lets a fields-only
  // edit keep its due date, status and reminders: an OMITTED value (`undefined`) keeps
  // the stored one, while an explicit value (including `null` to clear a date) replaces
  // it. So editing the fields never silently wipes the due date or resets the status.
  async function updateRecord(session: Session, input: UpdateRecordInput): Promise<ActionResult> {
    const valid = parseParams(updateRecordSchema, input);
    const current = await db.query(
      "SELECT due_date::text AS due_date, status FROM life_admin_records WHERE id = $1 AND user_id = $2",
      [valid.id, session.userId],
    );
    if (current.rows.length === 0) {
      return { ok: false, reason: "not_found" };
    }
    const existing = current.rows[0] as { due_date: string | null; status: string };
    const dek = await dataKeyFor(session.userId);
    await updateRecordRow(
      db,
      {
        userId: session.userId,
        id: valid.id,
        fields: valid.fields,
        dueDate: valid.dueDate === undefined ? existing.due_date : valid.dueDate,
        status: valid.status === undefined ? existing.status : valid.status,
        reminderOffsets: valid.reminderOffsets,
      },
      dek,
    );
    return { ok: true };
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
    if (!(await ownsRow("life_admin_records", session.userId, recordId))) {
      return { ok: false, reason: "not_found" };
    }
    const dek = await dataKeyFor(session.userId);
    const bytes = new Uint8Array(await file.arrayBuffer());
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
      if (!(await getAgentById(db, session.userId, valid.agentId))) {
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
      if (!(await getAgentById(db, session.userId, valid.assignee))) {
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
    if (valid.assignee !== "any" && !(await getAgentById(db, session.userId, valid.assignee))) {
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
    if (valid.assignee !== "any" && !(await getAgentById(db, session.userId, valid.assignee))) {
      return { ok: false, reason: "unknown_agent" };
    }
    const result = await db.query(
      "UPDATE tasks SET assignee = $3 WHERE id = $1 AND user_id = $2 RETURNING id",
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

  return {
    load,
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
