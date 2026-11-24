// E18-S07 — Home dashboard view component (src/components/home/dashboard-view.tsx).
//
// RED-first: src/components/home/dashboard-view.tsx does NOT exist yet, so
// importing `./dashboard-view` throws and every test here fails until the builder
// adds the component. That absence is the entire point of test-first — do not
// implement anything to make these pass.
//
// WHY this component exists (brief "Home dashboard"): Home must show the WHOLE
// dashboard the brief describes from ONE render-testable component, so the page
// loader (E18-S08) stays thin and every section has a plain empty state rather
// than a dead control. The dashboard composes, in one render:
//   • a GREETING (the signed-in person by name),
//   • the data-driven SET-UP CHECKLIST (reusing <SetupChecklist> from E18-S06,
//     whose five items/links come from the ONE domain module
//     @/domain/home/checklist — this component hard-codes none of them),
//   • a PENDING-APPROVALS count that links to /inbox,
//   • the LATEST ACTIVITY across all agents,
//   • each AGENT with its status and spend-this-period against its budget, and
//   • the upcoming life-admin REMINDERS.
// When a section has no data it shows a plain empty MESSAGE for that section
// (no pending approvals, no recent activity, no agents, no reminders) rather than
// a dead control.
//
// These tests pin BEHAVIOUR — what the component RENDERS for the data it is given
// — never the source text of dashboard-view.tsx, so a later behaviour-preserving
// refactor (different wrapper elements, reworded-but-still-plain copy, extra
// classes, a different icon) stays green. We render with `react-dom/server` (no
// DOM/jsdom — React component / E2E testing is a per-job ADR) and read the emitted
// markup, exactly as setup-checklist.test.tsx and the other component tests do.
//
// The data shapes below are the cross-task contract this task introduces (the
// E18-S05 metrics read is a later task; this renderer takes the already-computed,
// already-redacted, already-formatted values as props). Dates/amounts arrive as
// plain pre-formatted values — the view renders strings, it never reaches for a
// clock or a locale (brief module boundaries: no Date.now in a component).

import * as React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";

import { DashboardView } from "./dashboard-view";
import { computeSetupChecklist, type SetupChecklistItem } from "@/domain/home/checklist";

// --- the prop shapes this task introduces (described here as the contract) -----

// One connected agent on the dashboard: its name, connection status, and the
// spend in its current budget period against its budget. `status` uses the same
// vocabulary as the Status primitive (connected | needs-reconnect | error |
// pending); `spendThisPeriod`/`budget` are plain amounts in the major unit.
type DashboardAgent = {
  id: string;
  name: string;
  status: "connected" | "needs-reconnect" | "error" | "pending";
  spendThisPeriod: number;
  budget: number;
  budgetPeriod: "day" | "week" | "month";
};

// One latest-activity line: a plain, already-redacted summary, the agent it came
// from (absent for a Warthog-sourced entry), and a pre-formatted time label.
type DashboardActivity = {
  id: string;
  summary: string;
  agent?: string;
  at: string;
};

// One upcoming life-admin reminder: a title and a pre-formatted due label.
type DashboardReminder = {
  id: string;
  title: string;
  due: string;
};

type DashboardViewProps = {
  personName: string;
  checklist: ReadonlyArray<SetupChecklistItem>;
  pendingApprovals: number;
  activity: ReadonlyArray<DashboardActivity>;
  agents: ReadonlyArray<DashboardAgent>;
  reminders: ReadonlyArray<DashboardReminder>;
};

// --- fixtures ------------------------------------------------------------------
//
// Distinct, digit-free activity/reminder copy and agent names so that the numbers
// we assert on (an agent's spend/budget, the approvals count) can only come from
// the section under test — no cross-section collisions.

// The set-up checklist always renders (it is not one of the empty-state sections):
// its five items come from the ONE domain module, so this fixture is the real five.
const CHECKLIST: SetupChecklistItem[] = computeSetupChecklist({
  notificationsEnabled: true,
  cardAdded: true,
});

const AGENTS: DashboardAgent[] = [
  {
    id: "ag-claude",
    name: "Claude",
    status: "connected",
    spendThisPeriod: 42,
    budget: 200,
    budgetPeriod: "month",
  },
  {
    id: "ag-chatgpt",
    name: "ChatGPT",
    status: "needs-reconnect",
    spendThisPeriod: 0,
    budget: 150,
    budgetPeriod: "month",
  },
];

const ACTIVITY: DashboardActivity[] = [
  { id: "e1", summary: "Added Moving day to your calendar", agent: "Claude", at: "two minutes ago" },
  { id: "e2", summary: "Saved a receipt to Life admin", agent: "ChatGPT", at: "an hour ago" },
];

