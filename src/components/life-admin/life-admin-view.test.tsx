// E14-S11 — Life-admin records and checklist view component
// (src/components/life-admin/life-admin-view.tsx).
//
// RED-first: src/components/life-admin/life-admin-view.tsx does NOT exist yet, so
// importing `./life-admin-view` throws and every test here fails until the builder
// adds the component. That absence is the entire point of test-first — do not
// implement anything to make these pass.
//
// WHY this component exists (brief "Life admin" + "Moving-house helper"; design
// §4.1; the Life Admin primary journey): the Life Admin screen is where a person
// sees and maintains the records they and their agents both keep — SUBSCRIPTIONS,
// RECEIPTS & WARRANTIES, and RENEWALS & APPOINTMENTS — on tabs, alongside the
// MOVING CHECKLIST. Every record shows its (already-decrypted) fields with
// add/edit controls and a per-record reminder-offset setting; a receipt also
// carries an attach-file control with its return-by and warranty-end dates; each
// checklist item carries a tick-off and a "hand to an agent" control. Because it is
// a primary surface it must render EVERY record kind and the checklist from props,
// and no control may ever be dead — a control with nothing wired behind it renders
// DISABLED and says why (constitution: "No dead controls").
//
// This is the pure, prop-driven VIEW (a Client Component in the app): it renders the
// screen FROM the props the Life Admin page loader (E14-S10 `lifeAdminPageData`)
// hands it, with fields already decrypted and server actions passed in — exactly the
// precedent the sibling memory / inbox / connectors views set (pre-formatted values
// in, no clock / DB / session in the view). The real page wiring (reading the data,
// binding the server actions) lives in a LATER task; THIS component is pinnable
// without a browser, a session or any database.
//
// These tests pin BEHAVIOUR — what the component RENDERS for the props it is given
// (the record fields a person reads, the accessible controls, and the DISABLED /
// live state of each control) — never the source text of life-admin-view.tsx. A
// later behaviour-preserving refactor (different wrapper elements, reworded-but-
// still-plain copy, a disclosure instead of a button, a checkbox instead of a
// toggle, extra classes, a different icon) stays green. We render with
// `react-dom/server` (no DOM/jsdom — React component / E2E testing is a per-job ADR)
// and read the emitted markup, exactly as the 40 sibling component tests do.
//
// THE CONTRACT the builder implements (test-first spec):
//
//   LifeAdminView({ subscriptions, receipts, renewals, checklist, initialTab?,
//                   addRecordAction?, editRecordAction?, attachFileAction?,
//                   tickOffAction?, handToAgentAction? }):
//     • subscriptions / receipts / renewals — the person's life-admin records of
//       each kind, each { id, kind, fields (decrypted key→value), dueDate, status,
//       reminderOffsets, hasAttachedFile? }, shown on its own tab with its fields,
//       add/edit controls and a per-record reminder-offset setting.
//     • receipts additionally show an attach-file control, with the record's
//       return-by and warranty-end dates (carried in its fields).
//     • checklist — the moving-checklist items, each { id, label, done,
//       linkedTaskId }, shown with a tick-off and a "hand to an agent" control; an
//       item already linked to a task (handed off) shows that control DISABLED.
//     • initialTab — which tab's content a render shows (so each tab is pinnable);
//       the four tabs are always navigable.
//     • the *Action props are OPTIONAL server actions; a control whose action is
//       supplied is LIVE, and a control with no action renders DISABLED with a
//       stated reason (no dead controls).
//
//   Colour comes from the design tokens (globals.css) and shared components — never
//   a raw hex literal.

import * as React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";

import { LifeAdminView } from "./life-admin-view";

// --- the prop shapes this task renders (declared locally so this client VIEW never
// couples to the server db modules; they mirror E14-S10 LifeAdminPageData AFTER the
// loader has decrypted each record's fields) ----------------------------------------

type RecordKind = "subscription" | "receipt_warranty" | "renewal_appointment";

type LifeAdminRecordView = {
  id: string;
  kind: RecordKind;
  fields: Record<string, string>; // decrypted display fields (key → value)
  dueDate: string | null;
  status: string;
  reminderOffsets: number[];
  hasAttachedFile?: boolean; // receipts only
};

