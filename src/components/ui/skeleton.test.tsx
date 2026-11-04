// E02-S04 — Loading skeleton (src/components/ui/skeleton.tsx).
//
// RED-first: src/components/ui/skeleton.tsx does NOT exist yet, so importing
// `./skeleton` throws and every test here fails until the builder adds the
// component. That absence is the entire point of test-first — do not implement
// anything to make these pass.
//
// These tests pin BEHAVIOUR — what the component RENDERS and how it announces
// loading to assistive tech — never the source text of skeleton.tsx. A later
// behaviour-preserving refactor (different wrapper element, different shimmer
// classes) stays green. We render with `react-dom/server` (no DOM/jsdom — React
// component / E2E testing is a per-job ADR) and read the emitted markup.
//
// The contract the builder implements (exactly this):
//
//   Skeleton(props): a placeholder shimmer block shown while content loads.
//     • Renders an element.
//     • Exposes a screen-reader loading affordance: EITHER aria-busy="true" OR
//       role="status" (brief WCAG 2.2 AA — a loading state must be perceivable to
//       assistive tech, not colour/animation alone). Either satisfies the AC.
//     • Uses the design tokens (globals.css), never a raw hex colour.
//
import * as React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";

import { Skeleton } from "./skeleton";

test("Skeleton renders an element", () => {
  const markup = renderToStaticMarkup(<Skeleton />);
  assert.match(markup, /^<[a-z]/i, `Skeleton must render an element, got: ${markup}`);
});

// AC — Skeleton exposes a screen-reader affordance: aria-busy OR role=status.
// Either is accepted; the builder picks one.
test("Skeleton exposes a screen-reader loading affordance (aria-busy or role=status)", () => {
  const markup = renderToStaticMarkup(<Skeleton />);
  const hasAriaBusy = /\baria-busy="true"/.test(markup);
  const hasStatusRole = /\brole="status"/.test(markup);
  assert.ok(
    hasAriaBusy || hasStatusRole,
    `Skeleton must expose aria-busy="true" or role="status" for screen readers, got: ${markup}`,
  );
});

// Design system — colour comes from tokens, never a raw hex literal. There is no
// caller input here, so any hex in the output could only be a hard-coded colour.
test("Skeleton uses design tokens, never a raw hex colour", () => {
  const markup = renderToStaticMarkup(<Skeleton />);
  assert.ok(
    !/#[0-9a-fA-F]{3,8}\b/.test(markup),
    `no raw hex colour may appear in the Skeleton markup, got: ${markup}`,
  );
});
