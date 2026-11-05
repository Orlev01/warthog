// E10-S10 — Agent list view component (src/components/agents/agent-list-view.tsx).
//
// RED-first: src/components/agents/agent-list-view.tsx does NOT exist yet, so
// importing `./agent-list-view` throws and every test here fails until the builder
// adds the component. That absence is the entire point of test-first — do NOT
// implement anything to make these pass.
//
// WHY this component exists (brief "Agents screen" — a primary-journey surface;
// design §6.1; CLAUDE.md vocabulary: an *agent* is a connected AI client, one row
// per connection, carrying a platform, a status, a connected date, a last-active
// time, a request count and the spend in its current budget period). The Agents
// screen lists EVERY agent with those facts, and on each agent offers a Disconnect
// control (E10-S09 "one-click disconnect") and a link to that agent's FILTERED
// activity (the Activity feed, keyed to this agent).
//
// THIS component is the pure, prop-driven VIEW — exactly like DashboardView /
// ActivityView: it renders the screen from already-formatted props so it can be
// pinned without a browser, a session or any server plumbing. The loader (a later
// task) reads/decrypts/formats and feeds it: dates and times arrive as pre-formatted
// LABELS, amounts as plain major-unit numbers, the per-agent filtered-activity URL
// as `activityHref`, and the Disconnect control is BOUND to the `disconnectAction`
// server action the page passes (exactly as ActivityView binds Dispute/Undo). The
// view reaches for no clock, locale, DB or config and decides nothing.
//
// How these tests stay honest:
//   * They pin BEHAVIOUR — what the view RENDERS for the props it is given (the
//     plain-words copy a person reads, the accessible controls, the links, the
//     bound action carrying the right agent id) — never the source text of
//     agent-list-view.tsx. A behaviour-preserving refactor (different wrappers,
//     reworded-but-still-plain copy, extra classes, a different icon, composing a UI
//     primitive) stays green.
//   * They render with `react-dom/server` (no DOM/jsdom — React component / E2E
//     testing is a per-job ADR) and read the emitted markup, mirroring every other
//     component render test in this repo (dashboard-view, activity-view, status, …).
//   * Absence/uniqueness checks ("no 'null'", "no per-agent controls when empty",
//     "the disconnect form carries THIS agent's id") are scoped to the exact unit
//     under test — a single agent rendered alone, or one control's own <form> — never
//     a whole-output scan, because the same word/number can legitimately appear
//     elsewhere.
//
// The prop shapes below are the cross-task contract this task introduces, documented
// here exactly as dashboard-view.test.tsx / activity-view.test.tsx document theirs.
// The agent `status` is the shared StatusKey union the UI <Status> primitive renders
// (one source of truth with DashboardAgent) — a connection state shown with WORDS +
// an icon, never colour alone.

import * as React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";

import { AgentListView } from "./agent-list-view";

// --- the prop shapes this task introduces (described here as the contract) ------

// The connection state the UI <Status> primitive knows (one source of truth with
// DashboardAgent): "connected" | "needs-reconnect" | "error" | "pending".
type StatusKey = "connected" | "needs-reconnect" | "error" | "pending";

// One agent on the list. `connectedAt` / `lastActiveAt` are PRE-FORMATTED labels the
// loader produced (never a raw Date — the view reaches for no clock); `lastActiveAt`
// is null when the agent has never been active. `spendThisPeriod` / `budget` are
// plain major-unit amounts and `budgetPeriod` names the current period. `activityHref`
// is the ready-made URL to THIS agent's filtered activity (the loader owns the
// filter-param contract shared with the Activity feed — the view just links to it).
type AgentListItem = {
  id: string; // the agentId the Disconnect action consumes (one row per connection)
  name: string; // the agent's display name
  platform: string; // the platform it connected from, e.g. "ChatGPT"
  status: StatusKey;
  connectedAt: string; // pre-formatted connected-date label
  lastActiveAt: string | null; // pre-formatted last-active label; null = never active
  requestCount: number;
  spendThisPeriod: number; // major unit
  budget: number; // major unit
  budgetPeriod: "day" | "week" | "month";
  activityHref: string; // link to this agent's filtered activity
};

