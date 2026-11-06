"use client";

import * as React from "react";
import { CheckCircle, Circle, Clock, type LucideIcon } from "lucide-react";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/field";
import { EmptyState } from "@/components/ui/empty";

// E14-S12 — Tasks view component (src/components/life-admin/tasks-view.tsx).
//
// The Tasks tab is where the person and their agents hand work off to each other
// (brief "Tasks and hand-offs"; design §4.1; CLAUDE.md vocabulary). A TASK is created
// with a title, ASSIGNED to a specific agent or to 'any' agent, picked up, annotated
// with NOTES and marked DONE. This tab is the shared, visible list of those hand-offs:
// it renders EVERY task with its title, its current assignee and its status, the notes
// already on it (including the ones AGENTS contributed, labelled as reported by that
// agent — constitution 14), and the four controls that drive a hand-off: CREATE (tab
// level), ASSIGN, ADD-NOTE and COMPLETE (per task).
//
// This is the pure, prop-driven VIEW (a Client Component in the app): it renders FROM
// the props a later Life Admin page loader hands it — titles and notes already
// DECRYPTED, the assignee already resolved to a display name, the server actions passed
// in — exactly the precedent the sibling life-admin / memory / inbox / connectors views
// set (no clock / DB / session / crypto in the view).
//
// No control may ever be dead (constitution: "No dead controls"): a control whose server
// action is not supplied renders DISABLED with a one-line reason. Colour comes from the
// design tokens (globals.css) and shared components, never a raw hex.

// ─── the prop contract this task introduces ─────────────────────────────────────────

export type TaskStatus = "open" | "in_progress" | "done";

// Who authored a note (plaintext metadata on the db side): the signed-in person, or a
// specific connected agent — carried here with its display name for attribution.
export type TaskActorView =
  | { kind: "person" }
  | { kind: "agent"; agentId: string; agentName: string };

// One note on a task — part of the (already-decrypted) notes list.
export type TaskNoteView = {
  author: TaskActorView;
  text: string;
};

// The current assignee: 'any' agent, or a specific agent (id + resolved display name).
export type TaskAssigneeView =
  | { kind: "any" }
  | { kind: "agent"; agentId: string; agentName: string };

export type TaskItemView = {
  id: string;
  title: string;
  notes: ReadonlyArray<TaskNoteView>;
  assignee: TaskAssigneeView;
  status: TaskStatus;
};

// A connected agent a task may be assigned to.
export type AgentOption = { id: string; name: string };

// A control bound to a server action the page passes.
type TasksAction = (formData: FormData) => void | Promise<void>;

export type TasksViewProps = {
  tasks: ReadonlyArray<TaskItemView>;
  agents: ReadonlyArray<AgentOption>;
  // OPTIONAL server actions: a control whose action is supplied is LIVE; one with no
  // action renders DISABLED with a stated reason (no dead controls). The page (a later
  // task) always supplies them.
  createTaskAction?: TasksAction;
  assignAction?: TasksAction;
  addNoteAction?: TasksAction;
  completeAction?: TasksAction;
};

// ─── styling (design tokens; no raw hex) ─────────────────────────────────────────────
//
// Native control classes on the tokens, mirroring the sibling life-admin view. They omit
// the shared Button's `disabled:` variants so a LIVE control's class never reads as
// "disabled"; the one DISABLED control carries the native `disabled` attribute instead.
// The accent fill is the one primary action (Create / submit); everything else is the
// neutral surface.
const BTN_BASE =
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-card px-4 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-bg";
const BTN_PRIMARY = `${BTN_BASE} bg-accent text-accent-fg hover:bg-accent-hover`;
const BTN_SECONDARY = `${BTN_BASE} border border-line bg-surface text-fg hover:bg-surface-muted`;
const BTN_DISABLED = `${BTN_BASE} border border-line bg-surface text-fg-muted opacity-50`;

const SUMMARY_CLASS =
  "inline-flex w-fit cursor-pointer items-center gap-2 text-sm font-medium text-fg";
const CONTROL_CLASS =
  "min-h-11 w-full rounded-card border border-line bg-surface px-3 text-sm text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-bg";

