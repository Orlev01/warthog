// E04-S39 — the sign-up details step renders its name AND email inputs controlled
// from the first render (the view half: `src/components/auth/auth-views.tsx`).
//
// RED-first: today the details step's name input is uncontrolled (no `value`), and
// the email input is `value={email}` where `email` is `undefined` on the first
// render — so React warns the email input switches from uncontrolled to controlled,
// and the typed name is dropped. This task makes BOTH inputs controlled from the
// very first render (a defined string `value`, defaulting to "" when no prop is
// given), and lets the name be driven (a `name` value + an `onNameChange`). Until
// the builder does that, these tests fail — that absence IS the point of
// test-first. Do NOT implement anything to make them pass.
//
// These pin BEHAVIOUR — what the view RENDERS — not its source text. A controlled
// input is one React renders with a `value` attribute present (React emits
// `value=""` for a controlled empty input, and omits the attribute entirely for an
// uncontrolled one / a `value={undefined}` one). We render with `react-dom/server`
// (no DOM/jsdom — React component / E2E testing is a per-job ADR) and read markup.

import * as React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";

import { SignupView } from "./auth-views";

// ── tiny markup helpers (no DOM) ─────────────────────────────────────────────────

function attr(attrs: string, name: string): string | null {
  const m = attrs.match(new RegExp(`\\b${name}="([^"]*)"`, "i"));
  return m ? m[1]! : null;
}

// Void <input> elements (React self-closes them): just their attribute strings.
function inputs(markup: string): { attrs: string; type: string }[] {
  const out: { attrs: string; type: string }[] = [];
  for (const m of markup.matchAll(/<input\b([^>]*?)\/?>/gi)) {
    out.push({ attrs: m[1]!, type: (attr(m[1]!, "type") ?? "text").toLowerCase() });
  }
  return out;
}

// A controlled input carries a `value` attribute (present even when ""). Matching
// `value` only when it starts the attrs or follows whitespace avoids a false match
// on a hyphenated attribute like `data-value`.
function isControlled(attrs: string): boolean {
  return /(^|\s)value="/i.test(attrs);
}

// The two labellable text inputs the details step collects: the email (type=email)
// and the name (the other text input). Returned together so a test can check each.
function detailsInputs(markup: string): { email?: { attrs: string }; name?: { attrs: string } } {
  const all = inputs(markup);
  const email = all.find((i) => i.type === "email");
  const name = all.find((i) => i.type !== "email" && i.type !== "checkbox" && i.type !== "submit");
  return { email, name };
}

// ===========================================================================
// The details step is controlled from the first render (no email/name props).
// ===========================================================================

test("the details step renders the name AND email inputs controlled from the first render", () => {
  // No `email` / `name` props: this is the very first render, before the person has
  // typed anything. Both inputs must already be controlled (a defined `value`), so
  // there is no uncontrolled→controlled switch and no typed value is dropped.
  const markup = renderToStaticMarkup(<SignupView step="details" />);

  const { email, name } = detailsInputs(markup);
  assert.ok(email, `the details step must render an email input, got: ${markup}`);
  assert.ok(name, `the details step must render a name input, got: ${markup}`);

  assert.ok(
    isControlled(email!.attrs),
    `the email input must be controlled from the first render (a value attribute present), got: ${email!.attrs}`,
  );
  assert.ok(
    isControlled(name!.attrs),
    `the name input must be controlled from the first render (a value attribute present), got: ${name!.attrs}`,
  );
});

// ===========================================================================
// The controlled inputs reflect the values the flow drives them with.
// ===========================================================================

test("the details step reflects the driven name and email as the inputs' values", () => {
  const markup = renderToStaticMarkup(
    <SignupView step="details" email="sam@people.example" name="Sam Rivera" />,
  );

  const { email, name } = detailsInputs(markup);
  assert.ok(email && name, `the details step must render both a name and an email input, got: ${markup}`);

  assert.equal(
    attr(email!.attrs, "value"),
    "sam@people.example",
    `the email input must render the driven email as its value, got: ${email!.attrs}`,
  );
  assert.equal(
    attr(name!.attrs, "value"),
    "Sam Rivera",
    `the name input must render the driven name as its value, got: ${name!.attrs}`,
  );
});
