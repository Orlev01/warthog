// E02-S02 — Field + Label (src/components/ui/field.tsx).
//
// RED-first: src/components/ui/field.tsx does NOT exist yet, so importing
// `./field` throws and every test here fails until the builder adds the
// components. That absence is the entire point of test-first — do not implement
// anything to make these pass.
//
// These tests pin BEHAVIOUR — what the components RENDER and how they are wired
// for accessibility (WCAG 2.2 AA) — never the source text of field.tsx. A Field
// composes a Label, an Input and (when in error) an error-message element, and
// does the associating itself. We render with `react-dom/server` and read the
// emitted markup.
//
// The contract the builder implements (exactly this):
//
//   Label(props): a native <label> element.
//     • htmlFor → the `for` attribute; children → the visible label text.
//
//   Field({ label, error?, id?, ...inputProps }): a group that renders a Label,
//   an Input and, when `error` is given, an error-message element.
//     • The Label is associated with the Input: the Label's `for` equals the
//       Input's `id` (Field generates an id when the caller gives none).
//     • When `error` is given, the error TEXT is rendered in an element, that
//       element's id appears in the Input's `aria-describedby`, and the Input
//       carries aria-invalid="true" — so the error is conveyed by text and a
//       programmatic flag, never by colour alone.
//     • When there is no `error`, the Input is not marked invalid.
//     • The Input carries at least a 44px touch target.
//     • Remaining props (type, name, …) are forwarded to the Input.
//     • Uses design tokens, never a raw hex colour.
//
import * as React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";

import { Field, Label, SelectField, TextareaField } from "./field";

function parseAttrs(attrText: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([\w:-]+)="([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(attrText))) attrs[m[1]] = m[2];
  return attrs;
}

// Attributes of the first element with the given tag (a Field renders one Label
// and one Input, so "first" is unambiguous).
function firstTagAttrs(markup: string, tag: string): Record<string, string> {
  const m = markup.match(new RegExp(`<${tag}\\b([^>]*)>`));
  assert.ok(m, `expected a <${tag}> element in the rendered markup`);
  return parseAttrs(m![1]);
}

function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, "").trim();
}

// Find the element carrying id=`id` and return its inner text content. Used to
// prove an aria-describedby reference actually points at the error message.
function textOfElementById(markup: string, id: string): string | null {
  const re = /<([\w-]+)\b([^>]*)>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(markup))) {
    const attrs = parseAttrs(m[2]);
    if (attrs.id === id) {
      const tag = m[1];
      const start = m.index + m[0].length;
      const closeIdx = markup.indexOf(`</${tag}>`, start);
      if (closeIdx === -1) return "";
      return stripTags(markup.slice(start, closeIdx));
    }
  }
  return null;
}

function hasTouchTarget(cls: string): boolean {
  if (/\b(?:min-h|h)-(?:11|12|13|14|16|20)\b/.test(cls)) return true;
  const px = cls.match(/\b(?:min-h|h)-\[(\d+(?:\.\d+)?)px\]/);
  if (px && Number(px[1]) >= 44) return true;
  const rem = cls.match(/\b(?:min-h|h)-\[(\d+(?:\.\d+)?)rem\]/);
  if (rem && Number(rem[1]) * 16 >= 44) return true;
  return false;
}

// --- Label -----------------------------------------------------------------

test("Label renders a native <label> carrying its for target and text", () => {
  const markup = renderToStaticMarkup(<Label htmlFor="email">Email address</Label>);
  assert.match(markup, /^<label[\s>]/, "Label must render a native <label> element");
  assert.equal(firstTagAttrs(markup, "label").for, "email", "htmlFor becomes the label's for attribute");
  assert.ok(stripTags(markup).includes("Email address"), "the children are the visible label text");
});

// --- Field: label/input association (AC1, via id) --------------------------

test("Field associates its Label with the Input via a matching id", () => {
  // No id supplied: the Field must generate one and wire both sides to it.
  const markup = renderToStaticMarkup(<Field label="Email address" />);
  const labelFor = firstTagAttrs(markup, "label").for;
  const inputId = firstTagAttrs(markup, "input").id;
  assert.ok(labelFor, "the Label has a for attribute");
  assert.ok(inputId, "the Input has an id");
  assert.equal(labelFor, inputId, "the Label's for targets the Input's id");
});

test("Field honours a caller-supplied id on the Input and its Label", () => {
  const markup = renderToStaticMarkup(<Field label="Email address" id="email" />);
  assert.equal(firstTagAttrs(markup, "input").id, "email", "the Input uses the supplied id");
  assert.equal(firstTagAttrs(markup, "label").for, "email", "the Label points at the supplied id");
});

// --- Field: error association (AC1, via aria-describedby) ------------------

test("Field associates the error message with the Input via aria-describedby", () => {
  const error = "Enter a valid email address";
  const markup = renderToStaticMarkup(<Field label="Email address" id="email" error={error} />);

  const describedBy = firstTagAttrs(markup, "input")["aria-describedby"];
  assert.ok(describedBy, "the Input has aria-describedby when there is an error");

  // At least one of the referenced ids must point at an element holding the
  // error TEXT — that is what makes the association real.
  const ids = describedBy!.split(/\s+/).filter(Boolean);
  const described = ids
    .map((id) => textOfElementById(markup, id))
    .filter((t): t is string => t !== null);
  assert.ok(
    described.some((t) => t.includes(error)),
    `an aria-describedby target must contain the error text (described: ${JSON.stringify(described)})`,
  );
});

// --- Field: error conveyed by text + a programmatic flag, not colour (AC2) --

