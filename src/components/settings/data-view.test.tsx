// E16-S10 — Data & privacy view component (src/components/settings/data-view.tsx).
//
// RED-first: src/components/settings/data-view.tsx does NOT exist yet, so importing
// `./data-view` throws and every test here fails until the builder adds the component.
// That absence is the entire point of test-first — do NOT implement anything to make
// these pass.
//
// WHY this component exists (brief "Export and portability" / constitution 20
// "Australian Privacy Act and GDPR-style rights" — every person can export all of
// their data and delete their account themselves; design §4.1 account deletion =
// crypto-shredding): the Data & privacy screen is the one calm, plain-English home for
// the three heavy data actions — EXPORT all of your data, IMPORT a previous Warthog
// export, and DELETE your account — plus a read-only view of any history that was
// brought over by an import ("Imported history", kept OUTSIDE the live, hash-chained
// activity record so an import never claims authorship — constitution 14). Because
// deleting everything is irreversible, the weight of it is made clear BEFORE it happens
// (a plain sensitive-moment explainer), and the destructive control stays locked until
// the person types an exact confirmation phrase — the "are you really sure" gate.
//
// This is the PURE, prop-driven VIEW (a Client Component in the app, like the sibling
// NotificationsView / ActivityView): it renders the screen from its props so it can be
// pinned without a browser, a session or any server plumbing. The real plumbing — the
// export download, the import upload + validate, the crypto-shredding delete — lives in
// the server composition root and sibling actions wired by a LATER task; the controls
// here are native affordances. The confirmation GATE is a conceptually-interactive piece
// of state, so — exactly as NotificationsView lets a prop select the initial state of a
// conceptually-interactive screen (an unverified vs verified number) — this view takes
// the CURRENT confirmation text as a prop (`confirmationInput`, seeding the field's
// initial value, default ""), and derives the Delete control's disabled state SOLELY
// from whether it equals the required phrase. A render test then pins the locked and
// unlocked states without clicking anything.
//
// These tests pin BEHAVIOUR — what the component RENDERS for the props it is given (the
// controls a person can actually use, their live/disabled state, the labelling of the
// imported-history archive, the gate that unlocks only on the exact phrase, the
// sensitive-moment explainers) — never the source text of data-view.tsx. A later
// behaviour-preserving refactor (different wrapper elements, reworded-but-still-plain
// copy, a different icon, extra classes) stays green. We render with `react-dom/server`
// (no DOM/jsdom — React component / E2E testing is a per-job ADR) and read the emitted
// markup, exactly as the sibling component tests do. Colour comes from the design tokens
// (globals.css) — never a raw hex.
//
// ---------------------------------------------------------------------------
// THE CONTRACT the builder implements (test-first spec; the component conforms):
//
//   DataView({ importedHistory, confirmationPhrase?, confirmationInput?, ...actions }):
//     • importedHistory      — the archived entries brought over by a past import, each
//                              already display-ready ({ id, kind, at, summary }). Shown
//                              in a clearly-labelled, READ-ONLY "Imported history"
//                              section, distinct from the live activity feed. May be
//                              EMPTY (a fresh account that never imported).
//     • confirmationPhrase   — the EXACT phrase the person must type to unlock account
//                              deletion. OPTIONAL; the view supplies a plain default.
//                              It is SHOWN on the screen so the person knows what to
//                              type.
//     • confirmationInput    — the CURRENT contents of the confirmation field (seeds the
//                              field's initial value for the render test). OPTIONAL;
//                              defaults to "" (nothing typed yet). The Delete control is
//                              DISABLED unless confirmationInput === confirmationPhrase.
//     • exportAction / importAction / deleteAccountAction — the server actions the page
//                              passes in the running app; OMITTED in render tests (the
//                              controls' live/disabled state never depends on them).
//
// Behaviours asserted below:
//   - a live Export control, with a plain sensitive-moment explainer beside it.
//   - a live Import file picker.
//   - a clearly-labelled, read-only "Imported history" section showing the archived
//     entries, distinct from the live activity feed.
//   - a Delete-account control that is DISABLED until the exact confirmation phrase is
//     typed, LIVE once it is, and — while disabled — says what to do (no dead control).
//   - the required confirmation phrase + a live field to type it.
//   - a plain sensitive-moment explainer for delete that makes the weight (permanent /
//     everything) clear.
//   - no raw hex colour anywhere.

