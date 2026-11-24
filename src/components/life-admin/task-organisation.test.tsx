// Tasks, organised (the founder's "tidy and organise" pass): the shared task list is
// grouped by its real statuses — To do (open), In progress, Done — with Done collapsed,
// and can be narrowed to one assignee with `?assignee=` links built from the person's own
// agents (validated against them; anything else is ignored). The applied filter shows as
// a removable chip, and a filter with no matches says so with a way back to every task.

import * as React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";

import { TasksView, type TaskItemView, type TasksViewProps } from "./tasks-view";
import { groupTasksByStatus, resolveAssigneeFilter } from "./task-groups";

const ZEPHYR = { id: "0b4c6c7e-1c1a-4b55-9a49-5e2f0d6d1a01", name: "Zephyr Assistant" };
const BRAVO = { id: "0b4c6c7e-1c1a-4b55-9a49-5e2f0d6d1a02", name: "Bravo Scheduler" };
const AGENTS = [ZEPHYR, BRAVO];
const noop = () => {};

function task(id: string, title: string, status: TaskItemView["status"], agent?: { id: string; name: string }): TaskItemView {
  return {
    id,
    title,
    status,
    notes: [],
    assignee: agent ? { kind: "agent", agentId: agent.id, agentName: agent.name } : { kind: "any" },
  };
}

const OPEN_ANY = task("t-open-any", "Return the faulty kettle", "open");
const OPEN_ZEPHYR = task("t-open-z", "Compare energy plans", "open", ZEPHYR);
const BUSY_ZEPHYR = task("t-busy-z", "Book the removalists", "in_progress", ZEPHYR);
const DONE_BRAVO = task("t-done-b", "Renew the car rego", "done", BRAVO);
const TASKS = [OPEN_ANY, BUSY_ZEPHYR, DONE_BRAVO, OPEN_ZEPHYR];

function render(over: Partial<TasksViewProps> = {}): string {
  return renderToStaticMarkup(
    <TasksView
      tasks={TASKS}
      agents={AGENTS}
      createTaskAction={noop}
      assignAction={noop}
      addNoteAction={noop}
      completeAction={noop}
      {...over}
    />,
  );
}

function text(markup: string): string {
  return markup
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function headings(markup: string, level: number): string[] {
  return [...markup.matchAll(new RegExp(`<h${level}\\b[^>]*>([\\s\\S]*?)</h${level}>`, "g"))].map((m) => text(m[1]!));
}

function links(markup: string): { href: string; current: boolean; text: string }[] {
  return [...markup.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)].map((m) => ({
    href: (/href="([^"]*)"/.exec(m[1]!)?.[1] ?? "").replace(/&amp;/g, "&"),
    current: /aria-current="page"/.test(m[1]!),
    text: text(m[2]!),
  }));
}

function filterNav(markup: string): string {
  const nav = /<nav\b[^>]*aria-label="Filter tasks by assignee"[^>]*>([\s\S]*?)<\/nav>/.exec(markup);
  assert.ok(nav, "the assignee filter renders");
  return nav![1]!;
}

// ─── the pure helpers ────────────────────────────────────────────────────────────────

test("groupTasksByStatus groups by the real statuses in a fixed order, Done collapsible, empty groups omitted", () => {
  const groups = groupTasksByStatus(TASKS);
  assert.deepEqual(
    groups.map((g) => [g.status, g.title, g.collapsible, g.tasks.map((t) => t.id)]),
    [
      ["open", "To do", false, ["t-open-any", "t-open-z"]],
      ["in_progress", "In progress", false, ["t-busy-z"]],
      ["done", "Done", true, ["t-done-b"]],
    ],
  );
  assert.deepEqual(groupTasksByStatus([DONE_BRAVO]).map((g) => g.status), ["done"]);
  assert.deepEqual(groupTasksByStatus([]), []);
});

