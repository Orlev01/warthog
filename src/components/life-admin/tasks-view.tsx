"use client";

import * as React from "react";
import { CheckCircle, CheckCircle2, ChevronDown, Circle, Clock, ClipboardList, Settings2, type LucideIcon } from "lucide-react";

import { Button, buttonClasses } from "@/components/ui/button";
import { ButtonLink } from "@/components/ui/button-link";
import { Field, SelectField, TextareaField } from "@/components/ui/field";
import { EmptyState } from "@/components/ui/empty";
import { ListGroup, LIST_ROW } from "@/components/ui/list-group";
import { ListToolbar } from "@/components/ui/list-toolbar";
import { ActionForm, FormSubmit, PendingFormFields } from "@/components/ui/form-submit";
import { ActiveFilters, FilterLinks } from "@/components/ui/filter-links";
import { WorkspacePanel } from "@/components/shell/workspace-surfaces";
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
// set (no clock / DB / session / crypto in the view). The page heading (and the Records |
// Tasks views) belong to LifeAdminScreen, so this view starts at its first panel.
//
// Layout (the UI/UX pass): a "Create a task" panel that is always open (one field and one
// button, so a half-typed task survives switching views), the assignee filter in one
// bounded toolbar, then the status groups as panels with divider rows. Every form is a
// guarded ActionForm (one submission per click), and a title made only of spaces is refused
// before it is sent.
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
// action is not supplied renders DISABLED with a one-line reason tied to it. Colour comes
// from the design tokens (globals.css) and shared components, never a raw hex.

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

// A live claim: which agent is working on the task and until when. `until` is the
// loader's wording of the expiry in the person's own time zone ("12 Nov 2026, 6:17 pm").
export type TaskClaimView = { agentName: string; expiresAt: string; until?: string };

export type TaskItemView = {
  id: string;
  title: string;
  notes: ReadonlyArray<TaskNoteView>;
  assignee: TaskAssigneeView;
  status: TaskStatus;
  claim?: TaskClaimView;
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

// ─── styling (shared primitives and design tokens; no raw hex) ───────────────────────

// A <summary> that looks like a small Button, with the disclosure marker hidden because
// the label and its chevron say what opens.
const MANAGE_SUMMARY_CLASS = buttonClasses({
  variant: "ghost",
  size: "sm",
  className: "w-fit list-none [&::-webkit-details-marker]:hidden",
});

const HINT_CLASS = "text-sm text-fg-muted";

// A title must contain something other than spaces (the server refuses one that doesn't,
// too); checked before sending so the draft stays as typed.
const NOT_BLANK = ".*\\S.*";

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
// The native `disabled` attribute does the disabling, and a one-line reason says why; the
// reason is tied to the button so a screen reader announces it with the control.
function DisabledControl({ label, reason }: { label: string; reason: string }) {
  const reasonId = React.useId();
  return (
    <div className="flex flex-col gap-1">
      <Button variant="secondary" disabled aria-describedby={reasonId} className="w-fit">
        {label}
      </Button>
      <p id={reasonId} className={HINT_CLASS}>
        {reason}
      </p>
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
    <span className="inline-flex items-center gap-1.5 text-sm font-medium text-fg">
      <Icon aria-hidden={true} className={`h-4 w-4 shrink-0 ${tone}`} />
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
    <ul className="flex max-w-prose flex-col gap-2">
      {notes.map((note, index) => (
        <li key={index} className="flex flex-col gap-0.5 rounded-field bg-surface-muted px-3 py-2">
          <p className="text-sm text-fg [overflow-wrap:anywhere]">{note.text}</p>
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
      <SelectField
        label="Assign to"
        id={fieldId}
        name="assignee"
        defaultValue={current}
        disabled
        hint="Assigning isn't available just now."
        width="text"
      >
        {options}
      </SelectField>
    );
  }
  return (
    <ActionForm action={assignAction} className="flex flex-col gap-3">
      <input type="hidden" name="taskId" value={task.id} />
      <ReturnFilter value={returnAssignee} />
      <PendingFormFields>
        <SelectField label="Assign to" id={fieldId} name="assignee" defaultValue={current} width="text">
          {options}
        </SelectField>
      </PendingFormFields>
      <div>
        <FormSubmit variant="secondary" size="sm" pendingLabel="Assigning…">
          Assign
        </FormSubmit>
      </div>
    </ActionForm>
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
      <TextareaField
        label="Add a note"
        id={fieldId}
        name="note"
        rows={2}
        disabled
        placeholder="Leave a note for whoever picks this up"
        hint="Adding a note isn't available just now."
      />
    );
  }
  return (
    <ActionForm action={addNoteAction} className="flex flex-col gap-3">
      <input type="hidden" name="taskId" value={task.id} />
      <ReturnFilter value={returnAssignee} />
      <PendingFormFields>
        <TextareaField
          label="Add a note"
          id={fieldId}
          name="note"
          rows={2}
          required
          maxLength={4000}
          placeholder="Leave a note for whoever picks this up"
        />
      </PendingFormFields>
      <div>
        <FormSubmit variant="secondary" size="sm" pendingLabel="Adding note…">
          Add a note
        </FormSubmit>
      </div>
    </ActionForm>
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
    <ActionForm action={completeAction}>
      <input type="hidden" name="taskId" value={task.id} />
      <ReturnFilter value={returnAssignee} />
      <FormSubmit variant="secondary" size="sm" pendingLabel="Marking done…">
        <CheckCircle2 aria-hidden={true} className="h-4 w-4 shrink-0" />
        Mark done<span className="sr-only">: {task.title}</span>
      </FormSubmit>
    </ActionForm>
  );
}

// One task as a divider row: its title and status, its current assignee (and claim), its
// notes, then one row of actions — "Mark done" (not offered once the task is done) beside a
// Manage disclosure holding the assign / add-note controls, named for the task so each one
// is distinguishable. An open Manage takes the full row width below the buttons.
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
        <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
          <p className="min-w-0 font-medium text-fg [overflow-wrap:anywhere]">{task.title}</p>
          <TaskStatusBadge status={task.status} />
        </div>

        <p className={HINT_CLASS}>{assigneeText(task.assignee)}</p>
        {task.claim ? (
          <p className={HINT_CLASS}>
            Claimed by {task.claim.agentName}
            {task.claim.until ? (
              <>
                {" "}until <time dateTime={task.claim.expiresAt}>{task.claim.until}</time>
              </>
            ) : null}
            . Reassigning it lets another agent pick it up.
          </p>
        ) : null}

        <TaskNotes notes={task.notes} />

        <div className="flex min-w-0 flex-wrap items-start gap-2">
          {task.status === "done" ? null : (
            <CompleteControl task={task} completeAction={completeAction} returnAssignee={returnAssignee} />
          )}
          <details className="group/manage min-w-0 open:basis-full">
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
      </div>
    </li>
  );
}