const REMINDERS: DashboardReminder[] = [
  { id: "r1", title: "Renew your passport", due: "Fri, early Dec" },
  { id: "r2", title: "Book the removalists", due: "Mon, late Nov" },
];

// A fully-populated dashboard; each test overrides exactly the section it probes.
function base(overrides: Partial<DashboardViewProps> = {}): DashboardViewProps {
  return {
    personName: "Sam Rivera",
    checklist: CHECKLIST,
    pendingApprovals: 3,
    activity: ACTIVITY,
    agents: AGENTS,
    reminders: REMINDERS,
    ...overrides,
  };
}

// --- markup helpers (no DOM), mirrored from the sibling component tests ---------

function render(props: DashboardViewProps): string {
  return renderToStaticMarkup(<DashboardView {...props} />);
}

// Visible text with tags stripped: exactly the words a sighted reader sees (an
// <svg> icon contributes none). Decodes the entities that matter.
function strip(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&nbsp;/gi, " ")
    .replace(/&#x27;|&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function textOf(props: DashboardViewProps): string {
  return strip(render(props));
}

function lower(props: DashboardViewProps): string {
  return textOf(props).toLowerCase();
}

// Read one double-quoted attribute off an element's attribute string.
function attr(attrs: string, name: string): string | null {
  const m = attrs.match(new RegExp(`\\b${name}="([^"]*)"`, "i"));
  return m ? m[1]! : null;
}

type Anchor = { href: string | null; text: string };

// Every <a> in the markup, with its href and visible text.
function anchors(markup: string): Anchor[] {
  const out: Anchor[] = [];
  for (const m of markup.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    out.push({ href: attr(m[1]!, "href"), text: strip(m[2]!) });
  }
  return out;
}

function anchorsTo(markup: string, href: string): Anchor[] {
  return anchors(markup).filter((a) => a.href === href);
}

// Does the visible text carry a plain empty message that NAMES `noun` alongside an
// emptiness signal (none / no / nothing / not / yet / zero) within a short span —
// in either order ("No pending approvals" / "Approvals: none yet")? This accepts a
// broad family of plain-English empty copy while still requiring the message to
// name its own section, so an empty section reads as a message, not a blank gap.
function namesEmptySection(text: string, noun: string): boolean {
  const none = "(?:no|none|nothing|not|haven'?t|zero|empty|yet)";
  const re = new RegExp(
    `\\b${none}\\b[^.?!]{0,40}\\b${noun}\\b|\\b${noun}\\b[^.?!]{0,40}\\b${none}\\b`,
    "i",
  );
  return re.test(text);
}

// === AC1 — every section renders its data ======================================

test("renders the greeting naming the signed-in person", () => {
  const text = textOf(base());
  assert.ok(
    text.includes("Sam Rivera"),
    `the dashboard must greet the person by name, got: "${text}"`,
  );
});

test("renders the set-up checklist's five items, each with its label and link", () => {
  const markup = render(base());
  const text = strip(markup).toLowerCase();
  for (const item of CHECKLIST) {
    assert.ok(
      text.includes(item.label.toLowerCase()),
      `the dashboard must show the checklist item "${item.label}"`,
    );
    assert.equal(
      anchorsTo(markup, item.href).length,
      1,
      `the dashboard must link the checklist item to ${item.href} exactly once`,
    );
  }
});

test("renders a pending-approvals count that links to /inbox", () => {
  const markup = render(base({ pendingApprovals: 3 }));
  const toInbox = anchorsTo(markup, "/inbox");
  assert.equal(
    toInbox.length,
    1,
    `a populated approvals section links to /inbox exactly once, got ${toInbox.length}`,
  );
  assert.ok(
    toInbox[0]!.text.includes("3"),
    `the count that links to /inbox must show the pending total "3", got "${toInbox[0]!.text}"`,
  );
  assert.ok(
    /approval/i.test(strip(markup)),
    "the approvals section must name what the count is (approvals)",
  );
});

test("renders the latest activity across all agents (each entry's summary and its agent)", () => {
  const markup = render(base({ activity: ACTIVITY, agents: [], reminders: [] }));
  const text = strip(markup);
  for (const entry of ACTIVITY) {
    assert.ok(
      text.includes(entry.summary),
      `the activity feed must show the entry "${entry.summary}", got: "${text}"`,
    );
  }
  // "Across all agents" — both agents' entries appear, labelled with the agent.
  assert.ok(text.includes("Claude"), "an activity entry from Claude must name its agent");
  assert.ok(text.includes("ChatGPT"), "an activity entry from ChatGPT must name its agent");
});

