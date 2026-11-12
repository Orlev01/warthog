// E10-S02 — Agent consent view component (src/components/agents/consent-view.tsx).
//
// RED-first: src/components/agents/consent-view.tsx does NOT exist yet, so
// importing `./consent-view` throws and every test here fails until the builder
// adds the component. That absence is the entire point of test-first — do not
// implement anything to make these pass.
//
// WHY this component exists (brief "Agent consent screen"; design §6.1): when an
// agent starts connecting, the signed-in person names it, sees what it is asking
// for in plain words, picks a starting permission set (Minimal / Standard /
// Custom), adjusts it with toggles, sees whether the platform calling back is a
// known/verified one, and Approves or Refuses — all on ONE render-testable
// surface. The real OAuth/consent plumbing (deciding the redirect host, issuing
// the credential on approve) lives in the server composition root and is wired by
// a later task; THIS component is the pure, prop-driven view that renders the
// screen, so it can be pinned without a browser, a session or any protocol
// machinery.
//
// These tests pin BEHAVIOUR — what the component RENDERS for the props it is
// given (the plain-words copy a person reads, the accessible controls, and the
// GRANTED/not-granted state of each permission toggle) — never the source text of
// consent-view.tsx. A later behaviour-preserving refactor (different wrapper
// elements, reworded-but-still-plain copy, a switch instead of a checkbox, extra
// classes, a different icon) stays green. We render with `react-dom/server`
// (no DOM/jsdom — React component / E2E testing is a per-job ADR) and read the
// emitted markup, exactly as the sibling component tests do.
//
// THE CONTRACT the builder implements (test-first spec):
//
//   ConsentView({ platform, defaultName?, requestedScopes, services?, template,
//                 redirect }):
//     • platform        — the connecting agent's platform (e.g. "Claude"), named
//                          on the screen so the person knows what is connecting.
//     • defaultName      — the proposed name for the agent, pre-filled into an
//                          accessibly-labelled "name" text field the person edits.
//     • requestedScopes  — what the agent asked for, each a plain-words string
//                          shown verbatim (no protocol jargon).
//     • services         — the person's connectable services, each { id, name,
//                          ticked? }; the ticked ones' READ tools are granted under
//                          Standard/Custom with their change-making tools set to
//                          "Ask me first".
//     • template         — the selected starting set ("minimal" | "standard" |
//                          "custom"); it drives which permission toggles render ON.
//     • redirect         — { host, verified }: a KNOWN platform callback
//                          (verified) shows a "Verified platform" badge; any other
//                          host is shown prominently (its host text is visible).
//
//   Every grantable capability renders as a TOGGLE (a checkbox / radio / role=
//   switch) whose accessible checked state reflects whether the selected set grants
//   it — so the screen's granted permissions are the ON toggles. The GRANTS a set
//   produces are the pure domain contract @/domain/permissions/templates, which
//   this test imports and computes expectations from (it does not re-hardcode the
//   rules). Colour comes from design tokens (globals.css) — never a raw hex.

import * as React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";

import { ConsentView, consentToggleState } from "./consent-view";
import {
  permissionTemplate,
  type PermissionSet,
  type PermissionTemplate,
} from "@/domain/permissions/templates";

// --- the prop shape this task introduces (described here as the contract) -------

type ConsentViewService = { id: string; name: string; ticked?: boolean };

type ConsentViewProps = {
  platform: string;
  defaultName?: string;
  requestedScopes: ReadonlyArray<string>;
  services?: ReadonlyArray<ConsentViewService>;
  template: PermissionTemplate;
  redirect: { host: string; verified: boolean };
};

// --- fixtures -------------------------------------------------------------------
//
// Service names and scope phrases are chosen so they do NOT contain any of the
// capability keywords below (profile / skills / preferences / activity / memory /
// tasks / life-admin / high-tier / card / learns). That keeps the grant assertions
// honest: a capability keyword landing in the "granted" text can only come from a
// permission toggle, never from a service name or a requested-scope line.

