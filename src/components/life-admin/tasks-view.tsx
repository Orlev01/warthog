"use client";

import * as React from "react";
import { CheckCircle, ChevronDown, Circle, Clock, Settings2, type LucideIcon } from "lucide-react";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/field";
import { EmptyState } from "@/components/ui/empty";
import { ListGroup, LIST_ROW } from "@/components/ui/list-group";
import { ActiveFilters, FilterLinks } from "@/components/ui/filter-links";
import { hrefWith } from "@/lib/href";
import { ANY_ASSIGNEE, assigneeKey, groupTasksByStatus, resolveAssigneeFilter } from "./task-groups";

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
// Organisation (the "tidy and organise" pass): the list is grouped by the real statuses —
// To do (open), In progress, Done (collapsed) — each keeping the loader's oldest-first
// order. `?assignee=` narrows it to tasks for "any" agent or one of the person's own
// agents (validated against `agents`; anything else is ignored), shown as filter links
// with counts plus a removable chip. Each row keeps "Mark done" visible and puts Assign /
// Add a note behind one "Manage" disclosure. While filtered, every task form carries the
// filter back (`returnAssignee`) so the person lands on the same list.
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
  claim?: {agentName:string; expiresAt:string};
};

// A connected agent a task may be assigned to.
export type AgentOption = { id: string; name: string };

// A control bound to a server action the page passes.
type TasksAction = (formData: FormData) => void | Promise<void>;