type ChecklistItemView = {
  id: string;
  label: string;
  done: boolean;
  linkedTaskId: string | null; // non-null ⇒ already handed to an agent as a task
};

type LifeAdminTab = "subscriptions" | "receipts" | "renewals" | "checklist";

// A control bound to a server action the page passes.
type LifeAdminAction = (formData: FormData) => void | Promise<void>;

type LifeAdminViewProps = {
  subscriptions: ReadonlyArray<LifeAdminRecordView>;
  receipts: ReadonlyArray<LifeAdminRecordView>;
  renewals: ReadonlyArray<LifeAdminRecordView>;
  checklist: ReadonlyArray<ChecklistItemView>;
  initialTab?: LifeAdminTab;
  addRecordAction?: LifeAdminAction;
  editRecordAction?: LifeAdminAction;
  attachFileAction?: LifeAdminAction;
  tickOffAction?: LifeAdminAction;
  handToAgentAction?: LifeAdminAction;
};

// --- fixtures -----------------------------------------------------------------------
//
// Distinctive, recognisable values so every "renders this value" assertion is honest —
// the string can only have come from the record under test. Field values deliberately
// avoid the control vocabulary the tests match on (add / edit / remind / attach /
// upload / tick / done / hand / agent), so a control assertion can never pass on an
// incidental word in a record's fields.

const SUB_A: LifeAdminRecordView = {
  id: "sub-a",
  kind: "subscription",
  fields: { Service: "Spotlight Streaming", "Monthly cost": "A$18.50" },
  dueDate: "2026-12-15",
  status: "active",
  reminderOffsets: [14, 1],
};

const SUB_B: LifeAdminRecordView = {
  id: "sub-b",
  kind: "subscription",
  fields: { Service: "Gymbox membership", "Monthly cost": "A$62.00" },
  dueDate: "2027-01-02",
  status: "active",
  reminderOffsets: [7],
};

// A subscription with a DISTINCTIVE reminder offset (45) that appears nowhere else in
// its render — so "the record's reminder offset is shown" can only be satisfied by the
// record reflecting its own offsets, never by the Add form's defaults (14 / 1).
const SUB_REMINDER: LifeAdminRecordView = {
  id: "sub-reminder",
  kind: "subscription",
  fields: { Service: "Quarterly newsletter" },
  dueDate: "2027-10-20",
  status: "active",
  reminderOffsets: [45],
};

const REC_A: LifeAdminRecordView = {
  id: "rec-a",
  kind: "receipt_warranty",
  fields: {
    Item: "Dyson cordless vacuum",
    Store: "Good Guys",
    "Return by": "2026-12-20",
    "Warranty ends": "2029-11-30",
  },
  dueDate: "2026-12-20",
  status: "kept",
  reminderOffsets: [14, 1],
  hasAttachedFile: false,
};

const REC_B: LifeAdminRecordView = {
  id: "rec-b",
  kind: "receipt_warranty",
  fields: {
    Item: "Sony headphones",
    "Return by": "2026-11-28",
    "Warranty ends": "2028-11-01",
  },
  dueDate: "2026-11-28",
  status: "kept",
  reminderOffsets: [3],
  hasAttachedFile: true,
};

const REN_A: LifeAdminRecordView = {
  id: "ren-a",
  kind: "renewal_appointment",
  fields: { What: "Passport booking", Where: "Australia Post Chatswood" },
  dueDate: "2027-02-10",
  status: "upcoming",
  reminderOffsets: [30, 7],
};

const REN_B: LifeAdminRecordView = {
  id: "ren-b",
  kind: "renewal_appointment",
  fields: { What: "Dentist checkup", Who: "Dr Alvarez" },
  dueDate: "2027-03-05",
  status: "upcoming",
  reminderOffsets: [14],
};

// Checklist items. Labels avoid the control vocabulary (tick / done / hand / agent).
const ITEM_OPEN: ChecklistItemView = {
  id: "item-open",
  label: "Update address with Energy Australia",
  done: false,
  linkedTaskId: null,
};

const ITEM_DONE: ChecklistItemView = {
  id: "item-done",
  label: "Redirect mail at the post office",
  done: true,
  linkedTaskId: null,
};

