// E08-S08 — Activity view component (src/components/activity/activity-view.tsx).
//
// RED-first: src/components/activity/activity-view.tsx does NOT exist yet, so
// importing `./activity-view` throws and every test here fails until the builder
// adds the component. That absence is the entire point of test-first — do not
// implement anything to make these pass.
//
// WHY this component exists (brief "Activity feed" + "Dispute and undo", design §9,
// constitution principle 14 "Warthog writes the record, not the agents"): the
// timeline is the product's trust surface — one render-testable component that
// shows everything that passed through Warthog, labels agent-submitted summaries
// "Reported by <agent>" (never treating them as fact), and carries the per-entry
// controls (Dispute on every entry; Undo only where the entry's tool declares a
// reversal) plus the filters, search box, per-entry detail and Check-integrity
// control. The page loader (a later task) stays thin: it reads/decrypts/formats and
// feeds this view already-formatted props, exactly as DashboardView / OutboxView do.
//
// How these tests stay honest:
//   * They pin BEHAVIOUR — what the view RENDERS for the props it is given — never
//     the source text of activity-view.tsx. A later behaviour-preserving refactor
//     (different wrappers, reworded-but-still-plain copy, extra classes, a different
//     icon, composing a UI primitive) stays green.
//   * They render with `react-dom/server` (no DOM/jsdom — React component / E2E
//     testing is a per-job ADR) and read the emitted markup, mirroring every other
//     component render test in this repo (dashboard-view, outbox-view, status, …).
//   * Absence checks ("not labelled Reported by", "no Undo control") are scoped to
//     the exact unit under test — a single entry rendered alone, or the per-entry
//     controls themselves — never a whole-output text scan, because the same words
//     can legitimately appear elsewhere (an agent NAME shows on a Warthog entry too).
//
// The prop shapes below are the cross-task contract this task introduces (described
// here as documentary contract, exactly as dashboard-view.test.tsx does). The view
// renders already-formatted strings: a redacted `summary`/`detail`, a pre-formatted
// time label `at`, display-ready `kind`/`outcome` — it never reaches for a clock, a
// locale, a DB or the reversal seam (brief module boundaries: a pure, prop-driven
// component). Whether an entry's tool "declares a reversal" is decided upstream and
// handed in as the boolean `canUndo`.

import * as React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";

import { ActivityView } from "./activity-view";
// Documentary type anchor — the exact result shape the Check-integrity control
// displays, shared with the server's checkIntegrity (one source of truth). Erased at
// runtime, so the runtime assertions below are the real gate.
import type { IntegrityResult } from "@/server/activity/integrity";

// --- the prop shapes this task introduces (described here as the contract) -----

// One entry on the timeline. `source` is the activity vocabulary union
// ("warthog" = a fact Warthog recorded itself; "agent_reported" = a summary an agent
// submitted, shown labelled "Reported by <agent>" and never counted as fact).
// `agent` is the connected AI client; `service` the connected service it touched
// (either may be absent). `canUndo` is true ⇔ the entry's tool declares a reversal.
type ActivityEntryView = {
  seq: number;
  kind: string; // display-ready, e.g. "Tool call"
  source: "warthog" | "agent_reported";
  agent?: string;
  service?: string;
  outcome: string; // display-ready, e.g. "Done"
  at: string; // pre-formatted time label, e.g. "two minutes ago"
  summary: string; // one-line, already-redacted
  detail: string; // full detail, already-redacted (the per-entry "open for detail")
  canUndo: boolean;
};

// The values each filter dropdown offers (resolved display names / labels).
type ActivityFilterOptions = {
  agents: readonly string[];
  services: readonly string[];
  kinds: readonly string[];
  outcomes: readonly string[];
};

type ActivityViewProps = {
  entries: readonly ActivityEntryView[];
  filterOptions: ActivityFilterOptions;
  query: string; // the current search text (pre-fills the search box)
  integrity: IntegrityResult | null; // the latest Check-integrity result, if one has run
};