// ─── a present-but-not-actionable control (no dead controls) ─────────────────────────
//
// The native `disabled` attribute does the disabling, and a one-line reason says why.
function DisabledControl({ label, reason }: { label: string; reason: string }) {
  return (
    <div className="flex flex-col gap-1">
      <button type="button" disabled className={BTN_DISABLED}>
        {label}
      </button>
      <p className="text-xs text-fg-muted">{reason}</p>
    </div>
  );
}

// ─── status (words + icon, never colour alone) ───────────────────────────────────────

type StatusMeta = { label: string; Icon: LucideIcon; tone: string };

const STATUS_META: Record<TaskStatus, StatusMeta> = {
  open: { label: "To do", Icon: Circle, tone: "text-fg-muted" },
  in_progress: { label: "In progress", Icon: Clock, tone: "text-warning" },
  done: { label: "Done", Icon: CheckCircle, tone: "text-success" },
};

function TaskStatusBadge({ status }: { status: TaskStatus }) {
  const { label, Icon, tone } = STATUS_META[status];
  return (
    <span className={["inline-flex items-center gap-1.5 text-sm font-medium", tone].join(" ")}>
      <Icon aria-hidden={true} className="h-4 w-4 shrink-0" />
      {label}
    </span>
  );
}

// ─── the current assignee, as readable text ──────────────────────────────────────────

function assigneeText(assignee: TaskAssigneeView): string {
  return assignee.kind === "agent" ? `Assigned to ${assignee.agentName}` : "Assigned to anyone";
}

// ─── notes (including agent-contributed, labelled as reported by that agent) ──────────

function noteAttribution(author: TaskActorView): string {
  return author.kind === "agent" ? `Reported by ${author.agentName}` : "You";
}

function TaskNotes({ notes }: { notes: ReadonlyArray<TaskNoteView> }) {
  if (notes.length === 0) return null;
  return (
    <ul className="flex flex-col gap-2">
      {notes.map((note, index) => (
        <li key={index} className="flex flex-col gap-0.5 rounded-card bg-surface-muted p-3">
          <p className="text-sm text-fg">{note.text}</p>
          <p className="text-xs text-fg-muted">{noteAttribution(note.author)}</p>
        </li>
      ))}
    </ul>
  );
}

// ─── per-task controls ───────────────────────────────────────────────────────────────

// The ASSIGN control: pick a specific agent or 'any' and submit. LIVE (a form bound to
// assignAction) when supplied; otherwise the picker renders DISABLED with a reason.
function AssignControl({
  task,
  agents,
  assignAction,
}: {
  task: TaskItemView;
  agents: ReadonlyArray<AgentOption>;
  assignAction?: TasksAction;
}) {
  const fieldId = React.useId();
  const current = task.assignee.kind === "agent" ? task.assignee.agentId : "any";
  const options = (
    <>
      <option value="any">Anyone</option>
      {agents.map((agent) => (
        <option key={agent.id} value={agent.id}>
          {agent.name}
        </option>
      ))}
    </>
  );
  if (!assignAction) {
    return (
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={fieldId}>Assign to</Label>
        <select id={fieldId} name="assignee" defaultValue={current} disabled className={CONTROL_CLASS}>
          {options}
        </select>
        <p className="text-xs text-fg-muted">Assigning isn't available just now.</p>
      </div>
    );
  }
  return (
    <form action={assignAction} className="flex flex-col gap-1.5">
      <input type="hidden" name="taskId" value={task.id} />
      <Label htmlFor={fieldId}>Assign to</Label>
      <select id={fieldId} name="assignee" defaultValue={current} className={CONTROL_CLASS}>
        {options}
      </select>
      <div>
        <button type="submit" className={BTN_SECONDARY}>
          Assign
        </button>
      </div>
    </form>
  );
}