test("resolveAssigneeFilter accepts 'any' or one of the person's own agents, nothing else", () => {
  assert.equal(resolveAssigneeFilter("any", AGENTS), "any");
  assert.equal(resolveAssigneeFilter(ZEPHYR.id, AGENTS), ZEPHYR.id);
  for (const raw of [undefined, "", "0b4c6c7e-1c1a-4b55-9a49-5e2f0d6d1a99", "__proto__", "Zephyr Assistant", "https://evil.test"]) {
    assert.equal(resolveAssigneeFilter(raw, AGENTS), undefined, `ignored: ${String(raw)}`);
  }
});

// ─── the grouped, filterable view ────────────────────────────────────────────────────

// The status groups' headings (each group's heading id is `tasks-<status>-heading`), leaving
// out the Create panel's and an empty state's headings.
function groupHeadings(markup: string): string[] {
  return [...markup.matchAll(/<h2\b[^>]*id="tasks-[a-z_]+-heading"[^>]*>([\s\S]*?)<\/h2>/g)].map((m) => text(m[1]!));
}

test("the Tasks view leaves the page title to the Life admin heading band and doesn't repeat the tab's label", () => {
  // UI/UX pass: the h1 and the Records | Tasks tabs live in LifeAdminScreen's heading band, so
  // the view starts with its Create panel (no h1, no h2 "Tasks").
  const markup = render();
  assert.doesNotMatch(markup, /<h1\b/);
  assert.ok(!headings(markup, 2).includes("Tasks"));
  assert.equal(headings(markup, 2)[0], "Create a task");
});

test("tasks are grouped To do, In progress, Done with counts; Done starts collapsed", () => {
  const markup = render();
  assert.deepEqual(groupHeadings(markup), ["To do", "In progress", "Done"]);
  assert.match(text(markup), /To do 2 .*In progress 1 .*Done 1/);
  const details = [...markup.matchAll(/<details\b([^>]*)>\s*<summary\b[^>]*>([\s\S]*?)<\/summary>/g)];
  const done = details.find((m) => /^Done 1$/.test(text(m[2]!)));
  assert.ok(done, "Done is a disclosure");
  assert.doesNotMatch(done![1]!, /\bopen\b/, "Done is collapsed by default");
  assert.ok(!details.some((m) => /^(To do|In progress)\b/.test(text(m[2]!))), "To do and In progress are always open");
  // Inside each group the loader's order is kept.
  assert.ok(markup.indexOf("Return the faulty kettle") < markup.indexOf("Compare energy plans"));
});

test("a task row keeps Mark done visible and its assign / note controls behind one Manage disclosure", () => {
  const markup = render({ tasks: [OPEN_ZEPHYR] });
  const manage = [...markup.matchAll(/<summary\b[^>]*>([\s\S]*?)<\/summary>/g)].filter((m) => /^Manage\b/.test(text(m[1]!)));
  assert.equal(manage.length, 1);
  assert.equal(text(manage[0]![1]!), "Manage Compare energy plans");
  const at = markup.indexOf(manage[0]![0]);
  assert.match(text(markup.slice(0, at)), /Mark done/, "the one dominant action stays on the row");
  assert.match(markup.slice(at), /name="assignee"/);
  assert.match(markup.slice(at), /name="note"/);
});

test("a done task offers no Mark done (it is already done) but keeps its notes and controls", () => {
  const markup = render({ tasks: [DONE_BRAVO] });
  assert.doesNotMatch(text(markup), /Mark done/);
  assert.match(markup, /name="assignee"/);
  assert.match(text(markup), /Renew the car rego/);
});

test("assignee filter links come from the person's agents, with counts; All is current with no filter", () => {
  const nav = filterNav(render());
  assert.deepEqual(links(nav), [
    { href: "/life-admin?tab=tasks", current: true, text: "All 4" },
    { href: "/life-admin?assignee=any&tab=tasks", current: false, text: "Anyone 1" },
    { href: `/life-admin?assignee=${ZEPHYR.id}&tab=tasks`, current: false, text: "Zephyr Assistant 2" },
    { href: `/life-admin?assignee=${BRAVO.id}&tab=tasks`, current: false, text: "Bravo Scheduler 1" },
  ]);
});

