// E14-S12 — Tasks view component (src/components/life-admin/tasks-view.tsx).
//
// RED-first: src/components/life-admin/tasks-view.tsx does NOT exist yet, so importing
// `./tasks-view` throws and every test here fails until the builder adds the component.
// That absence is the entire point of test-first — do not implement anything to make
// these pass.
//
// WHY this component exists (brief "Tasks and hand-offs"; design §4.1; CLAUDE.md
// vocabulary): TASKS are how the person and their agents hand work off to each other.
// The person (or an agent) creates a task, ASSIGNS it to a specific agent or to "any"
// agent, and agents pick it up, add NOTES and mark it DONE. The Tasks tab is the shared
// list where those hand-offs become visible and actionable: it must render EVERY task
// with its title, its assignee (a specific agent or 'any') and its status, and offer the
// four controls that drive the hand-off — CREATE, ASSIGN, ADD-NOTE and COMPLETE —
// alongside the notes already on each task, including the ones AGENTS contributed.
//
// This is the pure, prop-driven VIEW (a Client Component in the app): it renders the
// Tasks tab FROM the props a later Life Admin page loader hands it — titles and notes
// already DECRYPTED, the assignee already resolved to a display name, the server actions
// passed in — exactly the precedent the sibling life-admin / memory / inbox / connectors
// views set (pre-formatted values in; no clock / DB / session / crypto in the view). The
// real page wiring (reading the data, binding the server actions) lives in a LATER task;
// THIS component is pinnable without a browser, a session or any database.
//
// These tests pin BEHAVIOUR — what the component RENDERS for the props it is given (the
// task fields a person reads, the accessible controls, and the DISABLED / live state of
// each control) — never the source text of tasks-view.tsx. A later behaviour-preserving
// refactor (different wrapper elements, reworded-but-still-plain copy, a disclosure
// instead of a button, a <select> instead of radios, extra classes, a different icon)
// stays green. We render with `react-dom/server` (no DOM/jsdom — React component / E2E
// testing is a per-job ADR) and read the emitted markup, exactly as the sibling component
// tests do.
//
// THE CONTRACT the builder implements (test-first spec):
//
//   TasksView({ tasks, agents, createTaskAction?, assignAction?, addNoteAction?,
//               completeAction? }):
//     • tasks — the shared task list, each { id, title, notes, assignee, status },
//       rendered with its title, its assignee and its status.
//         · assignee is { kind: "any" } or { kind: "agent", agentId, agentName } — the
//           CURRENT assignee, shown as readable text (a specific agent's name, or 'any').
//         · status is "open" | "in_progress" | "done" — shown in WORDS (never colour
//           alone), distinctly per value.
//         · notes is an ordered list of { author, text }; a note authored by an agent
//           ({ kind: "agent", agentId, agentName }) is shown AGAINST its task and
//           attributed to that agent (constitution 14: agent-submitted content is
//           labelled as reported by that agent).
//     • agents — the connected agents a task may be assigned to; the assign control
//       offers each of them AND 'any' as a target.
//     • the *Action props are OPTIONAL server actions; a control whose action is supplied
//       is LIVE, and a control with no action renders DISABLED with a stated reason (no
//       dead controls). The CREATE control is offered at the tab level (even with no
//       tasks); ASSIGN / ADD-NOTE / COMPLETE are per task.
//
//   Colour comes from the design tokens (globals.css) and shared components — never a raw
//   hex literal.

import * as React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";

import { TasksView } from "./tasks-view";

// --- the prop shapes this task renders (declared locally so this client VIEW never
// couples to the server db modules; they mirror the E14-S07 tasks aggregate AFTER the
// loader has decrypted each task's title/notes and resolved the assignee to a display
// name) ------------------------------------------------------------------------------

type TaskStatus = "open" | "in_progress" | "done";

// Who authored a note (plaintext metadata on the db side): the signed-in person, or a
// specific connected agent — carried here with its display name for attribution.
type TaskActorView =
  | { kind: "person" }
  | { kind: "agent"; agentId: string; agentName: string };