test("Field conveys the error by text, not colour alone", () => {
  const error = "Enter a valid email address";
  const markup = renderToStaticMarkup(<Field label="Email address" id="email" error={error} />);
  // The error is present as readable text content (a sighted or screen-reader
  // user gets the words), not signalled only by a colour class.
  assert.ok(stripTags(markup).includes(error), "the error message is rendered as text");
  assert.equal(firstTagAttrs(markup, "p").role, "alert", "a new asynchronous error is announced while focus stays on Submit");
  // ...and the Input is flagged invalid programmatically (a non-visual signal).
  assert.equal(
    firstTagAttrs(markup, "input")["aria-invalid"],
    "true",
    "the Input is marked aria-invalid=\"true\" while in error",
  );
});

test("Field does not mark the Input invalid when there is no error", () => {
  const markup = renderToStaticMarkup(<Field label="Email address" id="email" />);
  assert.notEqual(
    firstTagAttrs(markup, "input")["aria-invalid"],
    "true",
    "a Field with no error must not report aria-invalid=\"true\"",
  );
});

// --- Field: touch target (AC2) + prop forwarding ---------------------------

test("Field's Input carries at least a 44px touch target", () => {
  const markup = renderToStaticMarkup(<Field label="Email address" id="email" />);
  const cls = firstTagAttrs(markup, "input").class ?? "";
  assert.ok(
    hasTouchTarget(cls),
    `the Field's Input must apply a >=44px touch-target class (got class: "${cls}")`,
  );
});

test("Field forwards remaining props to its Input", () => {
  const markup = renderToStaticMarkup(
    <Field label="Email address" id="email" type="email" name="email" />,
  );
  const attrs = firstTagAttrs(markup, "input");
  assert.equal(attrs.type, "email", "Field forwards the type prop to the Input");
  assert.equal(attrs.name, "email", "Field forwards the name prop to the Input");
});

test("Field uses design tokens, never a raw hex colour", () => {
  // Caller text ("Email address", the error) carries no `#`, so any hex in the
  // rendered markup could only be a hard-coded colour in the component.
  const markup = renderToStaticMarkup(
    <Field label="Email address" id="email" error="Enter a valid email address" />,
  );
  assert.ok(
    !/#[0-9a-fA-F]{3,8}\b/.test(markup),
    "no raw hex colour may appear in the Field's rendered markup",
  );
});

test("Field keeps external help associated alongside its error", () => {
  const markup = renderToStaticMarkup(
    <Field label="Email address" id="email" error="Check your email" aria-describedby="email-help" aria-invalid={false} />,
  );
  const input = firstTagAttrs(markup, "input");
  assert.deepEqual(input["aria-describedby"].split(/\s+/), ["email-help", "email-error"]);
  assert.equal(input["aria-invalid"], "true");
});

test("Field preserves an external invalid state when no inline error is given", () => {
  const markup = renderToStaticMarkup(<Field label="Email address" aria-describedby="help" aria-invalid="grammar" />);
  const input = firstTagAttrs(markup, "input");
  assert.equal(input["aria-describedby"], "help");
  assert.equal(input["aria-invalid"], "grammar");
});

// ─── UI/UX pass: wrapper className, hint, widths, textarea/select parity ─────────────

test("Field's className styles its wrapper so it can grow in a row; inputClassName reaches the input", () => {
  const markup = renderToStaticMarkup(<Field label="Mobile number" className="sm:flex-1" inputClassName="font-mono" />);
  const wrapper = firstTagAttrs(markup, "div").class ?? "";
  const input = firstTagAttrs(markup, "input").class ?? "";
  assert.match(wrapper, /\bsm:flex-1\b/);
  assert.doesNotMatch(input, /\bsm:flex-1\b/);
  assert.match(input, /\bfont-mono\b/);
});

test("Field's hint is read with the control, before any error", () => {
  const markup = renderToStaticMarkup(<Field label="Due date" id="due" hint="Reminders use this date." error="Pick a date" />);
  assert.deepEqual(firstTagAttrs(markup, "input")["aria-describedby"].split(/\s+/), ["due-hint", "due-error"]);
  assert.equal(textOfElementById(markup, "due-hint"), "Reminders use this date.");
});

test("Field passes autocomplete and input mode through and sizes its control, not its label", () => {
  const markup = renderToStaticMarkup(<Field label="Code" autoComplete="one-time-code" inputMode="numeric" width="code" />);
  const input = firstTagAttrs(markup, "input");
  // HTML attribute names are case-insensitive; React writes autoComplete / inputMode.
  assert.equal(input.autoComplete ?? input.autocomplete, "one-time-code");
  assert.equal(input.inputMode ?? input.inputmode, "numeric");
  assert.match(input.class ?? "", /\bsm:max-w-32\b/);
  assert.doesNotMatch(firstTagAttrs(markup, "div").class ?? "", /max-w-32/);
});

test("TextareaField and SelectField wire label, error and touch target like Field", () => {
  const textarea = renderToStaticMarkup(<TextareaField label="Note" id="note" error="Too long" />);
  assert.equal(firstTagAttrs(textarea, "label").for, "note");
  assert.equal(firstTagAttrs(textarea, "textarea")["aria-describedby"], "note-error");
  assert.equal(firstTagAttrs(textarea, "textarea")["aria-invalid"], "true");
  const select = renderToStaticMarkup(<SelectField label="Assignee" id="who"><option>Me</option></SelectField>);
  assert.equal(firstTagAttrs(select, "label").for, "who");
  assert.ok(hasTouchTarget(firstTagAttrs(select, "select").class ?? ""));
});
