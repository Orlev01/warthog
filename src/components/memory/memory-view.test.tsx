// E13-S10 — Memory view component (src/components/memory/memory-view.tsx).
//
// RED-first: src/components/memory/memory-view.tsx does NOT exist yet, so importing
// `./memory-view` throws and every test here fails until the builder adds the
// component. That absence is the entire point of test-first — do NOT implement
// anything to make these pass.
//
// WHY this component exists (brief "Skills, preferences and shared memory"; design
// §4.1; journey: "MEMORY — the moving memory shows 'Saved by Claude · shared'"): the
// Memory screen lists every memory the person holds, each a short fact or note with the
// SOURCE AGENT that saved it, the TIME it was saved and its SHARING STATE — either KEPT
// to the agent that saved it or SHARED with the person's other permitted agents. A
// memory the PERSON added themselves has no source agent and is labelled as saved by
// the person. The person can SEARCH the memories and, on each, EDIT its content,
// RE-SCOPE it (kept ⇄ shared), DELETE it, and ADD THEIR OWN.
//
// This is the render-testable, prop-driven VIEW (a Client Component in the app). The
// real persistence/apply plumbing (searching, editing, re-scoping, deleting, adding a
// memory) lives in the server composition root and a sibling actions module wired by a
// LATER task (E13-S11); THIS component renders the screen from the props the Memory
// page read (E13-S09 `memoriesPageData` / `searchMemories`) hands it, with the source
// agent resolved to a DISPLAY NAME and the saved time pre-formatted to a LABEL by that
// loader — exactly the precedent the sibling skills / agent-list / rules / identity /
// connectors views set (pre-formatted labels in, no clock/DB/session in the view).
//
// These tests pin BEHAVIOUR — what the component RENDERS for the props it is given (the
// content, the saved-at time and the "Saved by <agent> · shared / · kept" label of each
// memory, the search box, and the live edit / re-scope / delete / add-own controls) —
// never the source text of memory-view.tsx. A later behaviour-preserving refactor
// (different wrapper elements, reworded-but-still-plain copy, a <select> instead of a
// toggle button, extra classes, a different icon) stays green. We render with
// `react-dom/server` (no DOM/jsdom — React component / E2E testing is a per-job ADR)
// and read the emitted markup, exactly as the sibling component tests do. Colour comes
// from the design tokens (globals.css) — never a raw hex.
//
// ---------------------------------------------------------------------------
// THE CONTRACT the builder implements (test-first spec; the component conforms):
//
//   MemoryView({ memories }):
//     • memories — ALL of the person's memories, each the shape the Memory page read
//                  (E13-S09 MemoryPageItem) hands back AFTER the loader resolves the
//                  source agent id to a display name and formats the saved time:
//                    { id, content, savedAt, sourceAgentName, scope }
//                  where `savedAt` is the pre-formatted time label, `sourceAgentName` is
//                  the saving agent's display name (NULL when the PERSON added it) and
//                  `scope` is "kept" | "shared". Each renders showing its content, its
//                  saved-at time and a "Saved by <agent> · shared / · kept" label (a
//                  person-added memory labelled as saved by the person), with live edit,
//                  re-scope and delete controls. A search box filters the list and a
//                  top-level add-own control adds a new memory.
//
// Behaviours asserted below:
//   - every memory renders with its content and its saved-at time.
//   - an agent-sourced memory is labelled "Saved by <that agent>" with its scope
//     (shared / kept); a person-added memory is labelled as saved by the person.
//   - each memory is attributed to its OWN source agent (not another's).
//   - the screen offers a search box.
//   - each memory offers live edit (pre-filled with its content), re-scope and delete
//     controls; the screen offers a live add-own control (even with no memories).
//   - design tokens only — no raw hex colour anywhere.

import * as React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";

import { MemoryView } from "./memory-view";

