// E18-S06 — Data-driven set-up checklist component (src/components/home/setup-checklist.tsx).
//
// RED-first: src/components/home/setup-checklist.tsx does NOT exist yet, so
// importing `./setup-checklist` throws and every test here fails until the
// builder adds the component. That absence is the whole point of test-first —
// do not implement anything to make these pass.
//
// WHY this component exists: the home dashboard needs the first-run set-up
// checklist to reflect real account state (brief design_ux "HOME — a set-up
// checklist"; the Home dashboard requirement). The five items, their labels and
// links, and the "done" rule all live in the ONE pure module
// `@/domain/home/checklist` (computeSetupChecklist, built/tested in E18-S03).
// This component is PURELY a renderer: it takes the already-computed items as a
// prop and draws each one. So the tests here build realistic props from the
// domain helper (the single source of the five labels/links) and pin only what
// THIS task adds — how the given items are RENDERED.
//
// These tests pin BEHAVIOUR — what the component RENDERS for the items it is
// given — never the source text of setup-checklist.tsx, so a later
// behaviour-preserving refactor (different wrapper elements, different icon,
// reworded-but-still-plain status copy, extra classes) stays green. We render
// with `react-dom/server` (no DOM/jsdom — React component / E2E testing is a
// per-job ADR) and read the emitted markup, exactly as status.test.tsx and
// portal-chrome.test.tsx do.
//
// The contract the builder implements (exactly this):
//
//   SetupChecklist({ items }): the data-driven first-run set-up checklist.
//     • items: ReadonlyArray<{ label: string; href: string; done: boolean }>
//       — the already-computed items (the SetupChecklistItem shape from
//       @/domain/home/checklist). The component renders EXACTLY the items it is
//       given, in order (it is data-driven — it does NOT hard-code the five).
//     • For each item it renders:
//         - the item's LABEL as visible text,
//         - a LINK (an <a href>) to the item's href that names the step, and
//         - a done / not-done STATE shown in WORDS plus an ICON (an <svg>),
//           never by colour alone (brief design_ux.feel + CLAUDE.md: "status
//           uses words + icons, never colour alone"). A done item reads as
//           complete (e.g. "Done"); a not-done item reads as still to do (e.g.
//           "To do" / "Not done"). The status words are rendered as text (so a
//           screen reader announces the state) ALONGSIDE the link — they are the
//           item's accessible completion state, not the link text.
//     • Colour comes from the design tokens (globals.css), never a raw hex.
//     • This component renders ONLY the given items (the list); any page heading
//       or progress summary is the caller's responsibility, not this task.
//
// The status COPY is not pinned to exact strings — the tests accept a broad
// family of plain-English completion / to-do wording and only require that the
// two states are distinguished BY WORDS (so the meaning is never carried by
// colour alone) and that a done item reads as complete.

import * as React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";

import { SetupChecklist } from "./setup-checklist";
import { computeSetupChecklist, type SetupChecklistItem } from "@/domain/home/checklist";

// --- fixtures: realistic props, built from the ONE source of the five items ---

// A freshly signed-up account: every signal absent → all five items not done.
const FRESH: SetupChecklistItem[] = computeSetupChecklist({});
// A mixed account: two done ("Get notified", "Add a card"), three not done.
const MIXED: SetupChecklistItem[] = computeSetupChecklist({
  notificationsEnabled: true,
  cardAdded: true,
});
// Everything done.
const ALL_DONE: SetupChecklistItem[] = computeSetupChecklist({
  notificationsEnabled: true,
  profileBuilt: true,
  cardAdded: true,
  serviceConnected: true,
  agentConnected: true,
});

// Preconditions on the fixtures (these exercise the already-green domain helper,
// but they document exactly what each scenario means for the tests below).
test("fixtures: FRESH is the five items all not done; MIXED has two done", () => {
  assert.equal(FRESH.length, 5, "a fresh account shows five set-up items");
  assert.equal(FRESH.filter((i) => i.done).length, 0, "a fresh account has nothing done");
  assert.equal(MIXED.length, 5, "MIXED is still the five items");
  assert.equal(MIXED.filter((i) => i.done).length, 2, "MIXED has exactly two items done");
  assert.equal(ALL_DONE.filter((i) => i.done).length, 5, "ALL_DONE has all five done");
});

// --- tiny markup helpers (no DOM), mirrored from the sibling component tests ---

function render(items: readonly SetupChecklistItem[]): string {
  return renderToStaticMarkup(<SetupChecklist items={items as SetupChecklistItem[]} />);
}