// --- fixtures ------------------------------------------------------------------
//
// Hex-free content (so the raw-hex scan can only catch a hard-coded colour) with
// distinct, digit-free marker words per entry (so an order/absence assertion can
// only be satisfied by the entry it targets). No fixture string contains "undo",
// "dispute", "#", or a facet LABEL word ("agent"/"service"/"kind"/"outcome") in a
// way that could spoof a control.

// A Warthog-recorded tool call — names its agent AND the service it touched, has a
// declared reversal (create_event ↔ delete_event), so it offers Undo. source
// "warthog": it is NOT an agent-reported summary, so it carries no "Reported by".
const ENTRY_TOOL_CALL: ActivityEntryView = {
  seq: 42,
  kind: "Tool call",
  source: "warthog",
  agent: "Claude",
  service: "Google Calendar",
  outcome: "Done",
  at: "two minutes ago",
  summary: "Added a dentist appointment to your calendar",
  detail: "Created the event on Thursday at nine. The agent's reason: booking your check-up.",
  canUndo: true,
};

// An agent-reported summary — shown labelled "Reported by ChatGPT". No declared
// reversal, so no Undo control.
const ENTRY_AGENT_NOTE: ActivityEntryView = {
  seq: 41,
  kind: "Note",
  source: "agent_reported",
  agent: "ChatGPT",
  outcome: "Noted",
  at: "an hour ago",
  summary: "Summarised your travel plans",
  detail: "The trip to Perth is booked for the long weekend.",
  canUndo: false,
};

// A one-time card release Warthog recorded — no reversal (you cannot un-release),
// so no Undo control, but it still offers Dispute like every entry.
const ENTRY_CARD_RELEASE: ActivityEntryView = {
  seq: 40,
  kind: "Card release",
  source: "warthog",
  agent: "Claude",
  service: "Qantas",
  outcome: "Released",
  at: "yesterday",
  summary: "Shared your Visa with the airline",
  detail: "One-time release of the card ending four-two-four-two for the flight booking.",
  canUndo: false,
};

const FILTER_OPTIONS: ActivityFilterOptions = {
  agents: ["Claude", "ChatGPT"],
  services: ["Google Calendar", "Qantas"],
  kinds: ["Tool call", "Note", "Card release"],
  outcomes: ["Done", "Noted", "Released"],
};

// A fully-populated timeline, newest-first (the order the loader hands in). Each test
// overrides exactly the slice it probes.
function base(overrides: Partial<ActivityViewProps> = {}): ActivityViewProps {
  return {
    entries: [ENTRY_TOOL_CALL, ENTRY_AGENT_NOTE, ENTRY_CARD_RELEASE],
    filterOptions: FILTER_OPTIONS,
    query: "",
    integrity: null,
    ...overrides,
  };
}

// --- tiny markup helpers (no DOM), mirrored from the sibling component tests -----