import * as React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";

import { DataView } from "./data-view";

// --- the prop shape this task introduces (described here as the contract) -------

type DataViewImportedEntry = {
  id: string;
  kind: string; // display-ready label of the archived item, e.g. "Payment"
  at: string; // pre-formatted time label, e.g. "1 March 2025"
  summary: string; // one-line, already-redacted, display-ready
};

type DataViewProps = {
  importedHistory: ReadonlyArray<DataViewImportedEntry>;
  confirmationPhrase?: string;
  confirmationInput?: string;
  // wiring (the page passes these in the running app; omitted in render tests)
  exportAction?: (formData: FormData) => void | Promise<void>;
  importAction?: (formData: FormData) => void | Promise<void>;
  deleteAccountAction?: (formData: FormData) => void | Promise<void>;
};

// --- fixtures -------------------------------------------------------------------
//
// The two imported entries carry distinctive, nonsense summaries so every "the archive
// shows this entry" assertion is honest — those exact words can only come from the
// imported-history rendering (there is no other feed in this view).

const ENTRY_A: DataViewImportedEntry = {
  id: "ih-aaaaaaaa",
  kind: "Payment",
  at: "1 March 2025",
  summary: "Renewed the quokka ferry pass",
};
const ENTRY_B: DataViewImportedEntry = {
  id: "ih-bbbbbbbb",
  kind: "Reminder",
  at: "15 April 2025",
  summary: "Topped up the wombat transport card",
};

// The exact phrase the Delete gate requires. Multi-word and loud, as a real "type this
// to confirm" phrase is. Passed explicitly so the lock/unlock match is deterministic;
// the view must display it AND honour it.
const PHRASE = "DELETE EVERYTHING";

function base(overrides: Partial<DataViewProps> = {}): DataViewProps {
  return {
    importedHistory: [ENTRY_A, ENTRY_B],
    confirmationPhrase: PHRASE,
    // confirmationInput intentionally omitted → the view's default (""), so the Delete
    // gate starts locked, which several tests pin.
    ...overrides,
  };
}

// --- markup helpers (no DOM), mirrored from the sibling component tests ---------

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
// or ` disabled="disabled"` — but never the word inside another attribute.
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

