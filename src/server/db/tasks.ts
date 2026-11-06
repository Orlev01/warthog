// The tasks aggregate's data access (brief "Tasks and hand-offs"; design §4.1).
// Tasks are how the person and their agents hand work off to each other: the
// person (or an agent) creates a task, assigns it to a specific agent or to "any
// agent", and agents pick it up, add notes and mark it done. A task's TITLE and
// NOTES are PERSONAL CONTENT, so they are stored only DEK-ENCRYPTED
// (`../crypto/envelope`): the id is generated up front so each envelope's
// associated data binds the ciphertext to its exact (table, column, row) — the
// plaintext title/notes never land in a column.
//
// The ASSIGNEE ('any' or a specific agent id), the STATUS (open | in_progress |
// done) and the CREATED-BY (person | agent) stay PLAINTEXT metadata (design §4.1),
// so the owner list-all and the agent-scoped read can filter WITHOUT decrypting
// another person's data.
//
// Every statement is parameterized through the `Db` seam (INV-102): the ids and
// every value travel as BOUND values, never concatenated into the SQL text, so a
// value shaped like SQL is stored as data and cannot alter the query. Every
// member-scoped read/write is scoped by the `userId` the caller passes — the
// session's / connection's id, never a client value — so one person can never
// read or write another's tasks. The DEK is injected (this module reads no
// `process.env` and holds no key, INV-103); `completeTask` takes no DEK at all —
// it only ever touches the plaintext status metadata.

import { randomUUID } from "node:crypto";

import { decrypt, encrypt } from "../crypto/envelope";
import type { Db, Row } from "./index";

// The envelope's associated data binds each blob to its exact location, so a row's
// ciphertext lifted into another row/column/table fails to decrypt.
const TABLE = "tasks";
const TITLE_COLUMN = "title";
const NOTES_COLUMN = "notes";

// The task lifecycle (plaintext metadata).
export type TaskStatus = "open" | "in_progress" | "done";

// Who created a task / authored a note (plaintext metadata): the signed-in person,
// or a connected agent (an opaque id, like activity.agent_id).
export type TaskActor = { kind: "person" } | { kind: "agent"; agentId: string };

// One note on a task — part of the DEK-ENCRYPTED notes blob.
export interface TaskNote {
  readonly author: TaskActor;
  readonly text: string;
}

// What createTask records. `userId` is the OWNER (the session's / connection's id,
// never a client value). `title` and `notes` are stored DEK-encrypted; `notes`
// defaults to []. `assignee` is 'any' or a specific agent id; `status` defaults to
// 'open'; `createdBy` is who created the task.
export interface NewTask {
  readonly userId: string;
  readonly title: string;
  readonly notes?: TaskNote[];
  readonly assignee: string;
  readonly status?: TaskStatus;
  readonly createdBy: TaskActor;
}

// What updateTask changes for the owner's own task. Member-scoped by `userId` +
// `id`. The notes are left untouched.
export interface UpdateTaskInput {
  readonly userId: string;
  readonly id: string;
  readonly title: string;
  readonly assignee: string;
  readonly status: TaskStatus;
}

// What addNote appends to the owner's own task. Member-scoped by `userId` + `id`.
export interface AddNoteInput {
  readonly userId: string;
  readonly id: string;
  readonly author: TaskActor;
  readonly text: string;
}

// A task as handed back to its owner / assigned agent, with its title and notes
// DECRYPTED.
export interface Task {
  readonly id: string;
  readonly userId: string;
  readonly title: string;
  readonly notes: TaskNote[];
  readonly assignee: string;
  readonly status: TaskStatus;
  readonly createdBy: TaskActor;
}

// The metadata columns every read returns; `title` and `notes` come back as
// ciphertext and are decrypted separately.
const SELECT_COLUMNS =
  "id, user_id, title, notes, assignee, status, created_by_kind, created_by_agent_id";

// Reconstruct the plaintext created-by actor from its two columns.
function toActor(kind: unknown, agentId: unknown): TaskActor {
  if (kind === "agent") {
    return { kind: "agent", agentId: agentId as string };
  }
  return { kind: "person" };
}

// Map a raw row (plus its already-decrypted title and notes) to a Task,
// translating the snake_case columns to the module's camelCase fields.
function toTask(row: Row, title: string, notes: TaskNote[]): Task {
  return {
    id: row.id as string,
    userId: row.user_id as string,
    title,
    notes,
    assignee: row.assignee as string,
    status: row.status as TaskStatus,
    createdBy: toActor(row.created_by_kind, row.created_by_agent_id),
  };
}

