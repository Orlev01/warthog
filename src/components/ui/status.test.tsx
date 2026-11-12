// E02-S03 — Status / badge component (src/components/ui/status.tsx).
//
// RED-first: src/components/ui/status.tsx does NOT exist yet, so importing
// `./status` throws and every test here fails until the builder adds the
// component. That absence is the entire point of test-first — do not implement
// anything to make these pass.
//
// These tests pin BEHAVIOUR — what the component RENDERS: that a status is shown
// with WORDS and an ICON (never colour alone, per brief design_ux.feel: "status
// shown with words and icons not colour alone"), and that the four connection
// statuses map to DISTINCT, readable accessible labels. They never read the
// source text of status.tsx, so a later behaviour-preserving refactor (different
// icon, reworded copy that stays distinct, a wrapping element) must keep them
// green except where a specific documented word is required. We render with
// `react-dom/server` (no DOM/jsdom — React component / E2E testing is a per-job
// ADR) and read the emitted markup.
//
// The contract the builder implements (exactly this):
//
//   Status({ status }): a labelled status indicator.
//     • status: "connected" | "needs-reconnect" | "error" | "pending"
//     • Renders BOTH an icon (an <svg> — e.g. a lucide-react glyph) AND a visible
//       text label. The meaning is carried by the words, never by colour alone.
//     • The icon is decorative (marked aria-hidden) so a screen reader announces
//       the words, not a mystery graphic — the accessible name is the label text.
//     • Each of the four statuses produces a DISTINCT accessible label. The
//       needs-reconnect status uses Warthog's documented copy "Reconnect needed".
//     • Uses the design tokens (globals.css), never a raw hex colour.
//
import * as React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";

import { Status } from "./status";

// The connection statuses this component must cover (brief: a connected service
// shows "connected / needs reconnecting / error"; approvals add pending; an agent the
// person disconnected is "disconnected" — a final state, not one to reconnect from).
type StatusKey = "connected" | "needs-reconnect" | "disconnected" | "error" | "pending";
const STATUSES: StatusKey[] = ["connected", "needs-reconnect", "disconnected", "error", "pending"];

// A word each status's label must contain. Kept to the obvious stem so a reworded
// label stays green as long as it still names the state — the exact phrasing is
// not pinned here (except the documented "Reconnect needed", asserted separately).
const EXPECTED_WORD: Record<StatusKey, RegExp> = {
  connected: /connected/i,
  "needs-reconnect": /reconnect/i,
  disconnected: /disconnected/i,
  error: /error/i,
  pending: /pending/i,
};

function render(status: StatusKey): string {
  return renderToStaticMarkup(<Status status={status} />);
}

// The visible text of the rendered markup, tags stripped. A lucide/<svg> icon
// contributes no text, so for a text-labelled badge this is exactly the words a
// sighted user reads and (with a decorative icon) the status's accessible name.
function labelText(markup: string): string {
  return markup.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
}

// AC1 — a status renders both an icon and a text label (never colour alone).
test("every status renders an icon (an <svg>) and a readable text label", () => {
  for (const status of STATUSES) {
    const markup = render(status);
    assert.match(
      markup,
      /<svg[\s>]/,
      `the ${status} status must render an icon (an <svg>), got: ${markup}`,
    );
    assert.ok(
      labelText(markup).length > 0,
      `the ${status} status must render a text label (words, not colour alone), got: "${labelText(markup)}"`,
    );
    // The meaning is in the words: the label names the state.
    assert.match(
      labelText(markup),
      EXPECTED_WORD[status],
      `the ${status} status label must name the state (expected ${EXPECTED_WORD[status]}), got: "${labelText(markup)}"`,
    );
  }
});

// AC2 — connected, needs-reconnect, disconnected, error and pending map to DISTINCT labels.
test("every status maps to a distinct accessible label", () => {
  const labels = STATUSES.map((status) => labelText(render(status)));
  for (const [i, label] of labels.entries()) {
    assert.ok(label.length > 0, `the ${STATUSES[i]} status has a non-empty label`);
  }
  assert.equal(
    new Set(labels).size,
    STATUSES.length,
    `each status must have a distinct label, got: ${JSON.stringify(labels)}`,
  );
});

// AC2 — the needs-reconnect status uses Warthog's documented copy.
test("needs-reconnect uses the documented copy \"Reconnect needed\"", () => {
  // CLAUDE.md vocabulary + brief: the UI copy for this state is "Reconnect needed".
  assert.match(
    labelText(render("needs-reconnect")),
    /reconnect needed/i,
    "the needs-reconnect label must read \"Reconnect needed\"",
  );
});

// A disconnected agent is NOT one that needs reconnecting: "Connect it again" makes a new
// connection, so the word is "Disconnected", with its own icon and a neutral tone — never
// the warning colour that asks for action, nor the success/danger tones.
test("disconnected reads \"Disconnected\" in a neutral tone with its own icon", () => {
  const markup = render("disconnected");
  assert.equal(labelText(markup), "Disconnected");
  assert.doesNotMatch(labelText(markup), /reconnect/i, "a disconnected agent is not told to reconnect");
  assert.match(markup, /text-fg-muted/, "a neutral tone");
  assert.doesNotMatch(markup, /text-(warning|danger|success)\b/, "never an alarm, error or success colour");
  const icon = (status: StatusKey) => /<svg[^>]*class="([^"]*)"/.exec(render(status))?.[1] ?? "";
  for (const other of STATUSES.filter((status) => status !== "disconnected")) {
    assert.notEqual(icon("disconnected"), icon(other), `disconnected has its own icon, not ${other}'s`);
  }
});

// Accessibility — the icon is decorative, so the status's accessible name comes
// from the words (reinforces "never colour/icon alone"). The attribute may sit on
// the <svg> or a wrapper; we only require a decorative icon to be present.
test("the status icon is decorative (aria-hidden) so the label carries the meaning", () => {
  for (const status of STATUSES) {
    const markup = render(status);
    assert.match(
      markup,
      /aria-hidden="true"/,
      `the ${status} status's icon must be marked decorative (aria-hidden="true"), got: ${markup}`,
    );
  }
});

// Design system — colour comes from tokens, never a raw hex literal. The caller
// passes no "#", so any hex in the output could only be a hard-coded colour.
test("a status uses design tokens, never a raw hex colour", () => {
  for (const status of STATUSES) {
    const markup = render(status);
    assert.ok(
      !/#[0-9a-fA-F]{3,8}\b/.test(markup),
      `no raw hex colour may appear in the ${status} status markup, got: ${markup}`,
    );
  }
});
