// E14-S07 — the `list_tasks` / `create_task` / `update_task` / `complete_task` core
// tools (design §6.2 MCP core tools; brief "Tasks and hand-offs": "a task list the
// person and agents share: the person (or an agent) creates a task, assigns it to a
// specific agent or 'any agent', and agents pick it up, add notes and mark it done";
// constitution principle 14 "Warthog … SHALL record every tool call itself at the
// moment it handles it").
//
// `create_task` creates ONE task FOR the CONNECTION's person, assigned to a specific
// agent or 'any' (defaulting to 'any'), created-by the connection's agent, status
// 'open'. `list_tasks` hands the agent back ONLY the tasks it may SEE — the person's
// tasks whose assignee is THIS agent or 'any' (the store's agent-scoped read), each
// title decrypted. `update_task` sets the status of (picks up) and/or appends an
// agent-authored note to a task the person OWNS; `complete_task` marks the person's
// own task done. Every tool is refused for a connection without the tasks permission.
//
// A SERVER module built purely from its INJECTED seams (the parameterizing `db`, the
// `KeyWrapper` that unwraps the person's DEK to encrypt the title / notes and decrypt
// on read; the tasks store takes no clock, so `clock` is unused here): it reads no
// `process.env` and holds no secret (INV-103). Each handler VALIDATES its input at the
// boundary (zod → a 4xx `HttpError` BEFORE any db access or crypto work, INV-102); the
// tasks store binds `user_id` / `assignee` / the ids as parameters and stores the
// title / notes DEK-encrypted as bound values, so a SQL-shaped field is inert data
// that cannot alter a query. The OWNING person and the agent are ALWAYS taken from the
// session `connection` (`connection.userId` owns; `connection.agentId` is the assignee
// scope and the task's / note's author; `connection.connectionId` keys the permission),
// never a value in the input — so one agent can never create against, read, or change
// another person's tasks. The tool call itself is recorded by the pipeline that routes
// these core tools (Warthog writes the record, principle 14).

import { savedByResolver, type SavedBy, type SavedByResolver } from "../../agents/saved-by";
import { z } from "zod";

import { validTaskAssignee, changeTaskAsAgent } from "../../db/task-handoffs";
import { systemClock } from "../../seams/clock";
import { parseParams } from "../../http/validate";
import { getConnectionPermissions, type ConnectionPermissions } from "../../db/agent-permissions";
import {
  createTask,
  tasksForAgent,
  type Task,
  type TaskStatus,
  type TaskNote,
  type TaskActor,
} from "../../db/tasks";
import { getUserById } from "../../db/users";
import type { KeyWrapper } from "../../crypto/key-wrapper";
import type { Clock } from "../../seams/clock";
import type { AgentConnection } from "../context";
import type { Db } from "../../db/index";

// Field caps, so a grossly oversized value is refused at the boundary before any db
// access (INV-102). A title and an assignee id are short; a note is a short line; a
// task id is an opaque uuid; `reason` matches the registry's envelope cap (design §6.2
// "every tool takes an optional reason").
const MAX_TITLE = 2000;
const MAX_ASSIGNEE = 500;
const MAX_NOTE = 4000;
const MAX_ID = 200;
const MAX_REASON = 2000;

// The universal OPTIONAL `reason` every core tool carries (design §6.2).
const reason = z.string().max(MAX_REASON).optional();

// list_tasks' input: nothing but the universal OPTIONAL `reason` (the owning person
// and the agent scope come from the connection). A z.object, so its `.shape` exposes
// each field.
export const listTasksSchema = z.object({ reason });

// create_task's input: a REQUIRED non-empty `title`, an OPTIONAL `assignee` (a
// specific agent id, defaulting to 'any'), plus the universal OPTIONAL `reason`.
export const createTaskSchema = z.object({
  title: z.string().min(1).max(MAX_TITLE),
  assignee: z.string().min(1).max(MAX_ASSIGNEE).optional(),
  reason,
});

// update_task's input: a REQUIRED non-empty `id`, an OPTIONAL `status` (pick it up)
// and an OPTIONAL `note` to append, plus the universal OPTIONAL `reason`.
export const updateTaskSchema = z.object({
  id: z.string().min(1).max(MAX_ID),
  status: z.enum(["open", "in_progress", "done"]).optional(),
  note: z.string().min(1).max(MAX_NOTE).optional(),
  reason,
});

// complete_task's input: a REQUIRED non-empty `id` plus the universal OPTIONAL `reason`.
export const completeTaskSchema = z.object({
  id: z.string().min(1).max(MAX_ID),
  reason,
});