// --- the prop shapes this task renders (declared locally so this client VIEW never
// couples to the server db modules; they mirror E13-S09 MemoryPageItem AFTER the
// loader resolves the agent name and formats the saved time) ------------------------

type MemoryScope = "kept" | "shared";

type MemoryViewItem = {
  id: string;
  content: string;
  savedAt: string; // pre-formatted "saved at" label the loader produced
  sourceAgentName: string | null; // the saving agent's display name; null when the PERSON added it
  scope: MemoryScope;
};

type MemoryViewProps = {
  memories: ReadonlyArray<MemoryViewItem>;
};

// --- fixtures -----------------------------------------------------------------------
//
// Distinctive, recognisable values so every "renders this value" assertion is honest —
// the string can only have come from the memory under test. Contents deliberately avoid
// the scope / saver / control vocabulary the tests match on ("shared"/"kept",
// "saved by", "edit"/"delete"/"add"/"search"/"scope"), so a label/control assertion can
// never pass on an incidental word in a memory's content. Agent display names are
// distinctive brand strings (Claude / ChatGPT) that appear nowhere else.

// An agent-sourced memory, SHARED — the journey's "Saved by Claude · shared".
const MEM_CLAUDE_SHARED: MemoryViewItem = {
  id: "mem-moving",
  content: "Moving on 1 Dec to the new house by the river",
  savedAt: "2 Dec 2026, 9:14 am",
  sourceAgentName: "Claude",
  scope: "shared",
};

// An agent-sourced memory, KEPT to the agent that saved it.
const MEM_CHATGPT_KEPT: MemoryViewItem = {
  id: "mem-coffee",
  content: "Prefers an oat flat white, no sugar",
  savedAt: "14 Nov 2026, 7:02 am",
  sourceAgentName: "ChatGPT",
  scope: "kept",
};

// A memory the PERSON added themselves — no source agent.
const MEM_OWN: MemoryViewItem = {
  id: "mem-own",
  content: "Allergic to penicillin",
  savedAt: "1 Nov 2026, 4:30 pm",
  sourceAgentName: null,
  scope: "shared",
};

const MEMORIES: MemoryViewItem[] = [MEM_CLAUDE_SHARED, MEM_CHATGPT_KEPT, MEM_OWN];

function base(overrides: Partial<MemoryViewProps> = {}): MemoryViewProps {
  return {
    memories: MEMORIES,
    ...overrides,
  };
}