// Save a task for `input.userId`, storing its title and notes DEK-encrypted plus
// the plaintext metadata (assignee, status — defaulting to 'open' — createdBy;
// notes defaulting to []). The id is generated up front so each envelope binds to
// the row; the returned task is assembled from the inputs (no dependency on a
// RETURNING read).
export async function createTask(db: Db, input: NewTask, dek: Uint8Array): Promise<Task> {
  const id = randomUUID();
  const notes = input.notes ?? [];
  const status = input.status ?? "open";
  const createdBy = input.createdBy;
  const createdByAgentId = createdBy.kind === "agent" ? createdBy.agentId : null;
  const titleEnvelope = await encrypt(dek, TABLE, TITLE_COLUMN, id, input.title);
  const notesEnvelope = await encrypt(dek, TABLE, NOTES_COLUMN, id, JSON.stringify(notes));

  await db.query(
    `INSERT INTO tasks
       (id, user_id, title, notes, assignee, status, created_by_kind, created_by_agent_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [id, input.userId, titleEnvelope, notesEnvelope, input.assignee, status, createdBy.kind, createdByAgentId],
  );

  return {
    id,
    userId: input.userId,
    title: input.title,
    notes,
    assignee: input.assignee,
    status,
    createdBy,
  };
}

// List ALL of `userId`'s tasks (member-scoped: user_id is bound), each title/notes
// blob DECRYPTED under the owner's `dek`. Never another person's tasks; an empty
// array when the person has none. A wrong DEK fails the GCM tag and rejects.
export async function listTasksForUser(db: Db, userId: string, dek: Uint8Array): Promise<Task[]> {
  const result = await db.query(
    `SELECT ${SELECT_COLUMNS} FROM tasks WHERE user_id = $1`,
    [userId],
  );
  return decryptRows(result.rows, dek);
}

// The AGENT-SCOPED read: the owner's tasks whose assignee is this `agentId` OR
// 'any' (member-scoped by user_id AND filtered by assignee), DECRYPTED. Never
// another person's tasks, and never a task assigned to a different specific agent.
export async function tasksForAgent(
  db: Db,
  userId: string,
  agentId: string,
  dek: Uint8Array,
): Promise<Task[]> {
  const result = await db.query(
    `SELECT ${SELECT_COLUMNS} FROM tasks WHERE user_id = $1 AND (assignee = $2 OR assignee = 'any')`,
    [userId, agentId],
  );
  return decryptRows(result.rows, dek);
}

// Update the owner's own task (member-scoped: both id AND user_id are bound),
// re-encrypting the title and updating the plaintext metadata (assignee, status).
// LEAVES the notes untouched. THROWS when no such task belongs to this user — so
// one person can never edit another's task.
export async function updateTask(db: Db, input: UpdateTaskInput, dek: Uint8Array): Promise<Task> {
  const titleEnvelope = await encrypt(dek, TABLE, TITLE_COLUMN, input.id, input.title);

  const result = await db.query(
    `UPDATE tasks
     SET title = $3, assignee = $4, status = $5
     WHERE id = $1 AND user_id = $2
     RETURNING ${SELECT_COLUMNS}`,
    [input.id, input.userId, titleEnvelope, input.assignee, input.status],
  );

  const row = result.rows[0];
  if (!row) {
    throw new Error("updateTask: no such task for this user");
  }
  const notes = await decryptNotes(row, dek);
  return toTask(row, input.title, notes);
}

// APPEND one note (author + text) to the owner's own task's notes, keeping the
// existing notes; re-encrypt the notes blob. Member-scoped: both id AND user_id
// are bound. THROWS when no such task belongs to this user. Returns the task with
// the note appended.
export async function addNote(db: Db, input: AddNoteInput, dek: Uint8Array): Promise<Task> {
  const existing = await db.query(
    `SELECT ${SELECT_COLUMNS} FROM tasks WHERE id = $1 AND user_id = $2`,
    [input.id, input.userId],
  );
  const row = existing.rows[0];
  if (!row) {
    throw new Error("addNote: no such task for this user");
  }

  const title = await decrypt(dek, TABLE, TITLE_COLUMN, row.id as string, row.title as string);
  const notes = await decryptNotes(row, dek);
  const appended = [...notes, { author: input.author, text: input.text }];
  const notesEnvelope = await encrypt(dek, TABLE, NOTES_COLUMN, input.id, JSON.stringify(appended));

  await db.query(
    `UPDATE tasks SET notes = $3 WHERE id = $1 AND user_id = $2`,
    [input.id, input.userId, notesEnvelope],
  );

  return toTask(row, title, appended);
}

// Mark the owner's own task done (member-scoped: both id AND user_id are bound).
// DEK-FREE (status is plaintext metadata, so no title/notes are touched). Returns
// true when it marked one, false when none matched — so one person can never
// complete another's task.
export async function completeTask(
  db: Db,
  input: { readonly userId: string; readonly id: string },
): Promise<boolean> {
  const result = await db.query(
    `UPDATE tasks SET status = 'done' WHERE id = $1 AND user_id = $2 RETURNING id`,
    [input.id, input.userId],
  );
  return result.rows.length > 0;
}

// Decrypt one row's notes blob under the owner's DEK back to the notes array.
async function decryptNotes(row: Row, dek: Uint8Array): Promise<TaskNote[]> {
  const plaintext = await decrypt(dek, TABLE, NOTES_COLUMN, row.id as string, row.notes as string);
  return JSON.parse(plaintext) as TaskNote[];
}

// Decrypt each row's title and notes under the owner's DEK and assemble the tasks.
async function decryptRows(rows: Row[], dek: Uint8Array): Promise<Task[]> {
  const tasks: Task[] = [];
  for (const row of rows) {
    const title = await decrypt(dek, TABLE, TITLE_COLUMN, row.id as string, row.title as string);
    const notes = await decryptNotes(row, dek);
    tasks.push(toTask(row, title, notes));
  }
  return tasks;
}
