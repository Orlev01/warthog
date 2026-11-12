// E10-S07 — Per-agent permissions view component (src/components/agents/permissions-view.tsx).
//
// RED-first: src/components/agents/permissions-view.tsx does NOT exist yet, so
// importing `./permissions-view` throws and every test here fails until the
// builder adds the component. That absence is the entire point of test-first — do
// NOT implement anything to make these pass.
//
// WHY this component exists (brief "Per-agent permissions page"; design §7): each
// agent's reach is shaped on ONE screen. For a given agent the person sees which
// connected services and which of their tools it may use (read tools and
// change-making tools listed SEPARATELY, change-making tools defaulting to "Ask
// me first"), which identity fields it may read without asking (low tier only)
// and whether it may request high-tier fields, whether it may request a card and
// its spending budget (card access cannot be switched on without a budget; the
// budget field defaults to A$200 per month), which skills it receives, whether it
// may read shared memory, whether what it learns is shared with other agents, its
// own rules, and (under Advanced) its request limit (default 120/min).
//
// THIS component is the pure, prop-driven VIEW: it renders the screen from its
// props so it can be pinned without a browser, a session or any server plumbing.
// The persistence/apply plumbing ("changes take effect on the agent's next
// request") lives in the server composition root and is wired by a later task.
//
// These tests pin BEHAVIOUR — what the component RENDERS for the props it is given
// (the plain-words copy a person reads, the accessible controls, the on/off state
// of each toggle, the disabled-with-a-reason save control) — never the source text
// of permissions-view.tsx. A behaviour-preserving refactor (different wrapper
// elements, reworded-but-still-plain copy, a switch instead of a checkbox, extra
// classes, a different icon) stays green. We render with `react-dom/server` (no
// DOM/jsdom — React component / E2E testing is a per-job ADR) and read the emitted
// markup, exactly as the sibling component tests do.
//
// The two one-source-of-truth domain contracts this screen builds on are imported
// and used to COMPUTE expectations, never re-encoded here:
//   • @/domain/budget/budget  — DEFAULT_CARD_BUDGET (A$200/month) and the Budget shape.
//   • @/domain/rules/rules    — ruleSentence(): a rule reads back as its exact sentence.

import * as React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";

import { PermissionsView } from "./permissions-view";
import { DEFAULT_CARD_BUDGET, type Budget } from "@/domain/budget/budget";
import { ruleSentence, type Rule } from "@/domain/rules/rules";

// --- the prop shape this task introduces (described here as the contract) -------

type ConnectorAccess = {
  id: string;
  name: string;
  // the tool names the agent may use, split into the two groups the brief names:
  // read tools and change-making tools (the latter default to "Ask me first").
  readTools: ReadonlyArray<string>;
  changeTools: ReadonlyArray<string>;
};

type SkillGrant = { id: string; name: string; granted: boolean };

type PermissionsViewProps = {
  // the agent being shaped, named on the screen.
  agentName: string;
  // granted connectors and the tools it may use, reads and changes listed apart.
  connectors: ReadonlyArray<ConnectorAccess>;
  // low-tier identity read (always low tier only) vs. the high-tier REQUEST toggle.
  lowTierRead: boolean;
  highTierRequest: boolean;
  // card access and its spending budget; a null budget means none is set yet.
  cardAccess: boolean;
  budget: Budget | null;
  // which skills it receives, each grantable.
  skills: ReadonlyArray<SkillGrant>;
  // read the person's shared memory; share what it learns with other agents.
  sharedMemoryRead: boolean;
  learningSharing: boolean;
  // its own rules, each rendered as its plain-English sentence (ruleSentence).
  rules: ReadonlyArray<Rule>;
  // Advanced: the sliding-window request limit; defaults to 120 requests/min.
  requestLimit?: number;
  // the person's currency label (e.g. "A$"); defaults are the view's concern.
  currency?: string;
};