test("an agent with no tasks is left out of the filter until it is the one selected", () => {
  const idle = { id: "0b4c6c7e-1c1a-4b55-9a49-5e2f0d6d1a03", name: "Idle Helper" };
  assert.doesNotMatch(filterNav(render({ agents: [...AGENTS, idle] })), /Idle Helper/);
  const selected = render({ agents: [...AGENTS, idle], assignee: idle.id });
  assert.ok(links(filterNav(selected)).some((l) => l.current && l.text === "Idle Helper 0"));
});

test("filtering to one assignee shows only their tasks, marks the link current and offers a removable chip", () => {
  const markup = render({ assignee: ZEPHYR.id });
  const body = text(markup);
  assert.match(body, /Compare energy plans/);
  assert.match(body, /Book the removalists/);
  assert.doesNotMatch(body, /Return the faulty kettle/);
  assert.doesNotMatch(body, /Renew the car rego/);
  assert.deepEqual(groupHeadings(markup), ["To do", "In progress"]);
  assert.ok(links(filterNav(markup)).some((l) => l.current && l.text === "Zephyr Assistant 2"));
  const chips = /<ul\b[^>]*aria-label="Applied filters"[^>]*>([\s\S]*?)<\/ul>/.exec(markup);
  assert.ok(chips, "the applied filter is listed");
  assert.deepEqual(links(chips![1]!), [{ href: "/life-admin?tab=tasks", current: false, text: "Remove filter Assigned to: Zephyr Assistant" }]);
  assert.ok(links(markup).some((l) => l.text === "Clear all filters" && l.href === "/life-admin?tab=tasks"));
});

test("while filtered, each task form returns to the same filter", () => {
  const filtered = render({ assignee: ZEPHYR.id });
  const returns = [...filtered.matchAll(/name="returnAssignee" value="([^"]*)"/g)].map((m) => m[1]);
  assert.ok(returns.length >= 3, "assign, note and complete forms carry the filter");
  assert.ok(returns.every((value) => value === ZEPHYR.id));
  assert.doesNotMatch(render(), /name="returnAssignee"/, "no filter, nothing to return to");
});

test("'Anyone' narrows to tasks any agent may pick up", () => {
  const body = text(render({ assignee: "any" }));
  assert.match(body, /Return the faulty kettle/);
  assert.doesNotMatch(body, /Compare energy plans/);
  assert.match(body, /Remove filter Assigned to: Anyone/);
});

test("a filter that matches nothing says so and links back to every task", () => {
  const idle = { id: "0b4c6c7e-1c1a-4b55-9a49-5e2f0d6d1a03", name: "Idle Helper" };
  const markup = render({ agents: [...AGENTS, idle], assignee: idle.id });
  assert.match(text(markup), /No tasks for Idle Helper/);
  assert.ok(links(markup).some((l) => l.text === "Show all tasks" && l.href === "/life-admin?tab=tasks"));
  assert.deepEqual(groupHeadings(markup), []);
});

test("an unknown assignee is ignored: every task shows and no chip appears", () => {
  const markup = render({ assignee: "0b4c6c7e-1c1a-4b55-9a49-5e2f0d6d1a99" });
  assert.match(text(markup), /Return the faulty kettle/);
  assert.match(text(markup), /Renew the car rego/);
  assert.doesNotMatch(markup, /aria-label="Applied filters"/);
  assert.ok(links(filterNav(markup)).some((l) => l.current && l.text === "All 4"));
});

test("with no tasks there is no filter, only the empty state and Create", () => {
  const markup = render({ tasks: [] });
  assert.doesNotMatch(markup, /Filter tasks by assignee/);
  assert.match(text(markup), /No tasks yet/);
  assert.match(text(markup), /Create a task/);
});

test("when every task shares one assignee the filter is left out (nothing to narrow)", () => {
  assert.doesNotMatch(render({ tasks: [OPEN_ANY] }), /Filter tasks by assignee/);
});

test("when only Done tasks remain the list says everything is done", () => {
  assert.match(text(render({ tasks: [DONE_BRAVO] })), /Everything here is done\./);
});

test("the organised tasks view uses tokens, never raw hex", () => {
  assert.doesNotMatch(render({ assignee: ZEPHYR.id }), /#[0-9a-fA-F]{3,8}\b/);
});