test("renders each agent with its status and its spend-this-period against its budget", () => {
  // Agents only (no activity) so the agent names and amounts can't collide.
  const text = textOf(base({ agents: AGENTS, activity: [], reminders: [], pendingApprovals: 0 }));
  const low = text.toLowerCase();

  // Each agent is named.
  assert.ok(text.includes("Claude"), "the connected agent is named");
  assert.ok(text.includes("ChatGPT"), "the needs-reconnect agent is named");

  // Status is shown in WORDS, distinguishing the two agents (never colour alone):
  // "connected" reads for the connected agent, "reconnect" for the other —
  // substrings present whether the builder renders the key or its human label.
  assert.ok(low.includes("connected"), "the connected agent reads as connected");
  assert.ok(low.includes("reconnect"), "the needs-reconnect agent reads as needing a reconnect");

  // Spend-this-period against budget: Claude's A$42 spend and A$200 budget both
  // appear, and ChatGPT's own A$150 budget appears (each agent carries its own).
  assert.ok(text.includes("42"), "the agent's spend this period (42) must be shown");
  assert.ok(text.includes("200"), "the agent's budget (200) must be shown alongside its spend");
  assert.ok(text.includes("150"), "each agent shows its own budget — ChatGPT's 150 must appear");
});

test("renders the upcoming reminders (each reminder's title and its due label)", () => {
  const text = textOf(base({ reminders: REMINDERS, agents: [], activity: [], pendingApprovals: 0 }));
  for (const reminder of REMINDERS) {
    assert.ok(text.includes(reminder.title), `the reminders section must show "${reminder.title}"`);
    assert.ok(
      text.includes(reminder.due),
      `the reminder "${reminder.title}" must show its due label "${reminder.due}"`,
    );
  }
});

test("composes every section together in one render", () => {
  const markup = render(base());
  const text = strip(markup);
  const low = text.toLowerCase();

  // greeting
  assert.ok(text.includes("Sam Rivera"), "greeting present");
  // checklist (one representative item + its link)
  assert.ok(low.includes("connect an agent"), "checklist present");
  assert.equal(anchorsTo(markup, "/agents/connect").length, 1, "checklist links present");
  // approvals count → inbox
  assert.equal(anchorsTo(markup, "/inbox").length, 1, "approvals count links to inbox");
  // activity
  assert.ok(text.includes("Added Moving day to your calendar"), "activity present");
  // agents with status + spend/budget
  assert.ok(low.includes("connected"), "agent status present");
  assert.ok(text.includes("42") && text.includes("200"), "agent spend against budget present");
  // reminders
  assert.ok(text.includes("Renew your passport"), "reminders present");
});

// === AC2 — an empty section renders a plain message, not a dead control =========

test("no pending approvals: a plain message, and no count-link to the inbox", () => {
  // The pending-approvals control IS the count linking to /inbox; with none
  // pending the brief wants a plain message "rather than a dead control". Within
  // THIS component /inbox can only originate from the approvals widget, so the
  // absence check is scoped to the exact unit under test.
  const markup = render(base({ pendingApprovals: 0 }));
  assert.equal(
    anchorsTo(markup, "/inbox").length,
    0,
    "with no pending approvals there must be no count-link to /inbox",
  );
  // One empty-inbox wording everywhere (UI/UX pass content-40), shared with the Inbox page.
  assert.ok(
    strip(markup).includes("Nothing waiting for you") && /needs your approval/.test(strip(markup)),
    `the empty Inbox panel must read as the plain "Nothing waiting for you" message, got: "${strip(markup)}"`,
  );
});

test("no recent activity: a plain message for the activity section", () => {
  // Only activity is empty; the other sections are populated, so the one emptiness
  // signal and the word "activity" can only come from the activity empty message.
  const text = textOf(base({ activity: [] }));
  assert.ok(
    !text.includes("Added Moving day to your calendar"),
    "an empty activity section shows none of the activity entries",
  );
  assert.ok(
    namesEmptySection(text, "activit(?:y|ies)"),
    `the empty activity section must read as a plain "no recent activity" message, got: "${text}"`,
  );
});

test("no agents: a plain message for the agents section", () => {
  // Only agents is empty; the other sections stay populated. The agents' own
  // spend/budget figures (42/200/150) are emitted only by the agents section, so
  // their absence proves the list is empty (agent NAMES can't be used here — the
  // populated activity feed legitimately names Claude/ChatGPT as its entries' agents).
  const text = textOf(base({ agents: [] }));
  assert.ok(
    !text.includes("42") && !text.includes("200") && !text.includes("150"),
    `an empty agents section shows none of the agents' spend/budget figures, got: "${text}"`,
  );
  assert.ok(
    namesEmptySection(text, "agents?"),
    `the empty agents section must read as a plain "no agents" message, got: "${text}"`,
  );
});