function render(props: ActivityViewProps): string {
  return renderToStaticMarkup(<ActivityView {...props} />);
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

// Visible text with tags stripped and entities decoded — exactly the words a sighted
// reader sees (an <svg> icon contributes none).
function visibleText(markup: string): string {
  return decode(markup.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
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
// voices it (so an icon-only button named by aria-label still counts).
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

// Every <button> whose accessible name matches `re` (disabled ones included — a
// disabled control that should be absent is still a dead control).
function buttonsMatching(markup: string, re: RegExp): El[] {
  return findAll(markup, "button").filter((b) => re.test(controlFace(b)));
}

// Attribute strings of every <input>.
function inputAttrs(markup: string): string[] {
  const out: string[] = [];
  for (const m of markup.matchAll(/<input\b([^>]*?)\/?>/gi)) out.push(m[1]!);
  return out;
}

// The "label-ish" text of a form: every <label>/<legend> visible text, plus the
// aria-label / name / placeholder that name a control. Scoped to form chrome, so an
// entry's body copy (e.g. a "travel agent" summary) can never spoof a facet match.
function controlLabelText(markup: string): string {
  const parts: string[] = [];
  for (const l of findAll(markup, "label")) parts.push(visibleText(l.inner));
  for (const l of findAll(markup, "legend")) parts.push(visibleText(l.inner));
  for (const m of markup.matchAll(/aria-label="([^"]*)"/gi)) parts.push(decode(m[1]!));
  for (const a of inputAttrs(markup)) {
    for (const n of ["name", "placeholder"]) {
      const v = attr(a, n);
      if (v) parts.push(decode(v));
    }
  }
  for (const s of findAll(markup, "select")) {
    const n = attr(s.attrs, "name");
    if (n) parts.push(n);
  }
  return parts.join(" | ");
}

// === AC1 — the timeline renders every entry, newest-first, agent-reported labelled ==

test("renders entries in the order given — newest at the top", () => {
  // The loader hands entries in newest-first order; the view must preserve that
  // order (never reverse it). Each entry carries a unique marker word so position is
  // unambiguous: dentist (newest) → travel → Visa (oldest).
  const markup = render(base());
  const text = visibleText(markup);
  const iDentist = text.indexOf("dentist");
  const iTravel = text.indexOf("travel");
  const iVisa = text.indexOf("Visa");
  assert.ok(iDentist >= 0 && iTravel >= 0 && iVisa >= 0, `every entry must render, got: "${text}"`);
  assert.ok(
    iDentist < iTravel && iTravel < iVisa,
    `entries must render newest-first (dentist, then travel, then Visa), got order indices ${iDentist}/${iTravel}/${iVisa} in: "${text}"`,
  );
});

test("renders each entry's kind, agent/service, outcome and time", () => {
  // One entry alone so each value can only come from it.
  const text = visibleText(render(base({ entries: [ENTRY_TOOL_CALL] })));
  for (const expected of [
    ENTRY_TOOL_CALL.kind, // "Tool call"
    ENTRY_TOOL_CALL.agent!, // "Claude"
    ENTRY_TOOL_CALL.service!, // "Google Calendar"
    ENTRY_TOOL_CALL.outcome, // "Done"
    ENTRY_TOOL_CALL.at, // "two minutes ago"
    ENTRY_TOOL_CALL.summary,
  ]) {
    assert.ok(
      text.includes(expected),
      `the entry must show "${expected}", got: "${text}"`,
    );
  }
});

test("labels an agent-reported entry 'Reported by <agent>'", () => {
  const text = visibleText(render(base({ entries: [ENTRY_AGENT_NOTE] })));
  assert.match(
    text,
    /reported by\s+ChatGPT/i,
    `an agent-reported summary must be labelled "Reported by ChatGPT", got: "${text}"`,
  );
});

test("a Warthog-sourced entry is NOT labelled 'Reported by' — even though it names its agent", () => {
  // ENTRY_TOOL_CALL names its agent (Claude) but was recorded by Warthog itself, so
  // it must NOT carry the agent-reported label. Rendered alone, so the absence check
  // is scoped to this one entry.
  const text = visibleText(render(base({ entries: [ENTRY_TOOL_CALL] })));
  assert.ok(text.includes("Claude"), "the Warthog entry still names its agent");
  assert.ok(
    !/reported by/i.test(text),
    `a Warthog-recorded entry must not be labelled "Reported by", got: "${text}"`,
  );
});

test("renders from the entries given, not a fixed list", () => {
  const onlyA: ActivityEntryView = {
    ...ENTRY_TOOL_CALL,
    seq: 99,
    summary: "Renewed your parking permit",
    detail: "Lodged the renewal with the council.",
  };
  const onlyB: ActivityEntryView = {
    ...ENTRY_TOOL_CALL,
    seq: 98,
    summary: "Topped up your transport card",
    detail: "Added credit to the card.",
  };
  const textA = visibleText(render(base({ entries: [onlyA] })));
  const textB = visibleText(render(base({ entries: [onlyB] })));
  assert.ok(textA.includes("parking permit"), "list A shows A's entry");
  assert.ok(!textA.includes("transport card"), "list A must not show B's entry");
  assert.ok(textB.includes("transport card"), "list B shows B's entry");
  assert.ok(!textB.includes("parking permit"), "list B must not show A's entry");
});

test("shows each entry's full detail (the timeline is render-testable, detail open-able)", () => {
  const text = visibleText(render(base()));
  for (const entry of base().entries) {
    assert.ok(
      text.includes(entry.detail),
      `the per-entry detail "${entry.detail}" must be render-present, got: "${text}"`,
    );
  }
});

// === AC2 — Dispute on every entry; Undo only where a reversal is declared ==========

test("shows a Dispute control on every entry (reversible and non-reversible alike)", () => {
  for (const entry of [ENTRY_TOOL_CALL, ENTRY_AGENT_NOTE, ENTRY_CARD_RELEASE]) {
    const markup = render(base({ entries: [entry] }));
    const disputes = buttonsMatching(markup, /dispute/i);
    assert.ok(
      disputes.length >= 1,
      `every entry must offer a Dispute control; entry seq ${entry.seq} had none`,
    );
    assert.ok(
      disputes.every((b) => !isDisabled(b)),
      `the Dispute control must be live, not a dead/disabled button (entry seq ${entry.seq})`,
    );
  }
  // Across the whole list, every entry contributes its own Dispute control.
  const all = base();
  assert.ok(
    buttonsMatching(render(all), /dispute/i).length >= all.entries.length,
    "a Dispute control must appear for each of the entries",
  );
});

test("shows an Undo control on an entry whose tool declares a reversal", () => {
  const markup = render(base({ entries: [ENTRY_TOOL_CALL] })); // canUndo: true
  const undos = buttonsMatching(markup, /\bundo\b/i);
  assert.ok(undos.length >= 1, "a reversible entry must offer an Undo control");
  assert.ok(
    undos.every((b) => !isDisabled(b)),
    "the Undo control must be live, not a dead/disabled button",
  );
});

test("shows NO Undo control on an entry whose tool declares no reversal", () => {
  // Rendered alone and as a non-reversible-only list: there must be no Undo control
  // at all — not even a disabled one (that would be a dead control). The Dispute
  // control, however, is still present (Undo and Dispute are distinct).
  for (const entry of [ENTRY_AGENT_NOTE, ENTRY_CARD_RELEASE]) {
    const markup = render(base({ entries: [entry] }));
    assert.equal(
      buttonsMatching(markup, /\bundo\b/i).length,
      0,
      `a non-reversible entry (seq ${entry.seq}) must offer no Undo control`,
    );
    assert.ok(
      buttonsMatching(markup, /dispute/i).length >= 1,
      `a non-reversible entry (seq ${entry.seq}) still offers Dispute`,
    );
  }
  const nonReversibleList = render(base({ entries: [ENTRY_AGENT_NOTE, ENTRY_CARD_RELEASE] }));
  assert.equal(
    buttonsMatching(nonReversibleList, /\bundo\b/i).length,
    0,
    "a list with no reversible entries offers no Undo control at all",
  );
});

// === The rest of the component's surface (brief "Activity feed") ===================

test("renders a search box", () => {
  const markup = render(base());
  const hasSearchInput = inputAttrs(markup).some((a) => {
    const type = attr(a, "type");
    const named = [attr(a, "name"), attr(a, "placeholder"), attr(a, "aria-label")]
      .filter(Boolean)
      .join(" ");
    return type === "search" || /search/i.test(named);
  });
  const hasSearchChrome =
    /role="search"/i.test(markup) || /search/i.test(controlLabelText(markup));
  assert.ok(
    hasSearchInput || hasSearchChrome,
    `the view must render a search box, got label/control text: "${controlLabelText(markup)}"`,
  );
});

test("renders filter controls for agent, service, kind, outcome and a date range", () => {
  const markup = render(base());
  const labels = controlLabelText(markup);
  assert.match(labels, /agent/i, `a filter for agent must be offered, got: "${labels}"`);
  assert.match(
    labels,
    /service|connector|connection/i,
    `a filter for service must be offered, got: "${labels}"`,
  );
  assert.match(labels, /kind/i, `a filter for kind must be offered, got: "${labels}"`);
  assert.match(labels, /outcome/i, `a filter for outcome must be offered, got: "${labels}"`);
  const dateInputs = inputAttrs(markup).filter((a) => attr(a, "type") === "date").length;
  assert.ok(
    dateInputs >= 1 || /\bdate\b|\bfrom\b|\bto\b|since|until|range/i.test(labels),
    `a date-range filter must be offered, got date inputs: ${dateInputs}, labels: "${labels}"`,
  );
});

test("renders a Check-integrity control", () => {
  const markup = render(base());
  assert.ok(
    buttonsMatching(markup, /check\s*integrity|verify.*record|integrity/i).length >= 1,
    `the view must render a Check-integrity control, got buttons: ${JSON.stringify(
      findAll(markup, "button").map((b) => controlFace(b)),
    )}`,
  );
});

test("shows an intact integrity result naming the number of entries checked", () => {
  // Rendered over an empty timeline so the number can only come from the result.
  const intact: IntegrityResult = { intact: true, checked: 7, brokenSeq: null };
  const text = visibleText(render(base({ entries: [], integrity: intact })));
  assert.ok(text.includes("7"), `the intact result must show the count checked (7), got: "${text}"`);
  assert.match(text, /intact/i, `the intact result must say the record is intact, got: "${text}"`);
  assert.match(text, /entr/i, `the intact result must mention entries, got: "${text}"`);
});

test("shows a failed integrity result with the advice to export and contact the operator", () => {
  const broken: IntegrityResult = { intact: false, checked: 9, brokenSeq: 4 };
  const text = visibleText(render(base({ entries: [], integrity: broken })));
  assert.match(
    text,
    /fail|broken|tamper|mismatch|doesn.?t match|couldn.?t verify|not intact|problem/i,
    `a failed result must read as a failure, got: "${text}"`,
  );
  assert.match(text, /export/i, `a failed result must advise exporting the record, got: "${text}"`);
  assert.match(text, /operator/i, `a failed result must advise contacting the operator, got: "${text}"`);
});

test("an empty timeline renders a message and keeps the Check-integrity control (no dead screen, no entry controls)", () => {
  let markup: string;
  try {
    markup = render(base({ entries: [] }));
  } catch (err) {
    assert.fail(
      "ActivityView must render an empty timeline, not crash: " +
        (err instanceof Error ? err.message : String(err)),
    );
    return;
  }
  assert.ok(visibleText(markup).length >= 3, `the empty state must say something, got: "${visibleText(markup)}"`);
  // No per-entry controls when there are no entries (scoping check).
  assert.equal(buttonsMatching(markup, /dispute/i).length, 0, "no Dispute controls when there are no entries");
  assert.equal(buttonsMatching(markup, /\bundo\b/i).length, 0, "no Undo controls when there are no entries");
  // The record-wide Check-integrity control is still available.
  assert.ok(
    buttonsMatching(markup, /check\s*integrity|verify.*record|integrity/i).length >= 1,
    "the Check-integrity control stays available on an empty timeline",
  );
});

// === AC3 — colour comes from design tokens, never a raw hex literal ================

test("uses design tokens, never a raw hex colour (populated, empty, and with a result)", () => {
  for (const props of [
    base(),
    base({ entries: [] }),
    base({ entries: [], integrity: { intact: false, checked: 9, brokenSeq: 4 } }),
  ]) {
    const markup = render(props);
    assert.ok(
      !/#[0-9a-fA-F]{3,8}\b/.test(markup),
      `no raw hex colour may appear in the ActivityView markup, got: ${markup}`,
    );
  }
});
