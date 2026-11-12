// E12-S16 — Rules view component (src/components/rules/rules-view.tsx).
//
// RED-first: src/components/rules/rules-view.tsx does NOT exist yet, so importing
// `./rules-view` throws and every test here fails until the builder adds the
// component. That absence is the entire point of test-first — do NOT implement
// anything to make these pass.
//
// WHY this component exists (brief "Rules and approvals"; design §8): the Rules
// screen must let a person READ BACK their existing rules as the exact plain
// sentences Warthog enforces — each with a Pause and a Delete — and BUILD a new
// rule from a template, previewing it as a sentence before saving and scoping it
// to all agents or chosen agents. The templates are the brief's own: the
// "Ask me first" and "Never allow" rules (over the brief's action and condition
// choices), the spending rules (a per-purchase limit, a budget per agent per
// day/week/month, an allowed-merchants-only list and a blocked-merchants list) and
// an approval-expiry setting.
//
// This is the render-testable, prop-driven VIEW (a Client Component in the app).
// The real persistence/apply plumbing (pausing, deleting, saving a new rule, and
// the live state as the person switches templates) lives in the server composition
// root and a sibling actions module wired by a LATER task; THIS component renders
// the screen from its props — the existing rules it is given, the person's agents,
// and a `draft` that selects the initially-active template + its values + scope —
// so it can be pinned without a browser, a session or any server plumbing. That
// `draft` seam is exactly the precedent the sibling consent view set (a `template`
// prop drives the initial render of a conceptually-interactive screen): it lets a
// render test pin the preview for EACH template without clicking anything.
//
// These tests pin BEHAVIOUR — what the component RENDERS for the props it is given
// (the plain sentences a person reads, the accessible/live controls, and the
// preview sentence the chosen draft produces) — never the source text of
// rules-view.tsx. A later behaviour-preserving refactor (different wrapper
// elements, reworded-but-still-plain copy, a <select> instead of radios, extra
// classes, a different icon) stays green. We render with `react-dom/server`
// (no DOM/jsdom — React component / E2E testing is a per-job ADR) and read the
// emitted markup, exactly as the sibling component tests do.
//
// The rule SENTENCE is the one-source-of-truth pure domain renderer `ruleSentence`
// (@/domain/rules/rules), which this test imports and computes its expectations
// from — it re-hardcodes no wording, so if the domain renderer's phrasing ever
// changes, the component and these tests move together. Colour comes from the
// design tokens (globals.css) — never a raw hex.
//
// ---------------------------------------------------------------------------
// THE CONTRACT the builder implements (test-first spec; the component conforms):
//
//   RulesView({ rules, agents, draft?, currency? }):
//     • rules    — the person's EXISTING rules, each { id, sentence, scope, status }
//                  (the shape the Rules page read hands back): the exact sentence is
//                  shown, with a live Pause (for an active rule) and a live Delete.
//     • agents   — the person's connected agents { id, name }, offered as the
//                  "chosen agents" scope choices alongside an "all agents" choice.
//     • draft    — the initially-ACTIVE create-form template, its values and its
//                  scope; it drives the preview sentence and the initial controls.
//                  One variant per template the form offers (see RuleDraft below).
//                  Optional — omitted lets the component pick its own default.
//     • currency — the person's currency label (e.g. "A$"); defaults are the view's.
//
// Behaviours asserted below:
//   - every existing rule renders as its plain sentence, each with a live Pause
//     (active rules) and a live Delete; a paused rule shows its status in words.
//   - the create form offers the Ask-me-first and Never-allow templates plus the
//     brief's six action choices (the spending and expiry "templates" are superseded:
//     see the template test below and rules-view.organise.test.tsx's Budgets tab).
//   - the chosen draft is PREVIEWED as a sentence before saving: an ask-first /
//     never-allow draft previews EXACTLY `ruleSentence(...)` (so the condition and
//     the all-agents / chosen-agent scope all flow through).
//   - a scope choice for all agents and for each connected agent is offered.
//   - a live control to add the rule is present; no raw hex colour anywhere.