// --- fixtures -------------------------------------------------------------------
//
// Tool / connector / skill names are chosen so they do NOT contain any of the
// capability keywords the assertions key on (card / budget / high-tier / low-tier
// / memory / learn / limit / minute / 120 / 200). That keeps the checks honest: a
// keyword landing in the asserted surface can only come from the control it names.

const CONNECTORS: ConnectorAccess[] = [
  {
    id: "gcal",
    name: "Google Calendar",
    readTools: ["See events", "List calendars"],
    changeTools: ["Create an event", "Delete an event"],
  },
];

const SKILLS: SkillGrant[] = [
  { id: "sk1", name: "Trip planning", granted: true },
  { id: "sk2", name: "Recipe ideas", granted: false },
];

// Two rules whose sentences are computed from the domain renderer, not hardcoded.
const RULES: Rule[] = [
  {
    kind: "never_allow",
    scope: { type: "agent", agentId: "a1", name: "Claude" },
    action: { type: "send_message", channel: "email" },
    condition: { type: "recipient_is", address: "manager@example.com" },
  },
  {
    kind: "ask_first",
    scope: { type: "any_agent" },
    action: { type: "send_message", channel: "chat" },
  },
];

function base(overrides: Partial<PermissionsViewProps> = {}): PermissionsViewProps {
  return {
    agentName: "Claude",
    connectors: CONNECTORS,
    lowTierRead: true,
    highTierRequest: false,
    cardAccess: false,
    budget: null,
    skills: SKILLS,
    sharedMemoryRead: true,
    learningSharing: false,
    rules: RULES,
    // requestLimit intentionally omitted in the base → the view's 120/min default.
    currency: "A$",
    ...overrides,
  };
}

// --- markup helpers (no DOM), mirrored from the sibling component tests ---------

