// How the Tasks view organises the shared task list (the "tidy and organise" pass): tasks
// are grouped by their real statuses (open → "To do", in_progress → "In progress", done →
// "Done", collapsed), and the list can be narrowed with `?assignee=` to the tasks assigned
// to "any" agent or to one of the person's own agents.
//
// Plain functions with no "use client" directive, so the server page can validate the
// query parameter with the same rule the view applies.

import type { AgentOption, TaskAssigneeView, TaskStatus } from "./tasks-view";

export const TASK_STATUS_GROUPS: ReadonlyArray<{ status: TaskStatus; title: string; collapsible: boolean }> = [
  { status: "open", title: "To do", collapsible: false },
  { status: "in_progress", title: "In progress", collapsible: false },
  { status: "done", title: "Done", collapsible: true },
];

export type TaskGroup<T> = { status: TaskStatus; title: string; collapsible: boolean; tasks: T[] };

// The non-empty status groups in the fixed order, each keeping the loader's order.
export function groupTasksByStatus<T extends { readonly status: TaskStatus }>(tasks: readonly T[]): TaskGroup<T>[] {
  return TASK_STATUS_GROUPS.map((group) => ({ ...group, tasks: tasks.filter((task) => task.status === group.status) })).filter(
    (group) => group.tasks.length > 0,
  );
}

// The filter value for a task's assignee: "any", or the agent's id.
export const ANY_ASSIGNEE = "any";
export function assigneeKey(assignee: TaskAssigneeView): string {
  return assignee.kind === "agent" ? assignee.agentId : ANY_ASSIGNEE;
}

// The `?assignee=` value validated against the person's own agents: "any" or one of their
// agent ids. Anything else (missing, another person's agent, a crafted value) is no filter.
export function resolveAssigneeFilter(raw: string | undefined, agents: readonly AgentOption[]): string | undefined {
  if (raw === ANY_ASSIGNEE) return ANY_ASSIGNEE;
  return raw !== undefined && agents.some((agent) => agent.id === raw) ? raw : undefined;
}
