// Focus across a save (src/components/ui/form-focus.ts). A redirect to `?notice=saved`
// re-renders the page, so the submitted form is a fresh element and focus falls to <body>.
// The helper remembers where focus was as the form submits and puts it back on the same
// field or button of the same form when it reappears. Driven with a minimal fake DOM (no
// jsdom in this repo): only the properties the helper reads.

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { formSignature, rememberSubmitFocus, resetSubmitFocus, restoreSubmitFocus } from "./form-focus";

class FakeDoc {
  activeElement: FakeEl | null = null;
  body: FakeEl;
  documentElement: FakeEl;
  forms: FakeEl[] = [];
  location = { pathname: "/life-admin" };
  constructor() {
    this.body = new FakeEl(this, "body");
    this.documentElement = new FakeEl(this, "html");
    this.activeElement = this.body;
  }
}

class FakeEl {
  children: FakeEl[] = [];
  parent: FakeEl | null = null;
  attrs: Record<string, string>;
  open = true;
  constructor(readonly ownerDocument: FakeDoc, readonly tag: string, attrs: Record<string, string> = {}) {
    this.attrs = attrs;
  }
  add(...kids: FakeEl[]): this {
    for (const kid of kids) { kid.parent = this; this.children.push(kid); }
    return this;
  }
  get id() { return this.attrs.id ?? ""; }
  get name() { return this.attrs.name ?? ""; }
  get value() { return this.attrs.value ?? ""; }
  getAttribute(name: string) { return this.attrs[name] ?? null; }
  all(): FakeEl[] { return this.children.flatMap((kid) => [kid, ...kid.all()]); }
  contains(other: unknown) { return other === this || this.all().includes(other as FakeEl); }
  querySelectorAll(selector: string): FakeEl[] {
    const all = this.all();
    if (selector === 'input[type="hidden"]') return all.filter((e) => e.tag === "input" && e.attrs.type === "hidden");
    if (selector === "[name]") return all.filter((e) => "name" in e.attrs);
    if (selector.startsWith("button")) return all.filter((e) => (e.tag === "button" && (!e.attrs.type || e.attrs.type === "submit")) || (e.tag === "input" && e.attrs.type === "submit"));
    throw new Error(`unsupported selector ${selector}`);
  }
  querySelector(selector: string): FakeEl | null {
    if (selector === ":scope > summary") return this.children.find((kid) => kid.tag === "summary") ?? null;
    throw new Error(`unsupported selector ${selector}`);
  }
  closest(selector: string): FakeEl | null {
    if (selector !== "details:not([open])") throw new Error(`unsupported selector ${selector}`);
    for (let node: FakeEl | null = this; node; node = node.parent) if (node.tag === "details" && !node.open) return node;
    return null;
  }
  focus() { this.ownerDocument.activeElement = this; }
}

type Built = { doc: FakeDoc; form: FakeEl; title: FakeEl; submit: FakeEl; summary: FakeEl; details: FakeEl };

// A disclosure holding a guarded form: hidden identifiers, one field, one submit button.
function build(doc = new FakeDoc(), kind = "subscription"): Built {
  const title = new FakeEl(doc, "input", { name: "title" });
  const submit = new FakeEl(doc, "button", { type: "submit" });
  const form = new FakeEl(doc, "form").add(
    new FakeEl(doc, "input", { type: "hidden", name: "kind", value: kind }),
    new FakeEl(doc, "input", { type: "hidden", name: "$ACTION_ID_abc", value: "" }),
    title,
    submit,
  );
  const summary = new FakeEl(doc, "summary");
  const details = new FakeEl(doc, "details").add(summary, form);
  doc.body.add(details);
  doc.forms.push(form);
  return { doc, form, title, submit, summary, details };
}

// The redirect re-renders the page: the old form is gone, a new one with the same identity mounts.
function rerender(previous: Built, options: { open?: boolean } = {}): Built {
  const doc = previous.doc;
  doc.body.children = [];
  doc.forms = [];
  doc.activeElement = doc.body;
  const next = build(doc);
  next.details.open = options.open ?? true;
  return next;
}

const asForm = (el: FakeEl) => el as unknown as HTMLFormElement;
const asEl = (el: FakeEl) => el as unknown as HTMLElement;

beforeEach(() => resetSubmitFocus());

test("the signature ignores React's action id and keeps the form's hidden identifiers", () => {
  const { form } = build();
  assert.equal(formSignature(asForm(form)), "&&kind=subscription");
});

test("focus on the submit button returns to the same button of the re-rendered form", () => {
  const before = build();
  before.submit.focus();
  rememberSubmitFocus(asForm(before.form), asEl(before.submit), 0);
  const after = rerender(before);
  assert.equal(restoreSubmitFocus(asForm(after.form), 1000), true);
  assert.equal(after.doc.activeElement, after.submit);
});

test("focus in a field returns to that field, or to the summary when its disclosure closed", () => {
  const before = build();
  before.title.focus();
  rememberSubmitFocus(asForm(before.form), null, 0);
  const open = rerender(before);
  assert.equal(restoreSubmitFocus(asForm(open.form), 1000), true);
  assert.equal(open.doc.activeElement, open.title);

  open.title.focus();
  rememberSubmitFocus(asForm(open.form), null, 2000);
  const closed = rerender(open, { open: false });
  assert.equal(restoreSubmitFocus(asForm(closed.form), 3000), true);
  assert.equal(closed.doc.activeElement, closed.summary);
});

test("a mouse submit (focus not in the form) still returns focus to the button that submitted", () => {
  const before = build();
  rememberSubmitFocus(asForm(before.form), asEl(before.submit), 0);
  const after = rerender(before);
  assert.equal(restoreSubmitFocus(asForm(after.form), 1000), true);
  assert.equal(after.doc.activeElement, after.submit);
});

test("nothing moves when focus survived, the person moved it, the form differs or time ran out", () => {
  // Focus survived the save: left alone.
  const kept = build();
  kept.submit.focus();
  rememberSubmitFocus(asForm(kept.form), asEl(kept.submit), 0);
  assert.equal(restoreSubmitFocus(asForm(kept.form), 100), false);
  assert.equal(kept.doc.activeElement, kept.submit);

  // A different form (other hidden identifiers) never takes the focus.
  const before = build();
  before.submit.focus();
  rememberSubmitFocus(asForm(before.form), asEl(before.submit), 0);
  const doc = before.doc;
  doc.body.children = []; doc.forms = []; doc.activeElement = doc.body;
  const other = build(doc, "receipt_warranty");
  assert.equal(restoreSubmitFocus(asForm(other.form), 1000), false);
  assert.equal(doc.activeElement, doc.body);

  // Another page, or after the restore window: forgotten.
  const late = build();
  late.submit.focus();
  rememberSubmitFocus(asForm(late.form), asEl(late.submit), 0);
  const afterLate = rerender(late);
  assert.equal(restoreSubmitFocus(asForm(afterLate.form), 60_000), false);

  const moved = build();
  moved.submit.focus();
  rememberSubmitFocus(asForm(moved.form), asEl(moved.submit), 0);
  const afterMove = rerender(moved);
  afterMove.doc.location.pathname = "/home";
  assert.equal(restoreSubmitFocus(asForm(afterMove.form), 1000), false);
});