// One note on a task — part of the (already-decrypted) notes list.
type TaskNoteView = {
  author: TaskActorView;
  text: string;
};

// The current assignee: 'any' agent, or a specific agent (id + resolved display name).
type TaskAssigneeView =
  | { kind: "any" }
  | { kind: "agent"; agentId: string; agentName: string };

type TaskItemView = {
  id: string;
  title: string;
  notes: ReadonlyArray<TaskNoteView>;
  assignee: TaskAssigneeView;
  status: TaskStatus;
};

// A connected agent a task may be assigned to.
type AgentOption = { id: string; name: string };

// A control bound to a server action the page passes.
type TasksAction = (formData: FormData) => void | Promise<void>;

type TasksViewProps = {
  tasks: ReadonlyArray<TaskItemView>;
  agents: ReadonlyArray<AgentOption>;
  createTaskAction?: TasksAction;
  assignAction?: TasksAction;
  addNoteAction?: TasksAction;
  completeAction?: TasksAction;
};

// --- fixtures -----------------------------------------------------------------------
//
// Distinctive, recognisable values so every "renders this value" assertion is honest —
// the string can only have come from the task under test. Titles and note texts avoid
// the control vocabulary the tests match on (create / add / new / assign / hand / give /
// note / comment / complete / done / finish / open / progress / any), so a control or a
// status assertion can never pass on an incidental word in a task's own content.

const AGENT_ZEPHYR: AgentOption = { id: "ag-zephyr", name: "Zephyr Assistant" };
const AGENT_BRAVO: AgentOption = { id: "ag-bravo", name: "Bravo Scheduler" };
const AGENTS: ReadonlyArray<AgentOption> = [AGENT_ZEPHYR, AGENT_BRAVO];

const T1: TaskItemView = {
  id: "t1",
  title: "Return the faulty kettle",
  assignee: { kind: "any" },
  status: "open",
  notes: [],
};

const T2: TaskItemView = {
  id: "t2",
  title: "Book the removalists",
  assignee: { kind: "agent", agentId: "ag-zephyr", agentName: "Zephyr Assistant" },
  status: "in_progress",
  notes: [],
};

const T3: TaskItemView = {
  id: "t3",
  title: "Find a cheaper energy plan",
  assignee: { kind: "any" },
  status: "done",
  notes: [],
};

const TASKS: ReadonlyArray<TaskItemView> = [T1, T2, T3];

// A task carrying notes from BOTH an agent and the person. The authoring agent
// (Pangolin Helper) is NEITHER the assignee NOR a member of the `agents` option list in
// the note test — so its name can only come from the note's attribution.
const T_WITH_NOTES: TaskItemView = {
  id: "t-notes",
  title: "Transfer the internet connection",
  assignee: { kind: "any" },
  status: "in_progress",
  notes: [
    {
      author: { kind: "agent", agentId: "ag-pangolin", agentName: "Pangolin Helper" },
      text: "Booked the changeover for the 12th",
    },
    { author: { kind: "person" }, text: "Great, locking it in" },
  ],
};

const noop: TasksAction = () => {};

// base() supplies EVERY action and the agents list, so a control is live unless a test
// deliberately omits its action. Individual tests override one collection / action to
// isolate the behaviour under test.
function base(overrides: Partial<TasksViewProps> = {}): TasksViewProps {
  return {
    tasks: TASKS,
    agents: AGENTS,
    createTaskAction: noop,
    assignAction: noop,
    addNoteAction: noop,
    completeAction: noop,
    ...overrides,
  };
}

function render(props: TasksViewProps): string {
  return renderToStaticMarkup(<TasksView {...props} />);
}

// Render a chosen set of tasks (the common case: one task, so a control / value assertion
// can only be satisfied by that task's content).
function renderTasks(
  tasks: ReadonlyArray<TaskItemView>,
  overrides: Partial<TasksViewProps> = {},
): string {
  return render(base({ tasks, ...overrides }));
}