test("no reminders: a plain message for the reminders section", () => {
  const text = textOf(base({ reminders: [] }));
  assert.ok(!text.includes("Renew your passport"), "an empty reminders section shows no reminders");
  assert.ok(
    namesEmptySection(text, "reminders?"),
    `the empty reminders section must read as a plain "no reminders" message, got: "${text}"`,
  );
});

// UI/UX pass newcomer-01: a brand-new member's Home is one clear task. The set-up panel
// comes first as "Get started", with exactly one primary action (Connect your first agent,
// straight to the connect guide) and the agent step first in the checklist; the panels
// that can only fill once an agent is connected stay out of the way until they have data.
test("a brand-new account sees Get started first, with one action to connect an agent", () => {
  const markup = render(
    base({ checklist: computeSetupChecklist({}), pendingApprovals: 0, activity: [], agents: [], reminders: [] }),
  );
  const text = strip(markup);

  assert.ok(text.includes("Sam Rivera"), "the greeting still shows for a brand-new account");
  assert.ok(text.includes("the one place you own that every AI agent connects through"), "the heading says what Warthog is");
  assert.ok(text.indexOf("Get started") > text.indexOf("Sam Rivera"), "Get started sits straight under the greeting");
  assert.ok(text.includes("0 of 5 steps done"), "progress reads from the real checklist");
  assert.ok(namesEmptySection(text, "agents?"), "it says plainly that no agent is connected yet");

  const connect = anchorsTo(markup, "/agents/connect");
  assert.equal(connect.length, 2, "the primary action and the checklist's first step both go to the connect guide");
  assert.match(markup, /<a class="[^"]*bg-accent[^"]*" href="\/agents\/connect">Connect your first agent/, "one primary action: Connect your first agent");
  assert.equal((markup.match(/\bbg-accent\s/g) ?? []).length, 1, "exactly one primary action on the page");
  assert.ok(text.indexOf("Connect an agent") < text.indexOf("Add a card"), "the agent step leads the checklist");

  assert.equal(anchorsTo(markup, "/inbox").length, 0, "no count-link to /inbox when nothing is pending");
  for (const empty of ["Recent activity", "Reminders", "Your agents", "Nothing waiting"]) {
    assert.ok(!text.includes(empty), `no empty "${empty}" panel before the first agent`);
  }
});

test("before the first agent, a panel with something in it still shows", () => {
  const text = textOf(base({ agents: [], pendingApprovals: 0, activity: [] }));
  assert.ok(text.includes("Renew your passport"), "reminders the member added themselves show");
  assert.ok(!text.includes("Recent activity"), "an empty activity panel stays out of the way");
});

test("once every step is done the set-up panel goes", () => {
  const all = computeSetupChecklist({ notificationsEnabled: true, profileBuilt: true, cardAdded: true, serviceConnected: true, agentConnected: true });
  const text = textOf(base({ checklist: all }));
  assert.ok(!/Finish setting up|Get started/.test(text), "no set-up panel once it's all done");
});

test("an agent with no card budget says so, with a way to set one", () => {
  const markup = render(base({ agents: [{ id: "ag-1", name: "Helper", status: "connected", spendThisPeriod: 0, budget: null, budgetPeriod: "month", href: "/agents/ag-1" }] }));
  const text = strip(markup);
  assert.ok(text.includes("No card budget"), "no budget reads as none");
  assert.ok(!/A\$0|\$0\.00 of/.test(text), "never a zero budget");
  assert.match(markup, /href="\/agents\/ag-1\?section=spending"[^>]*>Set a budget/);
});

// === Design system — colour comes from tokens, never a raw hex literal ==========

test("the dashboard uses design tokens, never a raw hex colour (populated and empty)", () => {
  for (const props of [
    base(),
    base({ pendingApprovals: 0, activity: [], agents: [], reminders: [] }),
  ]) {
    const markup = render(props);
    assert.ok(
      !/#[0-9a-fA-F]{3,8}\b/.test(markup),
      `no raw hex colour may appear in the dashboard markup, got: ${markup}`,
    );
  }
});

// Review fix W4.1 — the install-the-app prompt sits with the set-up checklist ("install the
// app and turn on notifications"), so a new person is offered it right on Home.
test("W4.1: Home mounts the install prompt in the set-up section", () => {
  const markup = renderToStaticMarkup(
    <DashboardView
      personName="Sam"
      checklist={CHECKLIST}
      pendingApprovals={0}
      activity={[]}
      agents={[]}
      reminders={[]}
    />,
  );
  const setup = markup.slice(markup.indexOf("Get started"));
  assert.ok(markup.includes("Get started"), "the set-up panel shows");
  assert.match(setup, /data-install-prompt/, "the install prompt is mounted beside the checklist");
});