// Already handed to an agent (linked to a task): its "hand to an agent" control must
// render DISABLED (you cannot hand it off twice) — a no-dead-control that says why.
const ITEM_HANDED: ChecklistItemView = {
  id: "item-handed",
  label: "Transfer the internet connection",
  done: false,
  linkedTaskId: "task-99",
};

const SUBSCRIPTIONS = [SUB_A, SUB_B];
const RECEIPTS = [REC_A, REC_B];
const RENEWALS = [REN_A, REN_B];
const CHECKLIST = [ITEM_OPEN, ITEM_DONE, ITEM_HANDED];

const noop: LifeAdminAction = () => {};

// base() supplies EVERY action, so a control is live unless a test deliberately omits
// its action (or the record's own state disables it). Individual tests override one
// collection / action to isolate the behaviour under test.
function base(overrides: Partial<LifeAdminViewProps> = {}): LifeAdminViewProps {
  return {
    subscriptions: SUBSCRIPTIONS,
    receipts: RECEIPTS,
    renewals: RENEWALS,
    checklist: CHECKLIST,
    initialTab: "subscriptions",
    addRecordAction: noop,
    editRecordAction: noop,
    attachFileAction: noop,
    tickOffAction: noop,
    handToAgentAction: noop,
    ...overrides,
  };
}

function render(props: LifeAdminViewProps): string {
  return renderToStaticMarkup(<LifeAdminView {...props} />);
}