// Visible text with tags stripped: exactly the words a sighted reader sees (an
// <svg> icon contributes none). Decodes the entities that matter.
function strip(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function norm(html: string): string {
  return strip(html).toLowerCase();
}

// Read one double-quoted attribute off an element's attribute string.
function attr(attrs: string, name: string): string | null {
  const m = attrs.match(new RegExp(`\\b${name}="([^"]*)"`, "i"));
  return m ? m[1]! : null;
}

type Anchor = { href: string | null; text: string };

// Every <a> in the markup, with its href and visible text.
function anchors(markup: string): Anchor[] {
  const out: Anchor[] = [];
  for (const m of markup.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    out.push({ href: attr(m[1]!, "href"), text: strip(m[2]!) });
  }
  return out;
}

// The one anchor that links to a given href (href is the stable item identity).
function anchorFor(markup: string, href: string): Anchor {
  const hits = anchors(markup).filter((a) => a.href === href);
  assert.equal(hits.length, 1, `exactly one link to ${href} expected, got ${hits.length}`);
  return hits[0]!;
}

// --- the done / not-done STATE, read as words (never colour alone) ------------
//
// We count the state WORDS in the rendered text. A done item reads as complete;
// a not-done item reads as still-to-do. The regexes accept a broad family of
// plain-English wording (the exact copy is the builder's choice) and are chosen
// so that:
//   • none of the five item LABELS matches either regex (so labels never
//     contaminate the count — "Connect a service" etc. carry no state word), and
//   • "not done" / "not complete" / "not ready" count as NOT-done, never done
//     (the (?<!not ) look-behind + \b word boundaries keep "done" inside
//     "not done" and "complete" inside "incomplete" from counting as done).
const DONE_RE = /(?<!not )\b(?:done|complete|completed|finished|ready|sorted)\b/gi;
const NOTDONE_RE =
  /\b(?:not done|not complete|not finished|to-?do|to do|incomplete|unfinished|not ready|not yet|pending|outstanding)\b/gi;

// Tally the done / not-done states shown across the whole render.
function tally(items: readonly SetupChecklistItem[]): { done: number; notDone: number } {
  const text = norm(render(items));
  return {
    done: (text.match(DONE_RE) ?? []).length,
    notDone: (text.match(NOTDONE_RE) ?? []).length,
  };
}

// === AC1 / AC2 — every given item renders its label and its link =============

test("renders every given item's label as visible text (fresh account, all five)", () => {
  const text = norm(render(FRESH));
  for (const item of FRESH) {
    assert.ok(
      text.includes(norm(item.label)),
      `the checklist must show the label "${item.label}", got: "${text}"`,
    );
  }
});

test("renders a link to each given item's href that names the step (fresh account)", () => {
  const markup = render(FRESH);
  for (const item of FRESH) {
    const a = anchorFor(markup, item.href);
    assert.ok(
      norm(a.text).includes(norm(item.label)),
      `the link to ${item.href} must name the step "${item.label}", got "${a.text}"`,
    );
  }
});

test("mixed account still renders every item's label and link", () => {
  const markup = render(MIXED);
  const text = norm(markup);
  for (const item of MIXED) {
    assert.ok(text.includes(norm(item.label)), `mixed render must show "${item.label}"`);
    const a = anchorFor(markup, item.href);
    assert.ok(
      norm(a.text).includes(norm(item.label)),
      `mixed render must link ${item.href} and name it "${item.label}"`,
    );
  }
});

// === AC1 — each item shows its state in WORDS and an ICON, never colour alone ==

test("a done item and a not-done item differ in WORDS, not colour alone", () => {
  // Same item, same label and link — only `done` differs. If the state were
  // carried by colour/class alone, the visible TEXT would be identical.
  const sample = { label: "About you", href: "/vault" };
  const doneText = norm(render([{ ...sample, done: true }]));
  const notText = norm(render([{ ...sample, done: false }]));

  assert.ok(doneText.includes("about you"), "the done item still shows its label");
  assert.ok(notText.includes("about you"), "the not-done item still shows its label");
  assert.notEqual(
    doneText,
    notText,
    "a done vs not-done item must differ in the visible WORDS (state is never colour alone)",
  );

  // Beyond the shared label there must be actual state WORDS on each side.
  const doneState = doneText.split("about you").join(" ").replace(/\s+/g, " ").trim();
  const notState = notText.split("about you").join(" ").replace(/\s+/g, " ").trim();
  assert.ok(doneState.length > 0, "a done item must show its state in words, got no extra text");
  assert.ok(notState.length > 0, "a not-done item must show its state in words, got no extra text");
  assert.notEqual(doneState, notState, "the done and not-done state words must differ");
});

test("each state renders an icon (an <svg>) alongside its words", () => {
  const sample = { label: "About you", href: "/vault" };
  for (const done of [true, false]) {
    const markup = render([{ ...sample, done }]);
    assert.match(
      markup,
      /<svg[\s>]/,
      `a ${done ? "done" : "not-done"} item must render an icon (an <svg>), got: ${markup}`,
    );
    // ...and still carry readable words (words + icon, never colour/icon alone).
    assert.ok(
      strip(markup).length > 0,
      `a ${done ? "done" : "not-done"} item must render readable text, got: "${strip(markup)}"`,
    );
  }
});

test("the checklist uses design tokens, never a raw hex colour", () => {
  for (const items of [FRESH, MIXED, ALL_DONE]) {
    const markup = render(items);
    assert.ok(
      !/#[0-9a-fA-F]{3,8}\b/.test(markup),
      `no raw hex colour may appear in the checklist markup, got: ${markup}`,
    );
  }
});

// === AC2 — a fresh account renders all five as NOT done =======================

test("a freshly signed-up account renders all five items as not done (and none done)", () => {
  const t = tally(FRESH);
  assert.equal(t.done, 0, `a fresh account shows nothing complete, got ${t.done} done marker(s)`);
  assert.equal(
    t.notDone,
    5,
    `a fresh account shows all five items as not done, got ${t.notDone} not-done marker(s)`,
  );
});

// === AC1 — done items are marked complete; the state tracks each item's flag ===

test("a mixed account marks exactly the done items complete and the rest not done", () => {
  const t = tally(MIXED);
  assert.equal(t.done, 2, `MIXED must mark its two done items complete, got ${t.done}`);
  assert.equal(t.notDone, 3, `MIXED must mark its three remaining items not done, got ${t.notDone}`);
});

test("an all-done account marks all five complete (and none not done)", () => {
  const t = tally(ALL_DONE);
  assert.equal(t.done, 5, `all items done must show five complete, got ${t.done}`);
  assert.equal(t.notDone, 0, `all items done must show nothing not done, got ${t.notDone}`);
});

test("the completion state follows each item's own `done` flag (one item done at a time)", () => {
  // Flip exactly one item to done; the render must show one complete, four not.
  FRESH.forEach((_, k) => {
    const items = FRESH.map((it, i) => ({ ...it, done: i === k }));
    const t = tally(items);
    assert.equal(
      t.done,
      1,
      `with only item ${k} ("${FRESH[k]!.label}") done, exactly one item is complete, got ${t.done}`,
    );
    assert.equal(
      t.notDone,
      4,
      `with only item ${k} ("${FRESH[k]!.label}") done, the other four are not done, got ${t.notDone}`,
    );
  });
});

// === data-driven — the component renders the items it is GIVEN, not a fixed five

test("renders arbitrary given items (label, link and state), not a hard-coded five", () => {
  const custom: SetupChecklistItem[] = [
    { label: "Alpha step", href: "/alpha", done: true },
    { label: "Beta step", href: "/beta", done: false },
  ];
  const markup = render(custom);
  const text = norm(markup);

  assert.ok(text.includes("alpha step"), "a given custom item's label must render");
  assert.ok(text.includes("beta step"), "a given custom item's label must render");
  assert.equal(anchors(markup).filter((a) => a.href === "/alpha").length, 1, "links /alpha once");
  assert.equal(anchors(markup).filter((a) => a.href === "/beta").length, 1, "links /beta once");

  const t = tally(custom);
  assert.equal(t.done, 1, `the one done custom item must read complete, got ${t.done}`);
  assert.equal(t.notDone, 1, `the one not-done custom item must read not done, got ${t.notDone}`);
});

// docs/adr/profile-build.md: "Build your profile" says what waits for the person, in words.
test("an item's note shows beside it, in muted words", async () => {
  const { computeSetupChecklist } = await import("@/domain/home/checklist");
  const markup = renderToStaticMarkup(<SetupChecklist items={computeSetupChecklist({ profileWaiting: 3 })} />);
  assert.match(markup, />Build your profile<\/span><span class="text-sm text-fg-muted">3 waiting for you to check<\/span>/);
});