function render(props: MemoryViewProps): string {
  return renderToStaticMarkup(<MemoryView {...props} />);
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
// contributes none, and an attribute value like an input's `value` is NOT visible text —
// the tag is stripped whole), tags stripped and entities decoded.
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

function findAll(markup: string, tag: string): Array<{ attrs: string; inner: string }> {
  const out: Array<{ attrs: string; inner: string }> = [];
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

// Names of every actionable (not-disabled) control: a live <button>, a live disclosure
// <summary>, a non-disabled input (by label / aria-label / value), a wrapping-label
// input, or an <option>. This reads RENDERED, LIVE affordances — never dead static text
// — covering the common control shapes (a button, a disclosure, a toggle switch, a
// select) without pinning any one implementation.
function selectableNames(markup: string): string[] {
  const labels = labelTextById(markup);
  const out: string[] = [];
  for (const b of findAll(markup, "button")) {
    if (hasBoolAttr(b.attrs, "disabled")) continue;
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

function hasSelectable(markup: string, re: RegExp): boolean {
  return selectableNames(markup).some((n) => re.test(n));
}

function countSelectable(markup: string, re: RegExp): number {
  return selectableNames(markup).filter((n) => re.test(n)).length;
}

// Value-bearing, GENUINELY-EDITABLE controls: a text-ish <input> or a <textarea> that is
// neither `disabled` nor `readonly`. `defaultValue` renders as the `value` attribute
// (input) or the element's text content (textarea) in SSR markup. This reads the
// RENDERED editable affordances — behaviour, not source.
type EditableField = { label: string; value: string; placeholder: string | null };
function editableFields(markup: string): EditableField[] {
  const NON_VALUE = new Set(["checkbox", "radio", "hidden", "submit", "button", "reset", "image", "file"]);
  const labels = labelTextById(markup);
  const out: EditableField[] = [];
  for (const m of markup.matchAll(/<input\b([^>]*?)\/?>/gi)) {
    const attrs = m[1];
    const type = (attr(attrs, "type") ?? "text").toLowerCase();
    if (NON_VALUE.has(type)) continue;
    if (hasBoolAttr(attrs, "disabled") || hasBoolAttr(attrs, "readonly")) continue;
    const id = attr(attrs, "id");
    out.push({
      label: ((id && labels[id]) || attr(attrs, "aria-label") || "").trim(),
      value: attr(attrs, "value") ?? "",
      placeholder: attr(attrs, "placeholder"),
    });
  }
  for (const t of findAll(markup, "textarea")) {
    if (hasBoolAttr(t.attrs, "disabled") || hasBoolAttr(t.attrs, "readonly")) continue;
    const id = attr(t.attrs, "id");
    out.push({
      label: ((id && labels[id]) || attr(t.attrs, "aria-label") || "").trim(),
      value: visibleText(t.inner),
      placeholder: attr(t.attrs, "placeholder"),
    });
  }
  return out;
}

// A discoverable SEARCH box: an <input type="search">, an input whose accessible hint
// (placeholder / aria-label / <label> / name) names searching, or a region/form marked
// role="search". Proves the screen offers a search affordance without pinning its shape.
function hasSearchBox(markup: string): boolean {
  if (/role="search"/i.test(markup)) return true;
  const labels = labelTextById(markup);
  for (const m of markup.matchAll(/<input\b([^>]*?)\/?>/gi)) {
    const attrs = m[1];
    const type = (attr(attrs, "type") ?? "text").toLowerCase();
    if (type === "search") return true;
    const id = attr(attrs, "id");
    const hint = [
      attr(attrs, "placeholder") ?? "",
      attr(attrs, "aria-label") ?? "",
      (id && labels[id]) || "",
      attr(attrs, "name") ?? "",
    ].join(" ");
    if (/search|find|filter/i.test(hint)) return true;
  }
  return false;
}

// The smallest list-item (<li>…</li>) whose markup contains `needle` — one memory's
// card — so a per-memory assertion is scoped to that memory and cannot be satisfied by a
// screen-level control (the add-own form, the search box) that lives OUTSIDE the list.
// Falls back to the whole markup if no <li> wraps the needle.
function cardMarkupFor(markup: string, needle: string): string {
  let best: string | null = null;
  for (const m of markup.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)) {
    if (m[0].includes(needle) && (best === null || m[0].length < best.length)) best = m[0];
  }
  return best ?? markup;
}

// Vocabulary for the per-memory controls. A re-scope control toggles kept ⇄ shared, so
// it reads as "share"/"keep"/"re-scope"/a kept|shared chooser; never pinned to one verb.
const EDIT_RE = /\bedit\b/i;
const DELETE_RE = /\b(delete|remove)\b/i;
const RESCOPE_RE =
  /re-?scope|change (the )?scope|\bscope\b|\bshare\b|\bshared\b|\bunshare\b|\bkeep\b|\bkept\b|make (it )?(shared|kept|private)|\bprivate\b/i;
const ADD_RE = /\badd\b|new memory|save a memory|write (a )?memory|remember something|note (a|something)|add (your )?own/i;

// ================================================================================
// AC1 — every memory renders with its content and the time it was saved.
// ================================================================================

test("lists every memory with its content and the time it was saved", () => {
  const text = visibleText(render(base()));
  for (const m of MEMORIES) {
    assert.ok(
      text.includes(m.content),
      `the memory list must show the content "${m.content}"; text="${text}"`,
    );
    assert.ok(
      text.includes(m.savedAt),
      `the memory list must show the saved-at time "${m.savedAt}"; text="${text}"`,
    );
  }
});

// ================================================================================
// AC1/AC2 — each memory is labelled "Saved by <agent> · shared / · kept", and a
// person-added memory is labelled as saved by the person. Scoped to the memory's own
// card so the label can only be the memory's (not a screen-level control's).
// ================================================================================

test("labels an agent-sourced shared memory as saved by that agent, and shared", () => {
  const card = cardMarkupFor(render(base({ memories: [MEM_CLAUDE_SHARED] })), MEM_CLAUDE_SHARED.content);
  const text = visibleText(card);
  assert.match(text, /saved by/i, `an agent memory must read "Saved by <agent>"; text="${text}"`);
  assert.ok(
    text.includes(MEM_CLAUDE_SHARED.sourceAgentName!),
    `the label must name the saving agent "${MEM_CLAUDE_SHARED.sourceAgentName}"; text="${text}"`,
  );
  assert.match(text, /\bshared\b/i, `a shared memory must show its scope as shared; text="${text}"`);
});

test("labels an agent-sourced kept memory as saved by that agent, and kept", () => {
  const card = cardMarkupFor(render(base({ memories: [MEM_CHATGPT_KEPT] })), MEM_CHATGPT_KEPT.content);
  const text = visibleText(card);
  assert.match(text, /saved by/i, `an agent memory must read "Saved by <agent>"; text="${text}"`);
  assert.ok(
    text.includes(MEM_CHATGPT_KEPT.sourceAgentName!),
    `the label must name the saving agent "${MEM_CHATGPT_KEPT.sourceAgentName}"; text="${text}"`,
  );
  assert.match(text, /\bkept\b/i, `a kept memory must show its scope as kept; text="${text}"`);
});

test("labels a person-added memory as saved by the person, not an agent", () => {
  const card = cardMarkupFor(render(base({ memories: [MEM_OWN] })), MEM_OWN.content);
  const text = visibleText(card);
  assert.match(
    text,
    /saved by you\b|\byou saved\b|added by you\b|saved it yourself/i,
    `a person-added memory must be labelled as saved by the person; text="${text}"`,
  );
  // ...and its scope is still shown (a person may add a shared or kept memory).
  assert.match(text, /\bshared\b/i, `the person-added memory's scope must be shown; text="${text}"`);
});

test("attributes each agent memory to its own source agent, not another", () => {
  // Claude's memory names Claude and never ChatGPT...
  const claude = render(base({ memories: [MEM_CLAUDE_SHARED] }));
  assert.ok(claude.includes("Claude"), `the Claude memory must name Claude; markup=${claude}`);
  assert.ok(
    !claude.includes("ChatGPT"),
    `the Claude memory must NOT be attributed to ChatGPT; markup=${claude}`,
  );
  // ...and ChatGPT's memory names ChatGPT and never Claude.
  const chatgpt = render(base({ memories: [MEM_CHATGPT_KEPT] }));
  assert.ok(chatgpt.includes("ChatGPT"), `the ChatGPT memory must name ChatGPT; markup=${chatgpt}`);
  assert.ok(
    !chatgpt.includes("Claude"),
    `the ChatGPT memory must NOT be attributed to Claude; markup=${chatgpt}`,
  );
});

// ================================================================================
// AC1 — the screen offers a search box.
// ================================================================================

test("offers a search box over the memories", () => {
  const markup = render(base());
  assert.ok(
    hasSearchBox(markup),
    `the Memory screen must offer a search box; markup=${markup}`,
  );
});

// ================================================================================
// AC1 — each memory offers a live edit control, pre-filled with its content.
// ================================================================================

test("offers a live edit control for each memory", () => {
  const markup = render(base());
  assert.ok(
    countSelectable(markup, EDIT_RE) >= MEMORIES.length,
    `each memory must offer a live Edit control (expected >= ${MEMORIES.length}); controls=${JSON.stringify(selectableNames(markup))}`,
  );
});

test("the edit control is pre-filled with the memory's current content", () => {
  // Editing replaces a memory's content in place, so the edit control must present the
  // CURRENT content as an editable field (so the person edits what is there). Rendered
  // in isolation: the only editable field bearing this value is this memory's edit box
  // (the add-own box is empty, the search box is empty).
  const markup = render(base({ memories: [MEM_CLAUDE_SHARED] }));
  assert.ok(
    editableFields(markup).some((f) => f.value === MEM_CLAUDE_SHARED.content),
    `the edit control must be pre-filled with the memory's content; editable=${JSON.stringify(editableFields(markup))}`,
  );
});

// ================================================================================
// AC1 — each memory offers a live re-scope control (kept ⇄ shared). Scoped to the
// memory's card so a screen-level add-own scope chooser cannot satisfy it.
// ================================================================================

test("offers a live re-scope control on a shared memory", () => {
  const card = cardMarkupFor(render(base({ memories: [MEM_CLAUDE_SHARED] })), MEM_CLAUDE_SHARED.content);
  assert.ok(
    hasSelectable(card, RESCOPE_RE),
    `a shared memory must offer a live re-scope control; controls=${JSON.stringify(selectableNames(card))}`,
  );
});

test("offers a live re-scope control on a kept memory", () => {
  const card = cardMarkupFor(render(base({ memories: [MEM_CHATGPT_KEPT] })), MEM_CHATGPT_KEPT.content);
  assert.ok(
    hasSelectable(card, RESCOPE_RE),
    `a kept memory must offer a live re-scope control; controls=${JSON.stringify(selectableNames(card))}`,
  );
});

// ================================================================================
// AC1 — each memory offers a live delete control.
// ================================================================================

test("offers a live delete control for each memory", () => {
  const markup = render(base());
  assert.ok(
    countSelectable(markup, DELETE_RE) >= MEMORIES.length,
    `each memory must offer a live Delete control (expected >= ${MEMORIES.length}); controls=${JSON.stringify(selectableNames(markup))}`,
  );
});

// ================================================================================
// AC1 — the screen offers a live add-own control (even with no memories).
// ================================================================================

test("offers a live control to add your own memory", () => {
  const markup = render(base());
  assert.ok(
    hasSelectable(markup, ADD_RE),
    `the Memory screen must offer a live control to add your own memory; controls=${JSON.stringify(selectableNames(markup))}`,
  );
});

test("renders a usable screen with no memories — an empty message and the add-own control", () => {
  const markup = render(base({ memories: [] }));
  const text = visibleText(markup);
  // The screen still renders and is recognisably about memories (an empty state)...
  assert.ok(text.length > 0, `the empty screen must still render; markup=${markup}`);
  assert.match(text, /memor/i, `the empty screen must still be about memories; text="${text}"`);
  // ...and the add-own control is still offered, so the person can create their first.
  assert.ok(
    hasSelectable(markup, ADD_RE),
    `with no memories, the add-own control must still be offered; controls=${JSON.stringify(selectableNames(markup))}`,
  );
});

// ================================================================================
// AC2 — uses design tokens and shared components; no raw hex colour anywhere.
// ================================================================================

test("uses design tokens, never a raw hex colour", () => {
  const variants: MemoryViewProps[] = [
    base(),
    base({ memories: [] }),
    base({ memories: [MEM_CLAUDE_SHARED] }),
    base({ memories: [MEM_CHATGPT_KEPT] }),
    base({ memories: [MEM_OWN] }),
  ];
  for (const props of variants) {
    const markup = render(props);
    assert.ok(
      !/#[0-9a-fA-F]{3,8}\b/.test(markup),
      `no raw hex colour may appear in the memory-view markup, got: ${markup}`,
    );
  }
});