// The ADD-NOTE control: leave a note on the task. LIVE (a form bound to addNoteAction)
// when supplied; otherwise the note entry renders DISABLED with a reason.
function AddNoteControl({ task, addNoteAction }: { task: TaskItemView; addNoteAction?: TasksAction }) {
  const fieldId = React.useId();
  if (!addNoteAction) {
    return (
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={fieldId}>Add a note</Label>
        <textarea
          id={fieldId}
          name="note"
          rows={2}
          disabled
          className={CONTROL_CLASS}
          placeholder="Leave a note for whoever picks this up"
        />
        <p className="text-xs text-fg-muted">Adding a note isn't available just now.</p>
      </div>
    );
  }
  return (
    <form action={addNoteAction} className="flex flex-col gap-1.5">
      <input type="hidden" name="taskId" value={task.id} />
      <Label htmlFor={fieldId}>Add a note</Label>
      <textarea
        id={fieldId}
        name="note"
        rows={2}
        className={CONTROL_CLASS}
        placeholder="Leave a note for whoever picks this up"
      />
      <div>
        <button type="submit" className={BTN_SECONDARY}>
          Add a note
        </button>
      </div>
    </form>
  );
}

// The COMPLETE control: mark the task done. LIVE (a form bound to completeAction) when
// supplied; otherwise DISABLED with a reason.
function CompleteControl({ task, completeAction }: { task: TaskItemView; completeAction?: TasksAction }) {
  if (!completeAction) {
    return <DisabledControl label="Mark done" reason="Completing isn't available just now." />;
  }
  return (
    <form action={completeAction}>
      <input type="hidden" name="taskId" value={task.id} />
      <button type="submit" className={BTN_SECONDARY}>
        Mark done
      </button>
    </form>
  );
}

// One task as a card: its title, status, current assignee, its notes and the per-task
// assign / add-note / complete controls.
function TaskCard({
  task,
  agents,
  assignAction,
  addNoteAction,
  completeAction,
}: {
  task: TaskItemView;
  agents: ReadonlyArray<AgentOption>;
  assignAction?: TasksAction;
  addNoteAction?: TasksAction;
  completeAction?: TasksAction;
}) {
  return (
    <li className="flex flex-col gap-3 rounded-card border border-line bg-surface p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-base font-semibold text-fg">{task.title}</h3>
        <TaskStatusBadge status={task.status} />
      </div>

      <p className="text-sm text-fg-muted">{assigneeText(task.assignee)}</p>

      <TaskNotes notes={task.notes} />

      <div className="flex flex-col gap-3">
        <AssignControl task={task} agents={agents} assignAction={assignAction} />
        <AddNoteControl task={task} addNoteAction={addNoteAction} />
        <CompleteControl task={task} completeAction={completeAction} />
      </div>
    </li>
  );
}

// ─── the tab-level CREATE control ────────────────────────────────────────────────────

// Revealed from a disclosure so an empty tab still offers it. LIVE (a form bound to
// createTaskAction) when supplied; otherwise DISABLED with a reason.
function CreateControl({ createTaskAction }: { createTaskAction?: TasksAction }) {
  const fieldId = React.useId();
  if (!createTaskAction) {
    return <DisabledControl label="Create a task" reason="Creating a task isn't available just now." />;
  }
  return (
    <details className="flex flex-col gap-3 rounded-card border border-line bg-surface p-4">
      <summary className={SUMMARY_CLASS}>Create a task</summary>
      <form action={createTaskAction} className="mt-2 flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={fieldId}>What needs doing</Label>
          <Input id={fieldId} name="title" placeholder="Describe the task" />
        </div>
        <div>
          <button type="submit" className={BTN_PRIMARY}>
            Create a task
          </button>
        </div>
      </form>
    </details>
  );
}

// ─── the view ────────────────────────────────────────────────────────────────────────

export function TasksView({
  tasks,
  agents,
  createTaskAction,
  assignAction,
  addNoteAction,
  completeAction,
}: TasksViewProps) {
  return (
    <section className="flex flex-col gap-4">
      <h2 className="text-lg font-semibold text-fg">Tasks</h2>

      <CreateControl createTaskAction={createTaskAction} />

      {tasks.length === 0 ? (
        <EmptyState
          heading="No tasks yet"
          description="Create one and assign it to an agent or leave it open for any of them to pick up."
        />
      ) : (
        <ul className="flex flex-col gap-3">
          {tasks.map((task) => (
            <TaskCard
              key={task.id}
              task={task}
              agents={agents}
              assignAction={assignAction}
              addNoteAction={addNoteAction}
              completeAction={completeAction}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

export default TasksView;