type AgentListViewProps = {
  agents: readonly AgentListItem[];
  // E10-S09 — the Disconnect control is BOUND to this server action (the page passes
  // an inline `use server` wrapper that re-derives the session and calls
  // disconnectAgent with the submitted agent id). OPTIONAL: the loader's own props
  // omit it (the page adds it), so when it is NOT supplied the Disconnect control
  // renders DISABLED with a one-line reason rather than a live button over a missing
  // action (constitution: no dead controls — disable it and say why).
  disconnectAction?: (formData: FormData) => void | Promise<void>;
};

// --- fixtures -------------------------------------------------------------------
//
// Hex-free content (so the raw-hex scan can only catch a hard-coded colour). Each
// agent's platform / name / date labels are distinct marker strings and DIGIT-FREE,
// so a field-presence assertion can only be satisfied by the field it targets, and
// the request-count / spend / budget numbers are chosen so none is a substring of
// another (317 ⊄ 42 ⊄ 200 …). No fixture string contains "disconnect", "activity",
// "null", or a status LABEL word ("reconnect"/"error") that could spoof a control.

const AGENT_A: AgentListItem = {
  id: "agent-arbor",
  name: "Research buddy",
  platform: "ChatGPT",
  status: "connected",
  connectedAt: "the third of last month",
  lastActiveAt: "a few minutes ago",
  requestCount: 317,
  spendThisPeriod: 42,
  budget: 200,
  budgetPeriod: "month",
  activityHref: "/activity?agent=agent-arbor",
};

const AGENT_B: AgentListItem = {
  id: "agent-beacon",
  name: "Travel planner",
  platform: "Claude",
  status: "needs-reconnect",
  connectedAt: "around Easter",
  lastActiveAt: null, // has never been active
  requestCount: 5,
  spendThisPeriod: 0,
  budget: 75,
  budgetPeriod: "week",
  activityHref: "/activity?agent=agent-beacon",
};

const AGENT_C: AgentListItem = {
  id: "agent-cistern",
  name: "Inbox helper",
  platform: "Cursor",
  status: "error",
  connectedAt: "on the weekend",
  lastActiveAt: "yesterday",
  requestCount: 88,
  spendThisPeriod: 9,
  budget: 30,
  budgetPeriod: "day",
  activityHref: "/activity?agent=agent-cistern",
};

// A stand-in server action: a bound action is what makes the Disconnect control LIVE.
// A test probes the disabled path by overriding `disconnectAction` to `undefined`.
const noopDisconnectAction = async (_formData: FormData): Promise<void> => {};

// By default the Disconnect action is bound (the page's live wiring), so the control
// tests exercise live controls; a test overrides it to probe the disabled path.
function base(overrides: Partial<AgentListViewProps> = {}): AgentListViewProps {
  return {
    agents: [AGENT_A, AGENT_B, AGENT_C],
    disconnectAction: noopDisconnectAction,
    ...overrides,
  };
}

// --- tiny markup helpers (no DOM), mirrored from the sibling component tests -----

function render(props: AgentListViewProps): string {
  return renderToStaticMarkup(<AgentListView {...props} />);
}