const SERVICES: ConsentViewService[] = [
  { id: "gcal", name: "Google Calendar", ticked: true },
  { id: "gmail", name: "Gmail", ticked: true },
  { id: "dropbox", name: "Dropbox", ticked: false },
];

const TICKED_IDS = SERVICES.filter((s) => s.ticked).map((s) => s.id);

const SCOPES = ["See your calendar", "Help with your inbox", "Look things up for you"];

function base(overrides: Partial<ConsentViewProps> = {}): ConsentViewProps {
  return {
    platform: "Claude",
    defaultName: "Research buddy",
    requestedScopes: SCOPES,
    services: SERVICES,
    template: "standard",
    redirect: { host: "claude.ai", verified: true },
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

// A boolean/valueless attribute present as its own token — ` checked`, ` checked=""`
// or ` checked="checked"` — but NEVER the "checked" inside `aria-checked`. We test
// against a leading space so the first attribute also has a boundary.
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

// Every toggle-like control in the markup — a checkbox / radio input (named by its
// <label for>, its wrapping <label>, or aria-label) OR a role=switch / aria-checked
// / aria-pressed element — with its accessible name, its on-state and whether it is
// disabled. This reads RENDERED ACCESSIBLE STATE (behaviour), covering the common
// accessible toggle implementations, not any one control's source.
function toggleControls(markup) {
  const labels = labelTextById(markup);
  const out = [];

  // checkbox / radio inputs associated by for/id or aria-label
  for (const m of markup.matchAll(/<input\b([^>]*?)\/?>/gi)) {
    const attrs = m[1];
    const type = (attr(attrs, "type") ?? "text").toLowerCase();
    if (type !== "checkbox" && type !== "radio") continue;
    const id = attr(attrs, "id");
    const name = ((id && labels[id]) || attr(attrs, "aria-label") || "").trim();
    const on = hasBoolAttr(attrs, "checked") || attr(attrs, "aria-checked") === "true";
    out.push({ name, on, type, disabled: hasBoolAttr(attrs, "disabled") });
  }

  // wrapping-label toggles: <label ...><input type=checkbox .../> Name</label>
  for (const l of findAll(markup, "label")) {
    const im = l.inner.match(/<input\b([^>]*?)\/?>/i);
    if (!im) continue;
    const iattrs = im[1];
    const type = (attr(iattrs, "type") ?? "text").toLowerCase();
    if (type !== "checkbox" && type !== "radio") continue;
    const on = hasBoolAttr(iattrs, "checked") || attr(iattrs, "aria-checked") === "true";
    out.push({ name: visibleText(l.inner), on, type, disabled: hasBoolAttr(iattrs, "disabled") });
  }

  // role=switch / aria-checked / aria-pressed buttons
  for (const b of findAll(markup, "button")) {
    const role = attr(b.attrs, "role");
    const ariaChecked = attr(b.attrs, "aria-checked");
    const ariaPressed = attr(b.attrs, "aria-pressed");
    if (role !== "switch" && ariaChecked == null && ariaPressed == null) continue;
    const name = (visibleText(b.inner) || attr(b.attrs, "aria-label") || "").trim();
    out.push({ name, on: ariaChecked === "true" || ariaPressed === "true", disabled: hasBoolAttr(b.attrs, "disabled") });
  }

  return out;
}

// The accessible names of the GRANTED (on) toggles, joined with a separator that a
// keyword regex cannot cross, lower-cased. This is the screen's granted-permission
// surface: a capability is granted iff its keyword appears here.
function grantedText(markup) {
  return toggleControls(markup)
    .filter((c) => c.on && c.type !== "radio")
    .map((c) => c.name)
    .join(" | ")
    .toLowerCase();
}

// Names of every actionable (not-disabled) control: a live <button>, a non-disabled
// checkbox/radio input (by label / aria-label / value), or a wrapping-label input —
// plus <option>s (a starting set may be chosen from a <select>). Used to prove a
// control is a live affordance, never dead static text.
function selectableNames(markup) {
  const labels = labelTextById(markup);
  const out = [];
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

function hasSelectable(markup, re) {
  return selectableNames(markup).some((n) => re.test(n));
}

// Visible names of the actionable (live) <button>s.
function actionableButtons(markup) {
  return findAll(markup, "button")
    .filter((b) => !hasBoolAttr(b.attrs, "disabled"))
    .map((b) => (visibleText(b.inner) || attr(b.attrs, "aria-label") || "").trim());
}

// Every text input with its accessible label, value and placeholder.
function textInputs(markup) {
  const labels = labelTextById(markup);
  const out = [];
  for (const m of markup.matchAll(/<input\b([^>]*?)\/?>/gi)) {
    const attrs = m[1];
    const type = (attr(attrs, "type") ?? "text").toLowerCase();
    if (type !== "text") continue;
    const id = attr(attrs, "id");
    out.push({
      label: ((id && labels[id]) || attr(attrs, "aria-label") || "").trim(),
      value: attr(attrs, "value"),
      placeholder: attr(attrs, "placeholder"),
    });
  }
  return out;
}

function render(props) {
  return renderToStaticMarkup(<ConsentView {...props} />);
}

// --- the capabilities, keyed to the PURE domain contract ------------------------
//
// Each entry maps a PermissionSet BOOLEAN field to the plain-words keyword its
// toggle must carry. For any template we compute the expected PermissionSet with
// `permissionTemplate` and assert the rendered granted-text matches the keyword iff
// the field is granted — so the three starting sets' grants are pinned to the
// one-source-of-truth domain module, not re-encoded here. Keywords are the brief's
// own words and are distinct from one another and from the fixtures above.

type BoolCap =
  | "lowTierProfile"
  | "skills"
  | "preferences"
  | "activityLogging"
  | "sharedMemoryRead"
  | "ownMemorySave"
  | "tasks"
  | "lifeAdmin"
  | "highTier"
  | "card"
  | "learningSharing";

const CAPS: Array<{ key: BoolCap; re: RegExp; label: string }> = [
  { key: "lowTierProfile", re: /everyday details/i, label: "everyday details" },
  { key: "sharedMemoryRead", re: /shared memor/i, label: "shared-memory read" },
  { key: "ownMemorySave", re: /own memor|save[^.|]*memor/i, label: "its own memories" },
  { key: "tasks", re: /tasks?/i, label: "tasks" },
  { key: "lifeAdmin", re: /life[\s-]?admin/i, label: "life-admin" },
  // Always opt-in — OFF in every starting set (Standard/Minimal/Custom alike).
  { key: "highTier", re: /request protected details/i, label: "protected details requests" },
  { key: "card", re: /\bcard/i, label: "card requests" },
  { key: "learningSharing", re: /what it learns|shares? what|learns?\b/i, label: "sharing what it learns" },
];

function assertGrantsMatchTemplate(template: PermissionTemplate) {
  const expected: PermissionSet = permissionTemplate(template, TICKED_IDS);
  const granted = grantedText(render(base({ template })));
  for (const cap of CAPS) {
    if (expected[cap.key]) {
      assert.match(
        granted,
        cap.re,
        `${template}: "${cap.label}" must render as a GRANTED (on) toggle; granted="${granted}"`,
      );
    } else {
      assert.doesNotMatch(
        granted,
        cap.re,
        `${template}: "${cap.label}" must NOT be granted under this starting set; granted="${granted}"`,
      );
    }
  }
}

// === The three starting sets are offered and selectable =========================

test("offers the three starting sets — Minimal, Standard and Custom — as live controls", () => {
  const markup = render(base());
  const text = visibleText(markup);
  for (const set of ["Minimal", "Standard", "Custom"]) {
    assert.ok(text.includes(set), `the consent screen must name the "${set}" starting set`);
    assert.ok(
      hasSelectable(markup, new RegExp(`\\b${set}\\b`, "i")),
      `the "${set}" starting set must be a selectable (live) control, not dead static text`,
    );
  }
});

// === AC1 — Minimal grants ONLY the base four ====================================

test("Minimal grants ONLY low-tier profile, skills, preferences and activity logging", () => {
  // permissionTemplate("minimal", …) → base four true; everything else false.
  // The assertion loop reads it straight from the domain contract, so Minimal's
  // "nothing else" is pinned field-by-field (additions, services, high-tier, card
  // and learning-sharing all absent from the granted toggles).
  assertGrantsMatchTemplate("minimal");
});

test("Minimal grants none of the ticked services (no service read-grants)", () => {
  // Minimal ignores the ticked services entirely (permissionTemplate returns
  // services: []). A ticked service's read-grant toggle is therefore NOT on, so its
  // name is absent from the GRANTED surface (this is scoped to the on-toggle text —
  // the service may still be LISTED elsewhere as an un-granted option).
  const granted = grantedText(render(base({ template: "minimal" })));
  for (const s of SERVICES) {
    assert.ok(
      !granted.includes(s.name.toLowerCase()),
      `Minimal must not grant "${s.name}"'s read tools; granted="${granted}"`,
    );
  }
});

// === AC1 — Standard adds the standard capabilities + ticked services ============

test("Standard adds shared-memory read, own memories, tasks and life-admin (on top of the base four)", () => {
  // permissionTemplate("standard", …) → base four + the four additions true;
  // high-tier / card / learning-sharing still false. Pinned field-by-field.
  assertGrantsMatchTemplate("standard");
});

test("Standard grants the TICKED services' read tools, with their changes set to Ask me first", () => {
  const markup = render(base({ template: "standard" }));
  const granted = grantedText(markup);
  const text = visibleText(markup);

  // Ticked services' read tools are granted (their toggles are on).
  for (const s of SERVICES.filter((s) => s.ticked)) {
    assert.ok(
      granted.includes(s.name.toLowerCase()),
      `Standard must grant the ticked service "${s.name}"'s read tools; granted="${granted}"`,
    );
  }
  // An un-ticked service is NOT granted.
  for (const s of SERVICES.filter((s) => !s.ticked)) {
    assert.ok(
      !granted.includes(s.name.toLowerCase()),
      `Standard must not grant the un-ticked service "${s.name}"; granted="${granted}"`,
    );
  }
  // Those services' change-making tools default to "Ask me first" (brief UI copy /
  // ServicePermission.changeTools === "ask_first").
  assert.match(
    text,
    /ask me first/i,
    `Standard must show the ticked services' changes as "Ask me first"; text="${text}"`,
  );
});

// === AC1 — Custom starts from Standard, every setting open to change ============

test("Custom starts from Standard's grants", () => {
  // "Custom: starts from Standard with every setting open to change." So its initial
  // grants equal Standard's (additions on; high-tier / card / learning-sharing off).
  assertGrantsMatchTemplate("custom");
});

test("Custom's permission toggles are adjustable — live, not disabled", () => {
  // "every setting open to change": a representative standard-addition toggle (tasks)
  // is a live control the person can flip, not a fixed/disabled one (no dead control).
  const controls = toggleControls(render(base({ template: "custom" })));
  const tasksToggle = controls.find((c) => /tasks?/i.test(c.name));
  assert.ok(tasksToggle, "Custom must render a tasks permission toggle");
  assert.ok(
    tasksToggle && !tasksToggle.disabled,
    "under Custom the tasks toggle must be adjustable (not disabled)",
  );
  assert.ok(
    controls.some((c) => !c.disabled),
    "Custom must render adjustable (live) permission toggles",
  );
});

// === The name field, the requested scopes, Approve / Refuse =====================

test("renders an accessibly-labelled name field pre-filled with the proposed name", () => {
  const markup = render(base({ defaultName: "Research buddy" }));
  const named = textInputs(markup).filter((i) => /name/i.test(i.label));
  assert.ok(named.length >= 1, "the consent screen must have a text field labelled for the agent's name");
  assert.ok(
    named.some((i) => i.value === "Research buddy" || i.placeholder === "Research buddy"),
    `the name field must be pre-filled with the proposed name; inputs=${JSON.stringify(named)}`,
  );
});

test("shows every requested scope in plain words", () => {
  const text = visibleText(render(base()));
  for (const scope of SCOPES) {
    assert.ok(text.includes(scope), `the requested scope "${scope}" must be shown in plain words; text="${text}"`);
  }
});

// The refusal reads "Deny", the product's one word for saying no (canonical terms, content-12).
test("renders an Approve and a Deny control, both live", () => {
  const buttons = actionableButtons(render(base()));
  assert.ok(
    buttons.some((b) => /approve/i.test(b)),
    `a live Approve control must be present; buttons=${JSON.stringify(buttons)}`,
  );
  assert.ok(
    buttons.some((b) => /^deny$/i.test(b.trim())),
    `a live Deny control must be present; buttons=${JSON.stringify(buttons)}`,
  );
});

// public-20: an unrecognised callback is named by its host only in the destination inset.
test("an unrecognised platform is called 'an agent', never titled after its callback host", () => {
  const markup = render(base({ platform: "relay.example-platform.com", redirect: { host: "relay.example-platform.com:8443", verified: false } }));
  assert.match(markup, /<h1>Connect an agent<\/h1>/);
  assert.match(markup, /What this agent is asking for/);
  assert.match(markup, /rename your account on that platform/);
  assert.match(markup, /relay\.example-platform\.com:8443/, "the host still shows in the destination inset");
});

// === AC2 — Verified-platform badge vs. a prominent other host ===================

test("a known platform callback shows the Verified-platform badge", () => {
  const text = visibleText(render(base({ redirect: { host: "claude.ai", verified: true } })));
  assert.match(
    text,
    /verified platform/i,
    `a verified platform callback must show a "Verified platform" badge; text="${text}"`,
  );
});

test("an unknown redirect host shows no Verified badge and names the host prominently", () => {
  const host = "relay.some-unknown-agent.example";
  const text = visibleText(render(base({ redirect: { host, verified: false } })));
  assert.ok(
    !/verified platform/i.test(text),
    `an unverified host must NOT carry the "Verified platform" badge; text="${text}"`,
  );
  assert.ok(
    text.includes(host),
    `an unverified redirect host must be shown (in the visible text, not hidden); text="${text}"`,
  );
});

// === Design system — colour comes from tokens, never a raw hex literal ==========

test("the consent view uses design tokens, never a raw hex colour", () => {
  for (const props of [
    base({ template: "minimal" }),
    base({ template: "standard" }),
    base({ template: "custom" }),
    base({ redirect: { host: "relay.some-unknown-agent.example", verified: false } }),
  ]) {
    const markup = render(props);
    assert.ok(
      !/#[0-9a-fA-F]{3,8}\b/.test(markup),
      `no raw hex colour may appear in the consent-view markup, got: ${markup}`,
    );
  }
});

// =====================================================================================
// Review fix A2 — every toggle the person can change is submitted, and the ones that
// cannot be changed say so.
//
// Until this fix only high-tier and sharing had a form name: unticking "Read your shared
// memory" (or ticking "Card requests", or a service) changed nothing that was stored,
// and switching the starting set left the toggles as they were. Now each adjustable
// toggle is a named, controlled input seeded from the starting set (and re-seeded when it
// changes — `consentToggleState`), card requests carry a budget, services submit their
// ids, and the always-included rows are shown as fixed (disabled) rather than as live
// controls that do nothing.
// =====================================================================================

function liveRender(props: Partial<ConsentViewProps> = {}): string {
  const noop = async (_formData: FormData) => {};
  return renderToStaticMarkup(<ConsentView {...base(props)} approveAction={noop} refuseAction={noop} />);
}

// Every <input>/<select> with a name, as { name, type, checked, value, disabled }.
function namedControls(markup: string) {
  const out: Array<{ name: string; type: string; checked: boolean; value: string | null; disabled: boolean }> = [];
  for (const m of markup.matchAll(/<(input|select)\b([^>]*?)\/?>/gi)) {
    const attrs = m[2]!;
    const name = attr(attrs, "name");
    if (!name) continue;
    out.push({
      name,
      type: (attr(attrs, "type") ?? m[1]!).toLowerCase(),
      checked: hasBoolAttr(attrs, "checked"),
      value: attr(attrs, "value"),
      disabled: hasBoolAttr(attrs, "disabled"),
    });
  }
  return out;
}

test("A2: every adjustable toggle on the live form has a name the decision reads", () => {
  const names = new Set(namedControls(liveRender()).filter((c) => c.type === "checkbox").map((c) => c.name));
  for (const name of ["identity", "memoryRead", "memoryWrite", "tasks", "records", "highTier", "card", "learningSharing", "service"]) {
    assert.ok(names.has(name), `the live form submits "${name}"; got ${[...names].join(", ")}`);
  }
});

test("included connection behavior is explained without pretend permission switches", () => {
  const markup = liveRender();
  const text = visibleText(markup);
  // content-56: one plain line for what every connection includes.
  assert.match(text, /your preferences and the skills you.ve given it/i);
  assert.match(text, /Warthog records what it does/i);
  assert.ok(!namedControls(markup).some(control => control.disabled), "included behavior is prose, not dead switches");
  const memoryWrite = namedControls(markup).find(control => control.name === "memoryWrite");
  assert.equal(memoryWrite?.type, "checkbox");
  assert.equal(memoryWrite?.disabled, false);
});

test("A2: ticked services submit their ids; un-ticked ones are present but unchecked", () => {
  const services = namedControls(liveRender()).filter((c) => c.name === "service");
  assert.deepEqual(
    services.map((s) => [s.value, s.checked]),
    [["gcal", true], ["gmail", true], ["dropbox", false]],
  );
});

test("A2: turning on card requests shows a budget defaulting to A$200 a month", () => {
  // Seeded with card off, so the budget is absent; the pure seed proves the default.
  assert.equal(namedControls(liveRender()).some((c) => c.name === "cardBudgetAmount"), false);
  const seeded = consentToggleState("standard", []);
  assert.equal(seeded.card, false, "card is opt-in");
  assert.deepEqual(seeded.cardBudget, { amount: "200", period: "month" });

  const withCard = namedControls(
    renderToStaticMarkup(
      <ConsentView
        {...base()}
        approveAction={async () => {}}
        refuseAction={async () => {}}
        initialState={{ ...seeded, card: true }}
      />,
    ),
  );
  assert.equal(withCard.find((c) => c.name === "cardBudgetAmount")?.value, "200");
  assert.equal(withCard.find((c) => c.name === "cardBudgetCurrency")?.value, "AUD");
  assert.ok(withCard.some((c) => c.name === "cardBudgetPeriod"), "the budget period is chosen");
});

test("A2: switching the starting set re-seeds the toggles (Standard → Minimal unticks shared memory, tasks, services)", () => {
  const standard = consentToggleState("standard", ["gmail"]);
  assert.equal(standard.memoryRead, true);
  assert.equal(standard.tasks, true);
  assert.equal(standard.records, true);
  assert.deepEqual(standard.services, ["gmail"]);

  const minimal = consentToggleState("minimal", ["gmail"]);
  assert.equal(minimal.identity, true, "the basic profile stays on");
  assert.equal(minimal.memoryRead, false);
  assert.equal(minimal.tasks, false);
  assert.equal(minimal.records, false);
  assert.deepEqual(minimal.services, []);
  for (const optIn of ["highTier", "card", "learningSharing"] as const) {
    assert.equal(standard[optIn], false);
    assert.equal(minimal[optIn], false);
  }
});


test("Custom opens the editor and review accurately describes an explicit denial", () => {
  const state = { ...consentToggleState("standard", []), memoryWrite: false, tasks: false };
  const markup = renderToStaticMarkup(<ConsentView {...base({ template: "custom" })} initialState={state} />);
  assert.match(markup, /<details[^>]*class="wh-permission-editor"[^>]*open/);
  const summary = markup.slice(markup.indexOf('class="wh-permission-summary"'));
  assert.doesNotMatch(summary, /<li>Save its own memories<\/li>/);
  assert.doesNotMatch(summary, /<li>Manage your tasks<\/li>/);
  assert.match(summary, /<li>Read shared memory<\/li>/);
  assert.match(visibleText(markup), /does not verify the agent/);
  assert.match(visibleText(markup), /cannot recall information already received/);
});
