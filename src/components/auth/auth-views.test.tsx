// E04-S12 — Auth page views (src/components/auth/auth-views.tsx).
//
// RED-first: src/components/auth/auth-views.tsx does NOT exist yet, so importing
// `./auth-views` throws and every test here fails until the builder adds the
// components. That absence is the entire point of test-first — do not implement
// anything to make these pass.
//
// Why these views exist (task E04-S12): the auth *entry* files (signup / signin /
// device / recover page.tsx) must stay thin; the step logic and the human copy
// live in plain, prop-driven components that render without a browser, a session
// or any protocol machinery — so a render test can pin the words a person reads at
// each step and prove no protocol/security jargon reaches these primary screens
// (brief design_ux.copy; constitution INV-22; design §5).
//
// These tests pin BEHAVIOUR — what each view RENDERS for a given `step` (the
// visible copy, the accessible form labels, the actionable controls) — never the
// source text of auth-views.tsx. A later behaviour-preserving refactor (different
// wrapper elements, reworded-but-still-plain copy, composing the Field/Button
// primitives, moving a step) stays green as long as the step still renders the
// right plain copy and accessible controls. We render with `react-dom/server`
// (no DOM/jsdom — React component / E2E testing is a per-job ADR) and read the
// emitted markup.
//
// The contract the builder implements (exactly this) — four step-driven views, a
// plain presentation component each, no internal protocol state:
//
//   SignupView({ step, recoveryCode? }):   the sign-up flow, one screen per step.
//     step "details"  → name + email entry (each an accessibly-labelled input).
//     step "code"     → enter the one-time code emailed to the person (a labelled
//                       input; the copy talks about "the code we emailed", never a
//                       protocol word).
//     step "passkey"  → create a passkey (plain copy using the word "passkey";
//                       an actionable control to do it).
//     step "recovery" → show the one-time `recoveryCode` ONCE and have the person
//                       confirm they have saved it (an "I've saved it" control).
//
//   SigninView({ step }):   returning sign-in.
//     step "passkey"  → sign in with your passkey (plain copy; an actionable control).
//     step "code"     → the authenticator-app fallback: email + a code entry
//                       (accessibly-labelled inputs).
//
//   RecoverView({ step, recoveryCode? }):   recovery after losing every passkey.
//     step "identify"      → enter your email; a one-time code is emailed to it.
//     step "email-code"    → prove it's you with the emailed one-time code.
//     step "recovery-code" → enter your saved recovery code (a labelled input).
//     step "passkey"       → create a new passkey.
//     step "new-recovery"  → show the NEW `recoveryCode` once; confirm it's saved.
//
//   DeviceView({ step }):   adding this device to an existing account.
//     step "code"    → enter the emailed one-time code (a labelled input).
//     step "confirm" → confirm it's you with an existing passkey / your other
//                      device (plain copy; an actionable control).
//
// Every view, at every step, is rendered from props alone, uses the design tokens
// (never a raw hex colour), gives every text/checkbox input an accessible label,
// and says what happens in plain Australian English — no "OAuth", "MCP", "token",
// "PRF", "WebAuthn", "TOTP", "attestation", "encryption key", etc. (The words
// "passkey", "recovery code", "authenticator" and "code" are the brief's OWN plain
// vocabulary and are expected, not jargon.)

import * as React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";

import { SignupView, SigninView, RecoverView, DeviceView } from "./auth-views";

// --- tiny markup helpers (no DOM) ------------------------------------------

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

// Visible text of an HTML fragment with tags stripped and entities decoded:
// exactly the words a sighted reader sees (an <svg> icon contributes none).
function visibleText(markup: string): string {
  return decode(markup.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

// All human-facing text: the visible copy PLUS the text a screen reader would
// announce from the attributes that carry words (aria-label, placeholder, title,
// alt). The jargon scan runs over this so hidden-but-announced jargon counts too.
function faceText(markup: string): string {
  const parts = [visibleText(markup)];
  for (const re of [
    /aria-label="([^"]*)"/gi,
    /placeholder="([^"]*)"/gi,
    /\btitle="([^"]*)"/gi,
    /\balt="([^"]*)"/gi,
  ]) {
    for (const m of markup.matchAll(re)) parts.push(decode(m[1]));
  }
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