function decode(s) {
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
// contributes none), tags stripped and entities decoded.
function visibleText(markup) {
  return decode(markup.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

// Read one double-quoted attribute off an element's attribute string.
function attr(attrs, name) {
  const m = attrs.match(new RegExp(`\\b${name}="([^"]*)"`, "i"));
  return m ? m[1] : null;
}

// A boolean/valueless attribute present as its own token — ` disabled`,
// ` disabled=""` or ` disabled="disabled"` — but never the "checked" inside
// `aria-checked`. Tested against a leading space so the first attr also has a
// boundary.
function hasBoolAttr(attrs, name) {
  return new RegExp(`(?:^|\\s)${name}(?:=(?:""|"${name}"))?(?=\\s|/|>|$)`, "i").test(" " + attrs);
}

function findAll(markup, tag) {
  const out = [];
  for (const m of markup.matchAll(new RegExp(`<${tag}\\b([^>]*)>([\\s\\S]*?)</${tag}>`, "gi"))) {
    out.push({ attrs: m[1], inner: m[2] });
  }
  return out;
}

// id → the visible text of the <label for=id> that targets it.
function labelTextById(markup) {
  const map = {};
  for (const l of findAll(markup, "label")) {
    const f = attr(l.attrs, "for");
    if (f) map[f] = visibleText(l.inner);
  }
  return map;
}

// Every toggle-like control — a checkbox / radio input (named by its <label for>,
// its wrapping <label>, or aria-label) OR a role=switch / aria-checked /
// aria-pressed element — with its accessible name, on-state and disabled flag.
// Reads RENDERED ACCESSIBLE STATE (behaviour), covering the common accessible
// toggle implementations, not any one control's source.
function toggleControls(markup) {
  const labels = labelTextById(markup);
  const out = [];

  for (const m of markup.matchAll(/<input\b([^>]*?)\/?>/gi)) {
    const attrs = m[1];
    const type = (attr(attrs, "type") ?? "text").toLowerCase();
    if (type !== "checkbox" && type !== "radio") continue;
    const id = attr(attrs, "id");
    const name = ((id && labels[id]) || attr(attrs, "aria-label") || "").trim();
    const on = hasBoolAttr(attrs, "checked") || attr(attrs, "aria-checked") === "true";
    out.push({ name, on, disabled: hasBoolAttr(attrs, "disabled") });
  }

  for (const l of findAll(markup, "label")) {
    const im = l.inner.match(/<input\b([^>]*?)\/?>/i);
    if (!im) continue;
    const iattrs = im[1];
    const type = (attr(iattrs, "type") ?? "text").toLowerCase();
    if (type !== "checkbox" && type !== "radio") continue;
    const on = hasBoolAttr(iattrs, "checked") || attr(iattrs, "aria-checked") === "true";
    out.push({ name: visibleText(l.inner), on, disabled: hasBoolAttr(iattrs, "disabled") });
  }

  for (const b of findAll(markup, "button")) {
    const role = attr(b.attrs, "role");
    const ariaChecked = attr(b.attrs, "aria-checked");
    const ariaPressed = attr(b.attrs, "aria-pressed");
    if (role !== "switch" && ariaChecked == null && ariaPressed == null) continue;
    const name = (visibleText(b.inner) || attr(b.attrs, "aria-label") || "").trim();
    out.push({
      name,
      on: ariaChecked === "true" || ariaPressed === "true",
      disabled: hasBoolAttr(b.attrs, "disabled"),
    });
  }

  return out;
}

// The first toggle whose accessible name matches `re`.
function toggle(markup, re) {
  return toggleControls(markup).find((c) => re.test(c.name));
}

// Every <button> with its accessible name and disabled state (live OR disabled).
function allButtons(markup) {
  return findAll(markup, "button").map((b) => ({
    name: (visibleText(b.inner) || attr(b.attrs, "aria-label") || "").trim(),
    disabled: hasBoolAttr(b.attrs, "disabled"),
  }));
}

// Value-bearing inputs (text / number / anything that is not a checkbox, radio or
// a non-value control) with their accessible label, value, placeholder and
// disabled flag. `defaultValue` renders as the `value` attribute in SSR markup.
function valueInputs(markup) {
  const NON_VALUE = new Set(["checkbox", "radio", "hidden", "submit", "button", "reset", "image", "file"]);
  const labels = labelTextById(markup);
  const out = [];
  for (const m of markup.matchAll(/<input\b([^>]*?)\/?>/gi)) {
    const attrs = m[1];
    const type = (attr(attrs, "type") ?? "text").toLowerCase();
    if (NON_VALUE.has(type)) continue;
    const id = attr(attrs, "id");
    out.push({
      label: ((id && labels[id]) || attr(attrs, "aria-label") || "").trim(),
      value: attr(attrs, "value"),
      placeholder: attr(attrs, "placeholder"),
      disabled: hasBoolAttr(attrs, "disabled"),
    });
  }
  return out;
}

// The value-input whose label matches `re` (used for the budget / request-limit
// fields). Returns undefined when no such field is rendered.
function valueField(markup, re) {
  return valueInputs(markup).find((i) => re.test(i.label));
}

// Does `re` appear in the visible text within `window` chars either side of the
// first occurrence of `needle`? Used to prove two things are rendered TOGETHER (a
// change tool and its "Ask me first" default) without pinning exact layout.
function nearInText(markup, needle, re, window = 300) {
  const vt = visibleText(markup);
  const i = vt.toLowerCase().indexOf(needle.toLowerCase());
  if (i < 0) return false;
  const lo = Math.max(0, i - window);
  const hi = Math.min(vt.length, i + needle.length + window);
  return re.test(vt.slice(lo, hi));
}

function render(props) {
  return renderToStaticMarkup(<PermissionsView {...props} />);
}

// ================================================================================
// The agent is named, and its own rules read back as their plain sentences.
// ================================================================================

test("names the agent being shaped", () => {
  const text = visibleText(render(base({ agentName: "Research buddy" })));
  assert.ok(
    text.includes("Research buddy"),
    `the permissions screen must name the agent it is shaping; text="${text}"`,
  );
});

test("renders each of the agent's own rules as its exact plain-English sentence", () => {
  // The rule sentences are the one-source-of-truth domain contract: the view shows
  // whatever ruleSentence() produces, verbatim — the test computes them, never
  // re-encodes the templates.
  const text = visibleText(render(base()));
  for (const rule of RULES) {
    const sentence = ruleSentence(rule);
    assert.ok(
      text.includes(sentence),
      `the agent's rule must be shown as its sentence "${sentence}"; text="${text}"`,
    );
  }
});

// ================================================================================
// AC1 — read tools and change-making tools listed SEPARATELY, changes default to
// "Ask me first".
// ================================================================================

test("lists each granted connector and the tools it may use", () => {
  const text = visibleText(render(base()));
  for (const c of CONNECTORS) {
    assert.ok(text.includes(c.name), `connector "${c.name}" must be listed; text="${text}"`);
    for (const t of [...c.readTools, ...c.changeTools]) {
      assert.ok(text.includes(t), `tool "${t}" (on "${c.name}") must be shown; text="${text}"`);
    }
  }
});

test("read tools and change-making tools are listed separately, changes defaulting to Ask me first", () => {
  const markup = render(base());
  const text = visibleText(markup);

  // Both groups are present and distinguished in words (the brief's own vocabulary:
  // "read tools and change-making tools listed separately"). Lenient: any copy that
  // keeps the read/change distinction passes.
  assert.match(text, /reads?|can read|can see|sees|viewing/i, `a "reads" grouping must be shown; text="${text}"`);
  assert.match(
    text,
    /makes? changes|change-making|changing|changes/i,
    `a "changes" grouping must be shown; text="${text}"`,
  );

  // The change-making tools carry their default: "Ask me first", rendered WITH the
  // change tools (not merely somewhere unrelated on the page) — so a change tool and
  // its ask-me-first default read together.
  assert.match(text, /ask me first/i, `change tools must default to "Ask me first"; text="${text}"`);
  for (const c of CONNECTORS) {
    const firstChange = c.changeTools[0];
    assert.ok(
      firstChange && nearInText(markup, firstChange, /ask me first/i),
      `the change tool "${firstChange}" must render alongside its "Ask me first" default; text="${text}"`,
    );
  }
});

// ================================================================================
// AC1 — the budget field shows ONLY alongside card access.
// ================================================================================

test("shows the budget field only when card access is on", () => {
  // Card ON → a budget field exists and carries the amount.
  const withCard = render(base({ cardAccess: true, budget: DEFAULT_CARD_BUDGET }));
  const field = valueField(withCard, /budget/i);
  assert.ok(field, "with card access on, a budget field must be shown");
  assert.ok(
    field && field.value != null && field.value.includes(String(DEFAULT_CARD_BUDGET.amount)),
    `the budget field must carry the amount ${DEFAULT_CARD_BUDGET.amount}; field=${JSON.stringify(field)}`,
  );

  // Card OFF → there is NO budget input field (scoped to the labelled control, not
  // the word "budget" which may legitimately appear elsewhere in copy).
  const withoutCard = render(base({ cardAccess: false, budget: null }));
  assert.ok(
    valueField(withoutCard, /budget/i) === undefined,
    "with card access off, the budget field must not be shown",
  );
});

test("the budget defaults to A$200 per month (the domain default) when card access is on", () => {
  // DEFAULT_CARD_BUDGET is the one-source-of-truth default: A$200 / month.
  const markup = render(base({ cardAccess: true, budget: DEFAULT_CARD_BUDGET }));
  const text = visibleText(markup);
  const field = valueField(markup, /budget/i);
  assert.ok(
    field && field.value != null && field.value.includes("200"),
    `the default budget amount (200) must be shown; field=${JSON.stringify(field)}`,
  );
  assert.match(text, /month/i, `the default budget period (month) must be shown; text="${text}"`);
});

// ================================================================================
// AC2 — enabling card access with no budget blocks SAVE, with a stated reason.
// ================================================================================

// Several plain-English ways the view might state "a budget is required first".
const budgetReason =
  /(add|set|needs?|need to|requires?|enter|choose|without|before|can(?:no|')?t|cannot|must)[\s\S]{0,60}budget|budget[\s\S]{0,60}(required|needed|first|to (?:save|enable|turn)|before)/i;

test("card access with no budget disables the save control and states why", () => {
  const markup = render(base({ cardAccess: true, budget: null }));
  const save = allButtons(markup).find((b) => /save|apply|update/i.test(b.name));
  assert.ok(save, "the permissions screen must have a save/apply control");
  assert.ok(
    save && save.disabled,
    "with card access on but no budget, the save control must be disabled (not a dead live button)",
  );
  assert.match(
    visibleText(markup),
    budgetReason,
    `the disabled save must be accompanied by a stated reason about needing a budget; text="${visibleText(markup)}"`,
  );
});

test("card access with a budget leaves the save control live", () => {
  const markup = render(base({ cardAccess: true, budget: DEFAULT_CARD_BUDGET }));
  const save = allButtons(markup).find((b) => /save|apply|update/i.test(b.name));
  assert.ok(save, "the permissions screen must have a save/apply control");
  assert.ok(
    save && !save.disabled,
    "with card access on AND a budget set, the save control must be live (not disabled)",
  );
});

test("with card access off the save control is live", () => {
  const markup = render(base({ cardAccess: false, budget: null }));
  const save = allButtons(markup).find((b) => /save|apply|update/i.test(b.name));
  assert.ok(save && !save.disabled, "with card access off the save control must be live");
});

// ================================================================================
// AC2 — the request limit, under Advanced, defaults to 120/min.
// ================================================================================

test("shows an Advanced request limit that defaults to 120 per minute", () => {
  // requestLimit omitted in base → the view supplies its 120/min default.
  const markup = render(base());
  const text = visibleText(markup);

  assert.match(text, /advanced/i, `the request limit must sit under an "Advanced" area; text="${text}"`);
  assert.match(text, /per minute|a minute|\/\s?min|minute/i, `the request limit must read as per-minute; text="${text}"`);

  const field = valueField(markup, /request|limit|per minute|minute/i);
  assert.ok(field, "an Advanced request-limit field must be rendered");
  assert.ok(
    field && field.value != null && field.value.includes("120"),
    `the request limit must default to 120; field=${JSON.stringify(field)}`,
  );
  assert.ok(field && !field.disabled, "the request-limit field must be live (adjustable), not disabled");
});

test("renders a supplied request limit instead of the default", () => {
  const markup = render(base({ requestLimit: 300 }));
  const field = valueField(markup, /request|limit|per minute|minute/i);
  assert.ok(
    field && field.value != null && field.value.includes("300"),
    `a supplied request limit must be rendered; field=${JSON.stringify(field)}`,
  );
});

// ================================================================================
// The identity, card, memory and sharing toggles reflect their props.
// ================================================================================

// content-09 — the identity tiers have one name each: "everyday details" (read) and
// "protected details" (ask each time), never low-/high-tier.
test("shows the everyday-details read and a protected-details request toggle that reflects its prop", () => {
  const text = visibleText(render(base()));
  assert.match(text, /everyday details/i, `the everyday-details read must be shown; text="${text}"`);
  assert.doesNotMatch(text, /low[\s-]?tier|high[\s-]?tier/i, "no tier jargon");

  // Protected details is a REQUEST toggle whose on-state follows the prop.
  const off = toggle(render(base({ highTierRequest: false })), /protected details/i);
  assert.ok(off, "a protected-details request toggle must be rendered");
  assert.ok(off && off.on === false, "the protected-details request must be OFF when its prop is false");

  const on = toggle(render(base({ highTierRequest: true })), /protected details/i);
  assert.ok(on && on.on === true, "the protected-details request must be ON when its prop is true");
});

// interaction-08 — a disconnected agent's settings are read-only: no Save, and the bar says
// why and offers the way back.
test("a read-only (disconnected) agent offers no Save and says why", () => {
  const markup = render(base({ readOnly: true }));
  assert.equal(allButtons(markup).filter((b) => /save/i.test(b.name)).length, 0, "no Save control");
  assert.match(visibleText(markup), /disconnected, so its access can.t be changed/);
  assert.match(markup, /href="\/agents\/connect"/);
});

// interaction-12 — each record is named after itself, with its type in words underneath.
test("record choices show the record's own name and its type in words", () => {
  const markup = render(base({ section: "settings", recordChoices: [{ id: "r1", name: "Netflix Premium", description: "Subscription", granted: true }] }));
  const choice = toggle(markup, /Netflix Premium/);
  assert.ok(choice, "the record's toggle is named after the record");
  assert.match(visibleText(markup), /Netflix Premium Subscription/);
  assert.doesNotMatch(visibleText(markup), /renewal_appointment|receipt_warranty/);
});

test("the card-access toggle reflects its prop", () => {
  const off = toggle(render(base({ cardAccess: false, budget: null })), /card/i);
  assert.ok(off, "a card-access toggle must be rendered");
  assert.ok(off && off.on === false, "card access must be OFF when its prop is false");

  const on = toggle(render(base({ cardAccess: true, budget: DEFAULT_CARD_BUDGET })), /card/i);
  assert.ok(on && on.on === true, "card access must be ON when its prop is true");
});

test("the shared-memory-read toggle reflects its prop", () => {
  const on = toggle(render(base({ sharedMemoryRead: true })), /shared memor/i);
  assert.ok(on, "a shared-memory-read toggle must be rendered");
  assert.ok(on && on.on === true, "shared-memory read must be ON when its prop is true");

  const off = toggle(render(base({ sharedMemoryRead: false })), /shared memor/i);
  assert.ok(off && off.on === false, "shared-memory read must be OFF when its prop is false");
});

test("the share-what-it-learns toggle reflects its prop", () => {
  const off = toggle(render(base({ learningSharing: false })), /learn/i);
  assert.ok(off, "a share-what-it-learns toggle must be rendered");
  assert.ok(off && off.on === false, "sharing what it learns must be OFF when its prop is false");

  const on = toggle(render(base({ learningSharing: true })), /learn/i);
  assert.ok(on && on.on === true, "sharing what it learns must be ON when its prop is true");
});

// ================================================================================
// Skills it receives — each is shown; a granted skill reads as ON.
// ================================================================================

test("shows the skills the agent receives", () => {
  // The granted skill it RECEIVES must be shown. (An ungranted skill may either be
  // listed as an off toggle or omitted from a "receives" list — both are reasonable
  // — so only the granted one's presence is asserted here.)
  const markup = render(base());
  const text = visibleText(markup);
  const grantedSkill = SKILLS.find((s) => s.granted);
  assert.ok(grantedSkill, "fixture must include a granted skill");
  assert.ok(
    grantedSkill && text.includes(grantedSkill.name),
    `the granted skill "${grantedSkill?.name}" must be shown; text="${text}"`,
  );
  assert.match(text, /skill/i, `a skills section must be present; text="${text}"`);

  // If the granted skill is rendered as a toggle, it must read as ON (never a toggle
  // that contradicts its granted prop).
  const grantedToggle = toggle(markup, /trip planning/i);
  if (grantedToggle) {
    assert.ok(grantedToggle.on === true, "a granted skill rendered as a toggle must read as ON");
  }
});

// ================================================================================
// AC3 — colour comes from design tokens; never a raw hex literal.
// ================================================================================

test("the permissions view uses design tokens, never a raw hex colour", () => {
  for (const props of [
    base(),
    base({ cardAccess: true, budget: DEFAULT_CARD_BUDGET }),
    base({ cardAccess: true, budget: null }),
    base({ highTierRequest: true, sharedMemoryRead: true, learningSharing: true }),
  ]) {
    const markup = render(props);
    assert.ok(
      !/#[0-9a-fA-F]{3,8}\b/.test(markup),
      `no raw hex colour may appear in the permissions-view markup, got: ${markup}`,
    );
  }
});