// ─── the tab-level CREATE control ────────────────────────────────────────────────────

// Always open, so an empty tab offers it and a half-typed title survives switching views.
// LIVE (a form bound to createTaskAction) when supplied; otherwise DISABLED with a reason.
function CreateControl({
  createTaskAction,
  hasAgents,
  returnAssignee,
}: {
  createTaskAction?: TasksAction;
  hasAgents: boolean;
  returnAssignee?: string;
}) {
  const fieldId = React.useId();
  const description = hasAgents
    ? "Assign it to an agent from its Manage menu, or leave it for any of your agents to pick up."
    : "It waits here until an agent picks it up.";
  if (!createTaskAction) {
    return (
      <WorkspacePanel title="Create a task" description={description}>
        <DisabledControl label="Create a task" reason="Creating a task isn't available just now." />
      </WorkspacePanel>
    );
  }
  return (
    <ActionForm action={createTaskAction}>
      <ReturnFilter value={returnAssignee} />
      <WorkspacePanel title="Create a task" description={description}>
        <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-end">
          <PendingFormFields>
            <Field
              label="What needs doing"
              id={fieldId}
              name="title"
              placeholder="Describe the task"
              required
              maxLength={2000}
              pattern={NOT_BLANK}
              title="Describe the task in a few words."
              className="sm:flex-1"
              width="full"
            />
          </PendingFormFields>
          <div className="shrink-0">
            <FormSubmit variant="primary" pendingLabel="Creating…">
              Create a task
            </FormSubmit>
          </div>
        </div>
      </WorkspacePanel>
    </ActionForm>
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
    <>
      <CreateControl createTaskAction={createTaskAction} hasAgents={agents.length > 0} returnAssignee={active} />

      {showFilter ? (
        <ListToolbar
          label="Find tasks"
          filters={
            <FilterLinks
              label="Filter tasks by assignee"
              variant="chips"
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
          }
          applied={
            <ActiveFilters
              clearHref={allHref}
              filters={activeLabel !== undefined ? [{ label: `Assigned to: ${activeLabel}`, removeHref: allHref }] : []}
            />
          }
        />
      ) : null}

      {tasks.length === 0 ? (
        <EmptyState
          icon={ClipboardList}
          heading="No tasks yet"
          description={
            agents.length > 0
              ? "Create one above, then assign it to an agent or leave it open for any of them to pick up."
              : "Tasks you create wait here for an agent to pick them up. Connect an agent so one can."
          }
          action={agents.length > 0 ? undefined : <ButtonLink href="/agents/connect" variant="primary">Connect your first agent</ButtonLink>}
        />
      ) : shown.length === 0 ? (
        <EmptyState
          heading={`No tasks for ${activeLabel ?? "this filter"}`}
          description={`Nothing here is assigned to ${activeLabel ?? "them"}.`}
          action={<ButtonLink href={allHref}>Show all tasks</ButtonLink>}
        />
      ) : (
        <>
          {allDone ? (
            <ListGroup id="tasks-open" title={<StatusGroupTitle status="open" title="To do" />} count={0}>
              <li className={LIST_ROW}>
                <EmptyState variant="inline" icon={CheckCircle} heading="Everything here is done." description="Create a task above when something new comes up." />
              </li>
            </ListGroup>
          ) : null}
          {groups.map((group) => (
            <ListGroup
              key={group.status}
              id={`tasks-${group.status}`}
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
        </>
      )}
    </>
  );
}

export default TasksView;
