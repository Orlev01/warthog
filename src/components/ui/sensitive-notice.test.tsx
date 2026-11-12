// E02-S06 — Sensitive-moment explainer (src/components/ui/sensitive-notice.tsx).
//
// RED-first: src/components/ui/sensitive-notice.tsx does NOT exist yet, so
// importing `./sensitive-notice` throws and every test here fails until the
// builder adds the component. That absence is the entire point of test-first — do
// not implement anything to make these pass.
//
// Why this component exists (brief design_ux.feel): "Sensitive moments (adding a
// passport or card, approving a payment) slow down slightly with a short, plain
// explanation of what will happen." So before a sensitive action continues, the
// person sees a short plain explanation AND must hit an explicit confirm control.
//
// These tests pin BEHAVIOUR — what the component RENDERS: that it shows a plain
// one-or-two-sentence explanation alongside an explicit, actionable confirm
// control (never a dead control), and that its DEFAULT copy carries no security
// or protocol jargon (brief design_ux.copy: no "OAuth", "MCP", "token", "PRF",
// "encryption key" on primary screens). They never read the source text of
// sensitive-notice.tsx, so a later behaviour-preserving refactor (different
// wrapper, reworded-but-still-plain copy, composing the Button primitive) stays
// green. We render with `react-dom/server` (no DOM/jsdom — React component / E2E
// click-dispatch testing is a per-job ADR) and read the emitted markup; the
// `onConfirm` handler prop is pinned by being passed here (the typecheck gate
// `tsc --noEmit` then forces the component to declare and accept it).
//
// The contract the builder implements (exactly this):
//
//   SensitiveNotice(props): a slow-down panel for a sensitive moment.
//     • explanation?: string
//         - A plain one or two sentence explanation of what will happen. Rendered
//           as visible body text. When omitted, a sensible DEFAULT plain
//           explanation is shown (the default copy carries no jargon).
//     • onConfirm?: () => void
//         - Called when the person activates the confirm control. Passed here so
//           the prop is type-checked into existence; wiring it is the "no dead
//           controls" convention.
//     • Renders BOTH the explanation AND an explicit confirm control — a native
//       <button>, actionable (no native `disabled`), labelled as a confirm — so
//       continuing requires the person's explicit action.
//     • Built on the design tokens (globals.css); never a raw hex colour.
//
import * as React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";

import { SensitiveNotice } from "./sensitive-notice";

// A no-op confirm handler. Passing it in every render pins `onConfirm` as an
// accepted prop under the typecheck gate without needing a DOM to dispatch it.
const noop = () => {};

// The visible text of the rendered markup, tags stripped — exactly the words a
// sighted person reads (an <svg> icon contributes none). Used for the whole-copy
// jargon scan.
function visibleText(markup: string): string {
  return markup
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// The visible text OUTSIDE any <button> — i.e. the explanation region. Scoping the
// sentence-count check here keeps the confirm control's own label (which carries
// no sentence-ending punctuation) from skewing the count.
function explanationText(markup: string): string {
  return visibleText(markup.replace(/<button\b[^>]*>[\s\S]*?<\/button>/gi, " "));
}

// The inner (stripped) text of every <button> rendered — one per button element.
function buttonTexts(markup: string): string[] {
  const out: string[] = [];
  const re = /<button\b[^>]*>([\s\S]*?)<\/button>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(markup)) !== null) {
    out.push(
      m[1]
        .replace(/<[^>]*>/g, " ")
        .replace(/\s+/g, " ")
        .trim(),
    );
  }
  return out;
}

// The OPENING tag of every <button> (used to read its attributes, e.g. disabled).
function buttonOpenTags(markup: string): string[] {
  return markup.match(/<button\b[^>]*>/gi) ?? [];
}

// A confirm-type label, left deliberately permissive so the builder picks plain
// Australian wording ("Confirm", "Continue", "Yes, add it", "I understand", …) —
// a back-out control ("Cancel", "Not now", "Go back") matches none of these.
const CONFIRM_LABEL = /\b(confirm|continue|got it|understand|proceed|yes|add|approve|ok(ay)?)\b/i;

// AC1 — a sensitive moment slows down: a plain explanation is shown TOGETHER with
// an explicit confirm control (a native <button>).
test("renders a plain explanation together with an explicit confirm control", () => {
  const markup = renderToStaticMarkup(<SensitiveNotice onConfirm={noop} />);

  assert.ok(
    explanationText(markup).length > 0,
    `the default render must show a plain explanation (visible words), got markup: ${markup}`,
  );
  assert.match(
    markup,
    /<button[\s>]/i,
    `the sensitive moment must present an explicit confirm control (a native <button>), got: ${markup}`,
  );
});