// The injected seams — no process.env (INV-103). `db` is the parameterizing seam the
// permission lookup and the tasks store read through; `keyWrapper` unwraps the person's
// DEK so titles / notes are encrypted on write / decrypted on read; `clock` is harmless
// if unused (the tasks store takes no clock).
export interface TasksToolDeps {
  readonly db: Db;
  readonly keyWrapper: KeyWrapper;
  readonly clock?: Clock;
}

// One task as handed to the agent (title and notes DECRYPTED under the owner's DEK).
export interface TaskView {
  readonly id: string;
  readonly title: string;
  readonly assignee: string;
  readonly status: TaskStatus;
  readonly notes: ReadonlyArray<TaskNote>;
  readonly createdBy: TaskActor;
  readonly savedBy?: SavedBy;
  readonly claimedBy?: string;
  readonly claimExpiresAt?: string;
}

export type ListTasksResult =
  | { status: "ok"; tasks: ReadonlyArray<TaskView> }
  | { status: "refused"; reason: string };

export type CreateTaskResult =
  | { status: "created"; id: string }
  | { status: "refused"; reason: string };

export type UpdateTaskResult =
  | { status: "updated"; id: string; claimExpiresAt?: string | null }
  | { status: "refused"; reason: string };

export type CompleteTaskResult =
  | { status: "completed"; id: string }
  | { status: "refused"; reason: string };

export interface ListTasksTool {
  readonly name: string;
  readonly inputSchema: z.ZodType;
  handle(input: unknown, connection: AgentConnection): Promise<ListTasksResult>;
}

export interface CreateTaskTool {
  readonly name: string;
  readonly inputSchema: z.ZodType;
  handle(input: unknown, connection: AgentConnection): Promise<CreateTaskResult>;
}

export interface UpdateTaskTool {
  readonly name: string;
  readonly inputSchema: z.ZodType;
  handle(input: unknown, connection: AgentConnection): Promise<UpdateTaskResult>;
}

export interface CompleteTaskTool {
  readonly name: string;
  readonly inputSchema: z.ZodType;
  handle(input: unknown, connection: AgentConnection): Promise<CompleteTaskResult>;
}

// The plain refusals. A connection with neither the read nor the change class for this
// tool has no tasks permission; a change tool against a task that is not the person's
// own refuses rather than throwing.
const NO_PERMISSION_REASON = "This agent does not have permission to use tasks.";

// Map a decrypted store task to the view handed to the agent (the owning userId stays
// out of the result).
function toView(task: Task, savedBy?: SavedByResolver): TaskView {
  return {
    id: task.id,
    title: task.title,
    assignee: task.assignee,
    status: task.status,
    notes: task.notes,
    createdBy: task.createdBy,
    // Who created it, as this agent reads it (write provenance).
    ...(savedBy ? { savedBy: savedBy(task.createdBy.kind === "agent" ? task.createdBy.agentId : null) } : {}),
    ...(task.claimedBy ? {claimedBy:task.claimedBy,claimExpiresAt:task.claimExpiresAt} : {}),
  };
}

// Resolve the person's unwrapped 256-bit DEK: read their wrapped DEK member-scoped by
// `userId` (the session's, never a client value) and unwrap it through the KeyWrapper
// seam. Throws when the person has no row — never fails silently.
async function dataKeyFor(db: Db, keyWrapper: KeyWrapper, userId: string): Promise<Uint8Array> {
  const user = await getUserById(db, userId);
  if (!user) {
    throw new Error("tasks tool: no data key for this user");
  }
  return keyWrapper.unwrap(user.wrappedDek);
}

// The connection's tasks permission, or null when it has none: its own `tasksAccess`
// grant (review fix A2 — the tasks grant the person set on the consent screen or
// permissions page, no longer the connector tool classes `readTools` / `changeTools`).
// It covers reads and changes alike; `kind` is kept for the callers. Keyed by
// `connection.connectionId` member-scoped by `connection.userId`, exactly the grant
// the person set.
async function tasksPermission(
  db: Db,
  connection: AgentConnection,
  kind: "read" | "change",
): Promise<ConnectionPermissions | null> {
  const permissions = await getConnectionPermissions(db, connection.userId, connection.connectionId);
  if (!permissions || !permissions.tasksAccess || (kind === "change" && permissions.resourceControls?.tasksWrite === false)) return null;
  return permissions;
}