import * as React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";

import { RulesView } from "./rules-view";
import {
  ruleSentence,
  type Rule,
  type RuleScope,
  type RuleAction,
  type RuleCondition,
} from "@/domain/rules/rules";

// --- the prop shape this task introduces (described here as the contract) -------

type RulesViewRule = {
  id: string;
  sentence: string;
  scope: RuleScope;
  status: "active" | "paused";
  kind: "ask_first" | "never_allow";
};

type RulesViewAgent = { id: string; name: string };

// The initially-active create-form template, its values and its scope. The two rule
// templates (ask_first / never_allow) carry the brief's action + optional condition.
// SUPERSEDED (rules tidy-up): the spending and approval-expiry "templates" were disabled
// radios pointing at settings that do not exist; they are gone from the form (see below).
type RuleDraft =
  | { template: "ask_first"; scope: RuleScope; action: RuleAction; condition?: RuleCondition }
  | { template: "never_allow"; scope: RuleScope; action: RuleAction; condition?: RuleCondition };

type RulesViewProps = {
  rules: ReadonlyArray<RulesViewRule>;
  agents: ReadonlyArray<RulesViewAgent>;
  draft?: RuleDraft;
  currency?: string;
};

// --- fixtures -------------------------------------------------------------------
//
// Existing-rule sentences and the connected-agent names are chosen so they never
// collide with the sentences / figures / merchants the preview tests assert. That
// keeps every "the preview shows X" assertion honest: X can only have come from the
// preview, never from an existing-rule line or a form control, because nothing else
// in the fixtures contains it.

const ANY_AGENT: RuleScope = { type: "any_agent" };
const CLAUDE_SCOPE: RuleScope = { type: "agent", agentId: "a-claude", name: "Claude" };

const EXISTING: RulesViewRule[] = [
  {
    id: "r1",
    sentence: "Ask me before any agent requests a high-tier identity detail",
    scope: ANY_AGENT,
    status: "active",
    kind: "ask_first",
  },
  {
    id: "r2",
    sentence: "Never allow Grok to make any change",
    scope: { type: "agent", agentId: "a-grok", name: "Grok" },
    status: "active",
    kind: "never_allow",
  },
  {
    id: "r3",
    sentence: "Ask me before any agent requests a card when the amount is over 500",
    scope: ANY_AGENT,
    status: "paused",
    kind: "ask_first",
  },
];

const ACTIVE_COUNT = EXISTING.filter((r) => r.status === "active").length; // 2
const TOTAL_COUNT = EXISTING.length; // 3

const AGENTS: RulesViewAgent[] = [
  { id: "a-claude", name: "Claude" },
  { id: "a-chatgpt", name: "ChatGPT" },
];

function base(overrides: Partial<RulesViewProps> = {}): RulesViewProps {
  return {
    rules: EXISTING,
    agents: AGENTS,
    draft: {
      template: "ask_first",
      scope: ANY_AGENT,
      action: { type: "send_message", channel: "email" },
    },
    currency: "A$",
    ...overrides,
  };
}

// Build the domain Rule an ask_first / never_allow draft represents, so the expected
// preview sentence comes straight from the one-source-of-truth renderer.
function ruleOf(draft: Extract<RuleDraft, { template: "ask_first" | "never_allow" }>): Rule {
  return {
    kind: draft.template,
    scope: draft.scope,
    action: draft.action,
    condition: draft.condition,
  };
}

// --- markup helpers (no DOM), mirrored from the sibling component tests ---------

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