// AC1 — the explanation is SHORT: one or two plain sentences (the slow-down is a
// brief pause, not a wall of text).
test("the default explanation is one or two plain sentences", () => {
  const text = explanationText(renderToStaticMarkup(<SensitiveNotice onConfirm={noop} />));

  assert.ok(text.length >= 10, `the default explanation must be a real sentence, got: "${text}"`);

  const sentences = text.match(/[.!?]+(?=\s|$)/g) ?? [];
  assert.ok(
    sentences.length >= 1 && sentences.length <= 2,
    `the default explanation must be ONE or TWO sentences (found ${sentences.length} sentence-ending marks), got: "${text}"`,
  );
});

// AC1 — the panel is reusable across sensitive moments: a caller-supplied
// explanation (the passport / card / payment copy) is rendered as visible text.
test("renders a caller-supplied explanation verbatim", () => {
  const explanation = "Adding your passport. Agents only ever see it when you approve.";
  const markup = renderToStaticMarkup(
    <SensitiveNotice explanation={explanation} onConfirm={noop} />,
  );

  assert.ok(
    visibleText(markup).includes(explanation),
    `the caller-supplied explanation must be rendered, got: "${visibleText(markup)}"`,
  );
});

// AC1 — the confirm control is an actionable native <button> labelled as a
// confirm: the person must explicitly act to continue, and the control is not a
// dead one (not disabled by default).
test("the confirm control is an actionable, confirm-labelled native button", () => {
  const markup = renderToStaticMarkup(<SensitiveNotice onConfirm={noop} />);

  const labels = buttonTexts(markup);
  assert.ok(labels.length >= 1, `a confirm control (a <button>) must be rendered, got: ${markup}`);

  const confirmIndex = labels.findIndex((label) => CONFIRM_LABEL.test(label));
  assert.ok(
    confirmIndex !== -1,
    `one button must be labelled as an explicit confirm (e.g. "Confirm" / "Continue"), got labels: ${JSON.stringify(labels)}`,
  );

  // React renders a true boolean `disabled` prop as `disabled=""`; this matches
  // the ATTRIBUTE, never a Tailwind `disabled:` class, so it proves the confirm
  // control is genuinely actionable rather than a dead button.
  const confirmTag = buttonOpenTags(markup)[confirmIndex] ?? "";
  assert.ok(
    !confirmTag.includes('disabled=""'),
    `the confirm control must be actionable (no native disabled attribute), got: ${confirmTag}`,
  );
});

// AC2 — the DEFAULT copy (explanation + confirm label) contains NO security or
// protocol jargon (brief design_ux.copy). Scoped to this component's own rendered
// default text, so the same word appearing elsewhere in the app is irrelevant.
const JARGON: { label: string; re: RegExp }[] = [
  { label: "OAuth", re: /\boauth\b/i },
  { label: "MCP", re: /\bmcp\b/i },
  { label: "PRF", re: /\bprf\b/i },
  { label: "token", re: /\btokens?\b/i },
  { label: "encryption key", re: /\bencryption key\b/i },
  { label: "cipher / ciphertext", re: /\bcipher(text)?\b/i },
  { label: "DEK", re: /\bdek\b/i },
  { label: "KEK", re: /\bkek\b/i },
  { label: "HMAC", re: /\bhmac\b/i },
  { label: "OIDC", re: /\boidc\b/i },
  { label: "SSRF", re: /\bssrf\b/i },
  { label: "JWT", re: /\bjwt\b/i },
];

test("the default copy contains no security or protocol jargon", () => {
  const text = visibleText(renderToStaticMarkup(<SensitiveNotice onConfirm={noop} />));

  for (const { label, re } of JARGON) {
    assert.ok(
      !re.test(text),
      `the default copy must say what happens in plain words — found jargon "${label}" in: "${text}"`,
    );
  }
});

// Design system — colour comes from tokens, never a raw hex literal. The caller
// passes no "#", so any hex in the output could only be a hard-coded colour.
test("the panel uses design tokens, never a raw hex colour", () => {
  const markup = renderToStaticMarkup(<SensitiveNotice onConfirm={noop} />);
  assert.ok(
    !/#[0-9a-fA-F]{3,8}\b/.test(markup),
    `no raw hex colour may appear in the sensitive-notice markup, got: ${markup}`,
  );
});

// ─── UI/UX pass: a pending confirm keeps focus and ignores repeat taps ────────────────

test("while the confirmed step runs the control says so, stays focusable and ignores taps", () => {
  let calls = 0;
  const markup = renderToStaticMarkup(<SensitiveNotice pending pendingLabel="Saving card…" onConfirm={() => { calls++; }} />);
  assert.match(markup, /aria-busy="true"/);
  assert.match(markup, /aria-disabled="true"/);
  assert.match(markup, />Saving card…<\/button>/);
  assert.doesNotMatch(markup, /\sdisabled=""/);
  assert.equal(calls, 0);
});