// Render ONE tab in isolation: the target collection is populated, the others emptied,
// so whichever way the builder gates its tab panels (client state, or all panels in
// the markup), the render can only contain the target tab's records / items — and a
// control assertion can never be satisfied by another tab's content. `initialTab`
// selects the tab under test.
function renderSubs(
  subscriptions: ReadonlyArray<LifeAdminRecordView>,
  overrides: Partial<LifeAdminViewProps> = {},
): string {
  return render(base({ initialTab: "subscriptions", subscriptions, receipts: [], renewals: [], checklist: [], ...overrides }));
}
function renderReceipts(
  receipts: ReadonlyArray<LifeAdminRecordView>,
  overrides: Partial<LifeAdminViewProps> = {},
): string {
  return render(base({ initialTab: "receipts", receipts, subscriptions: [], renewals: [], checklist: [], ...overrides }));
}
function renderRenewals(
  renewals: ReadonlyArray<LifeAdminRecordView>,
  overrides: Partial<LifeAdminViewProps> = {},
): string {
  return render(base({ initialTab: "renewals", renewals, subscriptions: [], receipts: [], checklist: [], ...overrides }));
}
function renderChecklist(
  checklist: ReadonlyArray<ChecklistItemView>,
  overrides: Partial<LifeAdminViewProps> = {},
): string {
  return render(base({ initialTab: "checklist", checklist, subscriptions: [], receipts: [], renewals: [], ...overrides }));
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

// Names of navigable tab affordances — selectable controls PLUS links (a[href]) — so
// the tab strip is recognised whether the builder renders tabs as client buttons,
// role=tab buttons, radios, or query-param links.
function linkNames(markup: string): string[] {
  return findAll(markup, "a")
    .filter((a) => attr(a.attrs, "href") !== null && attr(a.attrs, "aria-disabled") !== "true")
    .map((a) => (visibleText(a.inner) || attr(a.attrs, "aria-label") || "").trim())
    .filter((n) => n.length > 0);
}
function tabNames(markup: string): string[] {
  return [...selectableNames(markup), ...linkNames(markup)];
}
function hasTab(markup: string, re: RegExp): boolean {
  return tabNames(markup).some((n) => re.test(n));
}

function hasSelectable(markup: string, re: RegExp): boolean {
  return selectableNames(markup).some((n) => re.test(n));
}

// Every form control (input / select / textarea) with its accessible name (from a
// <label for>, aria-label, name or placeholder) and its disabled state. Used to find
// a NAMED control (e.g. the reminder-offset setting) without betting on the element.
type NamedControl = { name: string; disabled: boolean };
function namedControls(markup: string): NamedControl[] {
  const labels = labelTextById(markup);
  const out: NamedControl[] = [];
  for (const m of markup.matchAll(/<input\b([^>]*?)\/?>/gi)) {
    const a = m[1];
    const id = attr(a, "id");
    const name = [(id && labels[id]) || "", attr(a, "aria-label") || "", attr(a, "name") || "", attr(a, "placeholder") || ""].join(" ").trim();
    out.push({ name, disabled: hasBoolAttr(a, "disabled") || hasBoolAttr(a, "readonly") });
  }
  for (const s of findAll(markup, "select")) {
    const id = attr(s.attrs, "id");
    const name = [(id && labels[id]) || "", attr(s.attrs, "aria-label") || "", attr(s.attrs, "name") || ""].join(" ").trim();
    out.push({ name, disabled: hasBoolAttr(s.attrs, "disabled") });
  }
  for (const t of findAll(markup, "textarea")) {
    const id = attr(t.attrs, "id");
    const name = [(id && labels[id]) || "", attr(t.attrs, "aria-label") || "", attr(t.attrs, "name") || ""].join(" ").trim();
    out.push({ name, disabled: hasBoolAttr(t.attrs, "disabled") });
  }
  // wrapping-label inputs: the label text names the control.
  for (const l of findAll(markup, "label")) {
    const im = l.inner.match(/<input\b([^>]*?)\/?>/i);
    if (!im) continue;
    out.push({ name: visibleText(l.inner), disabled: hasBoolAttr(im[1], "disabled") });
  }
  return out;
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

const SUBS_TAB_RE = /subscriptions?/i;
const RECEIPTS_TAB_RE = /receipts?/i;
const RENEWALS_TAB_RE = /renewals?/i;
const CHECKLIST_TAB_RE = /checklist|moving/i;

const ADD_RE = /\badd\b|new (subscription|receipt|renewal|record)/i;
const EDIT_RE = /\bedit\b|\bchange\b|\bupdate\b/i;
const REMINDER_RE = /remind/i;
// The attach-file control; deliberately NOT matching "add a receipt" (the Add control).
const ATTACH_RE = /attach|upload|choose (a )?file|add (a |the )?(file|photo|scan|document|pdf)/i;
// The tick-off control: a checkbox is one unconditionally; a button reads as marking done.
const TICK_RE = /tick|mark (it |as )?(done|complete)|mark done|mark complete|\bdone\b|complete|cross off|check off/i;
// The "hand to an agent" control.
const HAND_RE = /\bhand\b|hand (it|this|off|over)|give (it |this )?to (an )?agent|assign (it |this )?to (an )?agent|send to (an )?agent/i;

// Tick-off controls in a render: every checkbox (a checklist tick is a checkbox), plus
// any button whose face reads as marking an item done. Returns each control's disabled
// state.
function tickControls(markup: string): El[] {
  const out: El[] = [];
  for (const m of markup.matchAll(/<input\b([^>]*?)\/?>/gi)) {
    const a = m[1];
    if ((attr(a, "type") ?? "").toLowerCase() === "checkbox") out.push({ attrs: a, inner: "" });
  }
  for (const b of findAll(markup, "button")) {
    if (TICK_RE.test(controlFace(b))) out.push(b);
  }
  return out;
}

// "Hand to an agent" controls in a render: buttons / disclosure summaries whose face
// reads as handing the item to an agent.
function handControls(markup: string): El[] {
  return [...findAll(markup, "button"), ...findAll(markup, "summary")].filter((c) => HAND_RE.test(controlFace(c)));
}

// Attach-file controls in a render: every <input type=file>, plus any button whose face
// reads as attaching/uploading a file.
function attachControls(markup: string): El[] {
  const out: El[] = [];
  for (const m of markup.matchAll(/<input\b([^>]*?)\/?>/gi)) {
    const a = m[1];
    if ((attr(a, "type") ?? "").toLowerCase() === "file") out.push({ attrs: a, inner: "" });
  }
  for (const b of findAll(markup, "button")) {
    if (ATTACH_RE.test(controlFace(b))) out.push(b);
  }
  return out;
}

// ════════════════════════════════════════════════════════════════════════════════
// The four tabs — Subscriptions, Receipts & warranties, Renewals & appointments and
// the Moving checklist — are named and navigable.
// ════════════════════════════════════════════════════════════════════════════════

test("names all four tabs — Subscriptions, Receipts & warranties, Renewals & appointments, Moving checklist — as navigable controls", () => {
  const markup = render(base());
  const text = visibleText(markup);

  // The brief's own wording for each tab is on the screen (the "&" words checked apart
  // so "&" vs "and" never matters).
  assert.match(text, /subscriptions/i, `the Subscriptions tab must be named; text="${text}"`);
  assert.match(text, /receipts/i, "the Receipts & warranties tab must be named");
  assert.match(text, /warrant/i, "the Receipts & warranties tab must name warranties");
  assert.match(text, /renewals/i, "the Renewals & appointments tab must be named");
  assert.match(text, /appointment/i, "the Renewals & appointments tab must name appointments");
  assert.match(text, /moving/i, "the Moving checklist tab must be named");
  assert.match(text, /checklist/i, "the Moving checklist tab must name the checklist");

  // Each tab is a LIVE affordance (a control / link you can switch to), never dead text.
  for (const [label, re] of [
    ["Subscriptions", SUBS_TAB_RE],
    ["Receipts", RECEIPTS_TAB_RE],
    ["Renewals", RENEWALS_TAB_RE],
    ["Moving checklist", CHECKLIST_TAB_RE],
  ] as const) {
    assert.ok(hasTab(markup, re), `the "${label}" tab must be a navigable control, not dead static text`);
  }
});

// ════════════════════════════════════════════════════════════════════════════════
// AC1 — each record kind renders in its tab with its fields.
// ════════════════════════════════════════════════════════════════════════════════

test("the Subscriptions tab renders each subscription's fields", () => {
  const text = visibleText(renderSubs(SUBSCRIPTIONS));
  for (const value of ["Spotlight Streaming", "A$18.50", "Gymbox membership", "A$62.00"]) {
    assert.ok(text.includes(value), `a subscription field "${value}" must render; text="${text}"`);
  }
});

test("the Renewals & appointments tab renders each renewal's fields", () => {
  const text = visibleText(renderRenewals(RENEWALS));
  for (const value of ["Passport booking", "Australia Post Chatswood", "Dentist checkup", "Dr Alvarez"]) {
    assert.ok(text.includes(value), `a renewal field "${value}" must render; text="${text}"`);
  }
});

test("the Receipts & warranties tab renders a receipt's fields including its return-by and warranty-end dates", () => {
  // Rendered alone so each value can only come from REC_A.
  const text = visibleText(renderReceipts([REC_A]));
  for (const value of ["Dyson cordless vacuum", "Good Guys", "2026-12-20", "2029-11-30"]) {
    assert.ok(text.includes(value), `a receipt field "${value}" must render; text="${text}"`);
  }
  // The two dates are identifiable as return-by and warranty-end (not two bare dates).
  assert.match(text, /return/i, `the receipt must label its return-by date; text="${text}"`);
  assert.match(text, /warrant/i, `the receipt must label its warranty-end date; text="${text}"`);
});

test("renders records from the props given, not a fixed list", () => {
  // Two disjoint single-record renders: each shows its own record and not the other's.
  const onlyA = visibleText(renderSubs([{ ...SUB_A, id: "x1", fields: { Service: "Tidewater Gazette" } }]));
  const onlyB = visibleText(renderSubs([{ ...SUB_A, id: "x2", fields: { Service: "Mountain Gym Pass" } }]));
  assert.ok(onlyA.includes("Tidewater Gazette"), "render A shows A's record");
  assert.ok(!onlyA.includes("Mountain Gym Pass"), "render A must not show B's record");
  assert.ok(onlyB.includes("Mountain Gym Pass"), "render B shows B's record");
  assert.ok(!onlyB.includes("Tidewater Gazette"), "render B must not show A's record");
});

// ════════════════════════════════════════════════════════════════════════════════
// AC1 — add / edit controls on every record tab and record.
// ════════════════════════════════════════════════════════════════════════════════

test("every record tab offers a live Add control", () => {
  assert.ok(hasSelectable(renderSubs(SUBSCRIPTIONS), ADD_RE), "the Subscriptions tab must offer a live Add control");
  assert.ok(hasSelectable(renderReceipts(RECEIPTS), ADD_RE), "the Receipts tab must offer a live Add control");
  assert.ok(hasSelectable(renderRenewals(RENEWALS), ADD_RE), "the Renewals tab must offer a live Add control");
});

test("the Add control is still offered on an empty tab (a person with no records can still add)", () => {
  // No dead / blank screen: an empty tab still renders its live Add affordance.
  assert.ok(hasSelectable(renderSubs([]), ADD_RE), "an empty Subscriptions tab must still offer a live Add control");
});

test("every record offers a live Edit control", () => {
  for (const [label, markup] of [
    ["subscription", renderSubs([SUB_A])],
    ["receipt", renderReceipts([REC_A])],
    ["renewal", renderRenewals([REN_A])],
  ] as const) {
    assert.ok(hasSelectable(markup, EDIT_RE), `a ${label} must offer a live Edit control`);
  }
});

// ════════════════════════════════════════════════════════════════════════════════
// AC1 — a per-record reminder-offset setting on every record kind.
// ════════════════════════════════════════════════════════════════════════════════

test("every record kind renders a per-record reminder-offset setting (a live, labelled control)", () => {
  for (const [label, markup] of [
    ["subscription", renderSubs([SUB_A])],
    ["receipt", renderReceipts([REC_A])],
    ["renewal", renderRenewals([REN_A])],
  ] as const) {
    const reminders = namedControls(markup).filter((c) => REMINDER_RE.test(c.name));
    assert.ok(reminders.length >= 1, `a ${label} must render a reminder-offset control; controls=${JSON.stringify(namedControls(markup))}`);
    assert.ok(
      reminders.some((c) => !c.disabled),
      `a ${label}'s reminder-offset setting must be a live (adjustable) control, not dead static text`,
    );
  }
});

test("the reminder-offset setting reflects the record's own offsets", () => {
  // SUB_REMINDER's offset (45) appears nowhere else in its render, so its presence can
  // only mean the record's current reminder offsets are shown (not a hard-coded default).
  const markup = renderSubs([SUB_REMINDER]);
  assert.match(markup, /\b45\b/, `the record's reminder offset (45 days) must be shown; markup did not contain it`);
});

// ════════════════════════════════════════════════════════════════════════════════
// AC1 — receipts carry an attach-file control (with return-by / warranty-end dates).
// ════════════════════════════════════════════════════════════════════════════════

test("a receipt offers an attach-file control, and it is live when the attach action is supplied", () => {
  const markup = renderReceipts([REC_A]);
  const controls = attachControls(markup);
  assert.ok(controls.length >= 1, `a receipt must offer an attach-file control; markup="${visibleText(markup)}"`);
  assert.ok(
    controls.some((c) => !isDisabled(c)),
    "the attach-file control must be LIVE when attachFileAction is supplied, never a dead button",
  );
});

test("a receipt's attach-file control is DISABLED with a reason when no attach action is configured (no dead controls)", () => {
  // Scoped to a single receipt so the only attach control is this receipt's (the Add
  // form is matched by the Add vocabulary, not the attach vocabulary).
  const live = renderReceipts([REC_A]);
  const dead = renderReceipts([REC_A], { attachFileAction: undefined });

  const deadControls = attachControls(dead);
  assert.ok(deadControls.length >= 1, "an attach-file affordance still appears when the action is absent");
  assert.ok(deadControls.every(isDisabled), "with no attachFileAction every attach-file control is DISABLED");
  assert.match(visibleText(dead), /Attaching a file isn't available just now/);
  assert.doesNotMatch(visibleText(live), /Attaching a file isn't available just now/);
});

// ════════════════════════════════════════════════════════════════════════════════
// AC2 — the moving checklist: a tick-off and a 'hand to an agent' control per item.
// ════════════════════════════════════════════════════════════════════════════════

test("the Moving checklist renders each item's label with a tick-off and a 'hand to an agent' control", () => {
  for (const item of CHECKLIST) {
    const markup = renderChecklist([item]); // rendered alone: the controls can only be this item's
    assert.ok(visibleText(markup).includes(item.label), `the checklist item "${item.label}" must render`);
    assert.ok(tickControls(markup).length >= 1, `the item "${item.label}" must render a tick-off control`);
    assert.ok(handControls(markup).length >= 1, `the item "${item.label}" must render a 'hand to an agent' control`);
  }
});

test("renders checklist items from the props given, not a fixed list", () => {
  const onlyA = visibleText(renderChecklist([{ ...ITEM_OPEN, id: "c1", label: "Cancel the gardening service" }]));
  const onlyB = visibleText(renderChecklist([{ ...ITEM_OPEN, id: "c2", label: "Move the piano upstairs" }]));
  assert.ok(onlyA.includes("Cancel the gardening service"), "render A shows A's item");
  assert.ok(!onlyA.includes("Move the piano upstairs"), "render A must not show B's item");
  assert.ok(onlyB.includes("Move the piano upstairs"), "render B shows B's item");
  assert.ok(!onlyB.includes("Cancel the gardening service"), "render B must not show A's item");
});

test("a ticked-off (done) checklist item reflects its done state", () => {
  const markup = renderChecklist([ITEM_DONE]);
  // Done is shown either as a checked checkbox or in plain words (never colour alone).
  const checkedCheckbox = [...markup.matchAll(/<input\b([^>]*?)\/?>/gi)].some(
    (m) => (attr(m[1], "type") ?? "").toLowerCase() === "checkbox" && hasBoolAttr(m[1], "checked"),
  );
  assert.ok(
    checkedCheckbox || /\b(done|completed|ticked|complete)\b/i.test(reasonSurface(markup)),
    `a done item must show its done state (a checked box or words); markup="${reasonSurface(markup)}"`,
  );
});

// ════════════════════════════════════════════════════════════════════════════════
// AC2 — no dead controls: an unavailable control renders DISABLED and states why.
// ════════════════════════════════════════════════════════════════════════════════

test("a tick-off control with no tick action is DISABLED with a reason (no dead controls)", () => {
  const live = renderChecklist([ITEM_OPEN]);
  const dead = renderChecklist([ITEM_OPEN], { tickOffAction: undefined });

  const deadTicks = tickControls(dead);
  assert.ok(deadTicks.length >= 1, "a tick-off affordance still appears when the action is absent");
  assert.ok(deadTicks.every(isDisabled), "with no tickOffAction every tick-off control is DISABLED");
  assert.ok(tickControls(live).some((c) => !isDisabled(c)), "with a tickOffAction the tick-off control is LIVE");
  assert.ok(
    reasonSurface(dead).length > reasonSurface(live).length,
    "the disabled tick-off says WHY it is unavailable — a reason the live control does not carry",
  );
});

test("an item already handed to an agent renders its 'hand to an agent' control DISABLED with a reason", () => {
  // ITEM_HANDED is already linked to a task — you cannot hand it off twice, so even with
  // handToAgentAction supplied the control is disabled and says why; a not-yet-handed item
  // (same action) stays live.
  const handed = renderChecklist([ITEM_HANDED]);
  const open = renderChecklist([ITEM_OPEN]);

  const handedControls = handControls(handed);
  assert.ok(handedControls.length >= 1, "a handed-off item still shows its 'hand to an agent' affordance");
  assert.ok(handedControls.every(isDisabled), "an already-handed item's 'hand to an agent' control is DISABLED");
  assert.ok(handControls(open).some((c) => !isDisabled(c)), "a not-yet-handed item's 'hand to an agent' control is LIVE");
  assert.ok(
    reasonSurface(handed).length > reasonSurface(open).length,
    "the disabled 'hand to an agent' says WHY — a reason the live control does not carry",
  );
});

// ════════════════════════════════════════════════════════════════════════════════
// AC3 — design system: colour comes from tokens, never a raw hex literal.
// ════════════════════════════════════════════════════════════════════════════════

test("the life-admin view uses design tokens, never a raw hex colour", () => {
  for (const markup of [
    renderSubs(SUBSCRIPTIONS),
    renderReceipts(RECEIPTS),
    renderRenewals(RENEWALS),
    renderChecklist(CHECKLIST),
    renderChecklist([ITEM_OPEN], { tickOffAction: undefined }),
    renderReceipts([REC_A], { attachFileAction: undefined }),
  ]) {
    assert.ok(
      !/#[0-9a-fA-F]{3,8}\b/.test(markup),
      `no raw hex colour may appear in the life-admin-view markup, got: ${markup}`,
    );
  }
});