// Visible text of an HTML fragment: the words a sighted reader sees (an <svg> icon
// contributes none, and an attribute value like an input's `value` is NOT visible
// text — the tag is stripped whole), tags stripped and entities decoded.
function visibleText(markup: string): string {
  return decode(markup.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

function attr(attrs: string, name: string): string | null {
  const m = attrs.match(new RegExp(`\\b${name}="([^"]*)"`, "i"));
  return m ? m[1] : null;
}

// A boolean/valueless attribute present as its own token — ` disabled`, ` disabled=""`
// or ` disabled="disabled"` — but never the word inside another attribute.
function hasBoolAttr(attrs: string, name: string): boolean {
  return new RegExp(`(?:^|\\s)${name}(?:=(?:""|"${name}"))?(?=\\s|/|>|$)`, "i").test(" " + attrs);
}

function findAll(markup: string, tag: string): Array<{ attrs: string; inner: string }> {
  const out: Array<{ attrs: string; inner: string }> = [];
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

// Names of every actionable (not-disabled) control: a live <button>, a non-disabled
// checkbox/radio input (by label / aria-label / value), a wrapping-label input, or
// an <option> (a choice may be made from a <select>). This reads RENDERED, LIVE
// affordances — never dead static text — covering the common control shapes without
// pinning any one implementation.
function selectableNames(markup: string): string[] {
  const labels = labelTextById(markup);
  const out: string[] = [];
  for (const b of findAll(markup, "button")) {
    if (hasBoolAttr(b.attrs, "disabled")) continue;
    out.push((visibleText(b.inner) || attr(b.attrs, "aria-label") || "").trim());
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

function hasSelectable(markup: string, re: RegExp): boolean {
  return selectableNames(markup).some((n) => re.test(n));
}

function countSelectable(markup: string, re: RegExp): number {
  return selectableNames(markup).filter((n) => re.test(n)).length;
}

// Names of every DISABLED control (the counterpart of selectableNames): a disabled
// <button>, a disabled checkbox/radio input, or a disabled wrapping-label input (an
// incomplete draft's Add button, say). Reads RENDERED state, not source text.
function disabledNames(markup: string): string[] {
  const labels = labelTextById(markup);
  const out: string[] = [];
  for (const b of findAll(markup, "button")) {
    if (!hasBoolAttr(b.attrs, "disabled")) continue;
    out.push((visibleText(b.inner) || attr(b.attrs, "aria-label") || "").trim());
  }
  for (const m of markup.matchAll(/<input\b([^>]*?)\/?>/gi)) {
    const attrs = m[1];
    if (!hasBoolAttr(attrs, "disabled")) continue;
    const id = attr(attrs, "id");
    out.push(((id && labels[id]) || attr(attrs, "aria-label") || attr(attrs, "value") || "").trim());
  }
  for (const l of findAll(markup, "label")) {
    const im = l.inner.match(/<input\b([^>]*?)\/?>/i);
    if (!im || !hasBoolAttr(im[1], "disabled")) continue;
    out.push(visibleText(l.inner));
  }
  return out.filter((n) => n.length > 0);
}

// Whether `markup` carries a form control (input / select / textarea) posting under
// `name` — the behaviour a FormData-reading server action depends on. Pins the NAME the
// control posts under, not its element kind or label copy (a refactor may swap a select
// for radios, or reword a label, and stay green).
function hasNamedControl(markup: string, name: string): boolean {
  return new RegExp(`<(?:input|select|textarea)\\b[^>]*\\bname="${name}"`, "i").test(markup);
}

function render(props: RulesViewProps): string {
  return renderToStaticMarkup(<RulesView {...props} />);
}

// === AC1 — existing rules read back as sentences, each with Pause and Delete =====

test("lists every existing rule as its exact plain sentence", () => {
  const text = visibleText(render(base()));
  for (const rule of EXISTING) {
    assert.ok(
      text.includes(rule.sentence),
      `the Rules screen must read back the rule "${rule.sentence}" verbatim; text="${text}"`,
    );
  }
});

test("offers a live Pause for each active rule and a live Delete for each rule", () => {
  const markup = render(base());
  // A Pause control per active rule (a paused rule may instead read "Resume", so we
  // only require Pause to cover the ACTIVE ones) …
  assert.ok(
    countSelectable(markup, /\bpause\b/i) >= ACTIVE_COUNT,
    `each active rule must offer a live Pause control (expected ≥ ${ACTIVE_COUNT}); ` +
      `controls=${JSON.stringify(selectableNames(markup))}`,
  );
  // … and a Delete (or Remove) control for every rule, active or paused.
  assert.ok(
    countSelectable(markup, /\b(delete|remove)\b/i) >= TOTAL_COUNT,
    `every rule must offer a live Delete control (expected ≥ ${TOTAL_COUNT}); ` +
      `controls=${JSON.stringify(selectableNames(markup))}`,
  );
});

test("marks a paused rule's state in words, and never promises resuming without a live Resume control", () => {
  // EXISTING has one paused rule. Its paused state must be legible as a word, per the
  // design rule "status uses words + icons, never colour alone" — shown either as a
  // "Paused" status or by offering a "Resume" control (both are words a reader sees).
  const markup = render(base());
  const text = visibleText(markup);
  assert.match(
    text,
    /paused|resume/i,
    `a paused rule must have its state legible in words (a "Paused" status or a "Resume" control); text="${text}"`,
  );
  // E18-S20 honest-pause contract (SUPERSEDES the old paused copy): the screen must not
  // PROMISE resuming unless a live Resume control is actually shown. A resume promise
  // with no control is a dead/dishonest affordance (there is no resume primitive to back
  // one). So if "resume" appears as visible copy, a selectable Resume control MUST exist;
  // if none is shown, the copy must not mention resuming. This holds either era honestly
  // (a reworded notice with no control, or a real Resume control added later).
  const promisesResume = /\bresume\b/i.test(text);
  const offersLiveResume = hasSelectable(markup, /\bresume\b/i);
  assert.ok(
    !promisesResume || offersLiveResume,
    `a paused rule must not promise resuming unless a live Resume control is shown; ` +
      `visibleText="${text}", liveControls=${JSON.stringify(selectableNames(markup))}`,
  );
});

test("renders a chosen-agent rule by the agent's name, never its raw connection id", () => {
  // E18-S20 AC2 (SUPERSEDES: a chosen-agent scope used to read back as a raw UUID in the
  // rule sentence). A rule scoped to a chosen agent reads back with the agent's DISPLAY
  // NAME in its sentence (as the one-source-of-truth ruleSentence renders a named scope —
  // by `scope.name`). The agent's connection id is matching metadata, never reader-facing
  // copy, so it must NEVER surface in the rendered rules list.
  const CONNECTION_ID = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d"; // a uuid that appears nowhere else
  const chosen: RulesViewRule = {
    id: "chosen-rule-1",
    // the sentence names the agent — what ruleSentence produces for a named scope …
    sentence: "Ask me before Claude requests a card",
    scope: { type: "agent", agentId: CONNECTION_ID, name: "Claude" },
    status: "active",
    kind: "ask_first",
  };
  const markup = render(base({ rules: [chosen] }));
  const text = visibleText(markup);
  assert.ok(
    text.includes("Ask me before Claude requests a card"),
    `the chosen-agent rule must read back naming the agent; text="${text}"`,
  );
  // … and its raw connection id never leaks into the render (the rules list shows the
  // sentence, not the scope's matching id).
  assert.ok(
    !markup.includes(CONNECTION_ID),
    `the agent's raw connection id must never appear in the rendered rules; markup=${markup}`,
  );
});

// === AC1 — the create form offers every template and the action choices ==========

test("offers the Ask-me-first and Never-allow rule templates as live choices", () => {
  const markup = render(base());
  assert.ok(
    hasSelectable(markup, /ask me (first|before)|ask[- ]first/i),
    `the create form must offer the "Ask me first" template; controls=${JSON.stringify(selectableNames(markup))}`,
  );
  assert.ok(
    hasSelectable(markup, /never allow/i),
    `the create form must offer the "Never allow" template; controls=${JSON.stringify(selectableNames(markup))}`,
  );
});

test("offers only the two rule templates: no disabled spending or approval-expiry choices", () => {
  // SUPERSEDES (rules tidy-up) the E12-S17 "shown DISABLED, set elsewhere" contract. Those
  // five radios were never selectable and pointed at settings that do not exist (no
  // per-purchase limit, merchant list or approval-expiry setting exists anywhere in the
  // app; only a per-agent card budget does, which the Budgets tab now links to). The form
  // offers exactly the two templates the rules store holds, and no disabled template.
  const markup = render(base());
  const templateRadios = [...markup.matchAll(/<input\b([^>]*\bname="rule-template"[^>]*?)\/?>/gi)].map((m) => m[1]!);
  assert.deepEqual(
    templateRadios.map((attrs) => attr(attrs, "value")),
    ["ask_first", "never_allow"],
    "the template picker holds exactly the two rule templates",
  );
  assert.ok(templateRadios.every((attrs) => !hasBoolAttr(attrs, "disabled")), "neither template is disabled");
  const text = visibleText(markup);
  for (const gone of [/per[- ]purchase limit/i, /allowed merchants only/i, /blocked merchants/i, /approval expiry/i, /approvals stay open/i]) {
    assert.doesNotMatch(text, gone, `no copy names a setting that does not exist (${gone})`);
  }
  assert.equal(disabledNames(markup).filter((n) => /template|merchant|expir|purchase/i.test(n)).length, 0);
});

test("offers the brief's six action choices under a rule template", () => {
  // With an ask-first template active, the action picker is shown; it offers exactly
  // the brief's action vocabulary. Each is an independent top-level choice, so all
  // six are present at once. (Condition choices are covered behaviourally through
  // the preview below, so the action-dependent condition UI is not pinned here.)
  const markup = render(base({ draft: { template: "ask_first", scope: ANY_AGENT, action: { type: "send_message", channel: "email" } } }));
  const controls = JSON.stringify(selectableNames(markup));
  const ACTION_CHOICES: Array<{ re: RegExp; label: string }> = [
    { re: /send|message|email/i, label: "a message-sending action" },
    { re: /specific tool|a particular tool|named tool/i, label: "a specific tool" },
    { re: /service|connector|connection/i, label: "any tool of a chosen service" },
    { re: /change[- ]?making|any change/i, label: "any change-making tool" },
    { re: /\bcard\b/i, label: "a card request" },
    // "Protected details" is the canonical name for the high tier (content-09).
    { re: /high[- ]?tier|protected detail/i, label: "a high-tier identity request" },
  ];
  for (const choice of ACTION_CHOICES) {
    assert.ok(
      hasSelectable(markup, choice.re),
      `the action picker must offer "${choice.label}"; controls=${controls}`,
    );
  }
});

// === AC2 — each template choice previews the rule as a sentence before saving =====

test("previews an Ask-me-first rule as its exact sentence (the AC's own example)", () => {
  // The acceptance criterion's worked example, verbatim through ruleSentence.
  const draft: RuleDraft = {
    template: "ask_first",
    scope: ANY_AGENT,
    action: { type: "send_message", channel: "email" },
    condition: { type: "recipient_is", address: "manager@example.com" },
  };
  const expected = ruleSentence(ruleOf(draft)); // "Ask me before any agent sends email to manager@example.com"
  assert.equal(expected, "Ask me before any agent sends email to manager@example.com");
  const text = visibleText(render(base({ draft })));
  assert.ok(
    text.includes(expected),
    `the preview must read back the rule as "${expected}"; text="${text}"`,
  );
});

test("previews a Never-allow rule as its sentence", () => {
  const draft: RuleDraft = {
    template: "never_allow",
    scope: ANY_AGENT,
    action: { type: "send_message", channel: "email" },
    condition: { type: "recipient_is", address: "manager@example.com" },
  };
  const expected = ruleSentence(ruleOf(draft));
  assert.ok(expected.startsWith("Never allow"), "sanity: a never-allow sentence starts with Never allow");
  const text = visibleText(render(base({ draft })));
  assert.ok(
    text.includes(expected),
    `the preview must read back the never-allow rule as "${expected}"; text="${text}"`,
  );
});

test("previews with the all-agents scope naming 'any agent'", () => {
  const draft: RuleDraft = {
    template: "ask_first",
    scope: ANY_AGENT,
    action: { type: "send_message", channel: "email" },
    condition: { type: "recipient_is", address: "manager@example.com" },
  };
  const text = visibleText(render(base({ draft })));
  assert.ok(
    text.includes(ruleSentence(ruleOf(draft))),
    `the all-agents preview must read "any agent"; text="${text}"`,
  );
});

test("previews with a chosen-agent scope naming that agent", () => {
  // Scoping to a chosen agent must change the sentence's subject to the agent's name.
  const draft: RuleDraft = {
    template: "ask_first",
    scope: CLAUDE_SCOPE,
    action: { type: "send_message", channel: "email" },
    condition: { type: "recipient_is", address: "manager@example.com" },
  };
  const expected = ruleSentence(ruleOf(draft)); // "Ask me before Claude sends email to manager@example.com"
  assert.ok(expected.includes("Claude"), "sanity: the chosen-agent sentence names the agent");
  const text = visibleText(render(base({ draft })));
  assert.ok(
    text.includes(expected),
    `the chosen-agent preview must name the agent in the sentence ("${expected}"); text="${text}"`,
  );
});

test("the preview reflects a recipient-in-domain condition", () => {
  const draft: RuleDraft = {
    template: "ask_first",
    scope: ANY_AGENT,
    action: { type: "send_message", channel: "email" },
    condition: { type: "recipient_in_domain", domain: "acme.example" },
  };
  const text = visibleText(render(base({ draft })));
  assert.ok(
    text.includes(ruleSentence(ruleOf(draft))),
    `the preview must fold in the recipient-domain condition; text="${text}"`,
  );
});

test("the preview reflects an amount-over condition on a card request", () => {
  const draft: RuleDraft = {
    template: "ask_first",
    scope: ANY_AGENT,
    action: { type: "card_request" },
    condition: { type: "amount_over", amount: 750 },
  };
  const expected = ruleSentence(ruleOf(draft)); // "...requests a card when the amount is over 750"
  const text = visibleText(render(base({ draft })));
  assert.ok(
    text.includes(expected),
    `the preview must fold in the amount-over condition ("${expected}"); text="${text}"`,
  );
});

test("the preview reflects a merchant-not-in condition on a card request", () => {
  const draft: RuleDraft = {
    template: "never_allow",
    scope: ANY_AGENT,
    action: { type: "card_request" },
    condition: { type: "merchant_not_in", merchants: ["Sketchy Store"] },
  };
  const expected = ruleSentence(ruleOf(draft));
  const text = visibleText(render(base({ draft })));
  assert.ok(
    text.includes(expected),
    `the preview must fold in the merchant condition ("${expected}"); text="${text}"`,
  );
});

// === AC6 — the rule form carries the NAMED payload fields the create action posts =====
//
// SUPERSEDED (E12-S17): the spending/expiry templates no longer preview a submittable
// sentence here (they are set elsewhere — covered above). Instead the RULE form gains
// the NAMED payload fields the create form's server action reads from its FormData — the
// SAME names the sibling actions.test.ts drives through `ruleInputFromForm`: a message
// `rule-channel`, a `rule-target` (the tool or service name) and a `rule-condition-detail`.
// These pin the NAME the control posts under (so a FormData-reading action gets its
// value), not the control's copy or element kind — a refactor that rewords a label or
// swaps a <select> for radios stays green.

test("a send-message rule form names its message-channel field", () => {
  const markup = render(
    base({ draft: { template: "ask_first", scope: ANY_AGENT, action: { type: "send_message", channel: "email" } } }),
  );
  assert.ok(
    hasNamedControl(markup, "rule-channel"),
    `a send-message rule form must post a named "rule-channel" field; markup=${markup}`,
  );
});

test("a specific-tool rule form names its tool-or-service field", () => {
  const markup = render(
    base({ draft: { template: "ask_first", scope: ANY_AGENT, action: { type: "specific_tool", tool: "send_email" } } }),
  );
  assert.ok(
    hasNamedControl(markup, "rule-target"),
    `a specific-tool rule form must post a named "rule-target" field (the tool name); markup=${markup}`,
  );
});

test("a service rule form names its tool-or-service field", () => {
  const markup = render(
    base({ draft: { template: "ask_first", scope: CLAUDE_SCOPE, action: { type: "service_tool", service: "gmail" } } }),
  );
  assert.ok(
    hasNamedControl(markup, "rule-target"),
    `a service rule form must post a named "rule-target" field (the service name); markup=${markup}`,
  );
});

test("a rule carrying a condition names its condition-detail field", () => {
  const markup = render(
    base({
      draft: {
        template: "ask_first",
        scope: ANY_AGENT,
        action: { type: "send_message", channel: "email" },
        condition: { type: "recipient_is", address: "manager@example.com" },
      },
    }),
  );
  assert.ok(
    hasNamedControl(markup, "rule-condition-detail"),
    `a rule with a condition must post a named "rule-condition-detail" field; markup=${markup}`,
  );
});

// === AC2 — scope choices: all agents or chosen agents ============================

test("offers an all-agents scope and each connected agent as a scope choice", () => {
  const markup = render(base());
  const controls = JSON.stringify(selectableNames(markup));
  assert.ok(
    hasSelectable(markup, /all agents|any agent|everyone|all of/i),
    `the scope control must offer "all agents"; controls=${controls}`,
  );
  for (const agent of AGENTS) {
    assert.ok(
      hasSelectable(markup, new RegExp(`\\b${agent.name}\\b`, "i")),
      `the scope control must offer the connected agent "${agent.name}"; controls=${controls}`,
    );
  }
});

// === A live control to add the rule (no dead controls) ===========================

test("renders a live control to add the new rule", () => {
  const markup = render(base());
  assert.ok(
    hasSelectable(markup, /\b(add|create|save)\b/i),
    `the create form must offer a live Add/Create/Save control; controls=${JSON.stringify(selectableNames(markup))}`,
  );
});

// === Still renders the create form with no existing rules ========================

test("renders the create form even when there are no existing rules", () => {
  const markup = render(base({ rules: [] }));
  assert.ok(
    hasSelectable(markup, /ask me (first|before)|ask[- ]first/i),
    "with no rules yet, the create form's Ask-me-first template must still be offered",
  );
  assert.ok(
    hasSelectable(markup, /never allow/i),
    "with no rules yet, the create form's Never-allow template must still be offered",
  );
  assert.ok(
    hasSelectable(markup, /\b(add|create|save)\b/i),
    "with no rules yet, the create form's add control must still be offered",
  );
});

// === Design system — colour comes from tokens, never a raw hex literal ===========

test("uses design tokens, never a raw hex colour", () => {
  const drafts: RuleDraft[] = [
    { template: "ask_first", scope: ANY_AGENT, action: { type: "send_message", channel: "email" } },
    { template: "never_allow", scope: CLAUDE_SCOPE, action: { type: "card_request" }, condition: { type: "amount_over", amount: 750 } },
  ];
  for (const draft of drafts) {
    const markup = render(base({ draft }));
    assert.ok(
      !/#[0-9a-fA-F]{3,8}\b/.test(markup),
      `no raw hex colour may appear in the rules-view markup, got: ${markup}`,
    );
  }
});
