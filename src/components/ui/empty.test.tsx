// E02-S04 — Empty state (src/components/ui/empty.tsx).
//
// RED-first: src/components/ui/empty.tsx does NOT exist yet, so importing
// `./empty` throws and every test here fails until the builder adds the
// component. That absence is the entire point of test-first — do not implement
// anything to make these pass.
//
// These tests pin BEHAVIOUR — what the component RENDERS — never the source text
// of empty.tsx, so a later behaviour-preserving refactor (different wrapper,
// different heading level, reworded internal copy) stays green. We render with
// `react-dom/server` (no DOM/jsdom — React component / E2E testing is a per-job
// ADR) and read the emitted markup.
//
// The contract the builder implements (exactly this):
//
//   EmptyState({ heading, description, action? }): a centred empty-state panel
//   for list screens with nothing to show yet.
//     • heading → rendered inside a HEADING element (an <h1>–<h6>, or any element
//       with role="heading") so a screen reader can jump to it.
//     • description → rendered as descriptive text (the words a reader sees).
//     • action? → an OPTIONAL action control (e.g. a <Button>). When given it is
//       rendered; when omitted nothing extra is rendered (no dead control).
//     • Uses the design tokens (globals.css), never a raw hex colour.
//
import * as React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";

import { EmptyState } from "./empty";

function render(node: React.ReactElement): string {
  return renderToStaticMarkup(node);
}

// The visible text of the markup with tags stripped — exactly the words a reader
// sees (an <svg>/icon contributes no text).
function stripTags(markup: string): string {
  return markup.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

// The inner text of the FIRST heading in the markup: an <h1>–<h6> element, or any
// element carrying role="heading". Returns null when there is no heading at all.
function headingText(markup: string): string | null {
  const byTag = markup.match(/<(h[1-6])\b[^>]*>([\s\S]*?)<\/\1>/i);
  if (byTag) return stripTags(byTag[2]);
  const byRole = markup.match(/<([\w-]+)\b[^>]*\brole="heading"[^>]*>([\s\S]*?)<\/\1>/i);
  if (byRole) return stripTags(byRole[2]);
  return null;
}

// Distinct, unambiguous copy per slot so each assertion isolates one slot.
const HEADING = "No agents yet";
const DESCRIPTION = "Connect your first agent to get started.";
const ACTION_LABEL = "Connect an agent";

// AC — the heading is rendered inside a real heading element (screen-reader
// navigable), carrying the heading text.
test("EmptyState renders its heading inside a heading element", () => {
  const markup = render(<EmptyState heading={HEADING} description={DESCRIPTION} />);
  const heading = headingText(markup);
  assert.ok(
    heading !== null,
    `EmptyState must render a heading element (<h1>-<h6> or role="heading"), got: ${markup}`,
  );
  assert.ok(
    heading!.includes(HEADING),
    `the heading element must carry the heading text, got: "${heading}"`,
  );
});

// AC — the description is rendered as text.
test("EmptyState renders its description text", () => {
  const markup = render(<EmptyState heading={HEADING} description={DESCRIPTION} />);
  assert.ok(
    stripTags(markup).includes(DESCRIPTION),
    `the description text must be rendered, got: "${stripTags(markup)}"`,
  );
});

// AC — the OPTIONAL action control is rendered when given.
test("EmptyState renders an action control when one is given", () => {
  const markup = render(
    <EmptyState
      heading={HEADING}
      description={DESCRIPTION}
      action={<button type="button">{ACTION_LABEL}</button>}
    />,
  );
  assert.match(markup, /<button[\s>]/, "the passed action control is rendered");
  assert.ok(
    stripTags(markup).includes(ACTION_LABEL),
    `the action control's content must be rendered, got: "${stripTags(markup)}"`,
  );
});

// AC — the action is OPTIONAL: with no `action` prop the action's own copy must
// not appear. Scoped to the action's unique label (which only an action node
// could contribute — the heading and description never contain it), not to a
// whole-output absence check.
test("EmptyState renders no action control when none is given", () => {
  const markup = render(<EmptyState heading={HEADING} description={DESCRIPTION} />);
  assert.ok(
    !stripTags(markup).includes(ACTION_LABEL),
    `with no action prop, the action label "${ACTION_LABEL}" must not appear, got: "${stripTags(markup)}"`,
  );
});

// Design system — colour comes from tokens, never a raw hex literal. The caller
// text carries no `#`, so any hex in the output could only be a hard-coded colour.
test("EmptyState uses design tokens, never a raw hex colour", () => {
  const markup = render(<EmptyState heading={HEADING} description={DESCRIPTION} />);
  assert.ok(
    !/#[0-9a-fA-F]{3,8}\b/.test(markup),
    `no raw hex colour may appear in the EmptyState markup, got: ${markup}`,
  );
});