// Read one double-quoted attribute off an element's attribute string.
function attr(attrs: string, name: string): string | null {
  const m = attrs.match(new RegExp(`\\b${name}="([^"]*)"`, "i"));
  return m ? m[1] : null;
}

type El = { attrs: string; inner: string };

function findAll(markup: string, tag: string): El[] {
  const out: El[] = [];
  for (const m of markup.matchAll(new RegExp(`<${tag}\\b([^>]*)>([\\s\\S]*?)</${tag}>`, "gi"))) {
    out.push({ attrs: m[1], inner: m[2] });
  }
  return out;
}

// Void <input> elements (React self-closes them): just their attributes.
function inputs(markup: string): { attrs: string; type: string; id: string | null }[] {
  const out: { attrs: string; type: string; id: string | null }[] = [];
  for (const m of markup.matchAll(/<input\b([^>]*?)\/?>/gi)) {
    const attrs = m[1];
    out.push({ attrs, type: (attr(attrs, "type") ?? "text").toLowerCase(), id: attr(attrs, "id") });
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

// Input types that MUST carry an accessible label for WCAG 2.2 AA. Submit/button
// inputs are named by their value; hidden inputs are not user-facing — both are
// out of scope for the label requirement.
const LABELLABLE = new Set([
  "text",
  "email",
  "tel",
  "number",
  "password",
  "search",
  "url",
  "checkbox",
  "radio",
]);

// Does this input have a programmatic accessible label — an associated <label for>,
// an aria-label, or an aria-labelledby?
function inputIsLabelled(input: { attrs: string; id: string | null }, labels: Record<string, string>): boolean {
  if (input.id && labels[input.id] && labels[input.id].length > 0) return true;
  const al = attr(input.attrs, "aria-label");
  if (al && al.trim().length > 0) return true;
  const alb = attr(input.attrs, "aria-labelledby");
  if (alb && alb.trim().length > 0) return true;
  return false;
}

// An actionable native <button> is one not carrying the native `disabled`
// attribute (React renders a truthy boolean `disabled` prop as `disabled=""`).
// This matches the ATTRIBUTE, never a Tailwind `disabled:` class — so it proves a
// genuinely live control rather than a dead button.
function actionableButtons(markup: string): { name: string; attrs: string }[] {
  return findAll(markup, "button")
    .filter((b) => !/\bdisabled=""/i.test(b.attrs))
    .map((b) => ({ name: visibleText(b.inner) || attr(b.attrs, "aria-label") || "", attrs: b.attrs }));
}

// Confirmation controls for the "I've saved it" moment, as either implementation:
// a <button> labelled with its text, or a checkbox labelled by its <label for>.
// Each paired with the attribute string so the caller can check it is actionable.
function confirmControls(markup: string): { name: string; attrs: string }[] {
  const out: { name: string; attrs: string }[] = [];
  for (const b of findAll(markup, "button")) {
    out.push({ name: visibleText(b.inner) || attr(b.attrs, "aria-label") || "", attrs: b.attrs });
  }
  const labels = labelTextById(markup);
  for (const input of inputs(markup)) {
    if (input.type !== "checkbox") continue;
    const name = (input.id && labels[input.id]) || attr(input.attrs, "aria-label") || "";
    out.push({ name, attrs: input.attrs });
  }
  return out;
}

// --- the forbidden vocabulary (brief design_ux.copy; design §5) -------------

const JARGON: { label: string; re: RegExp }[] = [
  { label: "OAuth", re: /\boauth\b/i },
  { label: "MCP", re: /\bmcp\b/i },
  { label: "PRF", re: /\bprf\b/i },
  { label: "token", re: /\btokens?\b/i },
  { label: "WebAuthn", re: /\bwebauthn\b/i },
  { label: "FIDO", re: /\bfido\b/i },
  { label: "TOTP", re: /\btotp\b/i },
  { label: "HMAC", re: /\bhmac\b/i },
  { label: "OIDC", re: /\boidc\b/i },
  { label: "JWT", re: /\bjwt\b/i },
  { label: "SSRF", re: /\bssrf\b/i },
  { label: "DEK", re: /\bdek\b/i },
  { label: "KEK", re: /\bkek\b/i },
  { label: "cipher / ciphertext", re: /\bcipher(text)?\b/i },
  { label: "attestation", re: /\battestation\b/i },
  { label: "assertion", re: /\bassertion\b/i },
  { label: "encryption key", re: /\bencryption key\b/i },
  { label: "RP ID", re: /\brp id\b/i },
];

// Distinct sample recovery codes (grouped base32-style). Distinct values let the
// recovery-step tests prove the view renders the CODE IT WAS GIVEN, not a constant.
// Neither contains a "#" (so the hex-colour scan is unaffected) nor any jargon word.
const SIGNUP_CODE = "K7MQ-2P4R-9XTD-6WHF";
const RECOVER_CODE = "T3BN-5J8V-2QLR-7HMK";

// --- the full step machine of every view (exercised by the sweeps) ---------

type Rendered = { view: string; step: string; render: () => string };

const ALL: Rendered[] = [
  ...(["details", "code", "passkey", "recovery"] as const).map((step) => ({
    view: "SignupView",
    step,
    render: () => renderToStaticMarkup(<SignupView step={step} recoveryCode={SIGNUP_CODE} />),
  })),
  ...(["passkey", "code"] as const).map((step) => ({
    view: "SigninView",
    step,
    render: () => renderToStaticMarkup(<SigninView step={step} />),
  })),
  ...(["identify", "email-code", "recovery-code", "passkey", "new-recovery"] as const).map((step) => ({
    view: "RecoverView",
    step,
    render: () => renderToStaticMarkup(<RecoverView step={step} recoveryCode={RECOVER_CODE} />),
  })),
  ...(["code", "confirm"] as const).map((step) => ({
    view: "DeviceView",
    step,
    render: () => renderToStaticMarkup(<DeviceView step={step} />),
  })),
];

// ===========================================================================
// Universal invariants — hold for EVERY step of EVERY view.
// ===========================================================================

// Each step is a real screen: it renders some visible words, never a blank frame.
for (const { view, step, render } of ALL) {
  test(`${view} step "${step}" renders visible copy (not a blank screen)`, () => {
    const text = visibleText(render());
    assert.ok(
      text.length >= 8,
      `${view} step "${step}" must render real copy a person can read, got: "${text}"`,
    );
  });
}

// AC2 — no protocol or security jargon on any of these primary screens. Scoped to
// each view-step's OWN rendered face text, so the same word living elsewhere in the
// app (a set-up guide, the security FAQ) is irrelevant to this assertion.
for (const { view, step, render } of ALL) {
  test(`${view} step "${step}" contains no protocol or security jargon`, () => {
    const text = faceText(render());
    for (const { label, re } of JARGON) {
      assert.ok(
        !re.test(text),
        `${view} step "${step}" must say what happens in plain words — found jargon "${label}" in: "${text}"`,
      );
    }
  });
}

// AC1 — accessible labels: every text-like / checkbox input at every step carries a
// programmatic accessible label (a <label for>, aria-label or aria-labelledby).
for (const { view, step, render } of ALL) {
  test(`${view} step "${step}" gives every input an accessible label`, () => {
    const markup = render();
    const labels = labelTextById(markup);
    for (const input of inputs(markup)) {
      if (!LABELLABLE.has(input.type)) continue;
      assert.ok(
        inputIsLabelled(input, labels),
        `${view} step "${step}" has a ${input.type} input with no accessible label (needs a <label for>, aria-label or aria-labelledby): ${input.attrs}`,
      );
    }
  });
}

// Design system — colour comes from tokens, never a raw hex literal. The sample
// recovery codes carry no "#", so any hex in the output could only be hard-coded.
for (const { view, step, render } of ALL) {
  test(`${view} step "${step}" uses design tokens, never a raw hex colour`, () => {
    const markup = render();
    assert.ok(
      !/#[0-9a-fA-F]{3,8}\b/.test(markup),
      `no raw hex colour may appear in ${view} step "${step}", got: ${markup}`,
    );
  });
}

// ===========================================================================
// AC1 — the three named step-copy moments: code entry, passkey create,
// recovery-code save confirm.
// ===========================================================================

// --- code entry -------------------------------------------------------------

test("SignupView 'code' step is a code-entry screen with an accessibly-labelled input", () => {
  const markup = renderToStaticMarkup(<SignupView step="code" />);
  const text = visibleText(markup);
  assert.match(text, /\bcode\b/i, `the code-entry step must talk about the "code", got: "${text}"`);

  const labels = labelTextById(markup);
  const entry = inputs(markup).filter((i) => LABELLABLE.has(i.type) && i.type !== "checkbox");
  assert.ok(entry.length >= 1, `the code-entry step must render a field to type the code into, got: ${markup}`);
  for (const input of entry) {
    assert.ok(
      inputIsLabelled(input, labels),
      `the code field must have an accessible label, got input: ${input.attrs}`,
    );
  }
});

test("DeviceView 'code' step is a code-entry screen with an accessibly-labelled input", () => {
  const markup = renderToStaticMarkup(<DeviceView step="code" />);
  assert.match(visibleText(markup), /\bcode\b/i, "the device code step must talk about the code");
  const labels = labelTextById(markup);
  const entry = inputs(markup).filter((i) => LABELLABLE.has(i.type) && i.type !== "checkbox");
  assert.ok(entry.length >= 1, `the device code step must render a field to type the code into, got: ${markup}`);
  for (const input of entry) {
    assert.ok(inputIsLabelled(input, labels), `the code field must have an accessible label, got: ${input.attrs}`);
  }
});

// --- passkey create ---------------------------------------------------------

test("SignupView 'passkey' step says 'passkey' in plain copy with an actionable control", () => {
  const markup = renderToStaticMarkup(<SignupView step="passkey" />);
  assert.match(
    visibleText(markup),
    /\bpasskey\b/i,
    `the passkey step must use the plain word "passkey", got: "${visibleText(markup)}"`,
  );
  const buttons = actionableButtons(markup);
  assert.ok(
    buttons.some((b) => b.name.trim().length > 0),
    `the passkey step must offer an actionable, named control to create the passkey (no dead button), got: ${markup}`,
  );
});

test("SigninView 'passkey' step says 'passkey' in plain copy with an actionable control", () => {
  const markup = renderToStaticMarkup(<SigninView step="passkey" />);
  assert.match(
    visibleText(markup),
    /\bpasskey\b/i,
    `the sign-in passkey step must use the plain word "passkey", got: "${visibleText(markup)}"`,
  );
  assert.ok(
    actionableButtons(markup).some((b) => b.name.trim().length > 0),
    `the sign-in passkey step must offer an actionable, named control (no dead button), got: ${markup}`,
  );
});

// --- recovery-code save confirm --------------------------------------------

test("SignupView 'recovery' step shows the given recovery code and an 'I've saved it' confirm", () => {
  const markup = renderToStaticMarkup(<SignupView step="recovery" recoveryCode={SIGNUP_CODE} />);

  // The view renders the code IT WAS GIVEN (behaviour, not a hard-coded constant).
  assert.ok(
    visibleText(markup).includes(SIGNUP_CODE),
    `the recovery step must display the supplied recovery code, got: "${visibleText(markup)}"`,
  );

  // An explicit "saved" confirmation control (a button or a labelled checkbox),
  // and it is actionable — the person must affirm they saved it to continue.
  const confirm = confirmControls(markup).find((c) => /saved/i.test(c.name));
  assert.ok(
    confirm,
    `the recovery step must offer an explicit "I've saved it" confirmation control, got controls: ${JSON.stringify(
      confirmControls(markup).map((c) => c.name),
    )}`,
  );
  assert.ok(
    !/\bdisabled=""/i.test(confirm!.attrs),
    `the "I've saved it" control must be actionable (not natively disabled), got: ${confirm!.attrs}`,
  );
});

test("RecoverView 'new-recovery' step shows the new recovery code and an 'I've saved it' confirm", () => {
  const markup = renderToStaticMarkup(<RecoverView step="new-recovery" recoveryCode={RECOVER_CODE} />);
  assert.ok(
    visibleText(markup).includes(RECOVER_CODE),
    `the new-recovery step must display the supplied (replacement) recovery code, got: "${visibleText(markup)}"`,
  );
  const confirm = confirmControls(markup).find((c) => /saved/i.test(c.name));
  assert.ok(
    confirm,
    `the new-recovery step must offer an explicit "I've saved it" confirmation control, got controls: ${JSON.stringify(
      confirmControls(markup).map((c) => c.name),
    )}`,
  );
  assert.ok(
    !/\bdisabled=""/i.test(confirm!.attrs),
    `the "I've saved it" control must be actionable (not natively disabled), got: ${confirm!.attrs}`,
  );
});

// The recovery code is a SECRET shown once — it must never be pre-filled into an
// editable input (that would put it in a form value / the DOM as data); it is
// displayed as read-only text for the person to copy down.
test("SignupView 'recovery' step does not place the code in an editable input value", () => {
  const markup = renderToStaticMarkup(<SignupView step="recovery" recoveryCode={SIGNUP_CODE} />);
  const prefilled = inputs(markup).some((i) => (attr(i.attrs, "value") ?? "").includes(SIGNUP_CODE));
  assert.ok(
    !prefilled,
    `the one-time recovery code must be shown as read-only text, never as an editable input value, got: ${markup}`,
  );
});

// --- enter-your-recovery-code (the recovery flow's second factor) ----------

test("RecoverView 'recovery-code' step asks for the recovery code via a labelled input", () => {
  const markup = renderToStaticMarkup(<RecoverView step="recovery-code" />);
  assert.match(
    visibleText(markup),
    /recovery code/i,
    `the recovery-code step must ask for the "recovery code" in plain words, got: "${visibleText(markup)}"`,
  );
  const labels = labelTextById(markup);
  const entry = inputs(markup).filter((i) => LABELLABLE.has(i.type) && i.type !== "checkbox");
  assert.ok(entry.length >= 1, `the recovery-code step must render a field to type the recovery code into, got: ${markup}`);
  for (const input of entry) {
    assert.ok(inputIsLabelled(input, labels), `the recovery-code field must have an accessible label, got: ${input.attrs}`);
  }
});

// --- sign-up details (name + email) ----------------------------------------

test("SignupView 'details' step collects name and email via accessibly-labelled inputs", () => {
  const markup = renderToStaticMarkup(<SignupView step="details" />);
  const labels = labelTextById(markup);
  const entry = inputs(markup).filter((i) => LABELLABLE.has(i.type) && i.type !== "checkbox");
  assert.ok(
    entry.length >= 2,
    `the details step must collect at least name and email (two fields), got ${entry.length}: ${markup}`,
  );
  for (const input of entry) {
    assert.ok(inputIsLabelled(input, labels), `every details field must have an accessible label, got: ${input.attrs}`);
  }
  // The combined label text names both the person's name and their email.
  const labelBlob = Object.values(labels).join(" ").toLowerCase();
  assert.match(labelBlob, /name/i, `a field must be labelled for the person's name, got labels: "${labelBlob}"`);
  assert.match(labelBlob, /email/i, `a field must be labelled for the email, got labels: "${labelBlob}"`);
});