export type TasksViewProps = {
  tasks: ReadonlyArray<TaskItemView>;
  agents: ReadonlyArray<AgentOption>;
  // The `?assignee=` filter: "any" or one of `agents`' ids. Anything else shows every task.
  assignee?: string;
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
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-full px-4 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-bg";
const BTN_PRIMARY = `${BTN_BASE} bg-accent text-accent-fg hover:bg-accent-hover`;
const BTN_SECONDARY = `${BTN_BASE} border border-line bg-surface text-fg hover:bg-surface-muted`;
const BTN_DISABLED = `${BTN_BASE} border border-line bg-surface text-fg-muted opacity-50`;

const SUMMARY_CLASS =
  "inline-flex w-fit cursor-pointer items-center gap-2 text-sm font-medium text-fg";
const CONTROL_CLASS =
  "min-h-11 w-full rounded-card border border-line bg-surface px-3 text-sm text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-bg";
const MANAGE_SUMMARY_CLASS =
  "inline-flex min-h-11 w-fit cursor-pointer list-none items-center gap-2 rounded-card text-sm font-medium text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus [&::-webkit-details-marker]:hidden";
const TEXT_LINK_CLASS =
  "inline-flex min-h-11 items-center px-2 text-sm font-medium text-fg underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus";

// The page the Tasks view lives on, and the query state its filter links keep.
const TASKS_PATH = "/life-admin";
const TASKS_STATE = { view: "tasks" } as const;

// While a filter is applied, each task form carries it back so the redirect after the
// action returns to the same filtered list.
function ReturnFilter({ value }: { value?: string }) {
  return value ? <input type="hidden" name="returnAssignee" value={value} /> : null;
}

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
  returnAssignee,
}: {
  task: TaskItemView;
  agents: ReadonlyArray<AgentOption>;
  assignAction?: TasksAction;
  returnAssignee?: string;
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
      <ReturnFilter value={returnAssignee} />
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
function AddNoteControl({
  task,
  addNoteAction,
  returnAssignee,
}: {
  task: TaskItemView;
  addNoteAction?: TasksAction;
  returnAssignee?: string;
}) {
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
      <ReturnFilter value={returnAssignee} />
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
function CompleteControl({
  task,
  completeAction,
  returnAssignee,
}: {
  task: TaskItemView;
  completeAction?: TasksAction;
  returnAssignee?: string;
}) {
  if (!completeAction) {
    return <DisabledControl label="Mark done" reason="Completing isn't available just now." />;
  }
  return (
    <form action={completeAction}>
      <input type="hidden" name="taskId" value={task.id} />
      <ReturnFilter value={returnAssignee} />
      <button type="submit" className={BTN_SECONDARY}>
        Mark done
      </button>
    </form>
  );
}

// One task as a divider row: its title and status, its current assignee (and claim), its
// notes, "Mark done" (not offered once the task is done) and a Manage disclosure holding
// the assign / add-note controls, named for the task so each one is distinguishable.
function TaskRow({
  task,
  agents,
  assignAction,
  addNoteAction,
  completeAction,
  returnAssignee,
}: {
  task: TaskItemView;
  agents: ReadonlyArray<AgentOption>;
  assignAction?: TasksAction;
  addNoteAction?: TasksAction;
  completeAction?: TasksAction;
  returnAssignee?: string;
}) {
  return (
    <li className={LIST_ROW}>
      <div className="flex min-w-0 flex-col gap-2">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <h4 className="min-w-0 text-sm font-medium text-fg">{task.title}</h4>
          <TaskStatusBadge status={task.status} />
        </div>

        <p className="text-sm text-fg-muted">{assigneeText(task.assignee)}</p>
        {task.claim && <p className="text-sm text-fg-muted">Claimed by {task.claim.agentName} until <time dateTime={task.claim.expiresAt}>{task.claim.expiresAt.replace("T", " ").replace(".000Z", " UTC")}</time>. Reassigning releases the claim.</p>}

        <TaskNotes notes={task.notes} />

        {task.status === "done" ? null : (
          <CompleteControl task={task} completeAction={completeAction} returnAssignee={returnAssignee} />
        )}

        <details className="group/manage">
          <summary className={MANAGE_SUMMARY_CLASS}>
            <Settings2 aria-hidden={true} className="h-4 w-4 shrink-0 text-fg-muted" />
            Manage<span className="sr-only"> {task.title}</span>
            <ChevronDown aria-hidden={true} className="h-4 w-4 shrink-0 text-fg-muted transition-transform group-open/manage:rotate-180" />
          </summary>
          <div className="mt-2 flex min-w-0 flex-col gap-4 border-s-2 border-line ps-4">
            <AssignControl task={task} agents={agents} assignAction={assignAction} returnAssignee={returnAssignee} />
            <AddNoteControl task={task} addNoteAction={addNoteAction} returnAssignee={returnAssignee} />
          </div>
        </details>
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

function StatusGroupTitle({ status, title }: { status: TaskStatus; title: string }) {
  const { Icon, tone } = STATUS_META[status];
  return (
    <span className="inline-flex items-center gap-1.5">
      <Icon aria-hidden={true} className={`h-4 w-4 shrink-0 ${tone}`} />
      {title}
    </span>
  );
}

export function TasksView({
  tasks,
  agents,
  assignee,
  createTaskAction,
  assignAction,
  addNoteAction,
  completeAction,
}: TasksViewProps) {
  const active = resolveAssigneeFilter(assignee, agents);
  const allHref = hrefWith(TASKS_PATH, TASKS_STATE);

  // Who the tasks are assigned to, with counts: "Anyone" and each of the person's agents
  // that has a task (or is the one selected). A task for an agent no longer on file is
  // only under All.
  const counts = new Map<string, number>();
  for (const task of tasks) {
    const key = assigneeKey(task.assignee);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const options = [{ key: ANY_ASSIGNEE, label: "Anyone" }, ...agents.map((agent) => ({ key: agent.id, label: agent.name }))].filter(
    (option) => (counts.get(option.key) ?? 0) > 0 || option.key === active,
  );
  const activeLabel = options.find((option) => option.key === active)?.label;
  // Only offer the filter when there is something to narrow (or one is applied).
  const showFilter = tasks.length > 0 && (options.length >= 2 || active !== undefined);

  const shown = active === undefined ? tasks : tasks.filter((task) => assigneeKey(task.assignee) === active);
  const groups = groupTasksByStatus(shown);
  const allDone = groups.length > 0 && groups.every((group) => group.status === "done");

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold tracking-tight text-fg">Life admin</h1>
      <section className="flex flex-col gap-4">
        <h2 className="text-lg font-semibold text-fg">Tasks</h2>

        <CreateControl createTaskAction={createTaskAction} />

        {showFilter ? (
          <div className="flex flex-col gap-2">
            <FilterLinks
              label="Filter tasks by assignee"
              items={[
                { label: "All", href: allHref, active: active === undefined, count: tasks.length },
                ...options.map((option) => ({
                  label: option.label,
                  href: hrefWith(TASKS_PATH, TASKS_STATE, { assignee: option.key }),
                  active: option.key === active,
                  count: counts.get(option.key) ?? 0,
                })),
              ]}
            />
            <ActiveFilters
              clearHref={allHref}
              filters={activeLabel !== undefined ? [{ label: `Assigned to: ${activeLabel}`, removeHref: allHref }] : []}
            />
          </div>
        ) : null}

        {tasks.length === 0 ? (
          <EmptyState
            heading="No tasks yet"
            description="Create one and assign it to an agent or leave it open for any of them to pick up."
          />
        ) : shown.length === 0 ? (
          <EmptyState
            heading={`No tasks for ${activeLabel ?? "this filter"}`}
            description={`Nothing here is assigned to ${activeLabel ?? "them"}.`}
            action={
              <a href={allHref} className={TEXT_LINK_CLASS}>
                Show all tasks
              </a>
            }
          />
        ) : (
          <div className="flex flex-col gap-6">
            {allDone ? <p className="text-sm text-fg-muted">Everything here is done.</p> : null}
            {groups.map((group) => (
              <ListGroup
                key={group.status}
                id={`tasks-${group.status}`}
                level={3}
                title={<StatusGroupTitle status={group.status} title={group.title} />}
                count={group.tasks.length}
                collapsible={group.collapsible}
              >
                {group.tasks.map((task) => (
                  <TaskRow
                    key={task.id}
                    task={task}
                    agents={agents}
                    assignAction={assignAction}
                    addNoteAction={addNoteAction}
                    completeAction={completeAction}
                    returnAssignee={active}
                  />
                ))}
              </ListGroup>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

export default TasksView;
