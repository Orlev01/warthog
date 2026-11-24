// E14-S11 — Life-admin records view component (src/components/life-admin/life-admin-view.tsx),
// reshaped by the life-admin profile (docs/adr/life-admin-profile.md) and the founder's tabs
// (23 Nov 2026: Records, Upcoming, History and Tasks; the moving checklist is gone).
//
// WHY this component exists (brief "Life admin"; design §4.1): the Life Admin screen is where a
// person sees and maintains the records they and their agents keep — a typed "Records" profile
// (vehicles and their rego, home, utilities, health insurance, super, ID expiry dates,
// subscriptions, pets, receipts …). Every record shows its (already-decrypted) fields with edit
// controls and, when it has a date, its reminder setting; a receipt also carries an attach-file
// control. No control may ever be dead — a control with nothing wired behind it renders
// DISABLED and says why (constitution: "No dead controls").
//
// This is the pure, prop-driven VIEW: it renders FROM the props the loader hands it, with
// fields already decrypted and server actions passed in (no clock / DB / session). These
// tests pin BEHAVIOUR — what the component RENDERS (the values a person reads, the
// accessible controls, and the DISABLED / live state of each) — never the source text. We
// render with `react-dom/server` (no DOM) and read the emitted markup.
//
// The organisation of the Records tab (category panels, assets, statuses, filters) is pinned in
// record-organisation.test.tsx and record-status.test.ts; the To check panel and the forms in
// records-review.test.tsx; the tabs, Upcoming and History in life-admin-sections.test.tsx; the
// reminder setting in record-reminders.test.tsx.

import * as React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";

import { LifeAdminView, type LifeAdminRecordView, type LifeAdminViewProps } from "./life-admin-view";

type LifeAdminAction = (formData: FormData) => void | Promise<void>;

// --- fixtures -----------------------------------------------------------------------
//
// Distinctive, recognisable values so every "renders this value" assertion is honest — the
// string can only have come from the record under test. Field values deliberately avoid the
// control vocabulary the tests match on (add / edit / remind / attach / upload), so a control
// assertion can never pass on an incidental word in a field.

const SUB_A: LifeAdminRecordView = {
  id: "sub-a",
  kind: "subscription",
  fields: { Service: "Spotlight Streaming", "Monthly cost": "A$18.50" },
  dueDate: "2026-12-15",
  status: "active",
  reminderOffsets: [14, 1],
};

// A DISTINCTIVE reminder offset (45) that appears nowhere else in its render, so "the
// record's reminder offset is shown" can only be satisfied by the record's own offsets.
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
  fields: { item: "Dyson cordless vacuum", provider: "Good Guys", warranty_ends: "2029-11-30" },
  dueDate: "2026-12-20",
  status: "active",
  reminderOffsets: [14, 1],
  hasAttachedFile: false,
};

const REN_A: LifeAdminRecordView = {
  id: "ren-a",
  kind: "renewal_appointment",
  fields: { What: "Passport booking", Where: "Australia Post Chatswood" },
  dueDate: "2027-02-10",
  status: "upcoming",
  reminderOffsets: [30, 7],
};

const PET_INS: LifeAdminRecordView = {
  id: "pet-ins",
  kind: "item",
  type: "pets.insurance",
  fields: { provider: "Bow Wow Cover", reference: "PI-5521", notes: "Pay at https://pay.example.test/bill?ref=1" },
  dueDate: "2027-04-01",
  status: "active",
  reminderOffsets: [30],
};

const RECORDS = [SUB_A, REC_A, REN_A, PET_INS];

const noop: LifeAdminAction = () => {};

// base() supplies EVERY action, so a control is live unless a test deliberately omits it.
function base(overrides: Partial<LifeAdminViewProps> = {}): LifeAdminViewProps {
  return {
    today: "2026-11-23",
    records: RECORDS,
    addRecordAction: noop,
    editRecordAction: noop,
    attachFileAction: noop,
    deleteRecordAction: noop,
    confirmRecordAction: noop,
    confirmAllAction: noop,
    dismissRecordAction: noop,
    acceptPendingAction: noop,
    declinePendingAction: noop,
    ...overrides,
  };
}