// Names of every actionable (not-disabled) form control: a live <button>, a non-disabled
// input (by label / aria-label / value), a wrapping-label input, or an <option>. Reads
// RENDERED, LIVE affordances — never dead static text — covering the common control
// shapes without pinning any one implementation.
function selectableNames(markup: string): string[] {
  const labels = labelTextById(markup);
  const out: string[] = [];
  for (const b of findAll(markup, "button")) {
    if (hasBoolAttr(b.attrs, "disabled")) continue;
    out.push((visibleText(b.inner) || attr(b.attrs, "aria-label") || "").trim());
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

// Accessible names of every live navigation/action link (an <a href> that is not
// aria-disabled). Export may legitimately be a download LINK or a FORM submit, so the
// "is there a live export control" check must see anchors too.
function anchorNames(markup: string): string[] {
  const out: string[] = [];
  for (const m of markup.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const attrs = m[1];
    if (attr(attrs, "href") == null) continue;
    if (attr(attrs, "aria-disabled") === "true") continue;
    out.push((visibleText(m[2]) || attr(attrs, "aria-label") || "").trim());
  }
  return out.filter((n) => n.length > 0);
}

// Every live affordance (button / input / option / link) a person can act on.
function actionableNames(markup: string): string[] {
  return [...selectableNames(markup), ...anchorNames(markup)];
}

function hasActionable(markup: string, re: RegExp): boolean {
  return actionableNames(markup).some((n) => re.test(n));
}

// Every <button> with its accessible name and disabled state (live OR disabled).
function allButtons(markup: string): Array<{ name: string; disabled: boolean }> {
  return findAll(markup, "button").map((b) => ({
    name: (visibleText(b.inner) || attr(b.attrs, "aria-label") || "").trim(),
    disabled: hasBoolAttr(b.attrs, "disabled"),
  }));
}

function button(markup: string, re: RegExp): { name: string; disabled: boolean } | undefined {
  return allButtons(markup).find((b) => re.test(b.name));
}

// Value-bearing inputs (text / number / … — not a checkbox, radio, file or other
// non-value control) with their accessible label and the value a render carries.
// `value`/`defaultValue` render as the `value` attribute in SSR markup.
type ValueInput = {
  label: string;
  value: string | null;
  placeholder: string | null;
  disabled: boolean;
  type: string;
};
function valueInputs(markup: string): ValueInput[] {
  const NON_VALUE = new Set(["checkbox", "radio", "hidden", "submit", "button", "reset", "image", "file"]);
  const labels = labelTextById(markup);
  const out: ValueInput[] = [];
  for (const m of markup.matchAll(/<input\b([^>]*?)\/?>/gi)) {
    const attrs = m[1];
    const type = (attr(attrs, "type") ?? "text").toLowerCase();
    if (NON_VALUE.has(type)) continue;
    const id = attr(attrs, "id");
    out.push({
      label: ((id && labels[id]) || attr(attrs, "aria-label") || "").trim(),
      value: attr(attrs, "value"),
      placeholder: attr(attrs, "placeholder"),
      disabled: hasBoolAttr(attrs, "disabled"),
      type,
    });
  }
  return out;
}

// The confirmation field — a value input whose label or placeholder marks it as the
// "type the phrase to confirm" gate.
function confirmField(markup: string): ValueInput | undefined {
  const RE = /confirm|phrase|type|delete/i;
  return valueInputs(markup).find((i) => RE.test(i.label) || RE.test(i.placeholder ?? ""));
}

// File inputs (the import picker), with their accessible label and disabled flag.
type FileInput = { label: string; disabled: boolean; accept: string | null };
function fileInputs(markup: string): FileInput[] {
  const labels = labelTextById(markup);
  const out: FileInput[] = [];
  for (const m of markup.matchAll(/<input\b([^>]*?)\/?>/gi)) {
    const attrs = m[1];
    if ((attr(attrs, "type") ?? "text").toLowerCase() !== "file") continue;
    const id = attr(attrs, "id");
    out.push({
      label: ((id && labels[id]) || attr(attrs, "aria-label") || "").trim(),
      disabled: hasBoolAttr(attrs, "disabled"),
      accept: attr(attrs, "accept"),
    });
  }
  return out;
}

function fileInput(markup: string): FileInput | undefined {
  return fileInputs(markup)[0];
}

// Does `re` appear in the visible text within `window` chars either side of the first
// occurrence of `needle`? Proves two things are rendered TOGETHER (a control and its
// explainer / stated reason) without pinning exact layout.
function nearInText(markup: string, needle: string, re: RegExp, window = 220): boolean {
  const vt = visibleText(markup);
  const i = vt.toLowerCase().indexOf(needle.toLowerCase());
  if (i < 0) return false;
  const lo = Math.max(0, i - window);
  const hi = Math.min(vt.length, i + needle.length + window);
  return re.test(vt.slice(lo, hi));
}

function render(props: DataViewProps): string {
  return renderToStaticMarkup(<DataView {...props} />);
}

// --- recognisers for the controls (generous over the plausible plain wordings) --

const EXPORT_RE = /export|download|get (a |your )?copy|save (a |your )?copy/i;
const IMPORT_RE = /import|upload|restore|choose (a )?file|bring (your )?data/i;
const DELETE_RE = /delete|remove (my |the |your )?account|close (my |your )?account/i;

// A plain sensitive-moment explainer (SensitiveNotice-style). Several phrasings so a
// reworded explainer stays matched: the generic slow-down copy, or an export-flavoured
// "this is a copy of everything about you, keep it safe".
const EXPLAINER_RE =
  /sensitive|take a moment|moment before|before it goes ahead|before you (download|export|do this|continue|go)|check (the|your) details|double.?check|slow down|make sure|keep (it|the file|this) (safe|somewhere)|a (copy|file) (of|with|containing)|everything (we |warthog )?(stores?|stored|keeps?|holds?|has)|all (of )?your (data|information)/i;

// The weight a delete-everything explainer must make clear — irreversibility and
// totality, in prose (phrasing that cannot be a mere button label).
const DELETE_WEIGHT_RE =
  /permanent(ly)?|cannot be undone|can.?t be undone|cannot be reversed|can.?t be reversed|no going back|for good|forever|erase everything|remove everything|delete all (of )?your|all of your (data|information)|everything (you|we|stored|about you)/i;

// The read-only / archived / separate marking that distinguishes the imported-history
// section from the live activity feed.
const READONLY_RE =
  /read[\s-]?only|view[\s-]?only|can.?t be (changed|edited)|cannot be (changed|edited)|archive|archived|from (a |an |your )?(previous|old|earlier|another|imported)|imported from|brought (in|over)|separate from|not part of (your |the )?(live |current )?(activity|feed|record)/i;

// ================================================================================
// AC1 — Export: a live control, with a plain sensitive-moment explainer beside it.
// ================================================================================

test("renders a live Export control", () => {
  const markup = render(base());
  assert.ok(
    hasActionable(markup, EXPORT_RE),
    `the screen must offer a live control to export all of the person's data; controls=${JSON.stringify(
      actionableNames(markup),
    )}`,
  );
});

test("shows a plain sensitive-moment explainer beside the Export control", () => {
  const markup = render(base());
  const exportName = actionableNames(markup).find((n) => EXPORT_RE.test(n));
  assert.ok(
    exportName,
    `the Export control must render before its explainer can be checked; controls=${JSON.stringify(
      actionableNames(markup),
    )}`,
  );
  assert.ok(
    exportName && nearInText(markup, exportName, EXPLAINER_RE, 400),
    `the Export action must carry a plain sensitive-moment explainer of what it does; text="${visibleText(
      markup,
    )}"`,
  );
});

// ================================================================================
// AC1 — Import: a live file picker.
// ================================================================================

test("renders a live Import file picker", () => {
  const markup = render(base());
  const picker = fileInput(markup);
  assert.ok(
    picker,
    `the screen must offer a file picker to import a previous export; actionables=${JSON.stringify(
      actionableNames(markup),
    )}`,
  );
  assert.ok(picker && !picker.disabled, "the import file picker must be live (not disabled)");
  assert.ok(
    hasActionable(markup, IMPORT_RE),
    `the file picker must sit in a clearly import/upload-labelled control; controls=${JSON.stringify(
      actionableNames(markup),
    )}`,
  );
});

// ================================================================================
// AC1 — Imported history: a clearly-labelled, read-only section showing the archived
//        entries, distinct from the live activity feed.
// ================================================================================

test("renders a clearly labelled Imported history section showing the archived entries", () => {
  const text = visibleText(render(base()));
  assert.match(
    text,
    /imported history/i,
    `the screen must carry a clearly labelled "Imported history" section; text="${text}"`,
  );
  for (const entry of [ENTRY_A, ENTRY_B]) {
    assert.ok(
      text.includes(entry.summary),
      `the Imported history section must show each archived entry (missing "${entry.summary}"); text="${text}"`,
    );
  }
});

test("renders from the imported-history list given, not a fixed list", () => {
  // A distinct single entry proves the section is data-driven: its words can only come
  // from this prop.
  const only: DataViewImportedEntry = {
    id: "ih-cccccccc",
    kind: "Connection",
    at: "2 February 2025",
    summary: "Connected the platypus calendar",
  };
  const text = visibleText(render(base({ importedHistory: [only] })));
  assert.ok(
    text.includes(only.summary),
    `the Imported history section must render the entries it is given; text="${text}"`,
  );
  // The default-fixture entries must NOT appear when they were not passed.
  assert.ok(
    !text.includes(ENTRY_A.summary) && !text.includes(ENTRY_B.summary),
    `the Imported history section must not render a hard-coded list; text="${text}"`,
  );
});

test("marks the Imported history section read-only and distinct from the live activity feed", () => {
  const markup = render(base());
  assert.ok(
    nearInText(markup, "imported history", READONLY_RE, 340),
    `the Imported history section must be marked read-only / archived / separate from the live activity feed; text="${visibleText(
      markup,
    )}"`,
  );
});

test("renders the Export, Import and Delete controls even with no imported history", () => {
  // A fresh account that never imported still gets its three heavy data actions; the
  // empty archive must not take the controls down.
  const markup = render(base({ importedHistory: [] }));
  assert.ok(hasActionable(markup, EXPORT_RE), "Export must render with an empty imported history");
  assert.ok(fileInput(markup), "the Import picker must render with an empty imported history");
  assert.ok(button(markup, DELETE_RE), "the Delete-account control must render with an empty imported history");
});

// ================================================================================
// AC1 — Delete: the control is present.
// ================================================================================

test("renders a Delete-account control", () => {
  const markup = render(base());
  assert.ok(
    button(markup, DELETE_RE),
    `the screen must offer a Delete-account control; buttons=${JSON.stringify(allButtons(markup))}`,
  );
});

// ================================================================================
// AC2 — the Delete-account control stays DISABLED until the EXACT phrase is typed, and
//        becomes LIVE once it is. While disabled it says what to do (no dead control).
// ================================================================================

test("the Delete-account control stays disabled until the exact confirmation phrase is typed", () => {
  // Three not-yet-exact states: nothing typed, an incomplete prefix, and a wrong string.
  // Each must leave the destructive control locked.
  const notExact: Array<string | undefined> = [undefined, PHRASE.slice(0, -1), "not the phrase at all"];
  for (const input of notExact) {
    const markup = render(base({ confirmationInput: input }));
    const del = button(markup, DELETE_RE);
    assert.ok(del, `a Delete-account control must always render; buttons=${JSON.stringify(allButtons(markup))}`);
    assert.ok(
      del && del.disabled,
      `with confirmation input ${JSON.stringify(input)} (not the exact phrase "${PHRASE}"), the Delete control must be DISABLED; buttons=${JSON.stringify(
        allButtons(markup),
      )}`,
    );
  }

  // No dead control: while locked, the Delete control must tell the person what to do
  // (type the phrase to unlock it) — never a silent disabled button.
  const locked = render(base());
  const del = button(locked, DELETE_RE);
  assert.ok(
    del && nearInText(locked, del.name, /type|enter|confirm|unlock|to delete/i, 500),
    `the disabled Delete control must state what to do (type the phrase to confirm); text="${visibleText(
      locked,
    )}"`,
  );
});

test("the Delete-account control becomes live once the exact confirmation phrase is typed", () => {
  const markup = render(base({ confirmationInput: PHRASE }));
  const del = button(markup, DELETE_RE);
  assert.ok(del, `a Delete-account control must render; buttons=${JSON.stringify(allButtons(markup))}`);
  assert.ok(
    del && !del.disabled,
    `with the exact phrase "${PHRASE}" typed, the Delete control must be LIVE (not disabled); buttons=${JSON.stringify(
      allButtons(markup),
    )}`,
  );
});

test("shows the required confirmation phrase and a live field to type it", () => {
  const markup = render(base());
  assert.ok(
    visibleText(markup).includes(PHRASE),
    `the screen must show the exact phrase the person must type ("${PHRASE}"); text="${visibleText(markup)}"`,
  );
  const field = confirmField(markup);
  assert.ok(field, `a confirmation field must render; fields=${JSON.stringify(valueInputs(markup))}`);
  assert.ok(field && !field.disabled, "the confirmation field must be live (editable)");

  // The field reflects what has been typed — the render-test seam that drives the gate.
  const typed = confirmField(render(base({ confirmationInput: PHRASE })));
  assert.equal(
    typed?.value,
    PHRASE,
    `the confirmation field must reflect the current confirmation input; field=${JSON.stringify(typed)}`,
  );
});

// ================================================================================
// AC3 — a plain sensitive-moment explainer for the delete action that makes the weight
//        (permanent / everything) clear before it happens.
// ================================================================================

test("makes the weight of deleting everything clear with a plain explainer beside the Delete control", () => {
  const markup = render(base());
  const del = button(markup, DELETE_RE);
  assert.ok(del, `the Delete control must render before its explainer can be checked; buttons=${JSON.stringify(
    allButtons(markup),
  )}`);
  assert.ok(
    del && nearInText(markup, del.name, DELETE_WEIGHT_RE, 500),
    `the Delete action must carry a plain explainer that makes its weight clear (permanent / everything / cannot be undone); text="${visibleText(
      markup,
    )}"`,
  );
});

// ================================================================================
// Design system — colour comes from tokens, never a raw hex literal.
// ================================================================================

test("uses design tokens, never a raw hex colour", () => {
  const variants: DataViewProps[] = [
    base(),
    base({ importedHistory: [] }),
    base({ confirmationInput: PHRASE }),
    base({ confirmationInput: "not the phrase" }),
  ];
  for (const props of variants) {
    const markup = render(props);
    assert.ok(
      !/#[0-9a-fA-F]{3,8}\b/.test(markup),
      `no raw hex colour may appear in the data-view markup, got: ${markup}`,
    );
  }
});

// ================================================================================
// Review fix G2 — Export really downloads a file, and says what the file holds.
// ================================================================================

test("the Export and Import controls run on the device without a raw-file form", () => {
  const markup = render(base());
  const forms = findAll(markup, "form");
  assert.equal(forms.some((form) => /type="file"/.test(form.inner)), false);
  assert.ok(hasActionable(markup, /export my data/i));
  assert.ok(fileInput(markup));
});

test("the Export explainer warns that opted-in protected details are readable in the file", () => {
  const text = visibleText(render(base()));
  assert.match(text, /include protected details/i);
  assert.match(text, /readable card numbers/i);
  assert.match(text, /anyone with the file can read it/i);
});


// content-28 — the delete explainer says what happens in plain words, without database
// terms, and still separates what happens straight away from what backups keep for a time.
test("deletion explains, in plain words, what happens now, within 24 hours and in backups", () => {
  const text = visibleText(render(base()));
  assert.match(text, /straight away/i);
  assert.match(text, /can no longer be opened/i);
  assert.match(text, /within 24 hours/i);
  assert.match(text, /backups/i);
  assert.match(text, /privacy policy/i);
  assert.doesNotMatch(text, /encryption|database|rows|queued|sensitive step|take a moment/i);
  assert.doesNotMatch(text, /encryption key is destroyed|everything.*erased for good/i);
});

// interaction-17 / F2 — one "Confirm it's you" on the page, offering only the member's
// factors, and no unlock guidance until it applies (content-29).
test("offers a single Confirm it's you when the session needs one, with only the member's factors", () => {
  const markup = render(base({ needsConfirm: true, passkey: false, authenticator: true }));
  assert.equal(markup.match(/class="wh-confirm-its-you/g)?.length, 1);
  assert.match(markup, /Authenticator app code/);
  assert.doesNotMatch(markup, />Confirm it&#x27;s you</);
  assert.equal(render(base()).match(/class="wh-confirm-its-you/g), null, "none when the session is fresh");
  assert.doesNotMatch(visibleText(render(base())), /unlock your vault|How would you like to unlock/i);
});

test("each task is its own panel, with the delete action in the delete panel's footer", () => {
  const markup = render(base());
  for (const title of ["Export your data", "Import a previous export", "Imported history", "Delete account"]) {
    assert.match(markup, new RegExp(`<section[^>]*class="wh-panel"[\\s\\S]*?<h2[^>]*>${title}</h2>`), title);
  }
  assert.match(markup, /<footer class="wh-panel-footer">[\s\S]*?Delete my account/);
  assert.match(render(base({ importedHistory: [] })), /wh-panel-empty[\s\S]*Nothing has been imported yet/, "the empty archive is an inline empty state");
});