export function createListTasksTool(deps: TasksToolDeps): ListTasksTool {
  const { db, keyWrapper } = deps;

  return {
    name: "list_tasks",
    inputSchema: listTasksSchema,

    async handle(input: unknown, connection: AgentConnection): Promise<ListTasksResult> {
      // VALIDATE at the boundary: a bad / oversized / mis-shaped input throws a 4xx
      // `HttpError` BEFORE any db access or crypto work (INV-102).
      parseParams(listTasksSchema, input);

      // Refuse a connection without the tasks READ permission.
      const permissions = await tasksPermission(db, connection, "read");
      if (!permissions) {
        return { status: "refused", reason: NO_PERMISSION_REASON };
      }

      // Read ONLY what this agent may see — the person's tasks assigned to it or to
      // 'any' — member-scoped by the CONNECTION's person and filtered by the
      // CONNECTION's agent (both from the session, never the input), titles decrypted.
      const dek = await dataKeyFor(db, keyWrapper, connection.userId);
      const tasks = await tasksForAgent(db, connection.userId, connection.agentId, dek);

      const savedBy = await savedByResolver(db, connection.userId, connection.agentId);
      return { status: "ok", tasks: tasks.map((task) => toView(task, savedBy)) };
    },
  };
}

export function createCreateTaskTool(deps: TasksToolDeps): CreateTaskTool {
  const { db, keyWrapper } = deps;

  return {
    name: "create_task",
    inputSchema: createTaskSchema,

    async handle(input: unknown, connection: AgentConnection): Promise<CreateTaskResult> {
      // VALIDATE at the boundary (INV-102) BEFORE any db access or crypto work.
      const parsed = parseParams(createTaskSchema, input);

      // Refuse a connection without the tasks CHANGE permission — nothing is created.
      const permissions = await tasksPermission(db, connection, "change");
      if (!permissions) {
        return { status: "refused", reason: NO_PERMISSION_REASON };
      }

      // Create FOR the CONNECTION's person, created-by the CONNECTION's agent (never a
      // value in the input), assigned to the named agent or 'any'. The title is stored
      // DEK-encrypted through the parameterized store; the assignee travels as a bound
      // value, so a SQL-shaped field is inert data.
      const dek = await dataKeyFor(db, keyWrapper, connection.userId);
      if (!(await validTaskAssignee(db, connection.userId, parsed.assignee ?? "any"))) {
        return { status: "refused", reason: "Choose one of your connected agents or any agent." };
      }
      const task = await createTask(
        db,
        {
          userId: connection.userId,
          title: parsed.title,
          assignee: parsed.assignee ?? "any",
          createdBy: { kind: "agent", agentId: connection.agentId },
        },
        dek,
      );

      return { status: "created", id: task.id };
    },
  };
}

export function createUpdateTaskTool(deps: TasksToolDeps): UpdateTaskTool {
  const { db, keyWrapper } = deps;

  return {
    name: "update_task",
    inputSchema: updateTaskSchema,

    async handle(input: unknown, connection: AgentConnection): Promise<UpdateTaskResult> {
      // VALIDATE at the boundary (INV-102) BEFORE any db access or crypto work.
      const parsed = parseParams(updateTaskSchema, input);

      // Refuse a connection without the tasks CHANGE permission — nothing is changed.
      const permissions = await tasksPermission(db, connection, "change");
      if (!permissions) {
        return { status: "refused", reason: NO_PERMISSION_REASON };
      }

      const dek = await dataKeyFor(db, keyWrapper, connection.userId);
      const changed = await changeTaskAsAgent(db, {
        userId: connection.userId, agentId: connection.agentId,
        id: parsed.id, status: parsed.status, note: parsed.note,
      }, dek, (deps.clock ?? systemClock).now());
      return changed ? { status: "updated", id: parsed.id, ...changed }
        : { status: "refused", reason: "Task unavailable, completed, or claimed by another agent." };
    },
  };
}

export function createCompleteTaskTool(deps: TasksToolDeps): CompleteTaskTool {
  const { db, keyWrapper } = deps;

  return {
    name: "complete_task",
    inputSchema: completeTaskSchema,

    async handle(input: unknown, connection: AgentConnection): Promise<CompleteTaskResult> {
      // VALIDATE at the boundary (INV-102) BEFORE any db access.
      const parsed = parseParams(completeTaskSchema, input);

      // Refuse a connection without the tasks CHANGE permission — nothing is changed.
      const permissions = await tasksPermission(db, connection, "change");
      if (!permissions) {
        return { status: "refused", reason: NO_PERMISSION_REASON };
      }

      const dek = await dataKeyFor(db, keyWrapper, connection.userId);
      const done = await changeTaskAsAgent(db, {
        userId: connection.userId, agentId: connection.agentId, id: parsed.id, status: "done",
      }, dek, (deps.clock ?? systemClock).now());
      return done ? { status: "completed", id: parsed.id }
        : { status: "refused", reason: "Task unavailable, completed, or claimed by another agent." };
    },
  };
}