// --- markup helpers (no DOM), mirrored from the sibling component tests -------------

function decode(s: string): string {
  return s
    .replace(/&amp;/gi, "&")
    .replace(/&#x27;/gi, "'")
    .replace(/&#39;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&nbsp;/gi, " ")
    .replace(/&middot;/gi, "·")
    .replace(/&#xb7;/gi, "·");
}

// Visible text of an HTML fragment: the words a sighted reader sees (an <svg> icon
// contributes none, and an attribute value like an input's `value` is NOT visible text —
// the tag is stripped whole), tags stripped and entities decoded.
function visibleText(markup: string): string {
  return decode(markup.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

function attr(attrs: string, name: string): string | null {
  const m = attrs.match(new RegExp(`\\b${name}="([^"]*)"`, "i"));
  return m ? m[1] : null;
}

// A boolean/valueless attribute present as its own token — ` disabled`, ` disabled=""`
// or ` disabled="disabled"` — but never the word inside another attribute's value.
function hasBoolAttr(attrs: string, name: string): boolean {
  return new RegExp(`(?:^|\\s)${name}(?:=(?:""|"${name}"))?(?=\\s|/|>|$)`, "i").test(" " + attrs);
}

type El = { attrs: string; inner: string };

function findAll(markup: string, tag: string): El[] {
  const out: El[] = [];
  for (const m of markup.matchAll(new RegExp(`<${tag}\\b([^>]*)>([\\s\\S]*?)</${tag}>`, "gi"))) {
    out.push({ attrs: m[1], inner: m[2] });
  }
  return out;
}

// id → the visible text of the <label for=id> that targets it.
function labelTextById(markup: string): Record<string, string> {
  const map: Record<string, string> = {};
  for (const l of findAll(markup, "label")) {
    const f = attr(l.attrs, "for");
    if (f) map[f] = visibleText(l.inner);
  }
  return map;
}

// The accessible NAME of a control element: its visible text, else its aria-label.
function controlFace(el: El): string {
  return (visibleText(el.inner) || attr(el.attrs, "aria-label") || "").trim();
}

// Whether an element is non-actionable: the native `disabled` attribute, or
// aria-disabled="true".
function isDisabled(el: El): boolean {
  return hasBoolAttr(el.attrs, "disabled") || attr(el.attrs, "aria-disabled") === "true";
}

// Names of every actionable (not-disabled) control: a live <button>, a live disclosure
// <summary>, a non-disabled input (by label / aria-label / value), a wrapping-label
// input, or an <option>. Reads RENDERED, LIVE affordances — never dead static text.
function selectableNames(markup: string): string[] {
  const labels = labelTextById(markup);
  const out: string[] = [];
  for (const b of findAll(markup, "button")) {
    if (isDisabled(b)) continue;
    out.push((visibleText(b.inner) || attr(b.attrs, "aria-label") || "").trim());
  }
  for (const s of findAll(markup, "summary")) {
    out.push((visibleText(s.inner) || attr(s.attrs, "aria-label") || "").trim());
  }
  for (const m of markup.matchAll(/<input\b([^>]*?)\/?>/gi)) {
    const attrs = m[1];
    if (hasBoolAttr(attrs, "disabled")) continue;
    const id = attr(attrs, "id");
    out.push(((id && labels[id]) || attr(attrs, "aria-label") || attr(attrs, "value") || "").trim());
  }
  for (const l of findAll(markup, "label")) {
    const im = l.inner.match(/<input\b([^>]*?)\/?>/i);
    if (!im || hasBoolAttr(im[1], "disabled")) continue;
    out.push(visibleText(l.inner));
  }
  for (const o of findAll(markup, "option")) out.push(visibleText(o.inner));
  return out.filter((n) => n.length > 0);
}

// The "say-why" surface of a render: visible text PLUS every title / aria-label. A
// disabled control that states its reason carries MORE of this than the same control
// live — the measure the sibling inbox / connectors / activity tests use.
function reasonSurface(markup: string): string {
  const parts = [visibleText(markup)];
  for (const m of markup.matchAll(/(?:title|aria-label)="([^"]*)"/gi)) parts.push(decode(m[1]));
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

// --- control vocabularies (accessible-name matchers; generous over plain wordings) --

// A task-CREATE control (tab level). Requires "create" or "task" so it can never be
// confused with the per-task "add a note" control.
const CREATE_RE = /\bcreate\b|new task|add (a |the )?task|add task/i;
// The per-task ASSIGN control (assign / re-assign / hand off / delegate / give to).
const ASSIGN_RE = /assign|re-?assign|hand (it|this|off|over)|delegate|give (it|this)?\s*to/i;
// The per-task ADD-NOTE control (add / leave a note; a comment).
const NOTE_RE = /add (a |the )?note|leave (a |the )?note|\bnote\b|comment/i;
// The per-task COMPLETE control (complete / mark done / finish). Matched on BUTTON /
// summary faces only, so the "done" STATUS word can never satisfy it.
const COMPLETE_RE = /complete|mark (it |as )?(done|complete)|mark done|mark complete|finish|\bdone\b/i;
// The 'any' assignment target.
const ANY_RE = /\bany\b|anyone|unassigned/i;
// Status words that carry NO collision with any control vocabulary.
const OPEN_STATUS_RE = /\bopen\b|to[\s-]?do|to start|not started|outstanding|waiting/i;
const PROGRESS_STATUS_RE = /in[\s_-]?progress|progress|started|under\s?way|doing/i;
// The "say-why" phrasing a disabled control carries (the sibling life-admin / inbox /
// connectors views say "… isn't available just now."). Generous over plain wordings; it
// must NOT match any LIVE control's copy, so a disabled control is distinguishable from a
// live one by the reason it adds.
const REASON_RE = /isn'?t available|not available|unavailable|just now|right now|can'?t|cannot|not set up|not configured|not connected/i;

// CREATE controls in a render: buttons / disclosure summaries whose face reads as
// creating a task.
function createControls(markup: string): El[] {
  return [...findAll(markup, "button"), ...findAll(markup, "summary")].filter((c) =>
    CREATE_RE.test(controlFace(c)),
  );
}

// ASSIGN controls in a render: buttons / summaries whose face reads as assigning, plus
// any <select> whose name / aria-label / <label for> text reads as the assignee picker
// (so an auto-submitting select with no submit button is still recognised).
function assignControls(markup: string): El[] {
  const labels = labelTextById(markup);
  const out: El[] = [];
  for (const c of [...findAll(markup, "button"), ...findAll(markup, "summary")]) {
    if (ASSIGN_RE.test(controlFace(c))) out.push(c);
  }
  for (const s of findAll(markup, "select")) {
    const id = attr(s.attrs, "id");
    const name = [attr(s.attrs, "name") || "", attr(s.attrs, "aria-label") || "", (id && labels[id]) || ""].join(" ");
    if (ASSIGN_RE.test(name)) out.push(s);
  }
  return out;
}

// ADD-NOTE controls in a render: buttons / summaries whose face reads as adding a note,
// plus any textarea / input whose name, aria-label, placeholder or <label for> text
// reads as a note entry.
function noteControls(markup: string): El[] {
  const labels = labelTextById(markup);
  const out: El[] = [];
  for (const c of [...findAll(markup, "button"), ...findAll(markup, "summary")]) {
    if (NOTE_RE.test(controlFace(c))) out.push(c);
  }
  for (const t of findAll(markup, "textarea")) {
    const id = attr(t.attrs, "id");
    const name = [attr(t.attrs, "name") || "", attr(t.attrs, "aria-label") || "", attr(t.attrs, "placeholder") || "", (id && labels[id]) || ""].join(" ");
    if (NOTE_RE.test(name)) out.push(t);
  }
  for (const m of markup.matchAll(/<input\b([^>]*?)\/?>/gi)) {
    const a = m[1];
    const id = attr(a, "id");
    const name = [attr(a, "name") || "", attr(a, "aria-label") || "", attr(a, "placeholder") || "", (id && labels[id]) || ""].join(" ");
    if (NOTE_RE.test(name)) out.push({ attrs: a, inner: "" });
  }
  return out;
}

// COMPLETE controls in a render: buttons / summaries whose face reads as marking a task
// done.
function completeControls(markup: string): El[] {
  return [...findAll(markup, "button"), ...findAll(markup, "summary")].filter((c) =>
    COMPLETE_RE.test(controlFace(c)),
  );
}

// ════════════════════════════════════════════════════════════════════════════════
// AC1 — each task renders with its title.
// ════════════════════════════════════════════════════════════════════════════════

test("renders each task's title", () => {
  const text = visibleText(render(base()));
  for (const title of ["Return the faulty kettle", "Book the removalists", "Find a cheaper energy plan"]) {
    assert.ok(text.includes(title), `a task title "${title}" must render; text="${text}"`);
  }
});

test("renders tasks from the props given, not a fixed list", () => {
  const onlyA = visibleText(renderTasks([{ ...T1, id: "x1", title: "Cancel the gym membership" }]));
  const onlyB = visibleText(renderTasks([{ ...T1, id: "x2", title: "Organise the garage sale" }]));
  assert.ok(onlyA.includes("Cancel the gym membership"), "render A shows A's task");
  assert.ok(!onlyA.includes("Organise the garage sale"), "render A must not show B's task");
  assert.ok(onlyB.includes("Organise the garage sale"), "render B shows B's task");
  assert.ok(!onlyB.includes("Cancel the gym membership"), "render B must not show A's task");
});

// ════════════════════════════════════════════════════════════════════════════════
// AC1 — each task renders with its assignee (a specific agent, or 'any').
// ════════════════════════════════════════════════════════════════════════════════

test("renders a task's assignee as the specific agent it is assigned to", () => {
  // The assignee's agent (Zephyr Assistant) is NOT in the agents option list, so its name
  // can only come from the CURRENT-assignee display — never an assign-control option.
  const markup = renderTasks([T2], { agents: [AGENT_BRAVO] });
  assert.ok(
    visibleText(markup).includes("Zephyr Assistant"),
    `a task assigned to a specific agent must SHOW that agent's name; text="${visibleText(markup)}"`,
  );
});

test("the shown assignee reflects whether the task is assigned to an agent or to 'any'", () => {
  // Same task, same agents option list (Bravo only, NOT Zephyr), differing only in
  // assignee. When assigned to Zephyr, the name shows (it is not an option); when assigned
  // to 'any', it does not — so the displayed assignee tracks the actual assignee.
  const toAgent = visibleText(renderTasks([T2], { agents: [AGENT_BRAVO] }));
  const toAny = visibleText(renderTasks([{ ...T2, assignee: { kind: "any" } }], { agents: [AGENT_BRAVO] }));

  assert.ok(toAgent.includes("Zephyr Assistant"), "assigned to Zephyr → the task shows Zephyr as its assignee");
  assert.ok(
    !toAny.includes("Zephyr Assistant"),
    "assigned to 'any' → the task must NOT show Zephyr as its assignee (the display tracks the real assignee)",
  );
  assert.match(toAny, ANY_RE, `a task assigned to 'any' must say so ('any' / anyone); text="${toAny}"`);
});

// ════════════════════════════════════════════════════════════════════════════════
// AC1 — each task renders with its status, in words (never colour alone), per value.
// ════════════════════════════════════════════════════════════════════════════════

test("renders each task's status in words, distinctly per status value", () => {
  // One task, FIXED in every respect except its status, so any difference across the
  // three renders can only be the status being shown (in words, not colour alone).
  const statusText = (status: TaskStatus) =>
    visibleText(renderTasks([{ id: "t-status", title: "Collect the spare keys", assignee: { kind: "any" }, status, notes: [] }]));

  const open = statusText("open");
  const inProgress = statusText("in_progress");
  const done = statusText("done");

  assert.match(open, OPEN_STATUS_RE, `an open task must show an open-ish status word; text="${open}"`);
  assert.match(inProgress, PROGRESS_STATUS_RE, `an in-progress task must show an in-progress status word; text="${inProgress}"`);

  // The three statuses render DISTINCTLY — status is carried in words, not colour alone.
  assert.notEqual(open, inProgress, "open and in-progress tasks must render different status text");
  assert.notEqual(open, done, "open and done tasks must render different status text");
  assert.notEqual(inProgress, done, "in-progress and done tasks must render different status text");
});

// ════════════════════════════════════════════════════════════════════════════════
// AC1 — the four hand-off controls: create, assign, add-note, complete.
// ════════════════════════════════════════════════════════════════════════════════

test("offers a task with live create, assign, add-note and complete controls", () => {
  // A single open task, every action supplied: all four controls must be present and LIVE.
  const markup = renderTasks([T1]);
  assert.ok(createControls(markup).some((c) => !isDisabled(c)), "a live Create control must be offered");
  assert.ok(assignControls(markup).some((c) => !isDisabled(c)), "the task must offer a live Assign control");
  assert.ok(noteControls(markup).some((c) => !isDisabled(c)), "the task must offer a live Add-note control");
  assert.ok(completeControls(markup).some((c) => !isDisabled(c)), "the task must offer a live Complete control");
});

test("the Create control is still offered on an empty task list (a person with no tasks can still create one)", () => {
  const markup = renderTasks([]);
  assert.ok(
    createControls(markup).some((c) => !isDisabled(c)),
    "an empty Tasks tab must still offer a live Create control",
  );
});

test("the assign control offers each connected agent AND 'any' as an assignment target", () => {
  const markup = renderTasks([T1], { agents: AGENTS });
  const names = selectableNames(markup);
  for (const agent of AGENTS) {
    assert.ok(
      names.some((n) => n.includes(agent.name)),
      `the assign control must offer "${agent.name}" as a target; selectables=${JSON.stringify(names)}`,
    );
  }
  assert.ok(names.some((n) => ANY_RE.test(n)), `the assign control must offer 'any' as a target; selectables=${JSON.stringify(names)}`);
});

// ════════════════════════════════════════════════════════════════════════════════
// AC1 — no dead controls: a control whose action is absent is DISABLED and says why.
// ════════════════════════════════════════════════════════════════════════════════

test("the Create control is DISABLED with a reason when no create action is configured (no dead controls)", () => {
  const live = renderTasks([T1]);
  const dead = renderTasks([T1], { createTaskAction: undefined });

  const deadControls = createControls(dead);
  assert.ok(deadControls.length >= 1, "a Create affordance still appears when the action is absent");
  assert.ok(deadControls.every(isDisabled), "with no createTaskAction every Create control is DISABLED");
  assert.ok(createControls(live).some((c) => !isDisabled(c)), "with a createTaskAction the Create control is LIVE");
  assert.ok(!REASON_RE.test(reasonSurface(live)), "the all-live render carries no unavailability reason");
  assert.match(
    reasonSurface(dead),
    REASON_RE,
    "the disabled Create control says WHY it is unavailable — a reason the live control does not carry",
  );
});

test("the Assign control is DISABLED with a reason when no assign action is configured (no dead controls)", () => {
  const live = renderTasks([T1]);
  const dead = renderTasks([T1], { assignAction: undefined });

  const deadControls = assignControls(dead);
  assert.ok(deadControls.length >= 1, "an Assign affordance still appears when the action is absent");
  assert.ok(deadControls.every(isDisabled), "with no assignAction every Assign control is DISABLED");
  assert.ok(assignControls(live).some((c) => !isDisabled(c)), "with an assignAction the Assign control is LIVE");
  assert.ok(!REASON_RE.test(reasonSurface(live)), "the all-live render carries no unavailability reason");
  assert.match(
    reasonSurface(dead),
    REASON_RE,
    "the disabled Assign control says WHY it is unavailable — a reason the live control does not carry",
  );
});

test("the Add-note control is DISABLED with a reason when no add-note action is configured (no dead controls)", () => {
  const live = renderTasks([T1]);
  const dead = renderTasks([T1], { addNoteAction: undefined });

  const deadControls = noteControls(dead);
  assert.ok(deadControls.length >= 1, "an Add-note affordance still appears when the action is absent");
  assert.ok(deadControls.every(isDisabled), "with no addNoteAction every Add-note control is DISABLED");
  assert.ok(noteControls(live).some((c) => !isDisabled(c)), "with an addNoteAction the Add-note control is LIVE");
  assert.ok(!REASON_RE.test(reasonSurface(live)), "the all-live render carries no unavailability reason");
  assert.match(
    reasonSurface(dead),
    REASON_RE,
    "the disabled Add-note control says WHY it is unavailable — a reason the live control does not carry",
  );
});

test("the Complete control is DISABLED with a reason when no complete action is configured (no dead controls)", () => {
  const live = renderTasks([T1]);
  const dead = renderTasks([T1], { completeAction: undefined });

  const deadControls = completeControls(dead);
  assert.ok(deadControls.length >= 1, "a Complete affordance still appears when the action is absent");
  assert.ok(deadControls.every(isDisabled), "with no completeAction every Complete control is DISABLED");
  assert.ok(completeControls(live).some((c) => !isDisabled(c)), "with a completeAction the Complete control is LIVE");
  assert.ok(!REASON_RE.test(reasonSurface(live)), "the all-live render carries no unavailability reason");
  assert.match(
    reasonSurface(dead),
    REASON_RE,
    "the disabled Complete control says WHY it is unavailable — a reason the live control does not carry",
  );
});

// ════════════════════════════════════════════════════════════════════════════════
// AC2 — agent-contributed notes are shown against their task.
// ════════════════════════════════════════════════════════════════════════════════

test("renders the notes on a task, including an agent-contributed note attributed to its agent", () => {
  // Pangolin Helper (the note's author) is NEITHER the assignee ('any') NOR in the agents
  // option list — so its name can only have come from the note's attribution.
  const markup = renderTasks([T_WITH_NOTES], { agents: [AGENT_BRAVO] });
  const text = visibleText(markup);

  assert.ok(
    text.includes("Booked the changeover for the 12th"),
    `the agent-contributed note's text must be shown; text="${text}"`,
  );
  assert.ok(text.includes("Great, locking it in"), `the person's note text must be shown; text="${text}"`);
  assert.ok(
    text.includes("Pangolin Helper"),
    `the agent-contributed note must be attributed to its agent (Pangolin Helper); text="${text}"`,
  );
});

// ════════════════════════════════════════════════════════════════════════════════
// AC2 — design system: colour comes from tokens, never a raw hex literal.
// ════════════════════════════════════════════════════════════════════════════════

test("the tasks view uses design tokens, never a raw hex colour", () => {
  for (const markup of [
    render(base()),
    renderTasks([T1]),
    renderTasks([T_WITH_NOTES]),
    renderTasks([]),
    renderTasks([T1], { assignAction: undefined }),
    renderTasks([T1], { addNoteAction: undefined }),
    renderTasks([T1], { completeAction: undefined }),
    renderTasks([T1], { createTaskAction: undefined }),
  ]) {
    assert.ok(
      !/#[0-9a-fA-F]{3,8}\b/.test(markup),
      `no raw hex colour may appear in the tasks-view markup, got: ${markup}`,
    );
  }
});