function decode(s: string): string {
  return s
    .replace(/&amp;/gi, "&")
    .replace(/&#x27;/gi, "'")
    .replace(/&#39;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&nbsp;/gi, " ");
}

// Visible text with tags stripped and entities decoded — the words a sighted reader
// sees (an <svg> icon contributes none). <script>/<style> BLOCKS are dropped whole:
// a bound server-action form makes React inject a progressive-enhancement submit
// script whose JS text ("javascript:…", "null!=f", …) is NOT visible copy and must
// never leak into a visible-text / no-"null" / reason-surface assertion.
function visibleText(markup: string): string {
  const withoutScripts = markup
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ");
  return decode(withoutScripts.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

function attr(attrs: string, name: string): string | null {
  const m = attrs.match(new RegExp(`\\b${name}="([^"]*)"`, "i"));
  return m ? m[1]! : null;
}

type El = { attrs: string; inner: string };

function findAll(markup: string, tag: string): El[] {
  const out: El[] = [];
  for (const m of markup.matchAll(new RegExp(`<${tag}\\b([^>]*)>([\\s\\S]*?)</${tag}>`, "gi"))) {
    out.push({ attrs: m[1]!, inner: m[2]! });
  }
  return out;
}

// The accessible name of a control: its visible text PLUS any aria-label / title that
// voices it (so an icon-only control named by aria-label still counts).
function controlFace(el: El): string {
  const parts = [visibleText(el.inner)];
  const al = attr(el.attrs, "aria-label");
  if (al) parts.push(decode(al));
  const ti = attr(el.attrs, "title");
  if (ti) parts.push(decode(ti));
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

function isDisabled(el: El): boolean {
  return /\bdisabled\b/i.test(el.attrs);
}

// Every <button> whose accessible name matches `re` (disabled ones included).
function buttonsMatching(markup: string, re: RegExp): El[] {
  return findAll(markup, "button").filter((b) => re.test(controlFace(b)));
}

function inputAttrs(markup: string): string[] {
  const out: string[] = [];
  for (const m of markup.matchAll(/<input\b([^>]*?)\/?>/gi)) out.push(m[1]!);
  return out;
}

// Every <a> with its href and accessible name.
type Anchor = { href: string | null; name: string };
function anchors(markup: string): Anchor[] {
  return findAll(markup, "a").map((a) => ({ href: attr(a.attrs, "href"), name: controlFace(a) }));
}

// Does `re` appear in the visible text within `window` chars of the first occurrence
// of `needle`? Proves two things render TOGETHER (a number and its label; a spend and
// its budget) without pinning exact layout.
function nearInText(markup: string, needle: string, re: RegExp, window = 80): boolean {
  const vt = visibleText(markup);
  const i = vt.toLowerCase().indexOf(needle.toLowerCase());
  if (i < 0) return false;
  const lo = Math.max(0, i - window);
  const hi = Math.min(vt.length, i + needle.length + window);
  return re.test(vt.slice(lo, hi));
}

// --- form-scoped helpers for the bound Disconnect control ------------------------
//
// Forms don't nest, so each <form>…</form> pairs with its own close tag. These scope
// an assertion to ONE control's own form — never the whole screen.

function formsForControl(markup: string, re: RegExp): El[] {
  return findAll(markup, "form").filter((f) =>
    findAll(f.inner, "button").some((b) => re.test(controlFace(b))),
  );
}

// React encodes a FUNCTION form action (a bound server action) as a `javascript:`
// progressive-enhancement placeholder in server-rendered markup; a bare form carries
// no such action. So "this form is bound to a server action" is observable as its
// action scheme — behaviour, not source text. (Same probe as activity-view.test.tsx.)
function isBoundToAction(form: El): boolean {
  const action = attr(form.attrs, "action");
  return action !== null && /^javascript:/i.test(action);
}

// Whether any field (hidden or otherwise) inside `form` carries the exact value
// `value` — e.g. the agent id the bound disconnect action consumes. Robust to the
// field's NAME (the action may read it as "agentId" / "id" / "agent"), pinning only
// the behaviour that the form identifies WHICH agent to disconnect.
function formCarriesValue(form: El, value: string): boolean {
  return inputAttrs(form.inner).some((a) => attr(a, "value") === value);
}

// The "say-why" surface: visible text PLUS every title / aria-label (an accessible
// reason may ride on either). A disabled control that says why carries MORE of this
// than the same control rendered live.
function reasonSurface(markup: string): string {
  const parts = [visibleText(markup)];
  for (const m of markup.matchAll(/(?:title|aria-label)="([^"]*)"/gi)) parts.push(decode(m[1]!));
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

// ================================================================================
// AC1 — renders every agent with platform, status, connected date, last active,
// request count and current-period spend against budget.
// ================================================================================

test("lists every agent with its platform (and name)", () => {
  const text = visibleText(render(base()));
  for (const agent of [AGENT_A, AGENT_B, AGENT_C]) {
    assert.ok(
      text.includes(agent.platform),
      `agent "${agent.name}" must show its platform "${agent.platform}"; text="${text}"`,
    );
    assert.ok(
      text.includes(agent.name),
      `agent "${agent.name}" must be named; text="${text}"`,
    );
  }
});

test("renders from the agents given, not a fixed list", () => {
  const textA = visibleText(render(base({ agents: [AGENT_A] })));
  const textB = visibleText(render(base({ agents: [AGENT_B] })));
  assert.ok(textA.includes("Research buddy"), "list A shows A's agent");
  assert.ok(!textA.includes("Travel planner"), "list A must not show B's agent");
  assert.ok(textB.includes("Travel planner"), "list B shows B's agent");
  assert.ok(!textB.includes("Research buddy"), "list B must not show A's agent");
});

test("renders an agent's connected date and last-active time (pre-formatted labels)", () => {
  // Rendered alone so each distinctive label can only come from this agent.
  const text = visibleText(render(base({ agents: [AGENT_A] })));
  assert.ok(
    text.includes(AGENT_A.connectedAt),
    `the connected-date label "${AGENT_A.connectedAt}" must be shown; text="${text}"`,
  );
  assert.ok(
    text.includes(AGENT_A.lastActiveAt as string),
    `the last-active label "${AGENT_A.lastActiveAt}" must be shown; text="${text}"`,
  );
});

test("shows a plain 'no activity yet' label (never the word null) for an agent that has never been active", () => {
  // AGENT_B.lastActiveAt is null. Rendered alone, so the absence check is scoped to
  // this one agent.
  const markup = render(base({ agents: [AGENT_B] }));
  const text = visibleText(markup);
  assert.ok(
    !/\bnull\b/i.test(text),
    `a never-active agent must not render the literal "null"; text="${text}"`,
  );
  assert.match(
    text,
    /never|no activity|not .{0,12}active|yet to|hasn.?t|awaiting/i,
    `a never-active agent must read as not-yet-active in plain words; text="${text}"`,
  );
});

test("shows each agent's request count, labelled as requests", () => {
  // Rendered alone; 317 is a substring of no other number/label in this fixture, so
  // its presence can only be the request count, and it must read AS a request count.
  const markup = render(base({ agents: [AGENT_A] }));
  assert.ok(
    visibleText(markup).includes(String(AGENT_A.requestCount)),
    `the request count ${AGENT_A.requestCount} must be shown; text="${visibleText(markup)}"`,
  );
  assert.ok(
    nearInText(markup, String(AGENT_A.requestCount), /request/i),
    `the count ${AGENT_A.requestCount} must render as a request count; text="${visibleText(markup)}"`,
  );
});

test("shows current-period spend against budget", () => {
  // Rendered alone. Spend (42) and budget (200) must both show, read TOGETHER, and the
  // current period (month) must be named — "A$42 of A$200 this month".
  const markup = render(base({ agents: [AGENT_A] }));
  const text = visibleText(markup);
  assert.ok(text.includes(String(AGENT_A.spendThisPeriod)), `spend ${AGENT_A.spendThisPeriod} must show; text="${text}"`);
  assert.ok(text.includes(String(AGENT_A.budget)), `budget ${AGENT_A.budget} must show; text="${text}"`);
  assert.ok(
    nearInText(markup, String(AGENT_A.spendThisPeriod), new RegExp(String(AGENT_A.budget))),
    `spend must read against its budget (the two amounts together); text="${text}"`,
  );
  assert.match(text, /month/i, `the current budget period (month) must be named; text="${text}"`);
});

test("renders each agent's status in words (not colour alone)", () => {
  // Rendered alone so the status word can only come from that agent's status. These
  // StatusKey labels are the shared <Status> vocabulary ("Reconnect needed", "Error").
  const reconnect = visibleText(render(base({ agents: [AGENT_B] }))); // needs-reconnect
  assert.match(
    reconnect,
    /reconnect/i,
    `a needs-reconnect agent must show its status in words; text="${reconnect}"`,
  );
  const error = visibleText(render(base({ agents: [AGENT_C] }))); // error
  assert.match(
    error,
    /error|problem|attention/i,
    `an errored agent must show its status in words; text="${error}"`,
  );
});

// ================================================================================
// AC2 — each agent offers a Disconnect control and a link to its filtered activity.
// ================================================================================

test("offers a Disconnect control for every agent (live when a disconnectAction is bound)", () => {
  const markup = render(base()); // disconnectAction bound
  const disconnects = buttonsMatching(markup, /disconnect/i);
  assert.ok(
    disconnects.length >= base().agents.length,
    `every agent must offer a Disconnect control; found ${disconnects.length} for ${base().agents.length} agents`,
  );
  assert.ok(
    disconnects.every((b) => !isDisabled(b)),
    "with a bound disconnectAction every Disconnect control is LIVE, not a dead/disabled button",
  );
});

test("binds Disconnect to the disconnectAction server action, carrying THIS agent's id", () => {
  // Rendered alone (AGENT_A) so the one Disconnect form can only be this agent's.
  const dispatched = async (_formData: FormData): Promise<void> => {};
  const markup = render(base({ agents: [AGENT_A], disconnectAction: dispatched }));
  const forms = formsForControl(markup, /disconnect/i);
  assert.equal(forms.length, 1, "exactly one Disconnect form for the single agent");
  const form = forms[0]!;
  assert.ok(
    isBoundToAction(form),
    "the Disconnect form is BOUND to the disconnectAction server action (a form action), not a dead button",
  );
  assert.ok(
    formCarriesValue(form, AGENT_A.id),
    `the Disconnect form must carry the agent id "${AGENT_A.id}" the action consumes (so it disconnects the right agent)`,
  );
  assert.ok(
    findAll(form.inner, "button")
      .filter((b) => /disconnect/i.test(controlFace(b)))
      .every((b) => !isDisabled(b)),
    "the Disconnect submit is live",
  );
});

test("a Disconnect control with no action configured renders disabled with a reason (no dead control)", () => {
  // Same agent, with a bound action (live) vs without (not configured). With no
  // disconnectAction the Disconnect is NOT a live button over a missing action — it is
  // DISABLED and SAYS WHY (constitution: disable the control and say why).
  const withAction = render(base({ agents: [AGENT_A], disconnectAction: async () => {} }));
  const noAction = render(base({ agents: [AGENT_A], disconnectAction: undefined }));

  const buttons = buttonsMatching(noAction, /disconnect/i);
  assert.ok(buttons.length >= 1, "the agent still surfaces a Disconnect affordance");
  assert.ok(
    buttons.every((b) => isDisabled(b)),
    "with no disconnectAction every Disconnect control is DISABLED",
  );
  assert.equal(
    formsForControl(noAction, /disconnect/i).filter(isBoundToAction).length,
    0,
    "the disabled Disconnect is not a bound live server-action form",
  );
  assert.ok(
    reasonSurface(noAction).length > reasonSurface(withAction).length,
    "the disabled Disconnect says WHY it is unavailable — a one-line reason the live control does not carry",
  );
});

test("links each agent to its own filtered activity", () => {
  const markup = render(base());
  const hrefs = anchors(markup)
    .map((a) => a.href)
    .filter((h): h is string => h !== null);

  for (const agent of base().agents) {
    assert.ok(
      hrefs.includes(agent.activityHref),
      `agent "${agent.name}" must link to its filtered activity (${agent.activityHref}); hrefs=${JSON.stringify(hrefs)}`,
    );
  }
  // The links are per-agent (filtered), not one shared link: each agent's activity URL
  // is distinct.
  const activityHrefs = base().agents.map((a) => a.activityHref);
  assert.equal(
    new Set(activityHrefs.filter((h) => hrefs.includes(h))).size,
    base().agents.length,
    "each agent's filtered-activity link must be distinct",
  );
});

test("the filtered-activity link reads as an activity link", () => {
  // Rendered alone so the one activity link can only be this agent's.
  const markup = render(base({ agents: [AGENT_A] }));
  const link = anchors(markup).find((a) => a.href === AGENT_A.activityHref);
  assert.ok(link, `an anchor to ${AGENT_A.activityHref} must be rendered`);
  assert.match(
    link!.name,
    /activit/i,
    `the filtered-activity link must be labelled as going to activity; name="${link!.name}"`,
  );
});

// ================================================================================
// Empty state — a plain message, no per-agent controls (no dead screen).
// ================================================================================

test("an empty agent list renders a message and no per-agent controls", () => {
  let markup: string;
  try {
    markup = render(base({ agents: [] }));
  } catch (err) {
    assert.fail(
      "AgentListView must render an empty list, not crash: " +
        (err instanceof Error ? err.message : String(err)),
    );
    return;
  }
  assert.ok(
    visibleText(markup).length >= 3,
    `the empty state must say something; text="${visibleText(markup)}"`,
  );
  assert.equal(
    buttonsMatching(markup, /disconnect/i).length,
    0,
    "no Disconnect controls when there are no agents",
  );
  assert.equal(
    anchors(markup).filter((a) => a.href && /\/activity/i.test(a.href)).length,
    0,
    "no per-agent activity links when there are no agents",
  );
});

// ================================================================================
// AC2 — colour comes from design tokens, never a raw hex literal.
// ================================================================================

test("uses design tokens, never a raw hex colour (populated and empty)", () => {
  for (const props of [base(), base({ agents: [] }), base({ disconnectAction: undefined })]) {
    const markup = render(props);
    assert.ok(
      !/#[0-9a-fA-F]{3,8}\b/.test(markup),
      `no raw hex colour may appear in the AgentListView markup, got: ${markup}`,
    );
  }
});