function render(props: LifeAdminViewProps): string {
  return renderToStaticMarkup(<LifeAdminView {...props} />);
}

// One record (or none) on Records, so a control assertion can only be satisfied by that record.
function renderThings(records: ReadonlyArray<LifeAdminRecordView>, overrides: Partial<LifeAdminViewProps> = {}): string {
  return render(base({ records, ...overrides }));
}

// The markup inside one tab panel (0 Records, 1 Add, 2 Upcoming, 3 History), so an assertion about
// one tab never meets another's content.
function tabPanel(markup: string, index: 0 | 1 | 2 | 3): string {
  const starts = [...markup.matchAll(/<div\b[^>]*role="tabpanel"[^>]*>/g)].map((m) => m.index!);
  return markup.slice(starts[index], starts[index + 1] ?? markup.length);
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

// --- control vocabularies (accessible-name matchers; generous over plain wordings) --

const RECORDS_TAB_RE = /^records$/i;
const UPCOMING_TAB_RE = /^upcoming$/i;
const HISTORY_TAB_RE = /^history$/i;

const ADD_RE = /\badd\b/i;
const EDIT_RE = /\bedit\b|\bchange\b|\bupdate\b/i;
const REMINDER_RE = /remind/i;
// The attach-file control; deliberately NOT matching "add a receipt" (the Add control).
const ATTACH_RE = /attach|upload|choose (a )?file|add (a |the )?(file|photo|scan|document|pdf)/i;

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
// The tabs — Records, Add, Upcoming and History — are named and navigable.
// ════════════════════════════════════════════════════════════════════════════════

test("names the tabs — Records, Upcoming and History — as navigable controls, Records first, with no counts", () => {
  const markup = render(base());
  assert.ok(hasTab(markup, RECORDS_TAB_RE), "the Records tab must be a navigable control");
  assert.ok(hasTab(markup, UPCOMING_TAB_RE), "the Upcoming tab must be a navigable control");
  assert.ok(hasTab(markup, HISTORY_TAB_RE), "the History tab must be a navigable control");
  assert.doesNotMatch(visibleText(markup), /Your things|Moving checklist/, "the old names are gone");
  const selected = /<button\b[^>]*aria-selected="true"[^>]*>([\s\S]*?)<\/button>/.exec(markup)!;
  assert.match(visibleText(selected[1]!), /^Records$/, "Records opens first, with no count in its name");
  const finished = render(base({ records: [...RECORDS, { ...SUB_A, id: "sub-done", status: "cancelled", phase: { phase: "ended", bucket: "finished", live: false, label: "Ended", comingUp: false } }] }));
  assert.doesNotMatch(tabPanel(finished, 0), /id="record-sub-done"/, "a cancelled record isn't on Records");
  assert.match(tabPanel(finished, 3), /id="record-sub-done"/, "it's in History");
});

// ════════════════════════════════════════════════════════════════════════════════
// AC1 — every record renders with its fields, whatever its kind or type.
// ════════════════════════════════════════════════════════════════════════════════

test("every record renders its fields: the original three kinds and a typed record", () => {
  const text = visibleText(tabPanel(renderThings(RECORDS), 0));
  for (const value of ["Spotlight Streaming", "A$18.50", "Dyson cordless vacuum", "Good Guys", "30 Nov 2029", "Passport booking", "Australia Post Chatswood", "Bow Wow Cover", "PI-5521"]) {
    assert.ok(text.includes(value), `the field value "${value}" must render; text="${text}"`);
  }
  assert.match(text, /Warranty ends 30 Nov 2029/, "a receipt's warranty date is labelled and formatted");
  assert.match(text, /Return by 20 Dec 2026/, "a receipt's due date reads as its return-by date");
  assert.match(text, /Policy number PI-5521/, "a typed record's facts use the type's labels");
});

test("renders records from the props given, not a fixed list", () => {
  const onlyA = visibleText(renderThings([{ ...SUB_A, id: "x1", fields: { Service: "Tidewater Gazette" } }]));
  const onlyB = visibleText(renderThings([{ ...SUB_A, id: "x2", fields: { Service: "Mountain Gym Pass" } }]));
  assert.ok(onlyA.includes("Tidewater Gazette") && !onlyA.includes("Mountain Gym Pass"));
  assert.ok(onlyB.includes("Mountain Gym Pass") && !onlyB.includes("Tidewater Gazette"));
});

test("a value an agent read from email is shown as text, never as a link", () => {
  const markup = renderThings([PET_INS]);
  assert.ok(visibleText(markup).includes("https://pay.example.test/bill?ref=1"), "the value is shown as written");
  for (const a of findAll(markup, "a")) {
    const href = attr(a.attrs, "href") ?? "";
    assert.ok(!/example\.test/.test(href), `no link is made from a record's value; found href="${href}"`);
  }
});

// ════════════════════════════════════════════════════════════════════════════════
// AC1 — add / edit controls, and a per-record reminder-offset setting.
// ════════════════════════════════════════════════════════════════════════════════

test("Records offers a live Add control, even with no records at all", () => {
  assert.ok(hasSelectable(renderThings(RECORDS, { addType: "subscriptions.service" }), ADD_RE));
  assert.ok(hasSelectable(renderThings([], { addType: "subscriptions.service" }), ADD_RE), "a person with no records can still add");
  const text = visibleText(renderThings([]));
  assert.match(text, /What are you adding\?/, "the first step (choose a type) is always there");
});

test("with no add action, the add form is DISABLED and says why (no dead controls)", () => {
  const dead = renderThings([], { addType: "subscriptions.service", addRecordAction: undefined });
  assert.match(visibleText(dead), /Adding isn't available just now\./);
  const button = findAll(dead, "button").find((b) => /Add to Life admin/.test(controlFace(b)));
  assert.ok(button && isDisabled(button), "the Add button is disabled");
});

test("every record offers a live Edit control", () => {
  for (const record of RECORDS) {
    assert.ok(hasSelectable(renderThings([record]), EDIT_RE), `${record.id} must offer a live Edit control`);
  }
  const dead = renderThings([SUB_A], { editRecordAction: undefined });
  assert.match(visibleText(dead), /Editing isn't available just now\./);
});

test("every record with a date renders a live, labelled reminder setting reflecting its own offsets", () => {
  for (const record of RECORDS) {
    const reminders = namedControls(renderThings([record])).filter((c) => REMINDER_RE.test(c.name));
    assert.ok(reminders.some((c) => !c.disabled), `${record.id} must render a live reminder-offset control`);
  }
  assert.match(renderThings([SUB_REMINDER]), /value="45"/, "the record's own offset (45 days) is shown");
});

// ════════════════════════════════════════════════════════════════════════════════
// AC1 — receipts carry an attach-file control.
// ════════════════════════════════════════════════════════════════════════════════

test("a receipt offers an attach-file control, live when the attach action is supplied", () => {
  const controls = attachControls(renderThings([REC_A]));
  assert.ok(controls.length >= 1, "a receipt must offer an attach-file control");
  assert.ok(controls.some((c) => !isDisabled(c)), "it is LIVE when attachFileAction is supplied");
  assert.equal(attachControls(renderThings([SUB_A])).length, 0, "only receipts take attachments");
});

test("a receipt's attach-file control is DISABLED with a reason when no attach action is configured", () => {
  const dead = renderThings([REC_A], { attachFileAction: undefined });
  const deadControls = attachControls(dead);
  assert.ok(deadControls.length >= 1 && deadControls.every(isDisabled));
  assert.match(visibleText(dead), /Attaching a file isn't available just now/);
  assert.doesNotMatch(visibleText(renderThings([REC_A])), /Attaching a file isn't available just now/);
});

// ════════════════════════════════════════════════════════════════════════════════
// AC3 — design system: colour comes from tokens, never a raw hex literal.
// ════════════════════════════════════════════════════════════════════════════════

test("the life-admin view uses design tokens, never a raw hex colour", () => {
  for (const markup of [
    render(base()),
    renderThings(RECORDS, { addType: "vehicles.registration" }),
    render(base({ initialTab: "upcoming" })),
    render(base({ initialTab: "history" })),
    renderThings([REC_A], { attachFileAction: undefined, editRecordAction: undefined }),
  ]) {
    assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(markup), "no raw hex colour may appear in the markup");
  }
});
